/**
 * 覆盖层的编辑面板：选中元素后出现的样式编辑器。
 *
 * 纯 DOM 构建（不用 React）——覆盖层要能在**任意技术栈**的页面里跑，
 * 引入框架反而给自己加约束。所有节点都挂在 Shadow DOM 里，样式不受宿主页面影响。
 *
 * 面板能力：
 * - 常用样式属性编辑（颜色 / 字号 / 间距 / 圆角 / 尺寸…）
 * - 拖拽调整（位置、尺寸）由 overlay.js 用鼠标直接操作，面板负责显示与微调
 * - 撤销 / 重做 / 待确认列表
 */

/** 面板里展示的样式分组。 */
const STYLE_GROUPS = [
	{
		title: "文字",
		items: [
			{ key: "color", label: "颜色", type: "color", palette: "colors" },
			// 字体系列：原先面板里**没有**这个字段。用户明确要求"字体也要能选已有的"，
			// 所以补上，并挂上画布上收集到的字体列表。
			{ key: "font-family", label: "字体", type: "text", palette: "fonts" },
			{ key: "font-size", label: "字号", type: "number", unit: "px", palette: "sizes" },
			{ key: "font-weight", label: "字重", type: "select", options: ["400", "500", "600", "700", "800"], palette: "weights" },
			{ key: "line-height", label: "行高", type: "text", palette: "leadings" },
			{ key: "text-align", label: "对齐", type: "select", options: ["left", "center", "right", "justify"] }
		]
	},
	{
		title: "外观",
		items: [
			{ key: "background-color", label: "背景", type: "color", palette: "colors" },
			{ key: "border-radius", label: "圆角", type: "number", unit: "px" },
			{ key: "border-width", label: "边框", type: "number", unit: "px" },
			{ key: "border-color", label: "边框色", type: "color", palette: "colors" },
			{ key: "opacity", label: "不透明", type: "number", step: "0.05", min: "0", max: "1" },
			{ key: "box-shadow", label: "阴影", type: "text" }
		]
	},
	{
		title: "间距",
		items: [
			{ key: "padding", label: "内边距", type: "number", unit: "px" },
			{ key: "margin", label: "外边距", type: "number", unit: "px" },
			{ key: "gap", label: "间隙", type: "number", unit: "px" }
		]
	},
	{
		title: "形状",
		items: [
			// 形状预设写的是 `clip-path`：不改元素本身的盒模型，所以不会把布局搅乱。
			// 选项用 { label, value } 形式——值是完整的 clip-path 字符串，直接显示会没法看。
			{
				key: "clip-path", label: "轮廓", type: "select", options: [
					{ label: "矩形（默认）", value: "none" },
					{ label: "圆形", value: "circle(50% at 50% 50%)" },
					{ label: "椭圆", value: "ellipse(50% 50% at 50% 50%)" },
					{ label: "胶囊", value: "inset(0 round 999px)" },
					{ label: "三角形", value: "polygon(50% 0%, 100% 100%, 0% 100%)" },
					{ label: "倒三角", value: "polygon(0% 0%, 100% 0%, 50% 100%)" },
					{ label: "菱形", value: "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)" },
					{ label: "六边形", value: "polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)" },
					{ label: "五角星", value: "polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)" },
					{ label: "箭头（右）", value: "polygon(0% 20%, 60% 20%, 60% 0%, 100% 50%, 60% 100%, 60% 80%, 0% 80%)" },
					{ label: "对话气泡", value: "polygon(0% 0%, 100% 0%, 100% 75%, 75% 75%, 75% 100%, 50% 75%, 0% 75%)" },
					{ label: "斜切", value: "polygon(12% 0%, 100% 0%, 88% 100%, 0% 100%)" }
				]
			},
			{ key: "border-radius", label: "圆角", type: "number", unit: "px" }
		]
	},
	{
		title: "尺寸与布局",
		items: [
			// 必须声明 unit：commit 只在「值是纯数字且字段有 unit」时才补单位。
			// 少了它，输入 800 会原样写成 `width: 800`——无效 CSS，浏览器直接忽略，
			// 表现就是「面板里改了宽高完全没反应」。纯数字才补，所以 `auto`、`50%`
			// 这类值照旧原样写出。
			{ key: "width", label: "宽", type: "text", unit: "px" },
			{ key: "height", label: "高", type: "text", unit: "px" },
			{ key: "display", label: "display", type: "select", options: ["block", "flex", "grid", "inline-flex", "inline-block", "none"] },
			{ key: "flex-direction", label: "主轴", type: "select", options: ["row", "column", "row-reverse", "column-reverse"] },
			{ key: "align-items", label: "交叉轴", type: "select", options: ["stretch", "flex-start", "center", "flex-end", "baseline"] },
			{ key: "justify-content", label: "主轴对齐", type: "select", options: ["flex-start", "center", "flex-end", "space-between", "space-around", "space-evenly"] }
		]
	}
];

