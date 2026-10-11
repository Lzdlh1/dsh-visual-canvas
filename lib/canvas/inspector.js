/**
 * 元素检查器：选中即显示「这是什么、什么尺寸、什么颜色」。
 *
 * ## 它和形状面板的区别（两者不是一回事）
 *
 * | | 形状面板 | 本模块 |
 * |---|---|---|
 * | 回答的问题 | 「我要**改**这个形状」 | 「我刚点的**是什么**」 |
 * | 出现时机 | 选了 `.dsh-shape` 才出现 | **任何**元素都出现 |
 * | 交互 | 全是可编辑控件 | **纯只读**（改还是去样式面板） |
 *
 * 做成只读是刻意的：可编辑控件一旦多起来，就变成第二个样式面板，
 * 两边都能改同一个元素、状态互相覆盖，比只读更难用。
 *
 * ## 为什么用计算样式而不是内联样式
 *
 * 用户想知道的是**它看起来什么样**，不是**源码里写了什么**。
 * 内联样式为空但元素有颜色的情况非常多（来自样式表、CSS 变量、继承）。
 * 所以一律读 `getComputedStyle`。
 *
 * @module inspector
 */

/** 需要显示的属性。顺序即显示顺序——从整体到细节。 */
const FIELDS = [
	{ key: "display", label: "布局" },
	{ key: "width", label: "尺寸" },
	{ key: "font", label: "字体" },
	{ key: "fontSize", label: "字号" },
	{ key: "fontWeight", label: "字重" },
	{ key: "color", label: "文字" },
	{ key: "background", label: "背景" },
	{ key: "border", label: "边框" },
	{ key: "borderRadius", label: "圆角" },
	{ key: "opacity", label: "不透明" }
];

/**
 * 布局类型：不值得单独占一行。
 *
 * `div` 的默认值就是 `block`，绝大多数元素都是——
 * 显示出来等于在每行都写一句废话。
 */
const LAYOUT_VALUES = new Set([
	"block", "inline", "inline-block", "list-item", "table", "table-row",
	"table-cell", "flex", "inline-flex", "grid", "inline-grid", "contents"
]);

/**
 * 造一个元素检查器。
 *
 * @param options - {
 *   root: HTMLElement,        // 挂载点
 *   el: (tag, props, children) => HTMLElement,
 *   onDelete?: () => void     // 点「删除」时调用；不传就不显示删除按钮
 * }。
 * @returns { setSelection(element|null), refresh() }。
 */
