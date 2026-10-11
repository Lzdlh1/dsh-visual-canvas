/**
 * 代理层：把目标 dev server 挂到 DSH 服务器的某个路径前缀下，并注入覆盖层脚本。
 *
 * ## 为什么要用 <base href> 而不是重写每个 URL
 *
 * 开发服务器（Vite / Next / Nuxt / SvelteKit / 纯静态）吐出的 HTML 里，
 * 资源路径既可能是相对的（`./src/main.tsx`）也可能是绝对的（`/src/main.tsx`、`/@vite/client`）。
 * 我们没法知道有哪些、也不该按框架写死规则。
 *
 * 插入一个 `<base href="/canvas/">` 之后，**相对 URL 与绝对 URL 都会以它为基准解析**，
 * 于是所有请求自然带上前缀回到代理，再被转发到真实服务器。这样：
 *
 * - 不需要改用户的构建配置（vibedit 要 patch next.config.mjs，那一步就把非 React 栈排除了）；
 * - 不需要按框架写 URL 重写规则；
 * - 页面内的 fetch/XHR 相对路径同样受益。
 *
 * 代价与已知限制写在 README 的「兼容性」一节里（跨域绝对 URL 不受影响，那本来也不该代理）。
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENDPOINTS, endpointPath, normalizePrefix } from "./util.js";

/** 逐跳头：按 RFC 7230 不应被代理转发。 */
const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade"
]);

/**
 * 覆盖层脚本的白名单：请求名 → overlay 目录下的真实文件名。
 *
 * 磁盘上的命名与请求名**完全一致**，别名表只是白名单（不拼接路径，杜绝穿越）：
 * - `overlay.js`：入口，宿主注入的就是它
 * - `core.js`：覆盖层主体实现（入口 `import { mount } from "./core.js"`）
 * - `editor.js`：样式面板
 *
 * 早先版本让入口叫 `index.js`、而 `overlay.js` 指实现，结果入口里的
 * `import "./overlay.js"` 会指回入口自己（循环）。改成同名一致就没有这个歧义。
 */
export const OVERLAY_ALIASES = new Map([
	["overlay.js", "overlay.js"],
	["core.js", "core.js"],
	["editor.js", "editor.js"]
]);

/** 会被注入脚本的响应类型。 */
const HTML_TYPE = /text\/html/i;
/** 需要改写 url() 的响应类型。 */
const CSS_TYPE = /^text\/css\s*(?:;|$)/i;

/**
 * 生成注入到页面 <head> 的引导脚本。
 *
 * 四件事：
 * 1. 用 `<base>` 兜底（若响应里没被插入成功，这里也能生效）；
 * 2. 把绝对路径引用改写到代理前缀下（HTML 层已改写，这里管 JS 动态发起的）；
 * 3. **改写 WebSocket 构造**：把 HMR 之类的绝对路径连接重定向到代理前缀，
 *    这样 Vite 的 HMR 也能穿过代理工作，而不需要用户改 vite.config；
 * 4. **显式声明插件的 WebSocket 地址与前缀**（`__DSH_CANVAS_WS__` / `__DSH_CANVAS_PREFIX__`）。
 *
 * 第 4 条是必需的：覆盖层原先靠 `location.pathname` 往上推一层来猜 WS 地址，
 * 那只在页面正好位于 `<prefix>/xxx` 时成立。画板里的页面路径是
 * `<prefix>/__frame__/login`，推导出来会变成 `<prefix>/__frame__/__canvas__/ws`——错的。
 * 与其让覆盖层猜，不如由宿主直接告诉它。
 *
 * @param prefix - 代理前缀（已归一化）。
 * @returns 内联脚本文本（不含 <script> 标签）。
 */