/** 面板 CSS（作用域在 Shadow DOM 内）。 */
export const PANEL_CSS = `
/* 颜色一律走主题令牌并带兜底：画布外壳里跟着主题走，单页覆盖层里退回默认暗色。 */
:host { all: initial; }
* { box-sizing: border-box; font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
.panel {
  position: fixed; top: 12px; right: 12px; width: 296px; max-height: calc(100vh - 24px);
  overflow: auto; background: var(--bg-panel, #1b1d21); color: var(--ink, #e8eaed); border: 1px solid var(--line, #33363c);
  border-radius: 10px; box-shadow: 0 12px 32px var(--scrim, rgba(0,0,0,.4)); font-size: 12px; z-index: 2147483000;
}
.head { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--bg-sunken, #2b2e33); position: sticky; top: 0; background: var(--bg-panel, #1b1d21); }
/*
 * 标题栏兼作**拖动把手**：光标提示它是可拖的。
 * user-select: none 是必须的 —— 不加的话拖动会顺手选中标题文字，
 * 松手后留下一片蓝色高亮，看着像出了问题。
 */
.head { cursor: grab; user-select: none; }
.head.dragging { cursor: grabbing; }
.head .grip { color: var(--ink-dim, #9aa0a6); font-size: 11px; letter-spacing: 1px; }
.head .panel-act {
  flex: 0 0 auto; width: 20px; height: 20px; padding: 0;
  display: grid; place-items: center;
  border: 0; border-radius: 5px; background: none;
  color: var(--ink-dim, #9aa0a6); font-size: 11px; line-height: 1;
  cursor: pointer;
}
.head .panel-act:hover { background: var(--bg-raised, #23262b); color: var(--ink, #e8eaed); }
/* 收起后标题栏的圆角要跟着收（不然底下留着直角） */
.panel.collapsed .head { border-bottom: 0; }
/*
 * 折叠：**只留标题栏**。
 *
 * 用  > *:not(.head)  一次盖住所有正文（分组/待确认/提示/页脚/状态栏），
 * 而不是逐个列出来 —— 以后往面板里加新块时不用再回来改这条规则，
 * 漏一个的表现是"收起了但底下还露着一截"。
 */
.panel.collapsed > *:not(.head) { display: none; }
.panel.collapsed { width: auto; min-width: 132px; max-height: none; }
/* 折叠时隐藏源码位置（窄条里放不下，挤着反而看不清） */
.panel.collapsed .loc { display: none; }
.head b { font-size: 12px; font-weight: 600; }
.tag { font-family: ui-monospace, Consolas, monospace; color: var(--accent, #7dd3fc); }
.loc { color: var(--ink-dim, #9aa0a6); font-size: 11px; margin-left: auto; font-family: ui-monospace, Consolas, monospace; cursor: pointer; }
.loc:hover { color: var(--ink, #e8eaed); }
.group { padding: 8px 10px; border-bottom: 1px solid var(--bg-raised, #23262a); }
.group h4 { margin: 0 0 6px; font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-dim, #9aa0a6); }
.row { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
.row label { flex: 0 0 62px; color: var(--ink-dim, #b6bcc4); }
.row input, .row select {
  flex: 1 1 auto; min-width: 0; background: var(--bg-raised, #23262b); color: var(--ink, #e8eaed); border: 1px solid var(--line, #33363c);
  border-radius: 5px; padding: 3px 6px; font: inherit; font-size: 11px;
}
.row input[type=color] { padding: 1px; height: 22px; cursor: pointer; }
.row input:focus, .row select:focus { outline: none; border-color: var(--accent, #4f8cff); }
.row .unit { color: var(--muted, #7a8087); font-size: 10px; }

/* ---- 画板上已有的值（快选） ----
   跟在对应字段下面一行。色块本身就是标签，所以它不需要文字；
   其他（字体名、字号…）用文字片，长了会截断。 */
.quick-row {
  display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
  margin: -1px 0 6px 68px; min-height: 18px;
}
.quick-label { color: var(--muted, #7a8087); font-size: 10px; flex: 0 0 auto; }
.quick-swatch {
  width: 16px; height: 16px; flex: 0 0 auto;
  border: 1px solid var(--line, #33363c); border-radius: 4px;
  padding: 0; cursor: pointer;
}
.quick-swatch:hover { transform: scale(1.15); }
.quick-chip {
  max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 1px 6px; border: 1px solid var(--line, #33363c); border-radius: 999px;
  background: var(--bg-raised, #23262b); color: var(--ink-dim, #b6bcc4);
  font: inherit; font-size: 10px; cursor: pointer;
}
.quick-chip:hover { border-color: var(--accent, #1a73e8); color: var(--ink, #e8eaed); }
.foot { display: flex; gap: 6px; padding: 8px 10px; flex-wrap: wrap; position: sticky; bottom: 0; background: var(--bg-panel, #1b1d21); border-top: 1px solid var(--bg-sunken, #2b2e33); }
button {
  flex: 1 1 auto; background: var(--bg-raised, #2b2f36); color: var(--ink, #e8eaed); border: 1px solid var(--line-strong, #3a3f47); border-radius: 6px;
  padding: 5px 8px; font: inherit; font-size: 11px; cursor: pointer;
}
button:hover:not(:disabled) { border-color: var(--accent, #4f8cff); color: var(--ink-on-accent, #fff); }
button:disabled { opacity: .45; cursor: not-allowed; }
button.primary { background: var(--accent-hover, #2f6fed); border-color: var(--accent-hover, #2f6fed); }
button.primary:hover:not(:disabled) { background: var(--accent-hover, #3d7bf7); }
.status { padding: 6px 10px; font-size: 11px; color: var(--ink-dim, #9aa0a6); border-top: 1px solid var(--bg-raised, #23262a); }
.status.ok { color: var(--ok, #6ee7a8); }
.status.err { color: var(--err, #fca5a5); }
.status.warn { color: var(--warn, #fcd34d); }
.hint { padding: 6px 10px; font-size: 10px; color: var(--muted, #7a8087); line-height: 1.5; }
.pending { padding: 6px 10px; border-top: 1px solid var(--bg-raised, #23262a); }
.pending div { color: var(--warn, #fcd34d); font-size: 11px; margin-bottom: 3px; }
.hidden { display: none !important; }
`;

