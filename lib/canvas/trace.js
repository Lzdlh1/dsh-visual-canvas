/**
 * trace id —— **浏览器与宿主都能用的纯函数**。
 *
 * ## 为什么要单独一个文件（2026-10-07 事故）
 *
 * `newTrace` 原先写在 `lib/log.js` 里。给外壳脚本 `lib/canvas/edit.js` 加上
 * `import { newTrace } from "../log.js"` 之后，**整个画布外壳直接崩了**：
 * 画板列表变空、"添加画板"点什么都没反应。
 *
 * 原因很简单：`log.js` 要落盘，所以 `import { appendFileSync } from "node:fs"` ——
 * 那是**宿主侧**模块。而 `edit.js` 跑在**浏览器**里，加载 `node:fs` 立刻失败，
 * 一个 import 失败就让整份外壳脚本不执行了（连画板列表都渲染不出来）。
 *
 * **教训**：给跨侧共用的代码加 import 之前，先问一句"这份文件在浏览器里跑吗"。
 * 生成 id 是纯计算，本来就不该和落盘逻辑待在一起。
 *
 * @module trace
 */

/**
 * 生成一个短 trace id。
 *
 * 一次用户操作（点选 → 拖动 → 写回）共用它，**跨进程也能对上**：
 * 外壳那边发消息时带上，宿主这边原样记进每条日志。
 *
 * 用时间戳 + 随机后缀：既能大致按时间排序，又不会撞。
 *
 * @returns 形如 `t3f2a91-7k2` 的字符串。
 */
export function newTrace() {
	const stamp = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 5);
	return `t${stamp}-${rand}`;
}
