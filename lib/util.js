/**
 * 通用小工具：路径安全、JSON 读写、回环守卫、安全调用。
 *
 * 这些函数是纯的或只碰 Node 内置模块，宿主与测试都能直接用。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** 稳定插件名。 */
export const name = "dsh-visual-canvas";

/** 挂载前必须就绪的宿主服务。 */
export const inject = ["webServer", "tools"];

/** 默认代理前缀。 */
export const DEFAULT_PREFIX = "/canvas";

/** 覆盖层与协议用的固定端点（挂在 prefix 之下）。 */
export const ENDPOINTS = {
	overlay: "__canvas__/overlay.js",
	ws: "__canvas__/ws"
};

/**
 * 路径是否在根之内（含根自身）。
 * @param root - 根目录绝对路径。
 * @param target - 待检查路径。
 * @returns 是否在内。
 */
export function isInside(root, target) {
	const base = resolve(root);
	const child = resolve(target);
	if (base === child) return true;
	const rel = relative(base, child);
	return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/**
 * 在根内拼路径，越界即抛错。
 * @param root - 根目录。
 * @param segments - 相对片段。
 * @returns 绝对路径。
 */
export function safeJoin(root, ...segments) {
	const target = join(root, ...segments);
	if (!isInside(root, target)) throw new Error(`路径越界: ${target}`);
	return target;
}

/**
 * 安全执行，出错返回兜底值。
 * @param fn - 待执行函数。
 * @param fallback - 出错时的返回值。
 * @returns 结果或兜底值。
 */
export function safe(fn, fallback) {
	try {
		return fn();
	} catch {
		return fallback;
	}
}

/**
 * 读文本文件；不存在或读不到返回 null。
 * @param path - 文件路径。
 * @returns 文本或 null。
 */
export function readText(path) {
	try {
		if (!existsSync(path)) return null;
		if (!statSync(path).isFile()) return null;
		const text = readFileSync(path, "utf8");
		// 去掉 BOM：它会让 frontmatter / 正则匹配失手。
		return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	} catch {
		return null;
	}
}

/**
 * 写 JSON 响应。
 * @param res - Node 响应对象。
 * @param status - HTTP 状态码。
 * @param payload - 可序列化的载荷。
 */
export function writeJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store"
	});
	res.end(body);
}

/**
 * 读请求体（带大小上限）。
 * @param req - Node 请求对象。
 * @param limit - 字节上限。
 * @returns {{ value?: any, error?: string }} 解析结果。
 */
export function readJsonBody(req, limit = 2 * 1024 * 1024) {
	return new Promise((resolvePromise) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				resolvePromise({ error: `请求体超过 ${limit} 字节` });
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8");
			if (text.trim() === "") {
				resolvePromise({ value: {} });
				return;
			}
			try {
				resolvePromise({ value: JSON.parse(text) });
			} catch (error) {
				resolvePromise({ error: `JSON 解析失败: ${error?.message ?? error}` });
			}
		});
		req.on("error", (error) => resolvePromise({ error: String(error?.message ?? error) }));
	});
}

/**
 * 请求是否来自本机回环（防 DNS 重绑定 / 防跨站窃取）。
 *
 * ## 四道判定
 *
 * 1. **来源地址**必须是回环（远程攻击者连不上）
 * 2. **Host 头**必须指向回环（防 DNS 重绑定：攻击者域名解析到 127.0.0.1 时 Host 是攻击者域名）
 * 3. **Origin**（若存在）必须与 Host 同源（挡掉远程页面直连 WebSocket / fetch）
 * 4. **跨站请求**：只放行「导航」与「WebSocket 握手」，挡掉 `cors` / `no-cors` 的子资源读取
 *
 * ## 第 4 条为什么这么定（DSH 侧边栏浏览器的实际情况）
 *
 * 桌面版的 DSH 外壳跑在 `dsh-app://app` 下，侧边栏浏览器是它里面的一个 `<iframe>`
 * （`webviewTag: false`，所以只能用 iframe）。从 `dsh-app://` 加载
 * `http://127.0.0.1:<port>/…` 在浏览器看来就是 **cross-site**——
 * 早先「一律拒绝 cross-site」的写法会把侧边栏面板整个 403 成白屏（踩过一次）。
 *
 * 放宽到「导航 + WebSocket」是安全的，理由：
 * - **导航**：iframe 里的响应内容对父页面是**跨源不可读**的（拿不到 DOM、拿不到文本），
 *   所以恶意站点最多是把页面「显示」出来，无法窃取；
 * - **WebSocket**：真正的防线是第 3 条 Origin 校验——远程页面的握手会带自己的 Origin，
 *   与 Host 不符直接拒绝；而代理页面自身发起的握手是同源的；
 * - **cors / no-cors 子资源**：这是唯一能「读到内容」的路径，保持拒绝。
 *
 * 另外代理**不返回任何 CORS 响应头**，跨源 `fetch` 即便发出也读不到响应体，
 * 这是同一方向的第二层保险。
 *
 * @param req - Node 请求对象。
 * @returns 是否放行。
 */
export function loopbackOnly(req) {
	const address = String(req.socket?.remoteAddress ?? "").toLowerCase();
	const fromAddress = address === "127.0.0.1" || address === "::1" || address.startsWith("::ffff:127.");
	if (!fromAddress) return false;

	const host = req.headers?.host;
	if (typeof host !== "string" || host === "") return false;
	let hostName;
	try {
		hostName = new URL(`http://${host}`).hostname.toLowerCase();
	} catch {
		return false;
	}
	const hostIsLoopback = hostName === "localhost" || hostName === "::1" || hostName === "[::1]"
		|| /^127(?:\.\d{1,3}){3}$/u.test(hostName);
	if (!hostIsLoopback) return false;

	// Origin 必须与 Host 同源（挡远程页面直连 WebSocket / fetch）。
	const origin = req.headers.origin;
	if (typeof origin === "string" && origin !== "") {
		try {
			if (new URL(origin).host.toLowerCase() !== host.toLowerCase()) return false;
		} catch {
			return false;
		}
	}

	// 跨站：只允许「导航」与「WebSocket 握手」，其余（cors / no-cors 子资源）拒绝。
	if (req.headers["sec-fetch-site"] === "cross-site") {
		const mode = String(req.headers["sec-fetch-mode"] ?? "").toLowerCase();
		const dest = String(req.headers["sec-fetch-dest"] ?? "").toLowerCase();
		const isNavigation = mode === "navigate" || dest === "document" || dest === "iframe" || dest === "frame";
		const isWebSocket = mode === "websocket" || dest === "websocket";
		if (!isNavigation && !isWebSocket) return false;
	}
	return true;
}

/**
 * 归一化 URL 前缀：保证以 / 开头、不以 / 结尾。
 * @param value - 原始前缀。
 * @returns 归一化前缀。
 */
export function normalizePrefix(value) {
	const text = String(value ?? "").trim();
	if (text === "" || text === "/") return DEFAULT_PREFIX;
	const withLead = text.startsWith("/") ? text : `/${text}`;
	return withLead.endsWith("/") ? withLead.slice(0, -1) : withLead;
}

/**
 * 拼出某个端点的完整路径。
 * @param prefix - 代理前缀。
 * @param endpoint - 端点后缀。
 * @returns 完整路径。
 */
export function endpointPath(prefix, endpoint) {
	return `${normalizePrefix(prefix)}/${endpoint}`;
}

/**
 * 取文件所在目录（不存在也返回规范化结果）。
 * @param path - 文件路径。
 * @returns 目录路径。
 */
export function dirOf(path) {
	return dirname(resolve(path));
}
