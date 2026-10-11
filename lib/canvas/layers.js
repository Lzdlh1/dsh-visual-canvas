/**
 * 图层树：把画板里的 DOM 结构整理成一棵可浏览的树。
 *
 * ## 为什么单独成模块
 *
 * 树的构建规则（跳过什么、怎么命名、多深截断）是**纯逻辑**，
 * 拆出来就能离线测——不必启动浏览器去点。外壳只负责把它渲染出来。
 *
 * ## 取名规则（按「人怎么认这个元素」排序）
 *
 * 1. `#id` —— 最可靠，人写的时候就是拿来当名字的
 * 2. `.class` —— 次之，通常描述用途（`card-title`、`btn-primary`）
 * 3. 标签名 —— 兜底
 *
 * 再附一段文本摘要。设计稿里「账号提示框」和「密码提示框」都是 `<label>`，
 * 光看标签名分不出谁是谁，**文本才是人认得出的那个东西**。
 */

/** 这些标签在图层树里没有意义：不渲染东西，或属于文档元信息。 */
const SKIP_TAGS = new Set([
	"SCRIPT", "STYLE", "LINK", "META", "TITLE", "HEAD", "BASE", "NOSCRIPT",
	"TEMPLATE", "BR", "WBR"
]);

/** 默认最多渲染多少个节点：页面大了不截断会把浏览器拖死。 */
const DEFAULT_MAX_NODES = 600;

/**
 * 判断一个节点该不该出现在图层树里。
 *
 * @param element - 元素。
 * @returns 是否跳过。
 */
export function shouldSkipLayer(element) {
	if (element === null || element === undefined) return true;
	const tag = String(element.tagName ?? "").toUpperCase();
	if (tag === "") return true;
	return SKIP_TAGS.has(tag);
}

/**
 * 给一个元素取一个「人认得出」的名字。
 *
 * @param element - 元素。
 * @param options - { maxText }。
 * @returns { tag, name, text, selector }。
 */
export function describeLayer(element, options = {}) {
	const maxText = options.maxText ?? 28;
	const tag = String(element.tagName ?? "").toLowerCase();
	const id = typeof element.id === "string" ? element.id.trim() : "";
	const classes = [...(element.classList ?? [])].filter((name) => typeof name === "string" && name !== "");

	// 名字优先级：id > class > 标签名
	let name = tag;
	if (id !== "") name = `#${id}`;
	else if (classes.length > 0) name = `.${classes[0]}`;

	// 文本摘要：只取**直接文本**，不含子元素里的文字。
	// 否则「登录界面」会显示成整页所有文字拼起来的一大坨，反而没法认。
	let text = "";
	for (const child of element.childNodes ?? []) {
		if (child.nodeType !== 3) continue;
		const value = String(child.textContent ?? "").replace(/\s+/gu, " ").trim();
		if (value !== "") { text = value; break; }
	}
	if (text.length > maxText) text = `${text.slice(0, maxText - 1)}…`;

	// 选择器摘要：给人一个「这是哪个」的线索，不追求能 querySelector
	const selector = [tag, id === "" ? "" : `#${id}`, ...classes.slice(0, 2).map((c) => `.${c}`)].join("");

	return { tag, name, text, selector, classes, id };
}

/**
 * 把一个 DOM 子树整理成图层树。
 *
 * @param root - 根节点（通常是画板的 body 或某个容器）。
 * @param options - { maxNodes, maxText, maxDepth }。
 * @returns { nodes, total, truncated }。
 *   nodes 每项：{ element, tag, name, text, selector, depth, children, hidden }
 */
export function buildLayerTree(root, options = {}) {
	const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
	const maxDepth = options.maxDepth ?? 24;
	let count = 0;
	let truncated = false;

	/**
	 * 递归构建。
	 * @param element - 当前元素。
	 * @param depth - 层级。
	 * @returns 节点数组。
	 */
	const walk = (element, depth) => {
		const out = [];
		if (depth > maxDepth) return out;
		for (const child of element.children ?? []) {
			if (count >= maxNodes) { truncated = true; return out; }
			if (shouldSkipLayer(child)) continue;
			count += 1;
			const described = describeLayer(child, options);
			// display:none 的元素仍然列出来——找不到的元素比看不见的元素更让人困惑，
			// 所以标记成「隐藏」而不是藏起来。
			let hidden = false;
			try {
				const view = child.ownerDocument?.defaultView;
				if (view !== null && view !== undefined) hidden = view.getComputedStyle(child).display === "none";
			} catch { /* 跨文档时读不到，按可见处理 */ }
			out.push({
				element: child,
				...described,
				depth,
				hidden,
				children: walk(child, depth + 1)
			});
		}
		return out;
	};

	const nodes = walk(root, 1);
	return { nodes, total: count, truncated };
}

/**
 * 找出从根到某个元素的路径（用于展开到当前选中项）。
 *
 * @param root - 根节点。
 * @param target - 目标元素。
 * @returns 元素数组（从根的子节点到 target），找不到返回空数组。
 */
export function pathToElement(root, target) {
	const path = [];
	let current = target;
	while (current !== null && current !== undefined && current !== root) {
		path.unshift(current);
		current = current.parentElement;
	}
	return current === root ? path : [];
}

/**
 * 按关键词过滤图层树（保留命中项的祖先链）。
 *
 * 命中范围：名字、标签、文本摘要、class。用户找图层时想的是「那个写着登录的按钮」，
 * 所以文本必须参与匹配。
 *
 * @param nodes - buildLayerTree 的 nodes。
 * @param query - 关键词（调用方负责转小写；空串返回原树）。
 * @returns 过滤后的 nodes。
 */
export function filterLayerTree(nodes, query) {
	if (query === undefined || query === null || query === "") return nodes;
	const needle = String(query).toLowerCase();

	/**
	 * 递归过滤。
	 * @param list - 节点数组。
	 * @returns 过滤后的数组。
	 */
	const walk = (list) => {
		const out = [];
		for (const node of list) {
			const haystack = `${node.name} ${node.tag} ${node.text} ${(node.classes ?? []).join(" ")}`.toLowerCase();
			const hit = haystack.includes(needle);
			const kids = walk(node.children ?? []);
			// 自己命中 → 整棵保留；只有子孙命中 → 保留自己作为路径
			if (hit) out.push({ ...node, children: node.children ?? [] });
			else if (kids.length > 0) out.push({ ...node, children: kids, matchedChild: true });
		}
		return out;
	};
	return walk(nodes);
}
