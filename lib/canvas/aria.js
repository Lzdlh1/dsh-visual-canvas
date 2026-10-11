/**
 * 语义标记 → **ARIA 正式属性**的映射。
 *
 * ## 为什么要有这个
 *
 * 工具原来的做法是往源码里写一堆自己的 `data-*`：
 * `data-role="functional"`、`data-interact="click"`、`data-effect="toast"`。
 *
 * 这些标记**只有我们自己的运行时看得懂**。用户拿去接到自己的应用里时：
 *
 * - 无障碍读屏软件**完全读不出**这是个按钮（它只认 `role="button"`）
 * - 用户换个框架就得读一遍我们的文档才知道 `data-effect="toast"` 是干嘛的
 * - 我们的标记格式一变，用户那边的样式就全废了
 *
 * 调研（shadcn/Radix、Material、Ark UI）里的结论是一致的：
 * **把 ARIA 属性当作设计工具和用户应用之间的正式接口**，
 * 输出 `role` / `aria-busy` / `aria-live` / `aria-invalid`，
 * 而不是发明 `class="is-loading"` 这种私有约定。
 *
 * 好处有三条：
 * 1. **无障碍默认就是对的**（这本来就是这些属性存在的理由）
 * 2. 用户用什么框架都能**顺着标准属性**写样式，不需要读我们的文档
 * 3. **我们的效果库不会随他的技术栈过时**
 *
 * ## 分两层，别混
 *
 * - `data-effect` 负责表达**意图**："我要一个 toast"
 * - ARIA 负责表达**当下状态**："它现在活着 / 正忙 / 出错了"
 *
 * 所以我们**两个都写**：`data-*` 给我们的画布和用户的自定义样式用，
 * ARIA 给读屏软件和用户的通用样式用。
 */

/**
 * 「作用」→ ARIA。
 *
 * `functional`（功能组件）是个能点的东西 → 按钮语义 + 可聚焦。
 * `background`（背景组件）是纯装饰 → `presentation`，
 * 让读屏软件**跳过它**（不然一大块背景会被念出来）。
 */
const ROLE_ARIA = {
	functional: { role: "button", tabindex: "0" },
	background: { role: "presentation" }
};

/**
 * 「交互方式」→ ARIA。
 *
 * ⚠️ **只有一部分交互有 ARIA 对应**：
 * - `click` / `focus` 有（能聚焦的东西）
 * - `hover` **没有** —— 悬停是纯视觉反馈，不是语义；
 *   而且触摸设备根本没有悬停（调研里 Apple HIG 明确说"不要假设用户能做出某个手势"）
 * - `swipe-*` / `drag` / `longpress` **没有对应的 ARIA role** ——
 *   这些手势的**可访问替代路径**要靠应用自己提供（WCAG 2.2 SC 2.5.7
 *   要求所有拖拽操作都能用单点操作完成），工具这边只能如实标注，不能假装有
 * - `scroll` → `region`（一块可滚动区域，读屏软件会把它当独立区块）
 */
const INTERACT_ARIA = {
	none: { role: "presentation", tabindex: null },
	click: { role: "button", tabindex: "0" },
	focus: { tabindex: "0" },
	scroll: { role: "region", tabindex: "0" },
	submit: {},
	doubleclick: {},
	rightclick: {},
	hover: {},
	longpress: {},
	"longpress-drag": {},
	drag: {},
	"swipe-left": {},
	"swipe-right": {},
	"swipe-up": {},
	"swipe-down": {},
	"edge-swipe": {},
	scrollintoview: {},
	"pull-to-refresh": {}
};

/**
 * 「效果」→ ARIA。
 *
 * 这一层是**最容易被忽略但最有价值**的：用户在画布上挂了个 `skeleton`，
 * 它的语义是"这块内容还没来"。读屏软件要能知道这件事，
 * 就得有 `aria-busy="true"` —— 而这个信息**只有设计阶段才有人知道**，
 * 运行时补不上（运行时只知道"数据没到"）。
 */
