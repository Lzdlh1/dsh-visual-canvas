/**
 * 关联（link）：图层与图层之间的**带类型的边**。
 *
 * ## 为什么单独一个模块
 *
 * 关联是这次功能的核心数据结构，而且它要同时满足三件事：
 * 能被编辑时联动用、能被面板列出、能写进源码供导出后用。
 * 混在 `shell.js` 里（2500 行）会很难测 —— 这里是**纯函数**，
 * 给一组假元素就能验，不需要浏览器也不需要宿主。
 *
 * ## 存在哪里（用户已确认：两者分开）
 *
 * | 信息 | 存哪 | 为什么 |
 * |---|---|---|
 * | **结构**（镶嵌：谁挂在谁身上） | **源码 `data-*`** | 跟着元素走，导出后仍在 |
 * | **语义**（功能：点了跳哪、弹什么） | **源码 `data-*`** | 同上 |
 *
 * 所以**源码是唯一事实来源** —— `collectLinks()` 从 DOM 反推，
 * 不额外维护一份会漂移的画布状态。
 *
 * ## 目标标识为什么用 `data-dsh-id` 而不是用户的 `id`
 *
 * - 画布上的图层**大多没有 id**，而关联需要一个稳定指向
 * - 用户自己的 `id` 可能有别的用途（锚点链接、脚本钩子），**占用它就是破坏**
 *
 * @module links
 */

/** 关联类型。 */
export const LINK_KINDS = {
	/** 镶嵌：挂在底座上，底座动它跟着动。 */
	mount: "mount",
	/** 功能：点了做什么（跳转 / 弹窗）。 */
	action: "action"
};

/** 方向。 */
export const LINK_DIRECTIONS = {
	/** 单向：子跟底座，底座不跟子。 */
	one: "one",
	/** 双向：互相跟随（拖任意一个，另一个也动）。 */
	both: "both"
};

/** 功能关联的具体行为。 */
export const ACTION_KINDS = {
	navigate: "navigate",
	alert: "alert",
	progress: "progress",
	toast: "toast"
};

/**
 * 造一个关联用的唯一标识。
 *
 * 用时间戳 + 随机后缀：既大致有序，又不会撞。
 *
 * @returns 形如 `dsh-3f2a91-7k2m` 的字符串。
 */