export function bootstrapScript(prefix) {
	const base = `${prefix}/`;
	const wsPath = `${prefix}/__hmr__`;
	const overlayWs = endpointPath(prefix, ENDPOINTS.ws);
	return `(() => {
  const BASE = ${JSON.stringify(base)};
  const WS_BASE = ${JSON.stringify(wsPath)};
  // 覆盖层按这两个全局量工作，不再自己猜路径。
  globalThis.__DSH_CANVAS_WS__ = ${JSON.stringify(overlayWs)};
  globalThis.__DSH_CANVAS_PREFIX__ = ${JSON.stringify(prefix)};

  if (!document.querySelector("base[data-canvas-base]")) {
    const tag = document.createElement("base");
    tag.setAttribute("data-canvas-base", "1");
    tag.href = BASE;
    document.head.prepend(tag);
  }

  // 把「绝对路径引用」改写到代理之下。
  //
  // 注意这里**不能只靠 base 元素**：以 / 开头的引用按 RFC 3986 只继承 base 的
  // scheme+authority，路径完全来自引用本身，所以 base 对它无效。
  // HTML 里的绝对路径由宿主在注入时改写；这里负责 JS 动态发起的那些。
  const rewrite = (value) => {
    try {
      if (typeof value !== "string" || value === "") return value;
      if (!value.startsWith("/") || value.startsWith("//")) return value;
      if (value === BASE.slice(0, -1) || value.startsWith(BASE)) return value;
      return BASE + value.slice(1);
    } catch {
      return value;
    }
  };

  // fetch
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function" && !nativeFetch.__canvasPatched) {
    const patchedFetch = function (input, init) {
      try {
        if (typeof input === "string") return nativeFetch(rewrite(input), init);
        if (input instanceof Request) {
          const next = rewrite(new URL(input.url, location.href).pathname);
          if (next !== new URL(input.url, location.href).pathname) {
            const url = new URL(input.url, location.href);
            url.pathname = next;
            return nativeFetch(new Request(url.href, input), init);
          }
        }
      } catch {
        // 落到原始调用
      }
      return nativeFetch(input, init);
    };
    patchedFetch.__canvasPatched = true;
    window.fetch = patchedFetch;
  }

  // XMLHttpRequest
  const nativeOpen = XMLHttpRequest.prototype.open;
  if (!nativeOpen.__canvasPatched) {
    const patchedOpen = function (method, url, ...rest) {
      let next = url;
      try {
        if (typeof url === "string") next = rewrite(url);
      } catch {
        // 原样
      }
      return nativeOpen.call(this, method, next, ...rest);
    };
    patchedOpen.__canvasPatched = true;
    XMLHttpRequest.prototype.open = patchedOpen;
  }

  // navigator.sendBeacon
  if (typeof navigator.sendBeacon === "function" && !navigator.sendBeacon.__canvasPatched) {
    const nativeBeacon = navigator.sendBeacon.bind(navigator);
    const patchedBeacon = (url, data) => nativeBeacon(rewrite(url), data);
    patchedBeacon.__canvasPatched = true;
    navigator.sendBeacon = patchedBeacon;
  }

  // EventSource
  const NativeES = window.EventSource;
  if (typeof NativeES === "function" && !NativeES.__canvasPatched) {
    const PatchedES = function (url, config) {
      return new NativeES(rewrite(url), config);
    };
    PatchedES.prototype = NativeES.prototype;
    PatchedES.__canvasPatched = true;
    window.EventSource = PatchedES;
  }

  // WebSocket：HMR 与自定义 socket 都走这里（路径要挂到 __hmr__ 之下再转发）。
  const NativeWS = window.WebSocket;
  if (NativeWS && !NativeWS.__canvasPatched) {
    const Patched = function (url, protocols) {
      try {
        const resolved = new URL(String(url), location.href);
        if (resolved.host === location.host && !resolved.pathname.startsWith(BASE)) {
          const suffix = resolved.pathname.replace(/^\\/+/, "");
          resolved.pathname = WS_BASE + "/" + suffix;
        }
        const socket = protocols === undefined ? new NativeWS(resolved.href) : new NativeWS(resolved.href, protocols);
        return socket;
      } catch {
        return protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
      }
    };
    Patched.prototype = NativeWS.prototype;
    for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Patched[key] = NativeWS[key];
    Patched.__canvasPatched = true;
    window.WebSocket = Patched;
  }
})();`;
}

