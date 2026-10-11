/**
 * 模块桥：让 node 也能解析 `edit.js` 里的 `./core.js`。
 *
 * ## 为什么会有这个文件
 *
 * `lib/canvas/edit.js` 写的是 `import ... from "./core.js"`，
 * 而 `core.js` 的**真实位置是 `lib/overlay/core.js`**。
 *
 * 浏览器里这是通的：外壳文件和覆盖层文件被宿主**平铺在同一个 URL 命名空间**下
 * （`/canvas/__canvas__/core.js` 由 `overlayDir` 应答），所以 `./core.js` 能取到。
 * 但 node 的解析是**文件系统级**的，`lib/canvas/core.js` 不存在就直接
 * `ERR_MODULE_NOT_FOUND`——于是所有想 import `edit.js` 的离线测试都跑不起来。
 *
 * ## 这不是实现副本
 *
 * 它只做转发，**唯一实现仍然是 `overlay/core.js`**：
 * - 浏览器：`SHELL_FILES` 里没有 `core.js` → 走 `overlayDir` → 直接拿 `overlay/core.js`
 * - node：解析到这个文件 → 转发到 `overlay/core.js`
 *
 * 两边拿到的是同一份代码，不存在"改了一处忘了另一处"。
 *
 * ## ⚠️ 不要把 core.js 加进 handler.js 的 SHELL_FILES
 *
 * 加了之后浏览器会拿到**这个转发文件**，而它里面的 `../overlay/core.js`
 * 会被解析成 `/canvas/overlay/core.js` —— 那是个 404。浏览器这条路现在就是通的，
 * 不要动它。
 *
 * @module canvas/core-bridge
 */
export * from "../overlay/core.js";
