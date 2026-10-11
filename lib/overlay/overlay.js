/**
 * 覆盖层的浏览器入口。
 *
 * 由宿主以 `<script type="module" src=".../overlay.js">` 注入。
 * WebSocket 地址优先取宿主注入的 `globalThis.__DSH_CANVAS_WS__`，
 * 退化时按当前页面路径推导（覆盖层与页面同源，所以直接换协议即可）。
 */

import { mount } from "./core.js";

/**
 * 推导 WebSocket 端点。
 * @returns WebSocket URL。
 */
function endpoint() {
	const injected = globalThis.__DSH_CANVAS_WS__;
	if (typeof injected === "string" && injected !== "") {
		// 注入值可能是相对路径（如 /canvas/__canvas__/ws），补上协议与主机。
		if (injected.startsWith("ws://") || injected.startsWith("wss://")) return injected;
		const scheme = location.protocol === "https:" ? "wss:" : "ws:";
		return `${scheme}//${location.host}${injected.startsWith("/") ? "" : "/"}${injected}`;
	}
	const scheme = location.protocol === "https:" ? "wss:" : "ws:";
	const base = location.pathname.replace(/\/[^/]*$/u, "");
	return `${scheme}//${location.host}${base}/__canvas__/ws`;
}

const instance = mount(endpoint());
globalThis.__DSH_CANVAS__ = instance;