/**
 * 把一个绝对路径引用改写到代理前缀之下。
 *
 * ## 为什么必须有这个函数（设计教训）
 *
 * 我最初以为注入 `<base href="/canvas/">` 就能让页面里的 `/styles.css` 自动走代理。
 * **这是错的**：按 RFC 3986，以单个 `/` 开头的引用是「绝对路径引用」，
 * 只继承 base 的 scheme + authority，**路径完全来自引用本身**。
 * 所以 `<base>` 只对 relative 引用（`./a.js`、`a.css`）有效，
 * 对 `/styles.css`、`/src/main.tsx` 这类**完全无效**。
 *
 * 实测症状：页面里的 `/styles.css` 与 `/assets/app.js` 全 404，
 * 页面既没样式也没交互，只有我们注入的覆盖层（那个 URL 本来就带了前缀）能加载。
 *
 * 结论：反向代理必须**改写 HTML 与 CSS 里的绝对路径**（nginx 的 `sub_filter` 同理）。
 *
 * @param url - 原始 URL 引用。
 * @param prefix - 归一化后的前缀（如 "/canvas"）。
 * @returns 改写后的引用。
 */
export function rewriteUrl(url, prefix) {
	const base = normalizePrefix(prefix);
	if (typeof url !== "string" || url === "") return url;
	// 已经在前缀之下：不重复加。
	if (url === base || url.startsWith(`${base}/`)) return url;
	// 只处理绝对路径引用：以单个斜杠开头（`//host/x` 是协议相对，交给原样）。
	if (!url.startsWith("/") || url.startsWith("//")) return url;
	// 跳过各类带 scheme 的（data:、blob:、mailto: 等不以 / 开头，上面已排除）。
	return `${base}${url}`;
}

/** HTML 里值是 URL 的属性（大小写不敏感匹配）。 */
const URL_ATTRIBUTES = "src|href|poster|action|formaction|data-src|data-href|manifest|cite|background|longdesc";
/** 一个属性并取其值（保留引号风格）。 */
const URL_ATTRIBUTE_PATTERN = new RegExp(
	`(\\s(?:${URL_ATTRIBUTES})\\s*=\\s*)(?:"([^"]*)"|'([^']*)')`,
	"giu"
);
/** CSS 里的 url(...) 与 @import。 */
const CSS_URL_PATTERN = /url\(\s*(['"]?)(\/(?!\/)[^'")]*)\1\s*\)/giu;
const CSS_IMPORT_PATTERN = /(@import\s+)(['"])(\/(?!\/)[^'"]*)\2/giu;

/**
 * 改写 CSS 里的绝对路径：`url(/x.png)` 与 `@import "/x.css"`。
 *
 * 为什么 CSS 也要改：CSS 里的 `url(/img.png)` 同样按 origin 解析，
 * 不改就会 404（背景图、字体全丢）。
 *
 * @param css - CSS 文本。
 * @param prefix - 代理前缀。
 * @returns 改写后的 CSS。
 */
export function rewriteCssUrls(css, prefix) {
	return css
		.replace(CSS_URL_PATTERN, (whole, quote, path) => `url(${quote}${rewriteUrl(path, prefix)}${quote})`)
		.replace(CSS_IMPORT_PATTERN, (whole, head, quote, path) => `${head}${quote}${rewriteUrl(path, prefix)}${quote}`);
}

/**
 * 改写 HTML 里所有绝对路径引用（属性、srcset、内联 style、<style> 块）。
 *
 * @param html - HTML 文本。
 * @param prefix - 代理前缀。
 * @returns 改写后的 HTML。
 */
export function rewriteHtmlUrls(html, prefix) {
	let out = html.replace(URL_ATTRIBUTE_PATTERN, (whole, head, doubleQuoted, singleQuoted) => {
		const value = doubleQuoted ?? singleQuoted;
		const quote = doubleQuoted === undefined ? "'" : '"';
		return `${head}${quote}${rewriteUrl(value, prefix)}${quote}`;
	});

	// srcset：逗号分隔的「URL 描述符」列表，每个候选单独改写。
	out = out.replace(/(\ssrcset\s*=\s*)(?:"([^"]*)"|'([^']*)')/giu, (whole, head, doubleQuoted, singleQuoted) => {
		const value = doubleQuoted ?? singleQuoted;
		const quote = doubleQuoted === undefined ? "'" : '"';
		const next = value.split(",").map((candidate) => {
			const trimmed = candidate.trim();
			if (trimmed === "") return candidate;
			const space = trimmed.search(/\s/u);
			const url = space < 0 ? trimmed : trimmed.slice(0, space);
			const descriptor = space < 0 ? "" : trimmed.slice(space);
			return `${rewriteUrl(url, prefix)}${descriptor}`;
		}).join(", ");
		return `${head}${quote}${next}${quote}`;
	});

	// <style> 块与 style="..." 内联样式里的 url()
	out = out.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/giu, (whole, open, body, close) => `${open}${rewriteCssUrls(body, prefix)}${close}`);
	out = out.replace(/(\sstyle\s*=\s*)(?:"([^"]*)"|'([^']*)')/giu, (whole, head, doubleQuoted, singleQuoted) => {
		const value = doubleQuoted ?? singleQuoted;
		const quote = doubleQuoted === undefined ? "'" : '"';
		return `${head}${quote}${rewriteCssUrls(value, prefix)}${quote}`;
	});

	// <meta http-equiv="refresh" content="0;url=/foo">
	out = out.replace(/(<meta[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*)(?:"([^"]*)"|'([^']*)')/giu, (whole, head, doubleQuoted, singleQuoted) => {
		const value = doubleQuoted ?? singleQuoted;
		const quote = doubleQuoted === undefined ? "'" : '"';
		const next = value.replace(/(url\s*=\s*)(\/[^\s;]*)/iu, (inner, key, path) => `${key}${rewriteUrl(path, prefix)}`);
		return `${head}${quote}${next}${quote}`;
	});

	return out;
}