/**
 * 创建一个 DOM 节点。
 * @param tag - 标签名。
 * @param props - 属性与事件。
 * @param children - 子节点或文本。
 * @returns 节点。
 */
export function el(tag, props = {}, children = []) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (key === "class") node.className = value;
		else if (key === "text") node.textContent = value;
		else if (key === "style") Object.assign(node.style, value);
		else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
		else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, String(value));
	}
	for (const child of [].concat(children)) {
		if (child === null || child === undefined) continue;
		node.append(typeof child === "string" ? document.createTextNode(child) : child);
	}
	return node;
}

/**
 * 编辑面板。
 */
export class EditorPanel {
	/**
	 * @param options - {
	 *   onDeclare: (declarations, options) => void   提交改动,
	 *   onUndo: () => void, onRedo: () => void,
	 *   onApplyPending: () => void, onDiscardPending: () => void,
	 *   onPickParent: () => void, onPickChild: () => void,
	 *   onToggleEnabled: () => void
	 * }
	 */
	constructor(options) {
		this.options = options;
		this.root = el("div", { class: "panel" });
		this.body = el("div");
		this.status = el("div", { class: "status" });
		this.pendingBox = el("div", { class: "pending hidden" });
		this.build();
		// 恢复上次的位置和折叠状态（本机偏好，存 localStorage）
		this.restoreLayout();
	}

