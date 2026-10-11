/**
 * 模块桥：让 node 也能解析 `edit.js` / `shell.js` 里的 `./editor.js`。
 *
 * 与 `canvas/core.js` 同一个原因、同一套约束——
 * 真实实现是 `lib/overlay/editor.js`，浏览器走 `overlayDir` 取它，
 * node 靠这里转发。两边同一份代码。
 *
 * ⚠️ **不要**把 `editor.js` 加进 `handler.js` 的 `SHELL_FILES`：
 * 浏览器会改拿这个转发文件，里面的 `../overlay/editor.js` 会 404。
 *
 * @module canvas/editor-bridge
 */
export * from "../overlay/editor.js";