export function createInspector(options) {
	const { root, el, onDelete } = options;

	/**
	 * 读一个元素的关键属性。
	 *
	 * @param {Element} element - 目标元素。
	 * @returns {object|null} 读不到时返回 null。
	 */
	const read = (element) => {
		// ownerDocument 可能因为画板重载而失效（defaultView 为 null），
		// 这时读计算样式会抛。返回 null 让界面显示「无法读取」而不是崩掉。
		const view = element.ownerDocument?.defaultView ?? null;
		if (view === null) return null;
		const cs = view.getComputedStyle(element);
		const rect = element.getBoundingClientRect();
		const out = {};
		for (const field of FIELDS) {
			out[field.key] = cs[field.key] ?? "";
		}
		out.width = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
		out.font = cs.fontFamily ?? "";
		out.border = `${cs.borderTopWidth ?? ""} ${cs.borderTopStyle ?? ""} ${cs.borderTopColor ?? ""}`.trim();
		out.background = cs.backgroundColor ?? "";
		return out;
	};

	/**
	 * 判断这个值「有没有信息量」。
	 *
	 * 默认值全显示会让面板变成一列噪音——`block`、`normal`、`0px`
	 * 这些谁都知道，不该占位置。
	 *
	 * @param {string} value - CSS 值。
	 * @param {string} key - 字段名。
	 * @returns {boolean} 是否值得显示。
	 */
	const interesting = (value, key) => {
		const v = String(value ?? "").trim();
		if (v === "") return false;

		// 颜色型字段的透明值是**有意义**的（"它其实是透明的"），
		// 所以不能一刀切。
		if (key === "background" || key === "color") return v !== "";

		// 无信息量的默认值。**`block` 漏过一次**（真实 bug：
		// 测试输出里出现「布局 block」才看出来），所以布局类型整类都挡。
		const NOISE = new Set(["none", "normal", "auto", "0px", "static", "visible", "baseline", "0s"]);
		if (NOISE.has(v)) return false;
		if (LAYOUT_VALUES.has(v)) return false;

		// 边框是**拼出来的三值串**（形如 `0px none rgb(0, 0, 0)`）。
		// 没有边框时整串都是噪音，而且在 208px 的面板里会被省略号截成
		// 「0px none rgb(255, 255, 2...」——**既没用又难看**（截图看出来的）。
		if (key === "border" && /^0px\s+none/u.test(v)) return false;

		return true;
	};

	// 记住当前选中，`refresh()` 要靠它重读——
	// 画板重载后计算样式会变（CSS 变量重新解析、元素被重建），
	// 缓存引用比让调用方再传一遍更不容易出错。
	let current = null;

	/**
	 * 渲染。
	 *
	 * @param {Element|null} element - 当前选中。
	 */
	const render = (element) => {
		current = element ?? null;
		root.replaceChildren();

		if (element === null || element === undefined) {
			root.append(el("div", { class: "insp-empty", text: "在画板上点一个元素，这里会显示它的尺寸、颜色和字体。" }));
			return;
		}

		const data = read(element);
		if (data === null) {
			root.append(el("div", { class: "insp-empty", text: "读不到这个元素的样式（画板可能刚重载，再点一次）。" }));
			return;
		}

		// ---- 标题：标签 + 标识 + 删除 ----
		//
		// **删除按钮为什么放在这个只读面板上**：
		// 它是"当前选中是什么"的唯一常驻显示处，而删除是**对选中元素的操作**——
		// 放在这里比放工具栏更符合心智（工具栏并不知道你选了什么）。
		//
		// 实测教训：删除原先只有键盘入口，而且绑错了（选中形状按 Delete 会删掉整块画板）。
		// **看不见的功能等于没有功能**，所以这里必须给一个能点到的入口。
		//
		// 它不违背"只读"设计：删除不编辑任何属性值，改属性仍然只有样式面板一条路。
		const tag = String(element.tagName ?? "?").toLowerCase();
		const id = element.id ? `#${element.id}` : "";
		const cls = typeof element.className === "string" && element.className !== ""
			? `.${element.className.trim().split(/\s+/u).slice(0, 2).join(".")}`
			: "";
		const head = [el("code", { class: "insp-tag", text: tag + id + cls })];
		if (typeof onDelete === "function") {
			head.push(el("button", {
				// `sm` 是规范里已有的小档位（24px）。**必须带上**——
				// 不加的话会被全局 `button { height: 32px }` 接管，
				// 在这个窄面板里显得又高又笨重（实测截图看出来的）。
				class: "insp-del sm",
				type: "button",
				title: "删除这个元素（也可以直接按 Delete 键）",
				text: "删除",
				onClick: () => onDelete()
			}));
		}
		root.append(el("div", { class: "insp-head" }, head));

		// ---- 属性行 ----
		// 注意：**这里不会有"什么都没有"的空态**——尺寸行永远有值
		// （最小也是 `0 × 0`），所以空列表在当前字段集下不可达。
		// 早先写过一个空态分支，是条不可达的代码，删掉了。
		const rows = [];
		for (const field of FIELDS) {
			const value = data[field.key];
			if (!interesting(value, field.key)) continue;
			rows.push(el("div", { class: "insp-row" }, [
				el("span", { class: "insp-label", text: field.label }),
				// `title`：值会被省略号截断（面板只有 208px），
				// 悬停能看到完整内容。截断而看不到全文 = 信息丢了。
				el("span", { class: "insp-value", text: String(value), title: String(value) })
			]));
		}
		root.append(el("div", { class: "insp-list" }, rows));
	};

	return {
		/**
		 * 更新当前选中。
		 *
		 * @param {Element|null} element - 新选中的元素。
		 */
		setSelection: (element) => { render(element); },
		/**
		 * 重绘（画板重载后计算样式会变，需要重新读）。
		 * @returns {void}
		 */
		refresh: () => { render(current); }
	};
}

/** @type {string[]} 导出字段名，方便测试断言"读了哪些属性"。 */
export const INSPECTOR_FIELDS = FIELDS.map((f) => f.key);