	/**
	 * 把面板放到外壳指定的上边缘（避开顶栏）。
	 *
	 * ## ⚠️ 用户拖过之后就不该再动它
	 *
	 * 外壳每次显示面板前都会调这个（顶栏高度会随窗口宽度变化，算一次固定住
	 * 的话窄窗口下又会压住工具栏）。但如果**用户自己把面板拖到别处**，
	 * 再套用外壳的位置就等于**把用户的拖动结果抹掉** ——
	 * 表现是"拖了、松手、选下一个元素，面板又跳回右上角"。
	 *
	 * 所以这里让位：用户定过位置就以用户为准。
	 *
	 * @param top - 外壳给的上边缘（px）。
	 * @returns { void }
	 */
	placeTop(top) {
		if (this.hasCustomPosition === true) return;
		this.root.style.top = `${top}px`;
	}

	/**
	 * 折叠 / 展开面板。
	 *
	 * 收起时**只留标题栏**（窄条），并且把按钮箭头和提示语跟着换掉 ——
	 * 一个永远显示「▸」的按钮，用户不知道点它是收还是开。
	 *
	 * @param collapsed - 是否收起。
	 * @param persist - 是否写入 localStorage（拖动结束时也要存，但那时不该重复写）。
	 * @returns { void }
	 */
	setCollapsed(collapsed, persist = true) {
		this.root.classList.toggle("collapsed", collapsed);
		if (this.collapseBtn !== undefined && this.collapseBtn !== null) {
			this.collapseBtn.textContent = collapsed ? "◂" : "▸";
			this.collapseBtn.title = collapsed ? "展开面板" : "收起面板";
		}
		if (persist) this.saveLayout();
	}

	/**
	 * 布局存储键。
	 *
	 * 说明：面板是浮动工具，位置属于**本机偏好**，不该进项目文件
	 * （队友打开时应该看到自己习惯的位置，而不是被我的拖拽结果覆盖）。
	 */
	static get LAYOUT_KEY() {
		return "dsh-canvas:panel-layout";
	}

	/**
	 * 把当前的位置与折叠状态存起来。
	 *
	 * localStorage 在隐私模式/被禁用时会**直接抛异常**，
	 * 所以整段包起来 —— 存不上最多是"下次打开回到默认位置"，
	 * 绝不能因为它让面板本身不能用了。
	 *
	 * @returns { void }
	 */
	saveLayout() {
		try {
			const rect = this.root.getBoundingClientRect();
			localStorage.setItem(EditorPanel.LAYOUT_KEY, JSON.stringify({
				left: Math.round(rect.left),
				top: Math.round(rect.top),
				collapsed: this.root.classList.contains("collapsed")
			}));
		} catch { /* 存不上不影响使用 */ }
	}

	/**
	 * 恢复上次的位置与折叠状态。
	 *
	 * ⚠️ **必须把坐标夹回视口内**：换一个更小的屏幕（或窗口缩小过），
	 * 上次存的 `left: 1200` 会让面板整个落在屏幕外面 ——
	 * 用户既看不到它也拖不回来，只能去删 localStorage。
	 *
	 * @returns { void }
	 */
	restoreLayout() {
		let saved = null;
		try {
			saved = JSON.parse(localStorage.getItem(EditorPanel.LAYOUT_KEY) ?? "null");
		} catch { saved = null; }
		if (saved === null || typeof saved !== "object") return;

		if (saved.collapsed === true) this.setCollapsed(true, false);
		if (Number.isFinite(saved.left) !== true || Number.isFinite(saved.top) !== true) return;

		// 夹回视口：至少留 80px 在屏幕内，保证标题栏抓得住。
		//
		// 注意这里**不能**用 `this.root.getBoundingClientRect()` 来算边界：
		// 面板在"没选中元素"时是 `display: none`（见 edit.js），
		// 那时 rect 全是 0，拿它算会把坐标错误地归零。
		const maxLeft = Math.max(0, window.innerWidth - 80);
		const maxTop = Math.max(0, window.innerHeight - 32);
		const left = Math.min(Math.max(0, saved.left), maxLeft);
		const top = Math.min(Math.max(0, saved.top), maxTop);
		this.root.style.left = `${left}px`;
		this.root.style.top = `${top}px`;
		// 一旦定了 left/top，就必须清掉 CSS 里的 `right` ——
		// 两者同时存在时 `right` 会赢，面板会跳回右上角（拖了等于没拖）
		this.root.style.right = "auto";
		// ★ 恢复出来的位置同样是"用户定的" —— 必须打这个标记，
		// 否则外壳的 placeTop() 会在面板显示时把 top 覆盖掉，
		// 表现是"刷新后恢复到了旧位置"，看着像持久化没生效。
		this.hasCustomPosition = true;
	}