/**
 * 在 HTML 里注入 <base>、路径改写、请求拦截与覆盖层脚本。
 *
 * 四件事缺一不可：
 * 1. **改写绝对路径**（真正解决问题的那一步）
 * 2. `<base>`：让 relative 引用（`./a.js`）也落在前缀之下
 * 3. 引导脚本：拦截 JS 动态发起的请求（fetch / XHR / WebSocket / sendBeacon）
 * 4. 覆盖层脚本本体（**只在编辑模式下注入**）
 *
 * ## 为什么要区分模式
 *
 * 画布里的每块画板是一个 iframe。如果每块画板都注入编辑器覆盖层，
 * 一个画布上就会冒出 N 个浮动面板，而且它们各连一条 WebSocket、各自维护选中态
 * ——完全不是想要的效果。所以：
 *
 * - `mode: "edit"`：单页编辑模式，注入覆盖层（现有行为）
 * - `mode: "frame"`：画板模式，**不注入覆盖层**，只保留 `<base>`／路径改写／引导脚本
 *   （路径改写照样必需，否则画板里的页面同样会 404）
 *
 * @param html - 原始 HTML 文本。
 * @param options - { prefix, overlayUrl, enabled, mode }。
 * @returns 注入后的 HTML。
 */
export function injectIntoHtml(html, options) {
	const prefix = normalizePrefix(options.prefix);
	const overlayUrl = options.overlayUrl ?? endpointPath(prefix, ENDPOINTS.overlay);
	const mode = options.mode === "frame" ? "frame" : "edit";
	const enabled = options.enabled !== false && mode === "edit";
	const baseTag = `<base data-canvas-base href="${prefix}/">`;
	const boot = `<script>${bootstrapScript(prefix)}</script>`;
	// 覆盖层是 **ES 模块**（入口里有 `import { mount } from "./core.js"`），
	// 所以必须带 `type="module"`。少了它浏览器会抛
	//   Uncaught SyntaxError: Cannot use import statement outside a module
	// ——这个错只在真浏览器里才暴露，离线测试看不出来（踩过一次）。
	const overlay = enabled
		? `<script type="module" src="${overlayUrl}" data-canvas-overlay></script>`
		: "";
	const block = `${baseTag}${boot}${overlay}`;

	// 先改写页面自身的绝对路径，再注入。
	const rewritten = rewriteHtmlUrls(html, prefix);

	// 插到 <head> 之后（保留原有的 charset / viewport 顺序语义）。
	const headOpen = /<head[^>]*>/iu.exec(rewritten);
	if (headOpen !== null) {
		const at = headOpen.index + headOpen[0].length;
		return `${rewritten.slice(0, at)}${block}${rewritten.slice(at)}`;
	}
	// 没有 <head>：退而插到 <html> 之后，再不行就前置。
	const htmlOpen = /<html[^>]*>/iu.exec(rewritten);
	if (htmlOpen !== null) {
		const at = htmlOpen.index + htmlOpen[0].length;
		return `${rewritten.slice(0, at)}${block}${rewritten.slice(at)}`;
	}
	return block + rewritten;
}

