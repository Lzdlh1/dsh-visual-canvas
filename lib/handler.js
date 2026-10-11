/**
 * 两个入口（DSH 端口与独立端口）共用的请求处理。
 *
 * ## 为什么要抽这一层
 *
 * 之前 DSH 路由与独立端口服务各写一份处理逻辑，结果规则开始漂移
 * （独立端口少了状态接口，就是一次真实的疏漏）。现在两者都只做一件事：
 * 起服务器、把请求交给这里。**安全判定、资源白名单、代理、画板 API 全部只实现一次。**
 *
 * ## 路由约定
 *
 * | 路径 | 行为 |
 * |---|---|
 * | `<prefix>/` | 画布外壳（新的主入口） |
 * | `<prefix>/__canvas__/*` | 插件自己的资源：覆盖层 js、外壳静态文件、状态、画板 API |
 * | `<prefix>/__frame__/<路径>` | 画板里嵌的实时页面（代理上游，**不注入编辑器覆盖层**） |
 * | `<prefix>/__edit__/<路径>` | 单页编辑模式（代理上游 + 注入覆盖层） |
 * | `<prefix>/<其它>` | 兼容旧地址：按单页编辑模式代理 |
 * | `<prefix>/__hmr__/<路径>`（升级） | 转发上游 WebSocket（HMR 等） |
 * | `<prefix>/__canvas__/ws`（升级） | 覆盖层 WebSocket |
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { handleProxy, handleUpgrade, resolveOwnRequest, resolveUpstream } from "./proxy.js";
import { matchMount, readMountFile } from "./static-mounts.js";
import { readJsonBody, loopbackOnly } from "./util.js";

/**
 * 注释路由的请求体上限。
 *
 * 默认的 2MB 对别的路由够用（改属性、存组件都很小），但注释能带图片，
 * 而图片走 base64 会膨胀约 33% —— 2MB 实际只装得下 1.5MB 的原图。
 * 放宽到 24MB 相当于能传约 18MB 的原图；
 * **真正的图片校验（尺寸/像素/媒体类型）在宿主的 attachments 服务那边**，
 * 这里只是别让传输层先卡住、给一个用户看不懂的失败。
 */
const PROMPT_BODY_LIMIT = 24 * 1024 * 1024;
import { completeHandshake, Peer } from "./ws.js";

/**
 * 外壳静态文件白名单（同时给出 content-type）。
 *
 * ⚠ 新增外壳模块**必须**加到这里，否则浏览器取不到它 → `shell.js` 里那条 import
 * 直接失败 → **整个外壳起不来**（页面空白、什么都不响应，且没有明显报错）。
 * 这个坑踩过两次（view.js、layers.js），`load-harness` 里已加断言守着。
 */
const SHELL_FILES = new Map([
	["shell.html", "text/html; charset=utf-8"],
	["shell.css", "text/css; charset=utf-8"],
	["shell.js", "application/javascript; charset=utf-8"],
	["edit.js", "application/javascript; charset=utf-8"],
	["view.js", "application/javascript; charset=utf-8"],
	["layers.js", "application/javascript; charset=utf-8"],
	["library-panel.js", "application/javascript; charset=utf-8"],
	["shapes.js", "application/javascript; charset=utf-8"],
	["shape-panel.js", "application/javascript; charset=utf-8"],
	// ⚠ 新增外壳文件**必须在这里登记**，否则浏览器 404，
	// 表现为「模块解析失败、控制台报 Failed to load module script」。
	// 这是白名单不是约定——不登记就真的加载不到。
	["inspector.js", "application/javascript; charset=utf-8"],
	// 2026-10-07：第三次踩这个坑（前两次是 view.js / layers.js）。
	// 这次是 `trace.js` —— 从 `edit.js` 里 `import { newTrace }` 引它，
	// 而它没登记 → 浏览器 404 → **整个外壳脚本不执行**：
	// 画板列表空、"添加画板"点什么都没反应，看起来像"画布坏了"。
	["trace.js", "application/javascript; charset=utf-8"],
	// 调色板：从画布上收集"已经在用的"颜色与文字样式，供侧边栏快选
	["palette.js", "application/javascript; charset=utf-8"],
	// 关联：图层与图层之间的带类型的边（镶嵌 / 功能）
	["links.js", "application/javascript; charset=utf-8"],
	// 语义 → ARIA 正式属性的映射（纯函数，零依赖）
	["aria.js", "application/javascript; charset=utf-8"]
	// ⚠️ **绝对不要把 `core.js` / `editor.js` 加到这个表里。**
	//
	// `lib/canvas/core.js` 和 `lib/canvas/editor.js` 是**给 node 用的转发桥**
	// （真实实现在 `lib/overlay/` 下，见那两个文件顶部的说明）。
	// 浏览器这条路现在是通的：白名单里没有它们 → 落到
	// `resolveOwnRequest(overlayDir)` → 直接拿到 overlay 那份实现。
	//
	// 一旦登记进来，浏览器会改拿转发文件，而它里面的 `../overlay/xxx.js`
	// 会被解析成 `/canvas/overlay/xxx.js` —— **404，整个外壳起不来**。
	// `test/shell-files-harness.mjs` 里有断言钉着这一条。
]);