	/**
	 * 让标题栏可以拖动面板。
	 *
	 * ## 两个容易漏的点
	 *
	 * 1. **监听挂在 `window` 上，不是把手本身** —— 鼠标滑出标题栏（拖快了很正常）
	 *    还要继续跟手，挂在自己身上会在边界处"掉手"。
	 * 2. **点按钮不算拖动** —— 折叠按钮在标题栏里，
	 *    不排除的话点一下会把面板挪一下（`preventDefault` 也顺手挡掉了点击）。
	 *
	 * @param handle - 作为把手的元素。
	 * @returns { void }
	 */
	bindDrag(handle) {
		let start = null;

		const onMove = (event) => {
			if (start === null) return;
			const left = start.left + (event.clientX - start.x);
			const top = start.top + (event.clientY - start.y);
			// 拖动不限制范围，但**至少留一条边在视口内**，免得拖丢
			this.root.style.left = `${Math.min(Math.max(left, -this.root.offsetWidth + 80), window.innerWidth - 80)}px`;
			this.root.style.top = `${Math.min(Math.max(top, 0), window.innerHeight - 32)}px`;
			this.root.style.right = "auto";
			// ★ 标记"位置是用户定的" —— 之后外壳的 placeTop 就不能再覆盖它
			this.hasCustomPosition = true;
			// 每次移动都落盘。
			//
			// 试过节流到 ~8fps，结果**最后一次移动被跳过**：
			// 松手时存的还是中途的坐标，刷新后位置差几十像素
			// （验收脚本量出 927,88 vs 实际 877,118）。
			// localStorage 是同步写但很快（亚毫秒级），60fps 也扛得住；
			// 而且**不能只靠 mouseup 兜底** —— 鼠标在窗口外松开时
			// mouseup 不一定送达，那时位置就停在旧值上。
			this.saveLayout();
			event.preventDefault();
		};
		const onUp = () => {
			if (start === null) return;
			start = null;
			handle.classList.remove("dragging");
			document.body.style.cursor = "";
			// 松手时补一次，把最后那一小段位移也存上
			this.saveLayout();
		};

		handle.addEventListener("mousedown", (event) => {
			// 点在按钮上 → 那是按钮的点击，不是拖动
			if (event.target?.closest?.("button") !== null) return;
			if (event.button !== 0) return;
			const rect = this.root.getBoundingClientRect();
			start = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
			handle.classList.add("dragging");
			document.body.style.cursor = "grabbing";
			event.preventDefault();
		});
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	}