/**
 * 按代理前缀剥掉前缀，得到转发给目标服务器的路径。
 * @param rawUrl - 原始 req.url（含查询串）。
 * @param prefix - 代理前缀。
 * @returns { path, suffix } 目标路径与剥掉前缀后的路径。
 */
export function stripPrefix(rawUrl, prefix) {
	const normalized = normalizePrefix(prefix);
	const url = new URL(rawUrl ?? "/", "http://proxy.local");
	let pathname = url.pathname;
	if (pathname === normalized) pathname = "/";
	else if (pathname.startsWith(`${normalized}/`)) pathname = pathname.slice(normalized.length);
	else pathname = "/";
	return { path: `${pathname}${url.search}`, suffix: pathname };
}

/**
 * 构造转发用的请求头。
 * @param headers - 原始请求头。
 * @param target - 目标 URL 对象。
 * @returns 过滤后的头。
 */
export function forwardHeaders(headers, target) {
	const out = {};
	for (const [key, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		const lower = key.toLowerCase();
		if (HOP_BY_HOP.has(lower)) continue;
		// Host 必须换为目标主机，否则 Vite 会以为自己在错误的 origin 上。
		if (lower === "host") continue;
		// 不转发压缩协商：我们可能改写响应体，压缩会让注入无从下手。
		if (lower === "accept-encoding") continue;
		out[key] = value;
	}
	out.host = target.host;
	out["accept-encoding"] = "identity";
	return out;
}

/**
 * 算出发给上游的路径，以及这次请求的注入模式。
 *
 * 画板里的页面走 `<prefix>/__frame__/<应用内路径>`，所以前缀要**剥两层**
 * （先剥 `<prefix>`，再剥 `/__frame__`），剩下的才是上游真实路径。
 * 这一步只做一次，`handleProxy` 与 `sendUpstream` 共用同一个结果，
 * 保证「转发到哪」与「按什么模式注入」永远一致。
 *
 * @param rawUrl - req.url（含查询串）。
 * @param prefix - 代理前缀。
 * @returns { path, mode }：上游路径与注入模式（"edit" | "frame"）。
 */
export function resolveUpstream(rawUrl, prefix) {
	const stripped = stripPrefix(rawUrl, prefix);
	const frameBase = "/__frame__";
	if (stripped.suffix === frameBase || stripped.suffix.startsWith(`${frameBase}/`)) {
		const rest = stripped.suffix.slice(frameBase.length);
		const search = stripped.path.slice(stripped.suffix.length);
		return { path: `${rest === "" ? "/" : rest}${search}`, mode: "frame" };
	}
	return { path: stripped.path, mode: "edit" };
}

/**
 * 发起转发请求。
 * @param target - 目标 dev server 的 URL。
 * @param req - 入站请求。
 * @param options - { prefix, timeoutMs, upstreamPath }。
 * @returns 上游响应或抛错。
 */
function sendUpstream(target, req, options) {
	const isHttps = target.protocol === "https:";
	const send = isHttps ? httpsRequest : httpRequest;
	const path = options.upstreamPath ?? stripPrefix(req.url, options.prefix).path;
	const headers = forwardHeaders(req.headers, target);
	return new Promise((resolvePromise, rejectPromise) => {
		const upstream = send({
			protocol: target.protocol,
			hostname: target.hostname,
			port: target.port === "" ? (isHttps ? 443 : 80) : target.port,
			method: req.method,
			path,
			headers,
			timeout: options.timeoutMs ?? 30_000
		}, (response) => resolvePromise(response));
		upstream.on("timeout", () => {
			upstream.destroy(new Error(`上游超时（${options.timeoutMs ?? 30_000}ms）`));
		});
		upstream.on("error", (error) => rejectPromise(error));
		// 请求体直接透传（含大文件上传）。
		req.pipe(upstream);
	});
}

/**
 * 处理一次代理请求。
 *
 * @param req - 入站 Node 请求。
 * @param res - 出站 Node 响应。
 * @param context - { target, prefix, enabled, logger, overlayDir }。
 */
export async function handleProxy(req, res, context) {
	// 上游路径与注入模式都基于 `rawUrl` 计算：调用方可能已经把 `__edit__`
	// 之类的内部分段剥掉了（见 handler.js），这里不再自己看 req.url。
	const rawUrl = context.rawUrl ?? req.url;

	// 覆盖层脚本由宿主自己应答，不走上游。这条判断与路由层共用同一个纯函数，
	// 任何一边改了规则另一边自动跟上（e2e 测的就是这条真实路径）。
	const own = resolveOwnRequest(rawUrl, context.prefix, context.overlayDir, context.status);
	if (own !== null) {
		res.writeHead(own.status, own.headers);
		res.end(own.body);
		return;
	}

	let target;
	try {
		target = new URL(context.target);
	} catch {
		res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
		res.end(`visual-canvas: 目标地址不合法：${context.target}`);
		return;
	}

	// 先算出上游路径与注入模式，两者一起决定后面的行为。
	const route = resolveUpstream(rawUrl, context.prefix);

	let upstream;
	try {
		upstream = await sendUpstream(target, req, { ...context, upstreamPath: route.path });
	} catch (error) {
		const message = String(error?.message ?? error);
		context.logger?.warn?.(`[visual-canvas] 代理失败: ${message}`);
		res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
		res.end([
			`visual-canvas: 连不上目标 dev server（${context.target}）。`,
			"",
			`原因：${message}`,
			"",
			"检查：1) 前端项目是否在跑；2) 端口是否与插件配置的 target 一致；3) 是否绑在 127.0.0.1 上。"
		].join("\n"));
		return;
	}

	const contentType = String(upstream.headers["content-type"] ?? "");
	const outHeaders = {};
	for (const [key, value] of Object.entries(upstream.headers)) {
		if (value === undefined) continue;
		if (HOP_BY_HOP.has(key.toLowerCase())) continue;
		outHeaders[key] = value;
	}
	// 我们可能改写响应体：去掉长度与压缩相关头，让 Node 用 chunked 发。
	delete outHeaders["content-length"];
	delete outHeaders["content-encoding"];

	if (HTML_TYPE.test(contentType)) {
		const chunks = [];
		for await (const chunk of upstream) chunks.push(chunk);
		const html = Buffer.concat(chunks).toString("utf8");
		const next = injectIntoHtml(html, {
			prefix: context.prefix,
			enabled: context.enabled !== false,
			mode: route.mode
		});
		const body = Buffer.from(next, "utf8");
		outHeaders["content-length"] = String(body.length);
		res.writeHead(upstream.statusCode ?? 200, outHeaders);
		res.end(body);
		return;
	}

	// CSS 也要改写：`url(/img.png)` 同样按 origin 解析，不改就会 404（背景图、字体全丢）。
	// 只处理 text/css（不是 text/css 的样式变体就跳过，避免误改）。
	if (CSS_TYPE.test(contentType)) {
		const chunks = [];
		for await (const chunk of upstream) chunks.push(chunk);
		const css = Buffer.concat(chunks).toString("utf8");
		const body = Buffer.from(rewriteCssUrls(css, context.prefix), "utf8");
		outHeaders["content-length"] = String(body.length);
		res.writeHead(upstream.statusCode ?? 200, outHeaders);
		res.end(body);
		return;
	}

	// 其它：原样流式转发，不做缓冲（JS 模块、图片、SSE 都走这条路）。
	res.writeHead(upstream.statusCode ?? 200, outHeaders);
	upstream.pipe(res);
}

/**
 * 判断这个请求是否该由插件自己应答（覆盖层脚本），是则给出完整响应。
 *
 * 抽成纯函数的原因：路由层与代理层都要用它，而 e2e 测试要在没有 DSH 的情况下
 * 验证同一条判断——三处共用一份实现，规则不会漂移。
 *
 * @param rawUrl - req.url。
 * @param prefix - 代理前缀。
 * @param overlayDir - overlay 源码目录（绝对路径）；不传则只认入口。
 * @param statusProvider - 可选；提供 `/__canvas__/status` 的 JSON 载荷。
 *   放在这里是因为「状态接口」也是插件自己应答的请求，两个入口（DSH 端口与独立端口）
 *   因此自动都有，不必各写一遍。
 * @returns { status, headers, body } 或 null（表示该转发给上游）。
 */
export function resolveOwnRequest(rawUrl, prefix, overlayDir, statusProvider) {
	const pathname = new URL(rawUrl ?? "/", "http://proxy.local").pathname;
	const overlayBase = endpointPath(prefix, "__canvas__");
	if (!pathname.startsWith(`${overlayBase}/`)) return null;
	const name = pathname.slice(overlayBase.length + 1);

	if (name === "status") {
		const payload = typeof statusProvider === "function" ? statusProvider() : { ok: true };
		return {
			status: 200,
			headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
			body: JSON.stringify(payload)
		};
	}

	// 入口与共享模块都在白名单里；目录可用时真读文件。
	const real = OVERLAY_ALIASES.get(name);
	if (real === undefined) {
		return {
			status: 404,
			headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
			body: JSON.stringify({ error: `未知的覆盖层文件: ${name}` })
		};
	}
	if (typeof overlayDir === "string" && overlayDir !== "") {
		try {
			const source = readFileSync(join(overlayDir, real), "utf8");
			return {
				status: 200,
				headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" },
				body: source
			};
		} catch (error) {
			return {
				status: 500,
				headers: { "content-type": "text/plain; charset=utf-8" },
				body: `读取覆盖层文件失败（${real}）：${String(error?.message ?? error)}`
			};
		}
	}
	return {
		status: 200,
		headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" },
		body: `/* visual-canvas: 覆盖层源码目录不可用，请检查插件安装 */\nthrow new Error("visual-canvas overlay unavailable");\n`
	};
}

/**
 * 转发 WebSocket 升级（HMR 等）。
 *
 * @param req - 入站请求。
 * @param socket - 已建立的客户端 socket。
 * @param head - 升级时已读到的首段数据。
 * @param context - { target, prefix, logger }。
 */
export function handleUpgrade(req, socket, head, context) {
	let target;
	try {
		target = new URL(context.target);
	} catch {
		socket.destroy();
		return;
	}
	const isHttps = target.protocol === "https:";
	const { path } = stripPrefix(req.url, context.prefix);
	const headers = forwardHeaders(req.headers, target);
	// 升级请求必须保留这些头。
	headers.connection = "Upgrade";
	headers.upgrade = req.headers.upgrade ?? "websocket";

	const upstream = (isHttps ? httpsRequest : httpRequest)({
		protocol: target.protocol,
		hostname: target.hostname,
		port: target.port === "" ? (isHttps ? 443 : 80) : target.port,
		method: "GET",
		path,
		headers
	});

	upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
		const lines = [`HTTP/1.1 ${upstreamRes.statusCode ?? 101} ${upstreamRes.statusMessage ?? "Switching Protocols"}`];
		for (const [key, value] of Object.entries(upstreamRes.headers)) {
			if (value === undefined) continue;
			if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`);
			else lines.push(`${key}: ${value}`);
		}
		socket.write(`${lines.join("\r\n")}\r\n\r\n`);
		if (upstreamHead.length > 0) socket.write(upstreamHead);
		if (head.length > 0) upstreamSocket.write(head);
		upstreamSocket.pipe(socket);
		socket.pipe(upstreamSocket);
		const closeBoth = () => {
			socket.destroy();
			upstreamSocket.destroy();
		};
		socket.on("error", closeBoth);
		upstreamSocket.on("error", closeBoth);
		socket.on("close", closeBoth);
		upstreamSocket.on("close", closeBoth);
	});

	upstream.on("response", (upstreamRes) => {
		// 上游拒绝升级：把状态码带回去，别假装成功。
		const lines = [`HTTP/1.1 ${upstreamRes.statusCode ?? 502} ${upstreamRes.statusMessage ?? "Bad Gateway"}`];
		for (const [key, value] of Object.entries(upstreamRes.headers)) {
			if (value === undefined) continue;
			if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`);
			else lines.push(`${key}: ${value}`);
		}
		socket.write(`${lines.join("\r\n")}\r\n\r\n`);
		socket.destroy();
	});

	upstream.on("error", (error) => {
		context.logger?.warn?.(`[visual-canvas] 升级转发失败: ${String(error?.message ?? error)}`);
		socket.destroy();
	});

	upstream.end();
}