/**
 * 创建两个入口共用的处理器。
 *
 * @param options - {
 *   target, prefix, enabled, overlayDir, shellDir, board, logger,
 *   onPeer: (socket, req, head) => void
 * }。
 * @returns { handleRequest, handleUpgradeRequest }。
 */
export function createHandlers(options) {
	const prefix = options.prefix;

	/**
	 * 应答插件自己的资源（覆盖层 / 外壳 / 状态 / 画板 API）。
	 *
	 * @param req - 请求。
	 * @param res - 响应。
	 * @returns 是否已经应答。
	 */
	const serveOwn = async (req, res) => {
		const pathname = new URL(req.url ?? "/", "http://proxy.local").pathname;

		// ---- 静态挂载：命中就直接从磁盘应答，**不经过代理**
		//
		// 必须在最前面：挂载的意义就是「这个路径由画布自己提供」，
		// 一旦往后走就会被转发给 target，而目标 dev server 多半根本没在跑。
		//
		// ⚠ 要比的是**应用内路径**，不是完整 URL。请求实际长这样：
		//     /canvas/plugin-ui             （直接打开）
		//     /canvas/__frame__/plugin-ui   （画板 iframe 里）
		//   而挂载配置写的是 `/plugin-ui`。拿完整路径去比**永远匹配不上**——
		//   这个 bug 让挂载整个失效，表现是「明明配了却还是去连 dev server 然后 ECONNREFUSED」。
		//   resolveUpstream 一次剥掉前缀和 __frame__，两种入口都能对上。
		const mounts = options.mounts ?? [];
		if (mounts.length > 0) {
			const hit = matchMount(mounts, resolveUpstream(req.url, prefix).path);
			if (hit !== null) {
				// 只读：挂载不提供任何写入能力。
				if (req.method !== "GET" && req.method !== "HEAD") {
					writeText(res, 403, "静态挂载是只读的");
					return true;
				}
				if (hit.file === null) {
					writeText(res, 403, `拒绝访问：${hit.reason ?? "路径非法"}`);
					return true;
				}
				const result = readMountFile(hit.file);
				if (result.error !== undefined) {
					writeText(res, result.status, result.error);
					return true;
				}
				writeBinary(res, result.status, result.body, result.type);
				return true;
			}
		}

		// ---- 画布外壳
		if (pathname === `${prefix}/` || pathname === prefix) {
			const html = readShellFile("shell.html");
			if (html === null) {
				writeText(res, 500, `读取画布外壳失败（${options.shellDir ?? "未配置"}）`);
				return true;
			}
			// 外壳需要知道自己的前缀（用来拼资源与画板 API 的地址）。
			// 注意必须替换**所有**出现处：HTML 里有多处引用。
			writeHtml(res, html.replaceAll("__PREFIX__", prefix));
			return true;
		}

		// ---- 画板 API
		if (pathname === `${prefix}/__canvas__/board`) {
			if (options.board === undefined) {
				writeJson(res, 503, { ok: false, error: "画板 API 不可用" });
				return true;
			}
			if (req.method === "GET") {
				writeJson(res, 200, options.board.snapshot());
				return true;
			}
			if (req.method === "POST") {
				const body = await readJsonBody(req);
				if (body.error !== undefined) {
					writeJson(res, 400, { ok: false, error: body.error });
					return true;
				}
				// 冲突（文件被外部改过）是**预期内**的业务结果，用 200 + ok:false 返回，
				// 让界面显示可读提示，而不是把它当成传输错误。
				writeJson(res, 200, options.board.apply(body.value ?? {}));
				return true;
			}
			writeJson(res, 405, { ok: false, error: `画板 API 只支持 GET/POST，收到 ${req.method}` });
			return true;
		}

		// ---- 设计库 API
		if (pathname === `${prefix}/__canvas__/library`) {
			if (options.library === undefined) {
				writeJson(res, 503, { ok: false, error: "设计库不可用（未配置库根目录）" });
				return true;
			}
			if (req.method === "GET") {
				const query = new URL(req.url ?? "/", "http://proxy.local").searchParams;
				// **把所有查询参数原样转发**，而不是逐个列出来。
				//
				// 早先这里只挑 `library` 和 `slug` 传下去，于是 `asset` 动作拿不到 `name`——
				// 表现是「图标列表能显示、却一个都画不出来，点一下报『找不到图标：undefined』」。
				// 逐个列举的写法**每加一个动作就多一个漏参的机会**，而且漏掉时是静默的
				//（缺的参数变成 undefined，不报错）。
				const payload = Object.fromEntries(query);
				const result = await options.library.dispatch(query.get("action") ?? "libraries", payload);
				writeJson(res, 200, result);
				return true;
			}
			if (req.method === "POST") {
				const body = await readJsonBody(req);
				if (body.error !== undefined) {
					writeJson(res, 400, { ok: false, error: body.error });
					return true;
				}
				const value = body.value ?? {};
				const result = await options.library.dispatch(value.action, value);
				// 业务失败（找不到库、包格式不对）是**预期内**的结果，用 200 + ok:false 返回，
				// 让界面显示可读原因，而不是当成传输错误。
				writeJson(res, 200, result);
				return true;
			}
			writeJson(res, 405, { ok: false, error: `设计库 API 只支持 GET/POST，收到 ${req.method}` });
			return true;
		}

		// ---- 画布 → Agent 的指令通道
		if (pathname === `${prefix}/__canvas__/prompt`) {
			if (options.prompt === undefined) {
				writeJson(res, 503, { ok: false, error: "指令通道不可用（未配置 prompt 桥）" });
				return true;
			}
			if (req.method === "GET") {
				writeJson(res, 200, await options.prompt.status());
				return true;
			}
			if (req.method === "POST") {
				// ⚠️ **这个路由要单独放宽体积上限**。
				//
				// `readJsonBody` 默认只收 2MB，别处够用（改属性、存组件都小）。
				// 但注释卡片能带图片，而图片是 base64 传的 —— **会膨胀约 33%**，
				// 也就是说 2MB 的上限实际只装得下 1.5MB 的原图。
				// 手机截图动辄两三兆，按默认值的话用户会看到"发送失败"，
				// 却完全不知道为什么（他选的图在别处都能传）。
				//
				// 真正的大小/像素校验在宿主那边（`attachments.saveImages`），
				// 这里放宽只是**别让传输层先卡住**，报错由宿主给更准确的原因。
				const body = await readJsonBody(req, PROMPT_BODY_LIMIT);
				if (body.error !== undefined) {
					writeJson(res, 400, { ok: false, error: body.error });
					return true;
				}
				// 「找不到目标会话」这类是**预期内**的业务结果，用 200 + ok:false 返回，
				// 让界面显示可读的提示与下一步，而不是把它当成传输错误。
				//
				// ## ⚠️ 请求体有两种形状，这里统一解掉
				//
				// `readJsonBody` 的 `value` 就是**整个请求体**，所以：
				//
				// ```
				// 发 { text, selection }                    → body.value 直接可用
				// 发 { action: "send", value: { text, … } } → 还得再解一层
				// ```
				//
				// 注释卡片原来发的是**后者**（照搬了 library / mutate 那套约定），
				// 而这个路由只解一层 —— 于是宿主收到的 request 是 `{action, value}`，
				// `request.text` 是 undefined，三个字段全空，走进判空分支。
				// 用户看到的是「发送失败：指令是空的。」**而卡片里明明写着字**。
				//
				// 前端已经改成统一形状了；这里**再宽容一层**：
				// 以后谁再加一条发送路径、顺手包了 action，也不会再踩同一个坑。
				const payload = body.value !== null && typeof body.value === "object"
					&& body.value.action === "send" && body.value.value !== undefined
					? body.value.value
					: (body.value ?? {});
				writeJson(res, 200, await options.prompt.send(payload));
				return true;
			}
			writeJson(res, 405, { ok: false, error: `指令通道只支持 GET/POST，收到 ${req.method}` });
			return true;
		}

		// ---- 外壳静态文件
		if (pathname.startsWith(`${prefix}/__canvas__/`)) {
			const name = pathname.slice(`${prefix}/__canvas__/`.length);
			const type = SHELL_FILES.get(name);
			if (type !== undefined) {
				const text = readShellFile(name);
				if (text === null) {
					writeText(res, 500, `读取 ${name} 失败`);
					return true;
				}
				res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
				res.end(text.replaceAll("__PREFIX__", prefix));
				return true;
			}
		}

		// ---- 覆盖层文件 / 状态接口（与代理层共用同一个纯函数）
		const own = resolveOwnRequest(
			req.url,
			prefix,
			options.overlayDir,
			options.status
		);
		if (own === null) return false;
		res.writeHead(own.status, own.headers);
		res.end(own.body);
		return true;
	};

	/**
	 * 读一个外壳文件。
	 * @param name - 文件名。
	 * @returns 文本或 null。
	 */
	function readShellFile(name) {
		if (typeof options.shellDir !== "string" || options.shellDir === "") return null;
		try {
			return readFileSync(join(options.shellDir, name), "utf8");
		} catch {
			return null;
		}
	}

	/**
	 * 主请求处理。
	 * @param req - 请求。
	 * @param res - 响应。
	 */
	const handleRequest = async (req, res) => {
		// 与之前一致的访问控制：来源地址 + Host + Origin + 跨站策略，一处实现两处生效。
		if (!loopbackOnly(req)) {
			writeJson(res, 403, { error: "forbidden: loopback-only" });
			return;
		}
		if (await serveOwn(req, res)) return;

		// `/__edit__/<路径>` 是显式的单页编辑地址；剥掉这一段再转发。
		const pathname = new URL(req.url ?? "/", "http://proxy.local").pathname;
		const editBase = `${prefix}/__edit__`;
		const isEdit = pathname === editBase || pathname.startsWith(`${editBase}/`);
		const url = isEdit ? (pathname === editBase ? `${prefix}/` : `${prefix}${pathname.slice(editBase.length)}`) : req.url;

		await handleProxy(req, res, {
			target: options.target,
			prefix,
			enabled: options.enabled !== false,
			overlayDir: options.overlayDir,
			status: options.status,
			logger: options.logger,
			// 让 handleProxy 按改写后的 URL 计算上游路径。
			rawUrl: url
		});
	};

	/**
	 * 升级（WebSocket）处理。
	 * @param req - 请求。
	 * @param socket - 客户端 socket。
	 * @param head - 已读字节。
	 */
	const handleUpgradeRequest = (req, socket, head) => {
		if (!loopbackOnly(req)) {
			socket.destroy();
			return;
		}
		const pathname = new URL(req.url ?? "/", "http://proxy.local").pathname;
		if (pathname === `${prefix}/__canvas__/ws`) {
			if (!completeHandshake(req, socket)) {
				socket.destroy();
				return;
			}
			const peer = new Peer(socket, { remoteAddress: socket.remoteAddress });
			socket.on("close", () => options.onPeerClosed?.(peer));
			options.onPeer(peer, req, head);
			return;
		}
		if (pathname.startsWith(`${prefix}/__hmr__/`)) {
			handleUpgrade(req, socket, head, {
				target: options.target,
				prefix: `${prefix}/__hmr__`,
				logger: options.logger
			});
			return;
		}
		socket.destroy();
	};

	return { handleRequest, handleUpgradeRequest };
}

/**
 * 写 JSON 响应。
 * @param res - 响应。
 * @param status - 状态码。
 * @param payload - 对象。
 */
function writeJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(body);
}

/**
 * 写纯文本响应。
 * @param res - 响应。
 * @param status - 状态码。
 * @param text - 文本。
 */
function writeText(res, status, text) {
	res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
	res.end(text);
}

/**
 * 写二进制响应（静态挂载用）。
 *
 * **不带 cache-control: no-store**：挂载的是用户的静态资源，图片/字体每次都回源
 * 会明显变慢；而且它们是只读的、改了文件名通常也变。这里给一个短缓存，
 * 兼顾「改了能较快看到」和「刷新不重复拉」。
 *
 * @param res - 响应。
 * @param status - 状态码。
 * @param body - Buffer。
 * @param type - content-type。
 */
function writeBinary(res, status, body, type) {
	res.writeHead(status, {
		"content-type": type,
		"content-length": String(body.length),
		"cache-control": "no-cache"
	});
	res.end(body);
}

/**
 * 写 HTML 响应。
 * @param res - 响应。
 * @param html - HTML。
 */
function writeHtml(res, html) {
	res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
	res.end(html);
}