	/**
	 * 组装面板骨架。
	 */
	build() {
		this.tagLabel = el("b", { class: "tag", text: "—" });
		this.locLabel = el("span", { class: "loc", text: "", title: "点击复制源码位置" });
		this.locLabel.addEventListener("click", () => {
			if (this.location === null) return;
			const text = `${this.location.file}:${this.location.line}`;
			void navigator.clipboard?.writeText(text);
			this.setStatus("ok", `已复制 ${text}`);
		});

		// 折叠按钮：放在标题栏**最左边**（和「▸/◂」的指向一致 —— 面板在右侧，
		// 收起是往左收，所以收起态显示 ◂）
		this.collapseBtn = el("button", {
			class: "panel-act",
			text: "▸",
			title: "收起面板",
			onClick: (event) => {
				// 别让点击冒泡成拖动（拖动在 mousedown 上，这里再挡一层更稳）
				event?.stopPropagation?.();
				this.setCollapsed(!this.root.classList.contains("collapsed"));
			}
		});

		const head = el("div", { class: "head", title: "拖动可以移动面板" }, [
			this.collapseBtn,
			el("span", { class: "grip", text: "⠿" }),
			el("span", { text: "画布" }),
			this.tagLabel,
			this.locLabel
		]);

		const groups = el("div", {}, STYLE_GROUPS.map((group) => this.buildGroup(group)));

		this.undoBtn = el("button", { text: "撤销", onClick: () => this.options.onUndo?.() });
		this.redoBtn = el("button", { text: "重做", onClick: () => this.options.onRedo?.() });
		this.parentBtn = el("button", { text: "选父级", onClick: () => this.options.onPickParent?.() });
		this.childBtn = el("button", { text: "选子级", onClick: () => this.options.onPickChild?.() });
		this.pendingApplyBtn = el("button", { class: "primary", text: "应用待确认", onClick: () => this.options.onApplyPending?.() });
		this.pendingDropBtn = el("button", { text: "丢弃", onClick: () => this.options.onDiscardPending?.() });
		const foot = el("div", { class: "foot" }, [
			this.undoBtn, this.redoBtn, this.parentBtn, this.childBtn
		]);
		const pendingFoot = el("div", { class: "foot" }, [this.pendingApplyBtn, this.pendingDropBtn]);

		this.root.append(
			head,
			groups,
			this.pendingBox,
			pendingFoot,
			el("div", { class: "hint", text: "拖拽元素可移动位置，拖动四角可改尺寸（落盘为样式属性）。点空白处取消选择。Alt+点击穿透到下层元素。" }),
			foot,
			this.status
		);
		// 标题栏兼作拖动把手（要等 head 进了 root 才有意义）
		this.bindDrag(head);
	}

	/**
	 * 构建一个样式分组。
	 * @param group - 分组定义。
	 * @returns 分组节点。
	 */
	buildGroup(group) {
		this.inputs = this.inputs ?? new Map();
		this.quickRows = this.quickRows ?? new Map();
		const rows = [];
		for (const item of group.items) {
			const input = this.buildInput(item);
			this.inputs.set(item.key, input);
			rows.push(el("div", { class: "row" }, [
				el("label", { text: item.label }),
				input,
				item.unit !== undefined ? el("span", { class: "unit", text: item.unit }) : null
			]));
			// 快选行的**容器常驻**，内容由 refreshQuickPicks 填。
			//
			// ⚠️ 不能在这里就把内容渲染好：`palette` 是"**选中变化时**重新收集"的，
			// 而这里只在面板构造时跑一次 —— 那样用户看到的永远是**上一次选中**的候选，
			// 而且从界面上看不出它是旧的（值都合理，只是属于别的元素）。
			if (typeof item.palette === "string") {
				const row = el("div", { class: "quick-row" });
				this.quickRows.set(item.key, { row, item });
				rows.push(row);
			}
		}
		return el("div", { class: "group" }, [el("h4", { text: group.title }), ...rows]);
	}

	/**
	 * 重填所有快选行 ——「画板上已经在用的值」。
	 *
	 * ## 为什么要有它
	 *
	 * 用户的原话：「颜色和文字这种则直接在侧边栏放置，选中组件时弹出的侧边栏
	 * 可以直接选中**已有组件的颜色和字体**」。
	 *
	 * 痛点很实在：改样式时每次都要**手输**颜色值 / 字体名，
	 * 而正确答案往往**就在画板上**（旁边那个按钮就是这个蓝）。
	 * 让人去记 `#4285f4` 或者翻源码，是工具该替他做的事。
	 *
	 * ## 呈现
	 *
	 * - **颜色** → 一排色块（色块本身就是最好的标签，不必再写十六进制）
	 * - **其他** → 一排文字片（字体名、字号、行高…）
	 *
	 * 点击即落盘，走 `applyValue`（和手动输入**完全同一条**路）。
	 *
	 * ## ⚠️ 必须每次 `update` 都调
	 *
	 * 候选来自 `getPalette()`，而那是"**选中变化时**重新收集"的。
	 * 只在构造时渲染一次的话，用户看到的永远是**上一次选中**的候选 ——
	 * 而且从界面上看不出它是旧的（值都合理，只是属于别的元素）。
	 *
	 * 没有候选的行**整行隐藏**：空行会把面板撑得很乱。
	 *
	 * @returns { void }。
	 */
	refreshQuickPicks() {
		for (const { row, item } of this.quickRows?.values() ?? []) {
			const values = this.options.getPalette?.()?.[item.palette] ?? [];
			if (values.length === 0) {
				row.replaceChildren();
				row.style.display = "none";
				continue;
			}
			row.style.display = "";
			row.replaceChildren(
				el("span", { class: "quick-label", text: "画板上的" }),
				...values.map((entry) => this.buildQuickChip(item, entry))
			);
		}
	}