const EFFECT_ARIA = {
	// 加载中：告诉读屏软件"这块先别念，还没好"
	spin: { "aria-busy": "true" },
	skeleton: { "aria-busy": "true" },
	"skeleton-wave": { "aria-busy": "true" },
	"skeleton-to-content": { "aria-busy": "true" },
	"progress-fill": { "aria-busy": "true" },
	"progress-indeterminate": { "aria-busy": "true" },

	// 状态播报：`polite` = 等用户手头的事做完再念，`assertive` = 立刻打断
	toast: { role: "status", "aria-live": "polite" },
	"save-flash": { role: "status", "aria-live": "polite" },
	"inline-msg-in": { "aria-live": "polite" },
	"new-content-ring": { "aria-live": "polite" },
	"pulse-ring": { "aria-live": "polite" },
	"badge-bounce": { "aria-live": "polite" },
	alert: { role: "alert", "aria-live": "assertive" },

	// 校验失败：读屏软件会念"无效"
	"field-invalid": { "aria-invalid": "true" }
};

/**
 * 一个元素**当前**的语义（从它身上的 `data-*` 读出来）。
 *
 * @param read - 取属性的函数 `(name) => string | null`（一般是 `el.getAttribute`）。
 * @returns { role, interact, effect, action }。
 */
export function readSemantics(read) {
	const get = (name) => {
		const value = read(`data-${name}`);
		return value === null || value === undefined || value === "" ? null : value;
	};
	return {
		role: get("role"),
		interact: get("interact"),
		effect: get("effect"),
		action: get("action")
	};
}

/**
 * 算出**应该写上去的** ARIA 属性。
 *
 * ## 为什么要把"删除"也表示出来
 *
 * 用户把「作用」从 `functional` 改成 `background` 时，
 * 原来写的 `role="button"` 和 `tabindex="0"` **必须被清掉** ——
 * 否则一个大背景还留着"我是个按钮"的语义，读屏软件会念错，
 * 而且**这种错误在视觉上完全看不出来**。
 *
 * 所以返回值里 `null` 表示"删掉这个属性"。
 *
 * ## 谁优先
 *
 * `data-role` 是用户**显式**选的"这个东西是什么"，比从交互方式推断出来的更可信，
 * 所以它说了算。没选 `data-role` 时才从 `interact` 推。
 *
 * @param semantics - 该元素**改完之后**的完整语义（`readSemantics` 的结果 + 本次改动）。
 * @returns 要写的属性表；`null` 值表示删除。
 */
export function ariaFor(semantics) {
	const out = {};

	const fromRole = semantics.role === null || semantics.role === undefined
		? null
		: ROLE_ARIA[semantics.role] ?? null;
	const fromInteract = semantics.interact === null || semantics.interact === undefined
		? null
		: INTERACT_ARIA[semantics.interact] ?? null;

	// 先写交互推断出来的，再用「作用」覆盖 —— 显式选择优先
	for (const source of [fromInteract, fromRole]) {
		if (source === null) continue;
		for (const [key, value] of Object.entries(source)) out[key] = value;
	}

	// 效果的 ARIA 是**叠加**的（`role` 和 `aria-busy` 不冲突）
	const fromEffect = semantics.effect === null || semantics.effect === undefined
		? null
		: EFFECT_ARIA[semantics.effect] ?? null;
	if (fromEffect !== null) {
		for (const [key, value] of Object.entries(fromEffect)) out[key] = value;
	}

	return out;
}

/**
 * 合并「本次改动」和「元素当前状态」，得到改完之后的完整语义。
 *
 * 面板一次只改一个字段（比如只改 `effect`），但算 ARIA 需要**全部**语义 ——
 * 不然改效果时会把交互方式推断出来的 `role` 一起清掉。
 *
 * @param attrs - 本次要改的属性（面板给的，键是 `role` / `interact` / `effect` …）。
 * @param current - 元素当前的语义（`readSemantics` 的结果）。
 * @returns 改完之后的完整语义。
 */
export function mergeSemantics(attrs, current) {
	const next = { ...current };
	for (const key of ["role", "interact", "effect", "action"]) {
		if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
		const value = attrs[key];
		next[key] = value === null || value === undefined || value === "" ? null : String(value);
	}
	return next;
}