export function newLinkId() {
	return `dsh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 确保一个元素有 `data-dsh-id`，没有就给它一个。
 *
 * **幂等**：已有就原样返回，不会换掉 —— 换了的话，
 * 指向它的那些关联会**全部断掉**，而且是静默的。
 *
 * @param element - 画板里的元素。
 * @returns { id, created } —— `created` 为真表示是新写的，调用方要把它写回源码。
 */
export function ensureLinkId(element) {
	if (element === null || element === undefined) return { id: null, created: false };
	const existing = typeof element.getAttribute === "function"
		? element.getAttribute("data-dsh-id")
		: null;
	if (typeof existing === "string" && existing !== "") return { id: existing, created: false };

	const id = newLinkId();
	if (typeof element.setAttribute === "function") element.setAttribute("data-dsh-id", id);
	return { id, created: true };
}

/**
 * 从一个文档里收集所有关联。
 *
 * **以源码为唯一事实来源**：DOM 上有什么就是什么，不读缓存。
 *
 * @param doc - 画板的 document。
 * @returns [{ from, to, kind, direction, action, message, tone }]。
 */
export function collectLinksFromDocument(doc) {
	if (doc === null || doc === undefined) return [];
	let nodes;
	try {
		// 只有带关联标记的元素才需要看：`data-mount` 或 `data-action`
		nodes = doc.querySelectorAll("[data-mount], [data-action]");
	} catch {
		return [];
	}

	const out = [];
	for (const node of nodes) {
		const from = node.getAttribute?.("data-dsh-id") ?? null;
		if (from === null || from === "") continue;

		const mount = node.getAttribute("data-mount");
		if (typeof mount === "string" && mount !== "") {
			out.push({
				from,
				to: mount,
				kind: LINK_KINDS.mount,
				// 缺省单向：更保守，也符合"镶嵌"的默认语义
				direction: node.getAttribute("data-mount-dir") === "both"
					? LINK_DIRECTIONS.both
					: LINK_DIRECTIONS.one,
				action: null,
				message: null,
				tone: null
			});
		}

		const action = node.getAttribute("data-action");
		if (typeof action === "string" && action !== "") {
			// 跳转类用 `data-target` 指应用路径；弹窗类用 `data-message` 带文案
			out.push({
				from,
				to: node.getAttribute("data-target") ?? null,
				kind: LINK_KINDS.action,
				direction: LINK_DIRECTIONS.one,
				action,
				message: node.getAttribute("data-message") ?? null,
				tone: node.getAttribute("data-tone") ?? null
			});
		}
	}
	return out;
}

/**
 * 收集多个画板里的关联。
 * @param docs - document 数组。
 * @returns 关联数组。
 */
export function collectLinks(docs) {
	const out = [];
	for (const doc of docs ?? []) out.push(...collectLinksFromDocument(doc));
	return out;
}

/**
 * 判断"把 `to` 挂到 `from` 上"会不会形成环。
 *
 * ## 为什么必须防
 *
 * 双向关联是**互相跟随**：A 跟 B、B 也跟 A。写成朴素实现就是
 * "拖 A → 移动 B → 又触发 A 移动 → …"，**直接死循环把页面卡死**。
 *
 * 更深一层：A 镶嵌 B、B 镶嵌 C、C 又镶嵌 A —— 三层的环同样会死。
 * 所以判据是"从 `to` 出发，沿 mount 边能不能走回 `from`"。
 *
 * @param links - 现有全部关联。
 * @param from - 源图层的 dsh-id。
 * @param to - 目标的 dsh-id。
 * @returns { ok, reason } —— ok 为 false 时 reason 是可读的原因。
 */
export function canMount(links, from, to) {
	if (from === to) return { ok: false, reason: "不能关联到自己" };
	if (typeof from !== "string" || from === "") return { ok: false, reason: "源图层没有标识" };
	if (typeof to !== "string" || to === "") return { ok: false, reason: "目标图层没有标识" };

	// 从 to 出发，顺着 mount 边往下走，看能不能回到 from
	const seen = new Set();
	const stack = [to];
	while (stack.length > 0) {
		const current = stack.pop();
		if (current === from) return { ok: false, reason: "这样会形成循环（底座互相挂住）" };
		if (seen.has(current)) continue;
		seen.add(current);
		for (const link of links ?? []) {
			if (link.kind !== LINK_KINDS.mount) continue;
			if (link.from === current) stack.push(link.to);
		}
	}
	return { ok: true, reason: null };
}

/**
 * 找出所有"镶嵌在 `id` 上的"图层（含双向时反向的那一层）。
 *
 * ## 双向怎么算
 *
 * 双向的语义是**互相跟随**：拖任意一个，另一个也动。
 * 所以对 `id` 来说，双向关联的**两端都是"跟随者"也是"被跟随者"**——
 * 移动 `id` 时要通知到对面，移动对面时也要通知到 `id`。
 * 这个函数给出的是"**移动 id 时，哪些图层该跟着动**"。
 *
 * @param links - 全部关联。
 * @param id - 被移动的图层标识。
 * @returns 该跟随的 dsh-id 数组（不含自己）。
 */
export function followersOf(links, id) {
	const out = new Set();
	for (const link of links ?? []) {
		if (link.kind !== LINK_KINDS.mount) continue;
		// 我挂着别人 → 我动，别人不必然动
		if (link.from === id) {
			// 只有单向时"我跟随别人"，所以移动我**不该**带动底座；
			// 双向时两边都要动
			if (link.direction === LINK_DIRECTIONS.both) out.add(link.to);
			continue;
		}
		// 别人挂着我 → 我动，它跟着动
		if (link.to === id) out.add(link.from);
	}
	out.delete(id);
	return [...out];
}

/**
 * 增删关联（去重：同 from/to/kind 只留一条）。
 *
 * @param links - 现有数组（不会被改）。
 * @param link - 要加的关联。
 * @returns 新数组。
 */
export function addLink(links, link) {
	const same = (a, b) => a.from === b.from && a.to === b.to && a.kind === b.kind;
	return [...(links ?? []).filter((item) => !same(item, link)), link];
}

/**
 * 删掉一条关联。
 * @param links - 现有数组。
 * @param from - 源标识。
 * @param to - 目标标识。
 * @param kind - 类型；省略则删该方向的全部。
 * @returns 新数组。
 */
export function removeLink(links, from, to, kind) {
	return (links ?? []).filter((item) => {
		if (item.from !== from || item.to !== to) return true;
		if (kind === undefined) return false;
		return item.kind !== kind;
	});
}