	/**
	 * 建一个快选小片（色块或文字片）。
	 *
	 * @param item - 字段定义。
	 * @param entry - { value, count }。
	 * @returns 节点。
	 */
	buildQuickChip(item, entry) {
		const isColor = item.palette === "colors";
		return el("button", {
			class: isColor ? "quick-swatch" : "quick-chip",
			type: "button",
			// 提示里带上"画板上用了多少处"：多个候选长得像时，这是唯一能区分的信息
			title: `${entry.value}　（画板上用了 ${entry.count} 处）`,
			style: isColor ? { background: entry.value } : undefined,
			text: isColor ? "" : String(entry.value).slice(0, 22),
			// 走 applyValue —— 和手动输入**完全同一条**落盘路径
			onClick: () => this.applyValue(item, entry.value)
		});
	}

	/**
	 * 按字段定义把值转成声明，并预览或落盘。
	 *
	 * 抽出来是为了让**快选和手动输入走完全同一条路**：单位补全、空值处理、
	 * 预览与落盘的分工，都不该有两套实现（两套迟早会不一致）。
	 *
	 * @param item - 字段定义。
	 * @param value - 值。
	 * @param mode - "preview" 只改 DOM；其他值落盘。
	 * @returns { void }。
	 */
	applyValue(item, value, mode = "commit") {
		if (this.suppress) return;
		const declarations = {};
		if (value === "") declarations[item.key] = null;
		else if (item.unit !== undefined && /^-?\d+(\.\d+)?$/u.test(value)) declarations[item.key] = `${value}${item.unit}`;
		else declarations[item.key] = value;

		if (mode === "preview") this.options.onPreview?.(declarations, { source: "panel" });
		else this.options.onDeclare?.(declarations, { source: "panel" });
	}

	/**
	 * 构建一个属性输入控件。
	 * @param item - 属性定义。
	 * @returns 控件节点。
	 */
	buildInput(item) {
		/**
		 * 把控件的原始值转成样式声明（补单位等）。
		 * @param value - 控件值。
		 * @returns 声明对象。
		 */
		const toDeclarations = (value) => {
			const declarations = {};
			if (value === "") declarations[item.key] = null;
			else declarations[item.key] = item.unit !== undefined && /^-?\d+(\.\d+)?$/u.test(value) ? `${value}${item.unit}` : value;
			return declarations;
		};
		/**
		 * **实时预览**：只改 DOM，不写源码。
		 *
		 * 与 commit 分成两条路是刻意的：输入框每敲一个字符都落盘会写出几十个快照、
		 * 几十次 git 提交，而且撤销栈会被灌满。预览只动内存里的样式，落盘仍然只有一次。
		 * @param value - 控件值。
		 */
		const preview = (value) => {
			if (this.suppress) return;
			this.options.onPreview?.(toDeclarations(value), { source: "panel" });
		};
		/**
		 * 落盘（写回源码）。
		 * @param value - 控件值。
		 */
		const commit = (value) => {
			if (this.suppress) return;
			this.options.onDeclare?.(toDeclarations(value), { source: "panel" });
		};

		if (item.type === "select") {
			// 选项允许两种写法：裸字符串（值即标签），或 { label, value }。
			// 后者是给「值很长没法当标签」的字段用的——比如 clip-path 的形状预设。
			const options = item.options.map((option) => (typeof option === "string"
				? { label: option, value: option }
				: option));
			const select = el("select", {
				// select 没有"中间状态"，选完即终值，所以直接落盘，不需要预览这条路。
				onChange: (event) => commit(event.target.value)
			}, [
				el("option", { value: "", text: "—" }),
				...options.map((option) => el("option", { value: option.value, text: option.label }))
			]);
			return select;
		}
		const input = el("input", {
			type: item.type === "color" ? "color" : item.type === "number" ? "number" : "text",
			step: item.step,
			min: item.min,
			max: item.max,
			// input = 每次改动（含逐字符、拖动取色器）→ 只预览
			onInput: (event) => preview(event.target.value),
			// change = 失焦或回车 → 落盘。取色器是关掉时触发，正好是"选完了"。
			onChange: (event) => commit(event.target.value),
			onKeyDown: (event) => {
				if (event.key === "Enter") commit(event.target.value);
			}
		});
		return input;
	}

