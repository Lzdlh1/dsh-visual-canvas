/**
 * 独立端口的画布服务。
 *
 * ## 为什么必须有它（设计与 DSH 约束的碰撞）
 *
 * 插件最初只挂在 DSH 自己的 Web 服务器上（`ctx.webServer.register`），
 * 好处是不额外开端口、天然继承回环信任链。但 **DSH 侧边栏的嵌入浏览器拒绝
 * 打开与 DSH 应用自身同源的地址**：
 *
 * ```js
 * // dsh-client-ui-sidebar-browser：parseBrowserAddress(input, applicationOrigin)
 * if (url.origin === new URL(applicationOrigin).origin) {
 *   return { ok: false, reason: "application-origin" };  // 「不能在嵌入浏览器中打开 DSH 应用自身。」
 * }
 * ```
 *
 * 而 DSH 的界面就跑在 `http://127.0.0.1:19387`，画布挂在同一个 origin 的 `<prefix>` 下
 * ——于是侧边栏里**永远**是白屏（实测：面板能打开 `127.0.0.1:5173`，打不开 `127.0.0.1:19387/canvas/`）。
 *
 * 同源判定包含端口，所以**换一个端口就是换一个 origin**，面板就肯打开了。
 *
 * ## 这个文件刻意保持很薄
 *
 * 所有处理逻辑都在 `lib/handler.js`（两个入口共用）。这里只做一件事：
 * 起一个只在回环上监听的 HTTP 服务器，把请求与升级原样交给 handler。
 * 早先这里自己实现过一份处理逻辑，结果与 DSH 路由那份开始漂移
 * （独立端口少了状态接口就是一次真实疏漏）——所以现在不允许它再长逻辑。
 */

import { createServer } from "node:http";

/**
 * 启动独立端口的画布服务。
 *
 * @param options - {
 *   port: 端口（0 表示让系统分配）,
 *   host: 绑定地址（默认 127.0.0.1）,
 *   handlers: { handleRequest, handleUpgradeRequest }
 * }。
 * @returns Promise<{ url, port, host, close }>。
 */
export function startStandaloneServer(options) {
	const host = options.host ?? "127.0.0.1";
	if (options.handlers === undefined) throw new Error("startStandaloneServer 需要 handlers（见 lib/handler.js）");

	const server = createServer((req, res) => {
		Promise.resolve(options.handlers.handleRequest(req, res)).catch((error) => {
			// handler 内部已经处理了大部分错误；这里兜住漏网的，避免整个服务挂掉。
			if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
			res.end(`visual-canvas: 处理请求失败：${String(error?.message ?? error)}`);
		});
	});

	server.on("upgrade", (req, socket, head) => {
		try {
			options.handlers.handleUpgradeRequest(req, socket, head);
		} catch {
			socket.destroy();
		}
	});

	return new Promise((resolvePromise, rejectPromise) => {
		server.once("error", rejectPromise);
		server.listen(options.port ?? 0, host, () => {
			server.off("error", rejectPromise);
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : options.port;
			resolvePromise({
				port,
				host,
				url: `http://${host}:${port}${options.urlPath ?? ""}`,
				/**
				 * 关闭服务。
				 * @returns Promise。
				 */
				close: () => new Promise((done) => {
					server.close(() => done());
					// 已经建立的 keep-alive 连接会拖住 close，主动断开。
					server.closeAllConnections?.();
				})
			});
		});
	});
}