	/**
	 * 面板挂载到 Shadow root。
	 * @param shadowRoot - Shadow root。
	 */
	mount(shadowRoot) {
		shadowRoot.append(this.root);
	}

	/**
	 * 用选中元素的信息刷新面板。
	 *
	 * @param info - {
	 *   tagName, location: { file, line, confidence } | null,
	 *   styles: { [property]: string }, pending: number, canUndo, canRedo
	 * }
	 */
	update(info) {
		this.location = info.location ?? null;
		this.tagLabel.textContent = info.tagName ?? "—";
		this.locLabel.textContent = this.location === null
			? "未定位"
			: `${this.location.file}:${this.location.line}${this.location.confidence === "inferred" ? "?" : ""}`;

		// 回填控件：期间屏蔽事件，避免程序性赋值被当成用户输入。
		this.suppress = true;
		for (const [key, input] of this.inputs ?? []) {
			const value = info.styles?.[key] ?? "";
			if (input.tagName === "SELECT") {
				const has = [...input.options].some((option) => option.value === value);
				input.value = has ? value : "";
			} else if (input.type === "color") {
				// 兜底必须是**合法的 #rrggbb**。
				// 早先这里写的是 `"var(--bg-app, #000000)"` —— 一个 CSS 令牌字符串，
				// `input[type=color]` 拒绝它，并在控制台刷
				// 「The specified value … does not conform to the required format」。
				// 取色器只认十六进制，给它别的任何东西都是无意义的。
				input.value = /^#[0-9a-f]{6}$/iu.test(value) ? value : "#000000";
			} else if (input.type === "number") {
				// **只喂单个数值。** 计算样式常常是多值（`0px 12px`、`0px 0px 8px`）
				// 或关键字（`normal`、`auto`），直接塞进 number 输入框会刷
				// 「cannot be parsed, or is out of range」。
				//
				// 拿不到单值时**留空**而不是硬塞：硬塞非法值会被浏览器丢掉、
				// 输入框仍显示上一次的旧值，用户看到的是**过时的数字**，比空更误导。
				const single = /^(-?[\d.]+)px$/u.exec(value.trim());
				input.value = single === null ? "" : single[1];
			} else {
				input.value = value.replace(/px$/u, "");
			}
		}
		this.suppress = false;

		// 每次选中变化都重填"画板上已有的值"。
		//
		// ⚠️ 少了这一行，快选里显示的会是**上一次选中**的候选 ——
		// 而且从界面上完全看不出来（值都合理，只是属于别的元素）。
		this.refreshQuickPicks();

		this.undoBtn.disabled = info.canUndo !== true;
		this.redoBtn.disabled = info.canRedo !== true;
		this.childBtn.disabled = info.hasChild === false;

		const pending = info.pending ?? 0;
		this.pendingBox.classList.toggle("hidden", pending === 0);
		if (pending > 0) {
			this.pendingBox.replaceChildren(el("div", { text: `有 ${pending} 条改动等待确认` }));
			this.pendingApplyBtn.disabled = false;
			this.pendingDropBtn.disabled = false;
		} else {
			this.pendingApplyBtn.disabled = true;
			this.pendingDropBtn.disabled = true;
		}
	}

	/**
	 * 在面板底部显示一条状态。
	 * @param tone - "ok" | "err" | "warn" | "info"。
	 * @param text - 文案。
	 */
	setStatus(tone, text) {
		this.status.className = `status ${tone}`;
		this.status.textContent = text;
	}
}
