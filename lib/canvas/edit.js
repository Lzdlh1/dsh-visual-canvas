/**
 * 画布内的编辑层：在画板的 iframe 里点选元素、改样式、写回源码。
 *
 * ## 为什么能这么做（前提是刻意的）
 *
 * 画板里的页面与画布外壳**同源**（都由插件在同一个端口上代理），所以外壳可以直接
 * 往 iframe 的 document 上挂事件监听、用 `elementFromPoint` 命中元素、读它的 class 与文本。
 *
 * ## 坐标换算（这里最容易错）
 *
 * iframe 的 **CSS 尺寸**始终等于设备尺寸，画布缩放只影响它的**显示尺寸**。
 * 而挂画板 document 上的事件，`event.clientX/clientY` 已经是**画板内坐标**——
 * 不要再当屏幕坐标换算一次（这个坑踩过，表现是「点了完全没反应」）。
 */

/**
 * 所以外壳可以直接：
 * - 往 iframe 的 document 上挂事件监听
 * - 用 `elementFromPoint` 命中元素
 * - 读它的 class / 文本 / 框架内部信息
 *
 * 如果不同源，就只能给每个画板各注入一份覆盖层，然后靠 postMessage 互相喊——
 * 那正是我不想走的路（N 个浮动面板、N 条连接、N 份选中态）。
 *
 * ## 坐标换算（这里最容易错）
 *
 * iframe 的 **CSS 尺寸**始终等于设备尺寸（1440×900 就是 1440×900 CSS 像素），
 * 画布缩放只影响它的**显示尺寸**。于是：
 *
 * ```
 * 显示缩放比 scale = iframe.getBoundingClientRect().width / iframe.clientWidth
 * 屏幕坐标 → 画板内坐标：(screenX − rect.left) / scale
 * 画板内坐标 → 屏幕坐标：rect.left + localX × scale
 * ```
 *
 * 用 `rect.width / clientWidth` 而不是直接用画布的 zoom 是刻意的：
 * 这样无论以后加了「单独缩放某块画板」还是别的变换，换算依然成立。
 *
 * ## 复用了什么
 *
 * - `describeElement`（overlay/core.js）：元素 → 源码线索
 * - `EditorPanel` + `PANEL_CSS`（overlay/editor.js）：样式面板本体
 *
 * 注意 import 写的是 `./core.js` 而不是 `../overlay/core.js`：
 * 磁盘上它们在两个目录，但**URL 上是同一层**（都由 `<前缀>/__canvas__/<名字>` 提供），
 * 所以按 URL 相对路径写才对。写错的话浏览器会去请求 `<前缀>/overlay/core.js` 而 404。
 *
 * 面板放进 Shadow DOM：`PANEL_CSS` 里的 `.status` / `.head` 等类名与画布外壳自己的
 * 样式会撞车，隔离掉最省事，也保证两处观感一致。
 */

import { describeElement, readInlineStyles } from "./core.js";
import { collapseTranslates, composeTransform, computeSnap } from "./view.js";
import { EditorPanel, PANEL_CSS, el } from "./editor.js";
// ⚠️ 这里**只能 import 浏览器安全、且已登记进白名单**的模块。
//
// 这个 import 踩过**两个**坑，每一个都会让**整份外壳脚本不执行**
//（画板列表空、点什么都没反应，看起来像"画布坏了"）：
//
//   1. 一开始写 `from "../log.js"` —— `log.js` 为了落盘 import 了 `node:fs`，
//      浏览器加载它直接失败。
//   2. 拆出 `trace.js` 后放在**上一层**（`lib/`），而外壳文件由**白名单**提供
//      （`lib/handler.js` 的 `SHELL_FILES`），浏览器请求 `../trace.js` 拿到 404。
//
// 结论：外壳模块必须**和引用方同目录**，并且**先在 `SHELL_FILES` 里登记**。
import { newTrace } from "./trace.js";
import { collectPalette } from "./palette.js";
import {
	LINK_DIRECTIONS,
	LINK_KINDS,
	canMount,
	collectLinksFromDocument,
	ensureLinkId,
	followersOf
} from "./links.js";

/** 空调色板：收集失败时的兜底（形状必须和 `collectPalette` 的返回一致）。 */
const EMPTY_PALETTE = { colors: [], fonts: [], sizes: [], weights: [], leadings: [], textStyles: [] };

/**
 * 让一个浮层能被它的把手拖动，并把位置记在本机。
 *
 * ## 为什么不用 HTML5 拖放
 *
 * `draggable` + dragstart/drop 在 **Shadow DOM** 里跨影子边界时表现不一致，
 * 而且拖拽期间拿不到连续的 pointermove（只有几个离散事件），拖起来一跳一跳。
 * 这里要的是"跟手"，所以直接用 pointer 事件 + setPointerCapture。
 *
 * ## 为什么记的是 left/top 而不是 bottom
 *
 * 浮层初始用 `left + bottom` 定位（贴左下角）。一旦拖动过，就必须换成
 * `left + top`——否则窗口一改尺寸，浮层会跟着底边跑，位置就"漂"了。
 *
 * @param box - 要拖动的浮层。
 * @param handle - 把手元素（通常标题栏）。
 * @param storageKey - localStorage 键名。
 */
function makeDraggable(box, handle, storageKey) {
	let drag = null;

	// 恢复上次位置。存的是 left/top，恢复时也要把 bottom 清掉，否则两套定位打架。
	try {
		const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
		if (saved !== null && typeof saved.x === "number") {
			box.style.left = `${saved.x}px`;
			box.style.top = `${saved.y}px`;
			box.style.bottom = "auto";
		}
	} catch { /* 存坏了就当没存过 */ }

	handle.addEventListener("pointerdown", (event) => {
		// 折叠按钮上的按下不该触发拖动
		if (event.target !== handle && event.target.closest("button") !== null) return;
		const rect = box.getBoundingClientRect();
		drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
		handle.setPointerCapture?.(event.pointerId);
		event.preventDefault();
	});

	handle.addEventListener("pointermove", (event) => {
		if (drag === null) return;
		// 夹在视口内：拖出去就再也抓不回来了
		const x = Math.max(0, Math.min(window.innerWidth - 60, event.clientX - drag.dx));
		const y = Math.max(0, Math.min(window.innerHeight - 24, event.clientY - drag.dy));
		box.style.left = `${x}px`;
		box.style.top = `${y}px`;
		box.style.bottom = "auto";
	});

	/**
	 * 结束拖动并记住位置。
	 * @param event - pointerup / pointercancel 事件。
	 */
	const end = (event) => {
		if (drag === null) return;
		drag = null;
		handle.releasePointerCapture?.(event.pointerId);
		const rect = box.getBoundingClientRect();
		try {
			localStorage.setItem(storageKey, JSON.stringify({ x: Math.round(rect.left), y: Math.round(rect.top) }));
		} catch { /* 存不下就算了 */ }
	};
	handle.addEventListener("pointerup", end);
	handle.addEventListener("pointercancel", end);
}

/**
 * 缩放手柄的公共样式：屏幕上恒定大小，不随画布缩放。
 *
 * `zIndex` 必须**高于样式面板**（面板是 2147483000，从单页覆盖层继承的
 * 「压住整页」设定）。手柄只有 8px，一旦被面板盖住就彻底抓不到——
 * 实测症状就是「元素右侧/下侧的手柄按不动，工具拒绝改变大小」。
 * 让手柄压过面板在视觉上有点怪（小方块浮在面板上），但 8px 的抓取目标
 * 必须永远可点，这个取舍是值得的。
 */
const HANDLE_STYLE = {
	position: "fixed",
	width: "9px",
	height: "9px",
	background: "#fff",
	border: "1px solid #4f8cff",
	borderRadius: "2px",
	display: "none",
	pointerEvents: "auto",
	zIndex: "2147483100",
	boxSizing: "border-box"
};

/**
 * 每个手柄相对选中框的定位（用 translate 把自己摆到边/角上）。
 * @param name - nw/n/ne/e/se/s/sw/w。
 * @returns 样式对象。
 */
function handleOffset(name) {
	const x = name.includes("w") ? "0%" : name.includes("e") ? "100%" : "50%";
	const y = name.includes("n") ? "0%" : name.includes("s") ? "100%" : "50%";
	const cursor = {
		nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize",
		n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize"
	}[name];
	return { left: x, top: y, transform: "translate(-50%, -50%)", cursor };
}

/**
 * 画布内的编辑层。
 */
/**
 * 元素在文档里的**结构路径**（从 body 往下的 nth-child 索引链）。
 *
 * ## 为什么需要它
 *
 * 落盘成功后画板会重载（iframe 重新导航），原来的 DOM 节点全部作废——
 * `this.selected` 变成一个**游离节点**：它不在文档里，`getBoundingClientRect()`
 * 全返回 0。后果是选中框要么跑到画板左上角，要么停在原地不动，而元素早就不在那里了。
 * 用户看到的就是「改了尺寸/移动之后，框不跟着走」。
 *
 * 路径比"选择器"可靠：`nth-child` 索引在同一份源码重载后是稳定的
 * （DOM 结构没变，只是样式/尺寸变了），而 class 可能重复、文本可能被改。
 *
 * @param element - 目标元素。
 * @returns {number[]|null} 索引链；拿不到时返回 null。
 */
export function elementPathOf(element) {
	try {
		if (element === null || element === undefined || element.isConnected === false) return null;
		const doc = element.ownerDocument;
		const parts = [];
		let node = element;
		// ⚠️ 走到 **body 为止**（不含 body 自己）。
		//
		// 早先写的是"走到 parentElement 为 null"，那会把 `<body>` 在 `<html>` 里的
		// 索引也记进去，于是 `resolveElementPath` 从 body 往下走时会**错位一层**
		// （拿 body 的兄弟索引去找 body 的子元素）—— 恢复出来的元素整个是错的。
		while (node !== null && node !== doc.body && node.parentElement !== null) {
			const parent = node.parentElement;
			const index = Array.prototype.indexOf.call(parent.children, node);
			if (index < 0) return null;
			parts.unshift(index);
			node = parent;
		}
		return parts.length === 0 ? null : parts;
	} catch {
		return null;
	}
}

/**
 * 按结构路径找回元素。
 *
 * @param doc - 新文档。
 * @param parts - `elementPathOf` 的结果。
 * @returns {Element|null} 找不到时返回 null（元素可能已被删掉）。
 */
export function resolveElementPath(doc, parts) {
	try {
		if (!Array.isArray(parts) || parts.length === 0) return null;
		let node = doc.body;
		for (const index of parts) {
			const next = node?.children?.[index];
			if (next === undefined || next === null) return null;
			node = next;
		}
		return node === doc.body ? null : node;
	} catch {
		return null;
	}
}

/**
 * 元素的简短标识（`div.dsh-shape 161×215` 这种），用于拖动/缩放时的即时提示。
 *
 * ## 为什么要显示它（2026-10-07 用户报「另一个组件随机偏移」的真因）
 *
 * 画板上的形状会**重叠**，而 `elementFromPoint` 拿的是**最顶层**的那一个。
 * 用户按住自己看得见的 A 拖，实际命中并移动的可能是盖在上面的 B ——
 * 他的体感就是「我没选 B，B 却动了，而 A 没动」，并合理地怀疑"组件之间有依赖"。
 *
 * 光显示 `div.dsh-shape` **没有用**：两个形状的标识一模一样，分不出区别。
 * 所以把**尺寸**也带上——同类元素靠它就能对上号（`161×215` 和 `124×134`）。
 *
 * ## ⚠️ 只在拖动/缩放**开始时**调一次
 *
 * `getBoundingClientRect()` 是强制同步布局。这个函数要是每帧都调，
 * 就又踩回"拖动发粘"那个坑（见 `snapTargetsFor` 的注释）。
 *
 * @param element - 元素。
 * @returns 形如 `div.dsh-shape 161×215` 的字符串。
 */
function elementLabel(element) {
	if (element === null || element === undefined) return "?";
	const tag = String(element.tagName ?? "?").toLowerCase();
	const cls = typeof element.className === "string" && element.className.trim() !== ""
		? `.${element.className.trim().split(/\s+/u).slice(0, 2).join(".")}`
		: "";
	const rect = element.getBoundingClientRect();
	return `${tag}${cls} ${Math.round(rect.width)}×${Math.round(rect.height)}`;
}

export class CanvasEditor {
	/**
	 * @param options - {
	 *   wsPath: WebSocket 路径（如 "/canvas/__canvas__/ws"）,
	 *   panelTop: () => number,   面板上边缘（避开外壳顶栏，否则会挡住工具栏按钮）,
	 *   onStatus: (tone, text) => void
	 * }。
	 */
	constructor(options) {
		this.wsPath = options.wsPath;
		this.onStatus = options.onStatus ?? (() => {});
		/** 画板内滚轮 → 由外壳执行缩放（锚点已换算成外壳视口坐标）。 */
		this.onCanvasZoom = options.onCanvasZoom ?? (() => {});
		/**
		 * 中键平移回调：(phase, screenX, screenY, event) => void。
		 * 画板是 iframe、事件不外冒，所以中键必须从画板里转发出来。
		 */
		this.onCanvasPan = options.onCanvasPan ?? (() => {});
		/** 锁定判断：返回 true 的元素在画布上点不中（锁定只是本地辅助，不是权限）。 */
		this.isLocked = options.isLocked;
		/** 选中变化回调（图层树靠它同步高亮）。 */
		this.onSelectionChange = options.onSelectionChange ?? (() => {});
		/**
		 * 关联选择模式的回调：画布上点中了"要关联的目标"。
		 *
		 * ⚠️ **这两个回调曾经整整两天没有工作过**：调用处写的是
		 * `this.onLinkPick?.(target)` —— 可选链让"回调是 undefined"这件事
		 * **完全不报错**，只是静默跳过。而根因就在这里：构造函数没保存它。
		 * 症状是"点了没反应"，而探针证明 onFrameClick 执行了、commentMode
		 * 也是 true —— 全链路只有"回调不存在"这最后一步是断的。
		 *
		 * 教训：**凡是 `this.xxx?.()` 形式的调用，构造函数必须保存 xxx**。
		 * 可选链的静默性 + 忘记保存 = 最难查的一类 bug。
		 */
		this.onLinkPick = options.onLinkPick ?? null;
		/** 注释模式的回调：点中了"要评论的元素"（见上一条的教训）。 */
		this.onCommentPick = options.onCommentPick ?? null;
		/**
		 * 画板里按下 Esc 的回调。
		 *
		 * **为什么需要它**：焦点在画板 iframe 里时，键盘事件不会冒泡到
		 * 外壳的 `window`。用户点画板元素选中后按 Esc，
		 * 外壳那个监听**根本收不到** —— 表现就是"选中后退不出去，只能刷新"。
		 *
		 * 和 `onLinkPick` 一样，**必须在构造函数里保存**：
		 * 调用处是 `this.onEscape?.()`，可选链对 undefined 静默跳过。
		 */
		this.onEscape = options.onEscape ?? null;
		// 面板在单页覆盖层里可以贴顶（那里没有工具栏），但画布外壳有顶栏——
		// 直接沿用 `top: 12px` 会把「添加画板 / 选择元素 / 适应 / 重载」全挡住。
		// 所以上边缘由外壳给（做成函数：窗口尺寸变了要重算）。
		this.panelTop = options.panelTop ?? (() => 12);
		/** id → { iframe, attached, hoverHandler, clickHandler, moveHandler, leaveHandler }。 */
		this.frames = new Map();
		this.activeId = null;
		this.pickMode = false;
		this.selected = null;
		this.located = null;
		/**
		 * 拖动状态。
		 *
		 * **必须在构造函数里初始化成 null**：不初始化时值是 `undefined`，
		 * 而下面用的是 `=== null` 判断（`undefined === null` 为 false），
		 * 于是「没有拖动」会被当成「正在拖动」，直接读到 undefined 的属性而抛异常。
		 * 我正是在真实浏览器里撞到的这条。
		 */
		this.drag = null;
		this.pendingDrag = null;
		/** 一次已经发给宿主、还在等回执的写回（用于决定刷新还是回滚）。 */
		this.pendingCommit = null;
		/**
		 * 落盘后要恢复的选中（元素结构路径）。
		 *
		 * 画板重载会重建 DOM，旧引用作废；记下路径就能在新文档里找回同一个元素，
		 * 让选中框继续跟着它——否则框会停在原地、或者跑到画板左上角（游离节点 rect 全 0）。
		 */
		this.pendingReselect = null;
		/**
		 * 已排队的重绘帧号（0 = 没有排队）。
		 *
		 * 见 `scheduleSyncBoxes()`：把同一帧内的多次重绘合并成一次。
		 */
		this.boxFrame = 0;
		/**
		 * 刚发出的撤销/重做（"undo" / "redo" / null）。
		 *
		 * 撤销**没有 pendingCommit**，而 `settleCommit` 第一行就是
		 * 「拿不到 commit 就 return」——所以它的回执到了也不会重载画板，
		 * 用户看到的就是「撤销没反应」（宿主其实已经回滚了）。
		 * 用这个字段认出"这条回执是撤销的"，改走重载那条路。
		 */
		this.pendingHistoryReload = null;
		/**
		 * 拖动这一帧待画的「辅助线 / 冻结框 / 状态栏」。
		 *
		 * 这三件事原本每次 `mousemove` 都做一遍，而高刷屏上一秒能来 200+ 次——
		 * 辅助线更是 `replaceChildren` 全量重建。用户的原话是
		 * 「**移动速度快了还是有明显延迟**」。现在合并成每帧最多一次。
		 */
		this.pendingFrame = null;
		/** 已经排队的帧回调（0 表示没排队）。 */
		this.dragFrame = 0;
		/** 上次画的辅助线签名，没变就不动 DOM。 */
		this.guidesKey = null;
		/** 上次写进状态栏的文字，没变就不写。 */
		this.metricsShown = null;
		/**
		 * 当前操作的 trace（跨进程排查用）。
		 *
		 * 一次"用户操作"（点选 / 拖动 / 面板改动）共用一个，
		 * 发消息时自动带上，宿主记进它的日志 —— 两边按这一个 id 就能对上。
		 */
		this.trace = null;
		/**
		 * "画板上已经在用的值"（颜色 / 字体 / 字号 / 整套文字样式）。
		 *
		 * 面板上每个字段下面那排快选就取自这里。它在**选中变化时**刷新
		 *（见 `refreshPalette`）—— 收集要遍历画板里的每个元素，不能更频繁。
		 */
		this.palette = EMPTY_PALETTE;
		/** 正在进行的缩放（拖手柄）。 */
		this.resize = null;
		this.socket = null;
		this.pending = 0;
		this.canUndo = false;
		this.canRedo = false;
		this.buildUi();
		this.connect();
	}

	// #region 界面（高亮框 + 面板，都在 Shadow DOM 里）

	/**
	 * 建立 Shadow DOM：高亮框与样式面板。
	 */
	buildUi() {
		const host = el("div", { id: "__dsh_canvas_editor__" });
		// pointer-events: none 让整个宿主不挡画布；面板自身再打开事件。
		host.style.cssText = "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 30;";
		this.host = host;
		this.shadow = host.attachShadow({ mode: "open" });
		const style = document.createElement("style");
		style.textContent = PANEL_CSS;
		this.shadow.append(style);

		this.hoverBox = el("div", {
			style: {
				position: "fixed", pointerEvents: "none", border: "1px dashed #9aa0a6",
				display: "none", zIndex: "31"
			}
		});
		this.box = el("div", {
			style: {
				position: "fixed", pointerEvents: "none", border: "1px solid #4f8cff",
				background: "rgba(79,140,255,.12)", display: "none", zIndex: "32"
			}
		});
		this.badge = el("div", {
			style: {
				position: "fixed", pointerEvents: "none", background: "#4f8cff", color: "#fff",
				font: "11px/1.6 ui-monospace, Consolas, monospace", padding: "1px 6px",
				borderRadius: "3px", display: "none", zIndex: "33", whiteSpace: "nowrap"
			}
		});
		// 操作过程中的实时数值：贴在一个固定位置（视口顶部居中），
		// 跟着光标跑反而会挡住要看的东西。
		this.metrics = el("div", {
			style: {
				position: "fixed", left: "50%", top: "12px", transform: "translateX(-50%)",
				pointerEvents: "none", background: "rgba(20,24,30,.92)", color: "#fff",
				font: "12px/1.6 ui-monospace, Consolas, monospace", padding: "3px 10px",
				borderRadius: "6px", display: "none", zIndex: "35", whiteSpace: "nowrap"
			}
		});

		this.panel = new EditorPanel({
			onDeclare: (declarations) => this.declare(declarations),
			// 实时预览：输入框每敲一下走这条，只改 DOM 不写源码。
			// 与 onDeclare 分开是刻意的——每敲一个字符都落盘会写出几十个快照和 git 提交。
			onPreview: (declarations) => this.previewFromPanel(declarations),
			// 面板上每个字段下面那排"画板上已经在用的值"就从这里取。
			// 见 refreshPalette 的说明：收集要遍历画板里的元素，不能每帧做。
			getPalette: () => this.palette,
			onUndo: () => this.history("undo"),
			onRedo: () => this.history("redo"),
			onApplyPending: () => this.send({ type: "applyPending" }),
			onDiscardPending: () => this.send({ type: "discardPending" }),
			onPickParent: () => this.selectRelative("parent"),
			onPickChild: () => this.selectRelative("child")
		});
		// 面板要能点，所以单独打开事件；它自己会被放到固定位置。
		this.panel.root.style.pointerEvents = "auto";
		this.panel.root.style.display = "none";

		// 候选区：定位不唯一时列出备选，让「猜的」变成「可改的」。
		//
		// 结构分成**标题栏 + 内容区**两块，因为标题栏要同时承担两件事：
		// 拖动把手、折叠开关。常驻展开会挡住画布视野，所以这两件都必须有。
		this.candidateTitle = el("span", {
			style: { flex: "1 1 auto", font: "600 11px/1.6 ui-monospace,Consolas,monospace", opacity: ".75" },
			text: "定位候选"
		});
		this.candidateBody = el("div", { style: { overflow: "auto", maxHeight: "34vh" } });
		const candidateHead = el("div", {
			style: {
				display: "flex", alignItems: "center", gap: "6px",
				cursor: "move", userSelect: "none", marginBottom: "4px"
			}
		}, [
			this.candidateTitle,
			el("button", {
				style: {
					flex: "0 0 auto", width: "18px", height: "18px", padding: "0", cursor: "pointer",
					background: "transparent", color: "#9aa0a6", border: "1px solid rgba(128,140,155,.35)",
					borderRadius: "4px", font: "10px/1 monospace"
				},
				text: "▾",
				title: "折叠 / 展开",
				onClick: (event) => {
					event.stopPropagation();
					this.setCandidatesCollapsed(!this.candidatesCollapsed);
				}
			})
		]);
		this.candidateBox = el("div", {
			style: {
				position: "fixed", left: "12px", bottom: "12px", width: "420px",
				pointerEvents: "auto", display: "none",
				background: "rgba(24,28,34,.97)", color: "#e7eaee", padding: "8px 10px",
				border: "1px solid rgba(128,140,155,.4)", borderRadius: "8px",
				boxShadow: "0 8px 24px rgba(0,0,0,.45)",
				zIndex: "2147483200"
			}
		}, [candidateHead, this.candidateBody]);
		makeDraggable(this.candidateBox, candidateHead, "dsh-canvas:candidates-pos");
		/** 候选区是否折叠。常驻展开会挡视野，所以状态要记住。 */
		this.candidatesCollapsed = false;

		// 辅助线层：放在最底（先 append），这样它画在选中框下面，
		// 不会盖住手柄——吸附线本身也不需要交互。
		this.guideLayer = el("div", { style: { position: "fixed", inset: "0", pointerEvents: "none", zIndex: "2147483050" } });
		this.shadow.append(this.guideLayer, this.hoverBox, this.box, this.badge, this.metrics, this.candidateBox, this.panel.root);
		document.documentElement.append(host);

		/**
		 * 八个缩放手柄（四边 + 四角）。
		 *
		 * 放在**外壳**这一层而不是画板里：画板被画布缩放到 30% 时，
		 * 画板内的手柄会跟着缩成 3px，根本抓不住。外壳层的手柄始终是屏幕上 8px。
		 */
		this.handles = new Map();
		for (const name of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
			const handle = el("div", { style: { ...HANDLE_STYLE, ...handleOffset(name) } });
			handle.dataset.handle = name;
			handle.addEventListener("mousedown", (event) => this.onHandleDown(name, event));
			this.handles.set(name, handle);
			this.shadow.append(handle);
		}

		// 窗口尺寸变化后顶栏高度可能变（换行等），重新贴一次。
		window.addEventListener("resize", () => this.placePanel());
		// 缩放手柄在外壳层，但**这不代表事件不会丢**：光标落到画板（iframe）上方时，
		// mouseup 会被 iframe 吃掉、不冒泡到父文档。所以除了这里监听，
		// onHandleMove 里还有一条「左键已松开就收尾」的兜底。
		window.addEventListener("mousemove", (event) => this.onHandleMove(event));
		window.addEventListener("mouseup", (event) => this.onHandleUp(event));
		// 鼠标离开窗口（切到别的应用）时也把手势收掉，免得回来还在拖。
		window.addEventListener("blur", () => {
			this.onHandleUp({ preventDefault: () => {}, stopPropagation: () => {}, clientX: 0, clientY: 0, buttons: 0 });
			this.onFramePointerUp({ preventDefault: () => {}, stopPropagation: () => {}, buttons: 0 });
		});
	}

	/**
	 * 把面板放到顶栏下方。
	 *
	 * 每次显示前都要调：顶栏高度会随窗口宽度变化（按钮换行），
	 * 算一次就固定住的话窄窗口下又会压住工具栏。
	 *
	 * ⚠️ 但**用户自己拖过面板的话要让位** —— 由 `panel.placeTop()` 判断，
	 * 不然会出现"拖了、松手、选下一个元素，面板又跳回右上角"，
	 * 看起来像拖动根本没生效。
	 */
	placePanel() {
		this.panel.placeTop?.(this.panelTop());
	}

	// #endregion

	// #region 与宿主的连接

	/**
	 * 建立到宿主的 WebSocket。
	 */
	connect() {
		const scheme = location.protocol === "https:" ? "wss:" : "ws:";
		const url = `${scheme}//${location.host}${this.wsPath}`;
		try {
			this.socket = new WebSocket(url);
		} catch (error) {
			this.onStatus("err", `无法连接宿主：${String(error?.message ?? error)}`);
			return;
		}
		this.socket.addEventListener("open", () => {
			this.onStatus("ok", "已连接 DSH 画布宿主");
			this.send({ type: "hello", url: location.href });
		});
		this.socket.addEventListener("message", (event) => this.onMessage(event));
		this.socket.addEventListener("close", () => {
			this.onStatus("err", "与宿主断开，正在重连…");
			window.setTimeout(() => this.connect(), 1000);
		});
	}

	/**
	 * 发一条消息。
	 *
	 * **每条都自动带上 `trace`**：一次用户操作（点选 → 拖动 → 写回）共用同一个 id，
	 * 宿主那边原样记进每条日志。出问题时按 trace 一筛，就能把
	 * "外壳发了什么 → 宿主定位到哪 → 写回成功没有"完整串起来。
	 * 这正是第一版排查时最缺的东西：界面说"没反应"、宿主说"没收到"，
	 * 谁也证明不了自己。
	 *
	 * @param payload - 消息体。
	 * @returns 是否发出去了。
	 */
	send(payload) {
		if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) return false;
		const body = this.trace === null || this.trace === undefined
			? payload
			: { trace: this.trace, ...payload };
		this.socket.send(JSON.stringify(body));
		return true;
	}

	/**
	 * 记一条外壳侧的日志（转发给宿主**统一落盘**）。
	 *
	 * 编辑层跑在外壳、定位写回跑在宿主，两边各写各的文件会让排查变成对时间戳。
	 * 统一落到宿主的 JSONL 里，一份文件按 trace 就能串起来。
	 *
	 * ⚠️ **不参与业务**：发不出去就算了，不重试、不报错、不影响调用方。
	 *
	 * @param event - 机器可读的事件名。
	 * @param data - 附加上下文。
	 * @param level - error | warn | info | debug（默认 debug，避免刷屏）。
	 */
	log(event, data, level = "debug") {
		// **日志绝不能影响业务。**
		//
		// 整段包在 try 里，因为每一种"没有日志"的情况都真实存在：
		//   - `this.socket` 是 undefined（测试用 `Object.create(prototype)` 造对象，
		//     没走 constructor）
		//   - `WebSocket` 整个不存在（node 环境跑离线测试）
		//   - socket 正在关闭、序列化失败
		// 第一版把 socket 检查放在 try **外面**，结果离线测试直接 ReferenceError，
		// 连带把一个正常的断言集打挂。
		try {
			if (this.socket === null || this.socket === undefined) return;
			if (typeof WebSocket !== "function") return;
			if (this.socket.readyState !== WebSocket.OPEN) return;
			// 直接走 socket，不走 this.send —— 后者会再包一层 trace，
			// 而这里 trace 是显式给的（可能正在记录"发起一次新操作"本身）。
			this.socket.send(JSON.stringify({
				type: "log",
				trace: this.trace ?? undefined,
				level,
				event,
				data: data ?? {}
			}));
		} catch {
			// 日志失败绝不影响业务
		}
	}

	/**
	 * 开始一次**用户操作**：换一个新的 trace。
	 *
	 * 一次操作 = 从"用户按下/点选"到"写回结果回来"。
	 * 选中、拖动、面板改动各自算一次，这样日志里一眼能分清是哪次操作出的问题。
	 *
	 * @param action - 动作名（`click` / `drag` / `panel` / `resize`）。
	 * @returns 新的 trace。
	 */
	beginTrace(action) {
		this.trace = newTrace();
		this.log(`${action}-begin`, { action }, "info");
		return this.trace;
	}

	/**
	 * 处理宿主消息。
	 * @param event - MessageEvent。
	 */
	onMessage(event) {
		let payload;
		try {
			payload = JSON.parse(String(event.data));
		} catch {
			return;
		}
		if (payload.type === "located") {
			this.located = payload.location ?? null;
			this.syncBoxes();
			this.refreshPanel();
			if (this.located === null || this.located.file === null) {
				this.onStatus("warn", this.located?.reason ?? "没能在项目里找到这个元素的源码位置");
				return;
			}
			const mark = this.located.confidence === "exact" ? "" : "（按内容匹配，请核对）";
			this.onStatus("ok", `已定位 ${this.located.file}:${this.located.line}${mark}`);
			return;
		}
		// ⚠️ `mutated` **必须**在这个条件里。
		//
		// 实测踩过（和 `lib/index.js` 漏 mutate 分支是同一类错误）：
		// 这个分支原先写在下面 `if (payload.type === "applied" || payload.type === "state")`
		// 的**内部**，而 `mutated !== "applied" && mutated !== "state"` ——
		// 外层永远不成立，于是整段是**死代码**。
		//
		// 症状：形状插入**成功了**（宿主回执、文件真的改了），
		// 但因为这里不重载画板，新元素要**手动刷新页面才出现**。
		// 用户看到的就是"画是画上了，但得刷新一下"。
		//
		// 教训：**分支的位置和分支的内容一样要检查**。
		// 光看 `if (payload.type === "mutated")` 这行是对的，
		// 错的是它**嵌在了一个到不了的地方**。
		if (payload.type === "applied" || payload.type === "state" || payload.type === "mutated") {
			this.pending = payload.pending ?? this.pending;
			this.canUndo = payload.canUndo ?? this.canUndo;
			this.canRedo = payload.canRedo ?? this.canRedo;
			if (payload.type === "applied") {
				// **先认一下这条回执是不是撤销/重做的。**
				//
				// 撤销没有 pendingCommit，走 settleCommit 会被它第一行的
				// 「拿不到 commit 就 return」挡掉 → 画板不刷新 → 用户说"撤销没反应"。
				// 取完立刻清掉，避免下一次普通写回被误认。
				const historyType = this.pendingHistoryReload;
				this.pendingHistoryReload = null;
				if (historyType !== null && historyType !== undefined) {
					this.afterHistoryReload(payload);
				} else {
					// 注意顺序：先把宿主的**原始原因**交给 settleCommit，再由它决定最终文案。
					// 早先这里先写一句通用状态、紧接着被 settleCommit 覆盖成「多半是定位不到」，
					// 结果真正的原因（补丁校验失败？属性不允许？）全被吞掉，排查只能靠猜。
					this.settleCommit(payload.ok !== false, payload.message, payload.op);
				}
			}
			// 结构改动（复制/删除/插入/移动）。
			//
			// 成功要**重载画板**让新结构显示出来；失败要把宿主的原话照搬——
			// 它往往直接告诉用户下一步做什么（"定位不唯一，请先在候选列表里选定"），
			// 换成通用文案就等于把可操作的信息丢了。
			if (payload.type === "mutated") {
				// 重载**哪块**画板：发送时记下的比 `activeEntry` 准（见 sendMutate）。
				// 取完立刻清掉，否则下一次回执会误用上一次的目标。
				const target = this.pendingMutateEntry ?? this.activeEntry;
				this.pendingMutateEntry = null;
				if (payload.ok === false) {
					this.onStatus("err", payload.message ?? "结构改动失败");
				} else {
					this.onStatus("ok", payload.message ?? "已改动");
					this.hideCandidates();
					const entry = target;
					if (entry !== undefined) {
						// 结构变了，原来选中的元素可能已经不在文档里：先清掉引用再重载，
						// 否则重载后选中框会指向一个游离节点（表现为框停在原地不跟内容走）。
						this.selected = null;
						this.syncBoxes();
						// **必须通知外壳**：图层树的高亮和元素检查器都跟着「当前选中」走。
						// 不通知的话，删完元素它们还显示着已经不存在的东西——
						// 和"画完不刷新看不到图形"是同一类问题：**界面没跟上状态**。
						this.notifySelection();
						this.reloadBoard(entry);
					}
				}
			}
			this.refreshPanel();
		}
	}

	/**
	 * 收尾一次写回：成功就刷新画板让源码的值接管，失败就回滚预览。
	 *
	 * 为什么成功也要刷新：写回的是**源码**，而画面上的实时预览是行内样式。
	 * 不刷新的话两者会各说各话——你之后再改一次，位移会在旧预览上叠加，
	 * 越拖越偏。刷新一次让源码成为唯一事实来源。
	 *
	 * @param ok - 写回是否成功。
	 * @param reason - 宿主给的原因（失败时一定要显示出来，不要用通用文案覆盖）。
	 * @param op - 宿主回执里的操作信息（含**真正写入的文件与行号**）。
	 */
	settleCommit(ok, reason, op) {
		const commit = this.pendingCommit;
		if (commit === null || commit === undefined) return;
		this.pendingCommit = null;
		if (ok === false) {
			// 没写进去就把预览撤回原样，免得让人以为改动生效了。
			//
			// 两条来源都要还原：
			// - pendingCommit 覆盖的是拖动/缩放的预览（transform / width / height）
			// - previewOrigin 覆盖的是**面板实时预览**改过的任意属性
			//   只还原前三个是不够的——面板能改任意样式，漏掉的那些会留在页面上，
			//   看起来像"写进去了"，实际源码里没有。
			this.revertPreview();
			try {
				commit.node.style.transform = commit.origin?.transform ?? "";
				commit.node.style.width = commit.origin?.width ?? "";
				commit.node.style.height = commit.origin?.height ?? "";
			} catch { /* 画板可能已经销毁 */ }
			this.onStatus("err", `没能写入源码：${reason ?? "宿主未说明原因"}（已撤回预览）`);
			return;
		}
		// **成功后必须报出写到了哪个文件**。
		//
		// 定位是「按内容匹配」猜出来的，可能猜错文件；只显示「已写入源码」的话，
		// 用户根本无从判断它有没有写错地方。实测已经因此把尺寸样式写进了插件的真实外壳
		// （本该写原型文件），所以这个位置信息是安全底线，不是锦上添花。
		const where = op === undefined || op.file === undefined ? "" : ` → ${op.file}:${op.line}`;
		this.onStatus("ok", `${reason ?? "已写入源码"}${where}`);
		// 定位不唯一时把候选摆出来，并支持一键改用别的文件。
		// 换完要**重发同一次改动**，否则用户只是看到列表、改动还是落在原来那个文件里。
		if (Array.isArray(op?.candidates) && op.candidates.length > 1) {
			this.showCandidates(op.candidates, op.file, (item) => {
				this.onStatus("", `改写到 ${item.file}:${item.line}…`);
				this.send({
					type: "declare",
					hint: commit.hint,
					declarations: commit.declarations,
					boardPath: this.boardPathOf(commit.entry),
					pin: { file: item.file, line: item.line }
				});
			});
		} else {
			this.hideCandidates();
		}
		// **落盘前记下"要恢复成选中哪个元素"。**
		//
		// `reloadBoard` 会让 iframe 重新导航，DOM 全部重建，`this.selected`
		// 随即变成游离节点（`getBoundingClientRect()` 全 0）。
		// 不记路径的话，重载后选中框要么停在原地、要么跳到画板左上角——
		// 用户看到的就是「改了尺寸，框不跟着形状走」。
		this.pendingReselect = elementPathOf(commit.node);
		this.reloadBoard(commit.entry);
	}

	/**
	 * 重新加载一块画板（没有 HMR 的项目靠它把源码的新值显示出来）。
	 * @param entry - 画板条目。
	 */
	reloadBoard(entry) {
		if (entry === null || entry === undefined) return;

		// ⚠️ **这个 entry 有两种来源，字段名不同：**
		//
		//   - `edit.js` 自己的 `this.frames`：`{ id, iframe, data }`
		//   - `shell.js` 的 `state.boards`：`{ data, element, frame, name, meta, spec }`
		//
		// 只认 `iframe` 的话，**从外壳传进来的 entry 会静默失败**：
		// `entry.iframe` 是 undefined → `frame.contentWindow` 抛 TypeError →
		// catch 里再访问 `entry.iframe.src` 又抛 → **什么都不发生**。
		//
		// 症状正是用户报的：「拖进去之后画板上什么都没有、图层里也查不到」，
		// 而**源码其实写进去了**（状态栏显示「新建 …（prototype.html:550）」）。
		// 界面和源码不一致，是最容易被当成"没生效"的一类失败。
		const frame = entry.iframe ?? entry.frame ?? null;
		if (frame === null) return;
		try {
			// 重新赋 src 会触发一次导航；编辑层按 document 身份重挂监听，所以不会失联。
			frame.contentWindow.location.reload();
		} catch {
			try {
				frame.src = frame.src;
			} catch { /* 忽略 */ }
		}
	}

	// #endregion

	// #region 画板接线

	/**
	 * 同步当前有哪些画板（渲染后调用）。
	 *
	 * @param frames - [{ id, iframe, data }]。
	 */
	syncFrames(frames) {
		const seen = new Set();
		for (const frame of frames) {
			seen.add(frame.id);
			const existing = this.frames.get(frame.id);
			if (existing !== undefined) {
				existing.data = frame.data;
				continue;
			}
			const entry = { id: frame.id, iframe: frame.iframe, data: frame.data, attached: false };
			this.frames.set(frame.id, entry);
			this.attachWhenReady(entry);
		}
		for (const [id, entry] of [...this.frames]) {
			if (seen.has(id)) continue;
			this.detach(entry);
			this.frames.delete(id);
			if (this.activeId === id) this.select(null);
		}
	}

	/**
	 * 等 iframe 就绪后挂事件监听。
	 *
	 * ## 为什么用「document 身份」而不是布尔标记
	 *
	 * iframe **每次导航都会换一个新的 document**（刷新、HMR 重载、点链接都算），
	 * 挂在旧 document 上的监听随之作废。如果用 `attached = true` 这种布尔标记，
	 * 重新加载后就会因为「看起来已经挂过」而跳过挂载——
	 * 表现为**元素选择静默失效**（不报错，就是点不动）。
	 * 我就是在浏览器验证里踩到的：测试为了让页面带上新内容刷新了 iframe，
	 * 之后点击就没有任何反应。
	 *
	 * 所以这里记的是「我挂在哪个 document 上」，换 document 就重挂。
	 *
	 * @param entry - 画板条目。
	 */
	attachWhenReady(entry) {
		const attach = () => {
			let doc;
			try {
				doc = entry.iframe.contentDocument;
			} catch {
				return;
			}
			if (doc === null || doc === undefined || doc.body === null) return;
			// 同一个 document 且已经挂过 → 什么都不用做。
			if (entry.doc === doc && entry.attached === true) return;

			entry.doc = doc;
			entry.moveHandler = (event) => this.onFrameMove(entry, event);
			entry.clickHandler = (event) => this.onFrameClick(entry, event);
			entry.leaveHandler = () => this.clearHover();
			entry.wheelHandler = (event) => this.onFrameWheel(entry, event);
			// 画板里的按键：焦点在画板里时，外壳的快捷键监听收不到（iframe 不外冒）。
			// 漏了这条，用户「点画板选中 → 按 Delete」就完全没反应。
			entry.keyHandler = (event) => this.onFrameKey(event);
			// 中键平移：画板是 iframe、事件不外冒，所以必须在这里拦下来转发给外壳。
			entry.middleDown = (event) => {
				if (event.button !== 1) return;
				event.preventDefault();
				this.onFrameMiddle(entry, event, "start");
			};
			entry.middleMove = (event) => {
				if ((event.buttons & 4) === 0) return;
				event.preventDefault();
				this.onFrameMiddle(entry, event, "move");
			};
			entry.middleUp = (event) => {
				if (event.button !== 1) return;
				this.onFrameMiddle(entry, event, "end");
			};
			doc.addEventListener("mousedown", entry.middleDown, true);
			doc.addEventListener("mousemove", entry.middleMove, true);
			doc.addEventListener("mouseup", entry.middleUp, true);
			entry.downHandler = (event) => this.onFramePointerDown(entry, event);
			entry.dragMoveHandler = (event) => this.onFramePointerMove(event);
			entry.upHandler = (event) => this.onFramePointerUp(event);
			doc.addEventListener("mousemove", entry.moveHandler, true);
			doc.addEventListener("click", entry.clickHandler, true);
			doc.addEventListener("mouseleave", entry.leaveHandler, true);
			// passive: false —— 必须能 preventDefault，否则 Ctrl+滚轮会被浏览器拿去缩放页面。
			doc.addEventListener("wheel", entry.wheelHandler, { capture: true, passive: false });
			doc.addEventListener("keydown", entry.keyHandler, true);
			doc.addEventListener("mousedown", entry.downHandler, true);
			doc.addEventListener("mousemove", entry.dragMoveHandler, true);
			doc.addEventListener("mouseup", entry.upHandler, true);
			entry.attached = true;
			// ---- 落盘后的重载：把选中恢复成同一个元素
			//
			// 说明见 `pendingReselect`。必须放在**监听挂好之后**：
			// 恢复时要 `syncBoxes()` 算屏幕矩形，而算矩形依赖 entry.iframe 的布局。
			//
			// 没有这一步的后果（实测）：落盘 → 重载 → `selected` 变游离节点 →
			// 选中框停在原地不动，或跳到画板左上角。用户的原话是
			// 「移动或者缩小放大之后，红色框还停留在原地不跟着形状走」。
			if (this.pendingReselect !== null && this.pendingReselect !== undefined) {
				const parts = this.pendingReselect;
				this.pendingReselect = null;
				this.activeEntry = entry;
				this.activeId = entry.id;
				const found = resolveElementPath(doc, parts);
				this.located = null;
				if (found === null) {
					// 元素已经不在了（比如刚被删掉）——清干净，
					// **绝不能让框继续停在一个旧位置上**，那比没有框更误导。
					this.selected = null;
					this.syncBoxes();
					this.notifySelection();
				} else {
					this.selected = found;
					this.syncBoxes();
					this.notifySelection();
					// 新文档里的元素位置可能变了，重新定位一次源码。
					this.send({ type: "select", hint: describeElement(found), boardPath: this.boardPathOf(entry) });
				}
			}
			// 记下「挂到了哪个地址的文档」——排查「点了没反应」时这是唯一能看出
			// 「挂到 about:blank 上去了」的线索。
			entry.attachCount = (entry.attachCount ?? 0) + 1;
			try {
				entry.attachedHref = String(doc.location?.href ?? "?");
			} catch {
				entry.attachedHref = "(不可读)";
			}
		};
		// load 在**每次**导航后都会触发，所以这里能覆盖刷新与 HMR 重载。
		entry.iframe.addEventListener("load", attach);
		// 可能已经加载完了（缓存命中时 load 不会再触发）。
		attach();
		// 兜底：有些情况下 body 稍后才可用。
		window.setTimeout(attach, 300);
		window.setTimeout(attach, 1200);
	}

	/**
	 * 摘掉某块画板的监听。
	 * @param entry - 画板条目。
	 */
	detach(entry) {
		if (!entry.attached) return;
		try {
			entry.doc?.removeEventListener("mousemove", entry.moveHandler, true);
			entry.doc?.removeEventListener("click", entry.clickHandler, true);
			entry.doc?.removeEventListener("mouseleave", entry.leaveHandler, true);
			entry.doc?.removeEventListener("wheel", entry.wheelHandler, { capture: true });
			entry.doc?.removeEventListener("keydown", entry.keyHandler, true);
			// 中键的三个监听也要摘：画板重载后会重新 attach，不摘就累积成多份。
			entry.doc?.removeEventListener("mousedown", entry.middleDown, true);
			entry.doc?.removeEventListener("mousemove", entry.middleMove, true);
			entry.doc?.removeEventListener("mouseup", entry.middleUp, true);
			entry.doc?.removeEventListener("mousedown", entry.downHandler, true);
			entry.doc?.removeEventListener("mousemove", entry.dragMoveHandler, true);
			entry.doc?.removeEventListener("mouseup", entry.upHandler, true);
		} catch {
			// 画板可能已经被移除，忽略。
		}
		entry.attached = false;
		entry.doc = null;
	}

	/**
	 * 设置当前激活的画板（只有它可编辑）。
	 * @param id - 画板 id 或 null。
	 */
	setActive(id) {
		this.activeId = id;
		if (id === null) {
			this.clearHover();
			this.select(null);
		}
	}

	/**
	 * 开关「选择元素」模式。
	 * @param on - 是否开启。
	 */
	setPickMode(on) {
		this.pickMode = on === true;
		if (!this.pickMode) this.clearHover();
		if (this.pickMode || this.selected !== null) {
			this.placePanel();
			this.panel.root.style.display = "";
		} else {
			this.panel.root.style.display = "none";
		}
	}

	// #endregion

	// #region 命中测试与高亮

	/**
	 * 屏幕坐标 → 画板内坐标。
	 * @param entry - 画板条目。
	 * @param clientX - 外壳视口内的坐标 X。
	 * @param clientY - 外壳视口内的坐标 Y。
	 * @returns { x, y } 或 null。
	 */
	framePoint(entry, clientX, clientY) {
		const rect = entry.iframe.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return null;
		// 用「显示宽度 / 布局宽度」得到缩放比，而不是直接用画布 zoom——
		// 这样以后加任何变换都不会算错。
		const scaleX = rect.width / (entry.iframe.clientWidth || rect.width);
		const scaleY = rect.height / (entry.iframe.clientHeight || rect.height);
		return { x: (clientX - rect.left) / scaleX, y: (clientY - rect.top) / scaleY };
	}

	/**
	 * 画板内坐标 → 外壳视口坐标（画高亮框、算缩放锚点要用）。
	 * @param entry - 画板条目。
	 * @param localX - 画板内的 X。
	 * @param localY - 画板内的 Y。
	 * @returns { x, y }。
	 */
	frameToScreen(entry, localX, localY) {
		const rect = entry.iframe.getBoundingClientRect();
		const scaleX = rect.width / (entry.iframe.clientWidth || rect.width);
		const scaleY = rect.height / (entry.iframe.clientHeight || rect.height);
		return { x: rect.left + localX * scaleX, y: rect.top + localY * scaleY };
	}

	/**
	 * 用**画板内坐标**命中元素。
	 *
	 * ## 为什么需要这个「Local」版本
	 *
	 * 事件监听挂在**画板自己的 document** 上，所以 `event.clientX/clientY` 是
	 * 「相对于画板视口」的坐标，**不是外壳的屏幕坐标**。
	 *
	 * 早先这里按屏幕坐标又换算了一次，于是真实点击算出来的位置远在页面之外，
	 * **永远命中不了元素**；而当时的浏览器测试用的是手工合成事件（里面塞的
	 * 恰好是屏幕坐标），正好迎合了这个错误，测试全绿、真实点击全废。
	 * 教训：测试一旦绕过真实事件路径，就会把 bug 一起绕过。
	 *
	 * @param entry - 画板条目。
	 * @param localX - 画板内的 X。
	 * @param localY - 画板内的 Y。
	 * @param deep - 是否**穿透**（Alt+点击）：跳过当前选中那一层，取它下面的一层。
	 * @returns 元素或 null。
	 */
	hitTestLocal(entry, localX, localY, deep) {
		try {
			const doc = entry.iframe.contentDocument;
			if (doc === null || doc === undefined) return null;
			/** 文档根 / body 不算可选中的元素。 */
			const usable = (node) => {
				if (node === null || node === undefined) return null;
				if (node === doc.documentElement || node === doc.body) return null;
				return node;
			};

			/**
			 * 把命中的节点**归到它所属的形状**上。
			 *
			 * ## 为什么需要（用户报「组件无法编辑（放大缩小等等）」）
			 *
			 * `elementFromPoint` 给的是**最顶层**那个节点。形状内部是空的时
			 *（画出来的矩形）它正好就是形状本身；但从设计库拖进来的图标是
			 * 一个**含 `<svg>` 的容器**，命中的往往是 `<svg>` 或 `<path>`。
			 *
			 * 于是"选中"的是一个没有盒模型概念的路径节点：
			 * 手柄画不出来、缩放没有对象、拖动也不知道该移动谁 ——
			 * 用户看到的就是**"组件无法编辑"**。
			 *
			 * 用 `closest(".dsh-shape")` 往上找到那个形状即可。
			 * 找不到就返回原节点：画板里的普通元素本来就可以直接选中，
			 * 不能因为加了这一层就选不中它们了。
			 *
			 * @param node - 命中的节点。
			 * @returns 归属的形状，或原节点。
			 */
			const owner = (node) => {
				const found = usable(node);
				if (found === null) return null;
				if (typeof found.closest !== "function") return found;
				return found.closest(".dsh-shape") ?? found;
			};

			if (deep === true && typeof doc.elementsFromPoint === "function") {
				// ## 穿透（Alt+点击）
				//
				// 用户的画板上有**层叠**：画布区 `.viewport`（flex 撑满、点阵背景）
				// 盖在别的东西上面。普通点击永远只能拿到最顶层那个，
				// 于是"演示用的组件"怎么点都点不中——他以为组件之间有强依赖，
				// 其实是**根本点不到**。
				//
				// `elementsFromPoint`（复数）会按**从上到下**给出所有层。
				// 语义定为「往下钻一层」：从当前选中那一层往下取一个；
				// 没选中过就给第二层（第一层就是普通点击会拿到的那个）。
				// 每次按都往下钻一层，所以连按可以逐层穿透到底。
				const stack = [...doc.elementsFromPoint(localX, localY)].filter((n) => usable(n) !== null);
				if (stack.length === 0) return null;
				// 每一层都先归到形状，否则 `indexOf(this.selected)` 永远匹配不上
				//（选中记的是形状，栈里给的是形状内部的小节点）。
				const owners = stack.map((n) => owner(n));
				const currentIndex = owners.indexOf(this.selected);
				if (currentIndex >= 0) return owners[currentIndex + 1] ?? null;
				return owners[Math.min(1, owners.length - 1)] ?? null;
			}

			return owner(doc.elementFromPoint(localX, localY));
		} catch {
			return null;
		}
	}

	/**
	 * 元素在屏幕上的矩形（用于画高亮框）。
	 * @param element - 元素。
	 * @param entry - 画板条目。
	 * @returns { left, top, width, height } 或 null。
	 */
	elementScreenRect(element, entry) {
		// 条目形状不对时返回 null 而不是抛错。
		// 早先这里直接读 entry.iframe，传错形状就抛 TypeError，
		// 而调用方（syncBoxes）没有 try — 异常一路冒到事件监听里被静默吞掉，
		// 表现是「点了没反应」，排查时完全看不到原因。
		if (entry === null || entry === undefined || entry.iframe === undefined) return null;
		const frameRect = entry.iframe.getBoundingClientRect();
		if (frameRect.width === 0) return null;
		const inner = element.getBoundingClientRect();
		const scaleX = frameRect.width / (entry.iframe.clientWidth || frameRect.width);
		const scaleY = frameRect.height / (entry.iframe.clientHeight || frameRect.height);
		return {
			left: frameRect.left + inner.left * scaleX,
			top: frameRect.top + inner.top * scaleY,
			width: inner.width * scaleX,
			height: inner.height * scaleY
		};
	}

	/**
	 * 鼠标在画板里移动。
	 * @param entry - 画板条目。
	 * @param event - 事件。
	 */
	onFrameMove(entry, event) {
		// 只对激活的画板、且在选择模式下高亮（Alt 按住时临时进入）。
		if (entry.id !== this.activeId) return;
		if (!this.pickMode) return;
		if (this.drag !== null) return;
		// 事件来自画板文档 → clientX/Y 已经是画板内坐标，直接用，不要当屏幕坐标换算。
		const node = this.hitTestLocal(entry, event.clientX, event.clientY);
		this.hovered = node;
		this.hoverEntry = entry;
		this.syncBoxes();
	}

	/**
	 * 在画板里按下鼠标：开始可能的一次拖动。
	 *
	 * 元素拖动改的是 `transform: translate(...)`（与单页覆盖层一致），
	 * 松手时才写回源码，中途只做视觉预览——否则每移动一像素就改一次文件。
	 *
	 * @param entry - 画板条目。
	 * @param event - 事件。
	 */
	onFramePointerDown(entry, event) {
		if (event.button !== 0) return;
		const wantsPick = this.pickMode || event.altKey === true;
		if (!wantsPick) return;
		// Alt 有两种可能的意思，**不能都挂在 Alt 上**（会互相吃掉）：
		//   没在选择模式 → Alt 临时进入选择模式（老行为，保留）
		//   已经在选择模式 → Alt 表示**往下钻一层**（穿透层叠）
		//
		// ⚠️ 一开始写成「`selected` 非空就穿透」，结果**把拖动整个吃掉了**：
		// 用户先点选一个元素、再按住 Alt 拖，`deep` 为真 → 穿透取下一层 →
		// 底下没有别的元素时 `hitTestLocal` 返回 null → 这里直接 return，
		// **拖动根本没建立起来**，表现为"元素拖不动"。
		// 现在只在已经进入选择模式后才让 Alt 承担穿透。
		// 一次拖动的 trace 从这里开始（外壳与宿主的日志靠它对齐）
		this.beginTrace("drag");
		const deep = event.altKey === true && this.pickMode === true;
		const node = this.hitTestLocal(entry, event.clientX, event.clientY, deep);
		if (node === null) return;
		// ★ **拖谁就选谁**——`located`（源码位置）跟着选中走。
		//
		// 不这么做的话，「选中 A，然后直接按住 B 拖」这个动作里
		// `drag.node` 是 B 而 `located` 还停在 A —— 松手写回时拿着 A 的位置，
		// **B 的位移就落进了 A 的源码**。用户看到的是
		// 「移动一个组件，另一个没被选中的却跟着偏移」，
		// 并合理地怀疑"组件之间有依赖"。
		//
		// 这里只是把选中切过去（拖动本身照旧），符合"我拖谁就是操作谁"的直觉。
		if (node !== this.selected) {
			this.activeId = entry.id;
			this.activeEntry = entry;
			this.revertPreview();
			this.selected = node;
			this.located = null;
			this.syncBoxes();
			this.send({ type: "select", hint: describeElement(node), boardPath: this.boardPathOf(entry) });
			this.notifySelection();
		}
		// 记下起点，但**先不拦截事件**：要等真的移动了才算拖动，
		// 否则单击会被当成零距离拖动，页面自己的点击行为就没了。
		this.pendingDrag = {
			entry, node,
			startLocalX: event.clientX, startLocalY: event.clientY,
			originTransform: node.style.transform || "",
			// 元素标识**在这里算一次**就够：`elementLabel` 要读 getBoundingClientRect
			//（强制同步布局），每帧算会把拖动拖慢。
			label: elementLabel(node),
			// 冻结的起点框与显示缩放比：拖拽期间全靠它们算，不读元素的实时矩形。
			startRect: this.elementScreenRect(node, entry),
			scale: (() => {
				const rect = entry.iframe.getBoundingClientRect();
				return rect.width / (entry.iframe.clientWidth || rect.width) || 1;
			})()
		};
		// ★ **记下这次拖动要带动谁**（镶嵌在它身上的图层）。
		//
		// 在这里算一次就够：拖动过程中每帧去扫全部画板的关联会很贵，
		// 而且拖动期间关联不会变（用户正在拖，改不了关联）。
		//
		// 用户明确说子图层"也可以自己自由移动" —— 所以只有**正在被拖的那个**
		// 才带动跟随者，单向关联下子图层拖动**不**反过来带底座。
		// 这个判定在 `followersOf` 里（纯函数，有测试）。
		this.dragFollowers = this.followersOfElement(node);
	}

	/**
	 * 在画板里移动鼠标：拖动中则更新预览。
	 * @param event - 事件。
	 */
	onFramePointerMove(event) {
		// 同样的兜底：iframe 里的 mouseup 有时收不到（比如松手时跨了文档边界），
		// 靠 buttons 判断「其实已经没按着了」来收尾，避免手势永远挂着。
		if ((event.buttons & 1) === 0 && (this.drag !== null || this.pendingDrag !== null)) {
			this.onFramePointerUp(event);
			return;
		}
		// 起点可能在 pendingDrag（还没超过阈值）或 drag（已经在拖）里。
		//
		// 早先这里只读 pendingDrag，而拖动一旦开始就把 pendingDrag 置空了，
		// 于是**后续所有移动都在开头提前返回**——最终只写回第一次移动的那一点点位移。
		// 真实表现是「拖了半天，元素只挪了一小步」，很难一眼看出是逻辑问题。
		const pending = this.pendingDrag;
		if (this.drag === null && pending === null) return;
		const start = this.drag ?? pending;
		const dx = event.clientX - start.startLocalX;
		const dy = event.clientY - start.startLocalY;
		if (this.drag === null) {
			// 超过阈值才算拖动：否则单击会被当成零距离拖动，页面自己的点击行为就没了。
			if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
			this.drag = pending;
			this.pendingDrag = null;
			pending.node.style.cursor = "grabbing";
			// **冻结基准矩形**：必须在施加任何 transform 之前取。
			//
			// 吸附要算的是"元素本来在哪 + 本次位移"，而 `getBoundingClientRect()`
			// 会把当前 transform 也算进去。拖动过程中再取就会形成反馈回路——
			// 上一次吸附的结果被当成基准，元素会自己往一个方向爬。
			try {
				const rect = pending.node.getBoundingClientRect();
				pending.baseRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
			} catch {
				pending.baseRect = null;
			}
			// ★ 吸附参照物**整个拖动过程只收集一次**。
			//
			// `snapTargetsFor` 会读父容器 + **每一个兄弟元素**的 `getBoundingClientRect()`，
			// 而那是**强制同步布局**：读一次要等浏览器把排版算完。
			//
			// 原先这里是每次 `mousemove` 都调一遍（在下面 computeSnap 那行）——
			// 兄弟一多，每帧就是十几次强制布局，拖动明显发粘、**选中框跟不上手**。
			// 用户的原话是「有明显延迟不跟手」。
			//
			// 拖动过程中页面不会被改，参照物是常量，所以一次就够。
			pending.snapTargets = this.snapTargetsFor(pending.node);
		}
		const active = this.drag;

		// ---- 吸附与辅助线
		//
		// 必须在**应用 transform 之前**算：算完要修正 dx/dy，再拿去写样式。
		// 顺序反了的话，辅助线会显示"差一点就对齐"的位置，而元素已经吸过去了。
		let guides = [];
		if (active.baseRect !== null && active.baseRect !== undefined) {
			// 用**拖动开始时缓存的那一份**参照物 —— 见建立 drag 处的说明。
			// 这里如果重新调 `snapTargetsFor`，就是每帧十几次强制布局。
			const snapped = computeSnap(active.baseRect, dx, dy, active.snapTargets ?? []);
			guides = snapped.guides;
			active.dx = snapped.dx;
			active.dy = snapped.dy;
		} else {
			active.dx = dx;
			active.dy = dy;
		}
		const finalDx = active.dx;
		const finalDy = active.dy;

		// 实时预览：拼在原有 transform 前面，避免覆盖元素自己的变换。
		//
		// **元素位移必须同步写**：拖动要跟手，这个不能延后一帧。
		active.node.style.transform = composeTransform(Math.round(finalDx), Math.round(finalDy), active.originTransform);

		// ★ **镶嵌的跟随者同步位移**（关联功能的核心行为）。
		//
		// 用户的原话：「当底座图层移动时他也移动或改变比例」。
		// 和元素本身一样**必须同步写** —— 延后一帧就会出现"底座和子元素脱开"的撕裂感。
		//
		// 只改 DOM 不写源码：每帧写会出几十个快照和 git 提交。
		// 落盘在 `onFramePointerUp` 里一次做完（见 `commitFollowers`）。
		if (this.dragFollowers !== undefined && this.dragFollowers.length > 0) {
			this.shiftFollowers(this.dragFollowers, finalDx, finalDy);
		}

		// ★ **选中框也必须同步画，和元素在同一帧。**
		//
		// 上一轮为了性能把框挪进了 `flushDragFrame`（rAF），而元素是同步写的 ——
		// 两者差了一帧，视觉上就是"框追不上元素"。用户的原话：
		// 「选中框还是有些不跟手，存在延迟」。
		//
		// 框是 `position: fixed` 的**独立元素**，改它自己的 left/top/宽高
		// 只影响它自己，不牵动画板内容 —— 代价很小，没必要为它牺牲跟手性。
		// 真正贵的是辅助线（要重建 DOM）和状态栏文字，那两个留在 rAF 里。
		//
		// 框按**冻结的起点**平移，不看元素当前在哪——否则会形成反馈回路（见 paintFrozenBox）。
		const frozen = active.startRect;
		if (frozen !== null && frozen !== undefined) {
			this.paintFrozenBox({
				left: frozen.left + finalDx * (active.scale ?? 1),
				top: frozen.top + finalDy * (active.scale ?? 1),
				width: frozen.width,
				height: frozen.height
			});
		}

		// 剩下的两件（辅助线 / 状态栏）**合并到下一帧**。
		//
		// 它们各自都在改 DOM，而 `mousemove` 在高刷屏上一秒能来 200+ 次：
		// 等于每移动一点就触发几轮重排。但它们**不影响跟手性**（辅助线只在吸附到
		// 某条线时才出现，状态栏文字是读数），所以可以安全地延后一帧。
		this.pendingFrame = { active, guides, dx: finalDx, dy: finalDy };
		this.scheduleDragFrame();
	}

	/**
	 * 排队「拖动这一帧」的绘制。
	 *
	 * 没有 `requestAnimationFrame` 时（node 里跑离线测试）**直接同步做**——
	 * 这样测试保持确定性，不用去等一个不存在的帧。
	 */
	scheduleDragFrame() {
		// ⚠️ 用**真值**判断，不要写 `!== 0`。
		//
		// 离线测试里对象是 `Object.create(CanvasEditor.prototype)` 造出来的，
		// 没走 constructor，字段是 `undefined` —— 而 `undefined !== 0` 为真，
		// 于是每一帧都被当成"已经排过队"直接丢掉，界面完全不动。
		// （同一个坑在 `boxFrame` 上已经踩过一次，这是第二次。）
		if (this.dragFrame) return;
		const raf = globalThis.requestAnimationFrame;
		if (typeof raf !== "function") {
			this.flushDragFrame();
			return;
		}
		this.dragFrame = raf(() => {
			this.dragFrame = 0;
			this.flushDragFrame();
		});
	}

	/** 真正画这一帧：辅助线、状态栏。**不含选中框**——框要和元素同帧，见 onFramePointerMove。 */
	flushDragFrame() {
		const frame = this.pendingFrame;
		this.pendingFrame = null;
		if (frame === null || frame === undefined) return;
		const { active, guides, dx, dy } = frame;
		if (active === null || active === undefined) return;

		this.paintGuides(active.entry, guides);

		// 带上元素标识 + 尺寸：画板上的形状会重叠，`elementFromPoint` 命中的可能是
		// **盖在上面的另一个**。只显示 `div.dsh-shape` 两个形状长得一模一样、
		// 分不出谁是谁；带上尺寸（161×215 / 124×134）用户立刻能对上号。
		this.showMetrics(`${active.label ?? "?"} · ${Math.round(dx)}, ${Math.round(dy)}`);
	}

	/**
	 * 松开鼠标：拖动结束则写回。
	 * @param event - 事件。
	 */
	onFramePointerUp(event) {
		this.pendingDrag = null;
		this.hideMetrics();
		// 辅助线必须在这里清：它是"拖动中"的提示，松手后还留着会让人以为
		// 元素仍处于吸附状态。
		this.clearGuides();
		const drag = this.drag;
		if (drag === null) return;
		this.drag = null;
		// 下一次 click 事件要跳过选中（拖完不该顺带换选中）。
		this.justDragged = true;
		drag.node.style.cursor = "";
		// 这里读的是 active.dx —— 它已被 computeSnap **吸附修正过**。
		// 用原始位移的话，写回源码的位置会和刚才预览看到的差几像素，
		// 表现是"松手后跳一下"。
		const dx = Math.round(drag.dx ?? 0);
		const dy = Math.round(drag.dy ?? 0);

		// ★ **跟随者也要落盘**。
		//
		// 拖动过程中它们只改了 DOM（每帧写源码会出几十个快照和 git 提交），
		// 松手时必须一起写回 —— 否则刷新一次就跟丢了，源码和画面对不上。
		//
		// ⚠️ 必须在 `dx === 0` 的提前返回**之前**做：那时拖动虽然为 0，
		// DOM 上的位移也是 0，但跟随者的临时样式还挂着，得还原掉。
		const followers = this.dragFollowers ?? [];
		this.dragFollowers = undefined;
		if (followers.length > 0) {
			if (dx === 0 && dy === 0) this.shiftFollowers(followers, 0, 0);
			else this.commitFollowers(followers, dx, dy);
		}

		if (dx === 0 && dy === 0) {
			drag.node.style.transform = drag.originTransform;
			return;
		}
		// **不回滚预览**。
		//
		// 早先这里把 transform 还原，注释写着「交给写回 + HMR」——错在**假设一定有 HMR**。
		// 演示站点、以及任何没有热更新的项目里，写回源码之后页面不会自己刷新，
		// 于是用户看到的是：拖到位、松手、**元素瞬移回原处**。这是最容易让人以为工具坏了的表现。
		//
		// 现在的做法：保留实时预览（元素就停在你放下的地方），写回成功后刷新那一块画板，
		// 由源码里的值接管；写回失败才回滚，并明确告诉你没写进去。
		const translate = `translate(${dx}px, ${dy}px)`;
		// 叠加而不是覆盖（拖两次要累计）；composeTransform 顺带把工具写的 translate 链合并成一段，
		// 否则每拖一次源码里就多一段，拖六次之后没人看得出元素到底偏了多少。
		const value = composeTransform(dx, dy, drag.originTransform);
		this.pendingCommit = {
			node: drag.node,
			entry: drag.entry,
			origin: {
				transform: drag.originTransform,
				width: drag.node.style.width || "",
				height: drag.node.style.height || ""
			},
			// 重发用：用户在候选列表里换一个位置时，要能原样再发一次。
			declarations: { transform: value },
			hint: describeElement(drag.node)
		};
		this.onStatus("", `写回位置：${translate}`);
		event.preventDefault();
		event.stopPropagation();
		// **带上 pin**：用选中时宿主给过的源码位置精确定位。
		// 不带的话，多个同类组件的线索同分 → 宿主会"自动挑一个" →
		// 位移被写进**另一个组件**（用户看到的就是"别的组件跟着乱跑"）。
		this.send({ type: "declare", hint: describeElement(drag.node), declarations: { transform: value }, boardPath: this.boardPathOf(drag.entry), pin: this.pinOf(drag.node) });
	}

	/**
	 * 收集吸附参照物：父容器 + 兄弟元素。
	 *
	 * 为什么是这两类：
	 * - **父容器**提供"贴边"和"在容器里居中"——最高频的对齐意图
	 * - **兄弟元素**提供"和旁边那个对齐"——列表项、并排卡片的常见需求
	 *
	 * 不做全页扫描：几百个节点的页面会把每次 pointermove 拖垮，
	 * 而且远处的元素做参照物对人也没有意义。
	 *
	 * @param node - 被拖元素。
	 * @returns 矩形数组（画板坐标系）。
	 */
	snapTargetsFor(node) {
		const out = [];
		/**
		 * 把一个元素转成吸附参照矩形。
		 * @param element - 元素。
		 */
		const push = (element) => {
			if (element === null || element === undefined) return;
			try {
				const rect = element.getBoundingClientRect();
				if (rect.width === 0 && rect.height === 0) return;
				out.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
			} catch { /* 跨文档读不到就跳过 */ }
		};
		push(node.parentElement);
		for (const sibling of node.parentElement?.children ?? []) {
			if (sibling !== node) push(sibling);
		}
		return out;
	}

	/**
	 * 画辅助线。
	 *
	 * @param entry - 画板条目。
	 * @param guides - computeSnap 给出的线（画板坐标系）。
	 */
	paintGuides(entry, guides) {
		const list = Array.isArray(guides) ? guides : [];
		// **没变就不动 DOM。**
		//
		// 这个函数拖动时每帧都调，而它做的是 `replaceChildren` + 逐个新建元素——
		// 高刷屏上一秒重建几百次，每次都要重新解析样式、重排。
		// 对齐位置大多数帧是**没变**的（辅助线只在吸附到某条线时才出现）。
		//
		// key 里不含画板矩形：拖动过程中画板不会被缩放/滚动，矩形是常量。
		const key = `${entry?.id ?? ""}|${list.map((g) => `${g.axis}:${g.at}:${g.from}:${g.to}`).join(",")}`;
		if (this.guidesKey === key) return;
		this.guidesKey = key;

		const layer = this.guideLayer;
		layer.replaceChildren();
		if (list.length === 0) return;
		const rect = entry?.iframe?.getBoundingClientRect();
		if (rect === undefined || rect === null) return;
		// 画板是缩放显示的，辅助线要按同样的比例换算到屏幕坐标
		const scale = rect.width / (entry.iframe.clientWidth || rect.width) || 1;
		for (const guide of list) {
			const style = { position: "fixed", background: "#ff3b81", pointerEvents: "none" };
			if (guide.axis === "x") {
				// 竖线：标识的是 X 坐标
				style.left = `${rect.left + guide.at * scale}px`;
				style.top = `${rect.top + guide.from * scale}px`;
				style.width = "1px";
				style.height = `${Math.max(1, (guide.to - guide.from) * scale)}px`;
			} else {
				style.top = `${rect.top + guide.at * scale}px`;
				style.left = `${rect.left + guide.from * scale}px`;
				style.height = "1px";
				style.width = `${Math.max(1, (guide.to - guide.from) * scale)}px`;
			}
			layer.append(el("div", { style }));
		}
	}

	/** 清掉辅助线。 */
	clearGuides() {
		// key 也要清：否则下次同样的辅助线会因为"签名没变"而不重画
		this.guidesKey = null;
		this.guideLayer.replaceChildren();
	}

	/**
	 * 在画板里点击。
	 * @param entry - 画板条目。
	 * @param event - 事件。
	 */
	onFrameClick(entry, event) {
		// 一次点选的 trace 从这里开始
		this.beginTrace("click");
		// 计数用于排查「点了没反应」：能区分「监听没挂上」与「挂上了但被逻辑挡掉」。
		this.clickSeen = (this.clickSeen ?? 0) + 1;

		// ---- 关联的**选择模式**优先于一切 ----
		//
		// 用户点了「＋ 添加关联」之后，画布上的每一次点击都是"我要关联它"，
		// 不该同时触发选中/拖动。所以这一支排在最前面，
		// 而且**不要求先进入 pickMode** —— 关联选择本身就是一种明确的模式。
		if (this.linkPickMode === true) {
			event.preventDefault();
			event.stopPropagation();
			this.clickSeenLink = (this.clickSeenLink ?? 0) + 1;
			// Alt 在这里仍然表示"往下钻一层"（层叠时点到被盖住的那个）
			const target = this.hitTestLocal(entry, event.clientX, event.clientY, event.altKey === true);
			if (target !== null) this.onLinkPick?.(target);
			return;
		}

		// ---- 注释模式：点谁就是"我要评论谁" ----
		//
		// 和关联的选择模式是同一套思路：进模式后画布点击**改道**，
		// 不触发普通的选中与拖动。
		//
		// **但这里要真的选中它** —— 注释卡片上显示的是"当前选中元素"的样式，
		// 而且用户接着很可能就想改它（比如"这个颜色不对"，说完顺手改掉）。
		//
		// 排在 `linkPickMode` 之后：两个模式不该同时开；
		// 万一都开了，关联那边是"正在进行的多选操作"，让它先做完。
		if (this.commentMode === true) {
			event.preventDefault();
			event.stopPropagation();
			this.clickSeenComment = (this.clickSeenComment ?? 0) + 1;
			const target = this.hitTestLocal(entry, event.clientX, event.clientY, event.altKey === true);
			if (target === null) return;
			this.activeId = entry.id;
			this.activeEntry = entry;
			this.revertPreview();
			this.selected = target;
			this.located = null;
			this.syncBoxes();
			this.send({ type: "select", hint: describeElement(target), boardPath: this.boardPathOf(entry) });
			this.notifySelection();
			this.onCommentPick?.(target);
			return;
		}

		// ---- Ctrl/Cmd + 点击：**加入多选集合**（用来把几个元素存成一个组件）
		//
		// 不做完整的框选：那要动 hitTest 和拖动逻辑，牵连太大。
		// Ctrl+点击是"我要挑这几个"的明确表达，而且**不干扰已有交互**
		//（不按修饰键时行为完全不变）。
		if (this.pickMode === true && (event.ctrlKey === true || event.metaKey === true)) {
			event.preventDefault();
			event.stopPropagation();
			const node = this.hitTestLocal(entry, event.clientX, event.clientY);
			if (node !== null) this.toggleExtraSelection(node);
			return;
		}

		// 普通点击**清空多选集合** —— 用户点了别处，说明"重新开始挑"
		if (event.ctrlKey !== true && event.metaKey !== true) this.clearExtraSelection();

		// 刚拖动过就不当成一次选中（否则拖完会立刻重选一次，闪一下）。
		if (this.justDragged === true) {
			this.justDragged = false;
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		// Alt+点击 在任何模式下都能选元素（省得先切模式）。
		const wantsPick = this.pickMode || event.altKey === true;
		if (!wantsPick) return;
		event.preventDefault();
		event.stopPropagation();
		// 同上：clientX/Y 是画板内坐标。
		// Alt 在**已进入选择模式**时表示往下钻一层（穿透层叠），否则是临时进入选择模式。
		// 两者不能都挂在 Alt 上：那样"先选中再 Alt 拖"会被当成穿透，拖动直接失效。
		const deep = event.altKey === true && this.pickMode === true;
		const node = this.hitTestLocal(entry, event.clientX, event.clientY, deep);
		// 记下这次点击「拿到了什么坐标、命中了什么」——排查「点了没反应」时最关键的一条。
		this.lastClick = { x: Math.round(event.clientX), y: Math.round(event.clientY), alt: event.altKey === true, hit: node === null ? null : node.tagName };
		if (node === null) return;
		// 锁定图层在画布上点不中（锁定只在图层树里生效，是「别让我误点它」的辅助）。
		// 往上找祖先：锁的是容器时，里面所有内容都不该被点中——
		// 否则「锁住背景」完全达不到目的，因为点它的子元素照样选中。
		if (this.isLockedFrom(node) === true) {
			this.onStatus("", "这个图层已锁定，在图层树里点它才能选中");
			return;
		}
		this.activeId = entry.id;
		this.activeEntry = entry;
		// 换选中之前把上一个元素的实时预览还原掉，否则它的样式会一直留在页面上——
		// 看起来像"改了生效了"，实际源码里没有，切回去才发现被打回原形。
		this.revertPreview();
		this.selected = node;
		this.located = null;
		this.onStatus("", "正在定位源码…");
		this.send({ type: "select", hint: describeElement(node), boardPath: this.boardPathOf(entry) });
		this.syncBoxes();
		this.refreshPanel();
		// 通知图层树：在画板里点选之后，树里要跟着高亮并展开到那一层。
		this.notifySelection();
	}

	/**
	 * 在画板里按中键：转发成画布平移。
	 *
	 * **必须转发**，理由和滚轮一样：画板是 iframe，事件不冒泡到外壳。
	 * 而中键平移恰恰是在「画板占满画布、找不到空白处」时最需要——
	 * 那正是画板覆盖面积最大的时候，不转发等于这个功能在最需要它的时候失效。
	 *
	 * @param entry - 画板条目。
	 * @param event - 事件。
	 * @param phase - "start" | "move" | "end"。
	 */
	onFrameMiddle(entry, event, phase) {
		const screen = this.frameToScreen(entry, event.clientX, event.clientY);
		this.onCanvasPan?.(phase, screen.x, screen.y, event);
	}

	/**
	 * 在画板里滚轮：转发成画布缩放。
	 *
	 * **必须转发**：画板是 iframe，它里面的 wheel 事件不会冒泡到外壳文档，
	 * 所以外壳挂在 viewport 上的滚轮监听收不到——而画板几乎铺满画布，
	 * 用户随手一滚其实都落在画板上。结果是「怎么滚都不缩放」，
	 * 按 Ctrl 滚还会被浏览器拿去缩放整个界面。
	 *
	 * @param entry - 画板条目。
	 * @param event - 事件。
	 */
	onFrameWheel(entry, event) {
		// 一律拦下：不拦的话浏览器会用 Ctrl+滚轮 缩放整个页面。
		event.preventDefault();
		const screen = this.frameToScreen(entry, event.clientX, event.clientY);
		this.onCanvasZoom(event.deltaY, screen.x, screen.y);
	}

	/**
	 * 把八个手柄摆到选中框上。
	 *
	 * @param rect - 选中框的屏幕矩形。
	 */
	placeHandles(rect) {
		this.frozenRect = rect;
		for (const handle of this.handles.values()) {
			const x = handle.dataset.handle.includes("w") ? rect.left
				: handle.dataset.handle.includes("e") ? rect.left + rect.width
					: rect.left + rect.width / 2;
			const y = handle.dataset.handle.includes("n") ? rect.top
				: handle.dataset.handle.includes("s") ? rect.top + rect.height
					: rect.top + rect.height / 2;
			handle.style.display = "block";
			handle.style.left = `${x}px`;
			handle.style.top = `${y}px`;
		}
	}

	/**
	 * 用「冻结的框」重画选中框与手柄。
	 *
	 * ## 为什么需要冻结
	 *
	 * 拖拽期间如果照常从元素的实时矩形重算，就会出现反馈回路：
	 * 元素一变大 → 矩形变了 → 手柄跟着挪 → 手柄从光标底下溜走 → 下一次位移算错。
	 * 用户体感就是「不听使唤、越拖越偏」。
	 *
	 * 所以拖拽期间框和手柄**按本次拖拽的起点与位移算**，完全不看元素当前在哪；
	 * 松手后再回到实时测量。
	 *
	 * @param options - { left, top, width, height }（屏幕坐标）。
	 */
	paintFrozenBox(options) {
		Object.assign(this.box.style, {
			display: "block",
			left: `${options.left}px`, top: `${options.top}px`,
			width: `${options.width}px`, height: `${options.height}px`
		});
		this.placeHandles(options);
	}

	/**
	 * 取一块画板对应的应用路径（如 `/plugin-ui`）。
	 *
	 * 这个值让宿主能学「哪块画板对应哪个文件」。没有它，定位只能靠内容相似度猜——
	 * 而分数分不出「原型里的 span」和「真实外壳里的 span」（文案一模一样），
	 * 实测因此把尺寸写进了插件的真实外壳，破坏了真实 UI。
	 *
	 * @param entry - 画板条目。
	 * @returns 路径字符串；拿不到时返回 undefined（宿主会退回纯分数挑选）。
	 */
	boardPathOf(entry) {
		const path = entry?.data?.path;
		return typeof path === "string" && path !== "" ? path : undefined;
	}

	/**
	 * 显示定位候选，供用户一键改用别的位置。
	 *
	 * 定位是**猜**出来的：同一段文案在多个文件里出现时分不出高下。
	 * 不给候选就等于让用户接受一个看不见的猜测——实测后果是把改动写进了错误的文件。
	 * 所以「我是猜的」和「你还能换成哪个」必须同时可见。
	 *
	 * @param candidates - 宿主回传的候选：[{ file, line, score, excerpt, learned }]。
	 * @param selectedFile - 当前实际写入的文件。
	 * @param onPick - 用户点了某个候选时的回调（接收候选对象）。
	 */
	showCandidates(candidates, selectedFile, onPick) {
		const box = this.candidateBox;
		const body = this.candidateBody;
		body.replaceChildren();
		if (!Array.isArray(candidates) || candidates.length === 0) {
			box.style.display = "none";
			return;
		}
		box.style.display = "block";
		this.candidateTitle.textContent = `定位候选（${candidates.length}）—— 猜的，可换`;
		// 恢复上次的折叠状态（本机偏好，不进项目文件）
		this.setCandidatesCollapsed(localStorage.getItem("dsh-canvas:candidates-collapsed") === "1", true);

		for (const item of candidates) {
			const row = el("button", {
				style: {
					display: "block", width: "100%", textAlign: "left", cursor: "pointer",
					padding: "4px 6px", marginBottom: "2px", borderRadius: "4px",
					border: `1px solid ${item.file === selectedFile ? "#4f8cff" : "rgba(128,140,155,.35)"}`,
					background: item.file === selectedFile ? "rgba(79,140,255,.18)" : "transparent",
					color: "inherit", font: "11px/1.5 ui-monospace,Consolas,monospace"
				},
				title: item.excerpt ?? "",
				onClick: (event) => {
					event.stopPropagation();
					onPick(item);
				}
			});
			const mark = item.file === selectedFile ? "● " : "○ ";
			const learned = item.learned === true ? "  ← 这块画板以前用的就是它" : "";
			row.textContent = `${mark}${item.file}:${item.line}${learned}`;
			body.append(row);
		}
	}

	/**
	 * 折叠 / 展开候选区。
	 *
	 * @param collapsed - 是否折叠。
	 * @param silent - true 时不写 localStorage（用于恢复状态，避免无谓写入）。
	 */
	setCandidatesCollapsed(collapsed, silent = false) {
		this.candidatesCollapsed = collapsed === true;
		this.candidateBody.style.display = this.candidatesCollapsed ? "none" : "";
		// 折叠后只剩标题栏，宽度也该收窄，不然还是一大片挡视野
		this.candidateBox.style.width = this.candidatesCollapsed ? "230px" : "420px";
		const toggle = this.candidateBox.firstElementChild?.lastElementChild;
		if (toggle !== null && toggle !== undefined) toggle.textContent = this.candidatesCollapsed ? "▸" : "▾";
		if (silent !== true) {
			try {
				localStorage.setItem("dsh-canvas:candidates-collapsed", this.candidatesCollapsed ? "1" : "0");
			} catch { /* 存不下就算了 */ }
		}
	}

	/** 藏起候选区（只清内容，保留标题栏——标题栏上有折叠和拖动把手）。 */
	hideCandidates() {
		this.candidateBox.style.display = "none";
		this.candidateBody.replaceChildren();
	}

	/**
	 * 在光标附近显示实时数值（拖动位移 / 缩放尺寸）。
	 *
	 * 为什么值得单独做一个：操作过程中如果没有任何数字反馈，用户只能靠肉眼估，
	 * 体感就是「不知道自己在干什么、也不确定有没有生效」。设计工具全都给这个。
	 *
	 * @param text - 要显示的文字。
	 */
	showMetrics(text) {
		// 值没变就别写：这两个赋值都会让浏览器重排，而拖动时它每帧都调。
		if (this.metricsShown === text) return;
		this.metricsShown = text;
		this.metrics.textContent = text;
		this.metrics.style.display = "block";
	}

	/** 藏起数值提示。 */
	hideMetrics() {
		this.metricsShown = null;
		this.metrics.style.display = "none";
	}

	/** 藏起所有手柄。 */
	hideHandles() {
		for (const handle of this.handles.values()) handle.style.display = "none";
	}

	/**
	 * 按住某个手柄：开始一次缩放。
	 * @param name - 手柄名。
	 * @param event - 事件。
	 */
	onHandleDown(name, event) {
		if (this.selected === null) return;
		// **选中项可能指向一份已经丢弃的文档。**
		//
		// 画板重载（改结构之后会重载）会把旧文档连同它的 `defaultView` 一起丢掉，
		// 而 `this.selected` 还可能握着旧文档里的节点——那上面的
		// `ownerDocument.defaultView` 是 `null`，直接 `getComputedStyle` 就抛
		// 「Cannot read properties of null」。
		//
		// 抛在这里的后果不只是"缩放坏了"：`event.preventDefault()` 已经执行过，
		// 拖拽会开始但永远走不完，界面看起来就是**卡住**。
		const view = this.selected.ownerDocument?.defaultView ?? null;
		if (view === null) {
			// 引用过期了，直接丢掉——留着只会在每次操作时再抛一次
			this.selected = null;
			this.syncBoxes();
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const computed = view.getComputedStyle(this.selected);
		const box = this.selected.getBoundingClientRect(); // 画板内坐标
		this.resize = {
			name,
			node: this.selected,
			entry: this.activeEntry,
			// 同拖动：标识只在这里算一次（读布局很贵，别放进每帧的回调）
			label: elementLabel(this.selected),
			startX: event.clientX,
			startY: event.clientY,
			// 冻结的起点框（屏幕坐标）：拖拽期间一律基于它算，不看元素当前在哪。
			startRect: this.elementScreenRect(this.selected, this.activeEntry),
			// 用**计算后的实际尺寸**当起点：元素多半没有显式 width/height，
			// 直接用 style.width（空串）会算出 NaN。
			startW: box.width,
			startH: box.height,
			originWidth: this.selected.style.width || "",
			originHeight: this.selected.style.height || "",
			originTransform: this.selected.style.transform || "",
			minW: parseFloat(computed.minWidth) || 0,
			minH: parseFloat(computed.minHeight) || 0
		};
		this.onStatus("", `缩放中：${name}（松手后写回源码）`);
	}

	/**
	 * 拖动中：实时预览新尺寸。
	 * @param event - 事件。
	 */
	onHandleMove(event) {
		const resize = this.resize;
		if (resize === null || resize === undefined) return;
		// **兜底收尾**：左键已经松开了却还在收到移动，说明 mouseup 丢了。
		//
		// 为什么会丢：画板是 iframe，**iframe 里的鼠标事件不会冒泡到父文档**。
		// 拖手柄时手柄就贴在选中框边缘，光标很容易落在画板上方，
		// 那一松手父窗口永远收不到 mouseup —— 缩放状态就一直挂着。
		// 用户体感是「松手了没反应，鼠标一移回来组件又开始变大」，而且不知道怎么就触发了。
		//
		// `buttons` 位掩码里第 0 位是左键：为 0 就表示此刻并没有按住。
		// 这一条比补事件监听更可靠：不管 mouseup 丢在哪一层，手势都能收干净。
		if ((event.buttons & 1) === 0) {
			this.onHandleUp(event);
			return;
		}
		// 记下最后一次真实光标位置：blur 之类的兜底收尾拿不到坐标，要用它。
		this.resize.lastX = event.clientX;
		this.resize.lastY = event.clientY;
		// 手柄在外壳层，clientX/Y 是外壳坐标；画板内尺寸要按显示缩放比换算。
		const entry = resize.entry;
		const rect = entry.iframe.getBoundingClientRect();
		const scale = rect.width / (entry.iframe.clientWidth || rect.width) || 1;
		const dx = (event.clientX - resize.startX) / scale;
		const dy = (event.clientY - resize.startY) / scale;
		const name = resize.name;

		let width = resize.startW;
		let height = resize.startH;
		if (name.includes("e")) width = resize.startW + dx;
		if (name.includes("w")) width = resize.startW - dx;
		if (name.includes("s")) height = resize.startH + dy;
		if (name.includes("n")) height = resize.startH - dy;
		// 别缩到负数或不可见：给一个下限，否则元素会「缩没了」找不回来。
		width = Math.max(8, Math.round(width));
		height = Math.max(8, Math.round(height));

		resize.w = width;
		resize.h = height;
		resize.node.style.width = `${width}px`;
		resize.node.style.height = `${height}px`;
		// 从左边/上边拖时，元素自身的锚点在左上角，视觉上会「往右/往下跑」。
		// 用 translate 抵消掉，让对边保持不动——否则手感完全不对。
		const shiftX = this.resize.originTransform === "" && name.includes("w") ? resize.startW - width : 0;
		const shiftY = name.includes("n") ? resize.startH - height : 0;
		if (shiftX !== 0 || shiftY !== 0) {
			resize.node.style.transform = composeTransform(Math.round(shiftX), Math.round(shiftY), resize.originTransform);
			resize.shifted = true;
		}
		// **用冻结框重画**，而不是 syncBoxes()（那会从元素实时矩形重算，形成反馈回路）。
		const start = resize.startRect;
		if (start !== null) {
			this.paintFrozenBox({
				left: name.includes("w") ? start.left + (resize.startW - width) * scale : start.left,
				top: name.includes("n") ? start.top + (resize.startH - height) * scale : start.top,
				width: width * scale,
				height: height * scale
			});
		}
		this.showMetrics(`${resize.label ?? "?"} · ${width} × ${height}`);
	}

	/**
	 * 松开：写回尺寸。
	 * @param event - 事件。
	 */
	onHandleUp(event) {
		const resize = this.resize;
		if (resize === null || resize === undefined) return;
		this.resize = null;
		this.hideMetrics();
		if (resize.w === undefined) return;
		event.preventDefault();
		event.stopPropagation();

		const declarations = { width: `${resize.w}px`, height: `${resize.h}px` };
		if (resize.shifted === true) {
			const rect = resize.entry.iframe.getBoundingClientRect();
			const scale = rect.width / (resize.entry.iframe.clientWidth || rect.width) || 1;
			// 兜底收尾（blur / 左键已松开）时事件里没有有效坐标，用最后记录的真实位置。
			const endX = event.clientX || resize.lastX || resize.startX;
			const endY = event.clientY || resize.lastY || resize.startY;
			const dx = Math.round((endX - resize.startX) / scale);
			const dy = Math.round((endY - resize.startY) / scale);
			const shiftX = resize.name.includes("w") ? -dx : 0;
			const shiftY = resize.name.includes("n") ? -dy : 0;
			const translate = `translate(${shiftX}px, ${shiftY}px)`;
			declarations.transform = composeTransform(shiftX, shiftY, resize.originTransform);
		}
		this.pendingCommit = {
			node: resize.node,
			entry: resize.entry,
			origin: { transform: resize.originTransform, width: resize.originWidth, height: resize.originHeight },
			// 重发用：用户换候选位置时要原样再发一次，否则列表只是摆设、改动仍落在原处。
			declarations,
			hint: describeElement(resize.node)
		};
		this.onStatus("", `写回尺寸：${resize.w}×${resize.h}`);
		this.send({ type: "declare", hint: describeElement(resize.node), declarations, boardPath: this.boardPathOf(resize.entry), pin: this.pinOf(resize.node) });
	}

	/**
	 * 清掉悬停高亮。
	 */
	clearHover() {
		this.hovered = null;
		this.hoverEntry = null;
		this.hoverBox.style.display = "none";
	}

	/**
	 * 把同一帧内的多次重绘合并成一次。
	 *
	 * ## 为什么需要
	 *
	 * `syncBoxes()` 要读 `getBoundingClientRect()` —— 那是**强制同步布局**：
	 * 浏览器必须先算完排版才能给值。参数面板拖滑块时每敲一下都会请求一次，
	 * 十几次布局叠起来就是"发粘、跟不上手"。
	 *
	 * 合并到每帧一次，视觉上没有任何差别（一帧 16ms 人眼分不出来），
	 * 但布局次数降一个数量级。
	 *
	 * 拿不到 `requestAnimationFrame` 时（比如在 node 里跑测试）**同步执行**——
	 * 调用方不用关心环境，测试里也能直接断言"同步过了"。
	 */
	scheduleSyncBoxes() {
		// ⚠️ 用**真值判断**，不要写 `!== 0`。
		//
		// `boxFrame` 未初始化时是 `undefined`，而 `undefined !== 0` 为真——
		// 那样写会**直接 return，重绘被永久跳过**（界面看起来卡死）。
		// 测试里用一个没有初始化该字段的对象调进来，立刻就暴露了。
		if (this.boxFrame) return;
		const raf = this.host?.ownerDocument?.defaultView?.requestAnimationFrame;
		if (typeof raf !== "function") {
			this.syncBoxes();
			return;
		}
		this.boxFrame = raf(() => {
			this.boxFrame = 0;
			this.syncBoxes();
		});
	}

	/**
	 * 同步高亮框位置。
	 */
	syncBoxes() {
		if (this.hovered !== null && this.hoverEntry !== undefined && this.hovered !== this.selected) {
			const rect = this.elementScreenRect(this.hovered, this.hoverEntry);
			if (rect === null) this.hoverBox.style.display = "none";
			else Object.assign(this.hoverBox.style, {
				display: "block",
				left: `${rect.left}px`, top: `${rect.top}px`,
				width: `${rect.width}px`, height: `${rect.height}px`
			});
		} else {
			this.hoverBox.style.display = "none";
		}

		if (this.selected === null || this.activeEntry === undefined) {
			this.box.style.display = "none";
			this.badge.style.display = "none";
			this.hideHandles();
			return;
		}
		const rect = this.elementScreenRect(this.selected, this.activeEntry);
		if (rect === null) {
			this.box.style.display = "none";
			this.badge.style.display = "none";
			this.hideHandles();
			return;
		}
		Object.assign(this.box.style, {
			display: "block",
			left: `${rect.left}px`, top: `${rect.top}px`,
			width: `${rect.width}px`, height: `${rect.height}px`
		});
		this.placeHandles(rect);
		const tag = this.selected.tagName.toLowerCase();
		Object.assign(this.badge.style, {
			display: "block",
			left: `${rect.left}px`,
			top: `${Math.max(0, rect.top - 20)}px`
		});
		this.badge.textContent = this.located === null
			? tag
			: `${tag} · ${this.located.file}:${this.located.line}`;
	}

	// #endregion

	// #region 选择与改动

	/**
	 * 选中一个元素（null 表示取消）。
	 * @param element - 元素或 null。
	 */
	select(element) {
		// 同帧点击那条路：换选中前先还原上一个元素的实时预览。
		this.revertPreview();
		this.selected = element;
		if (element === null) {
			this.located = null;
			this.box.style.display = "none";
			this.badge.style.display = "none";
			if (this.pickMode) {
				this.placePanel();
				this.panel.root.style.display = "";
			} else {
				this.panel.root.style.display = "none";
			}
			return;
		}
		this.placePanel();
		this.panel.root.style.display = "";
		this.syncBoxes();
		this.refreshPanel();
	}

	/**
	 * 把元素加进/移出多选集合（Ctrl+点击）。
	 *
	 * ## 用途
	 *
	 * 用户要「把已有元素**组合**成组件」—— 那就得先能"挑几个"。
	 * 完整的框选要动 `hitTest` 和拖动逻辑，牵连太大；
	 * Ctrl+点击是明确的"我要挑这几个"，而且**不干扰已有交互**
	 *（不按修饰键时行为完全不变，这是外科手术式改动的前提）。
	 *
	 * @param element - 被点的元素。
	 * @returns { void }。
	 */
	toggleExtraSelection(element) {
		if (element === null || element === undefined) return;
		this.extraSelected = this.extraSelected ?? [];
		const index = this.extraSelected.indexOf(element);
		if (index >= 0) {
			this.extraSelected.splice(index, 1);
			element.style.outline = "";
			element.style.outlineOffset = "";
		} else {
			this.extraSelected.push(element);
			// 虚线框标记：和"选中"的实线框区分开，一眼能看出挑了几个
			element.style.outline = "2px dashed #9334e6";
			element.style.outlineOffset = "2px";
		}
		this.onStatus("", this.extraSelected.length === 0
			? "已清空多选"
			: `已多选 ${this.extraSelected.length} 个元素（「库 → ＋」可存成一个组件）`);
	}

	/** 清掉多选集合和它们身上的临时标记。 */
	clearExtraSelection() {
		for (const element of this.extraSelected ?? []) {
			element.style.outline = "";
			element.style.outlineOffset = "";
		}
		this.extraSelected = [];
	}

	/**
	 * 取"要存成组件的那些元素"。
	 *
	 * 多选集合非空就用它（用户明确挑了），否则退回当前选中的单个元素。
	 *
	 * @returns 元素数组（可能为空）。
	 */
	selectionForComponent() {
		if ((this.extraSelected ?? []).length > 0) return [...this.extraSelected];
		return this.selected === null || this.selected === undefined ? [] : [this.selected];
	}

	/**
	 * 收集所有画板里的关联。
	 *
	 * @returns 关联数组。
	 */
	allLinks() {
		const out = [];
		for (const entry of this.frames?.values?.() ?? []) {
			let doc = null;
			try {
				doc = entry?.iframe?.contentDocument ?? null;
			} catch {
				doc = null;
			}
			if (doc !== null && doc !== undefined) out.push(...collectLinksFromDocument(doc));
		}
		return out;
	}

	/**
	 * 找镶嵌在 `element` 上的图层（**移动它时该跟着动的**）。
	 *
	 * ## 双向的语义（用户确认：互相跟随）
	 *
	 * - **单向**：子跟底座。移动底座 → 子动；移动子 → 底座不动
	 *   （用户明确说子图层"也可以自己自由移动"）
	 * - **双向**：互相跟随。移动任意一个，另一个也动
	 *
	 * 具体判定交给 `followersOf`（纯函数，那边有测试）。
	 *
	 * @param element - 被移动的元素。
	 * @returns 该跟着动的元素数组。
	 */
	followersOfElement(element) {
		const id = element?.getAttribute?.("data-dsh-id") ?? null;
		if (id === null || id === "") return [];
		const ids = followersOf(this.allLinks(), id);
		if (ids.length === 0) return [];

		// 把标识换回元素：可能跨画板，所以每个画板都要找
		const out = [];
		for (const entry of this.frames?.values?.() ?? []) {
			let doc = null;
			try {
				doc = entry?.iframe?.contentDocument ?? null;
			} catch {
				doc = null;
			}
			if (doc === null) continue;
			for (const want of ids) {
				const node = doc.querySelector(`[data-dsh-id="${want}"]`);
				if (node !== null) out.push({ element: node, entry });
			}
		}
		return out;
	}

	/**
	 * 把跟随者按给定的位移同步过去（**只改 DOM，不写源码**）。
	 *
	 * 拖动过程中每帧调 —— 所以必须便宜：只写 `transform`，不读布局。
	 *
	 * @param followers - `followersOfElement` 的结果。
	 * @param dx - 位移（画板内像素）。
	 * @param dy - 位移。
	 * @returns { void }。
	 */
	shiftFollowers(followers, dx, dy) {
		for (const { element } of followers) {
			// 记下起点，松手写回源码时要用
			if (element.__dshFollowOrigin === undefined) {
				element.__dshFollowOrigin = {
					transform: element.style.transform || "",
					left: element.style.left || "",
					top: element.style.top || ""
				};
			}
			element.style.transform = composeTransform(Math.round(dx), Math.round(dy), element.__dshFollowOrigin.transform);
		}
	}

	/**
	 * 松手：把跟随者的位移**写回源码**。
	 *
	 * 拖动中只改 DOM 是刻意的（每帧写源码会出几十个快照和 git 提交），
	 * 但松手后必须落盘 —— 否则刷新一次就跟丢了，而且源码和画面对不上。
	 *
	 * @param followers - `followersOfElement` 的结果。
	 * @param dx - 位移。
	 * @param dy - 位移。
	 * @returns { void }。
	 */
	commitFollowers(followers, dx, dy) {
		for (const { element, entry } of followers) {
			const origin = element.__dshFollowOrigin;
			delete element.__dshFollowOrigin;
			if (origin === undefined) continue;
			// 还原 DOM 上的临时位移，让 declare 从"源码的值"出发算新值
			element.style.transform = origin.transform;

			const previous = this.selected;
			const previousEntry = this.activeEntry;
			this.selected = element;
			this.activeEntry = entry;
			this.declare({
				transform: composeTransform(Math.round(dx), Math.round(dy), origin.transform),
				left: null,
				top: null
			});
			this.selected = previous;
			this.activeEntry = previousEntry;
		}
	}

	/**
	 * 取当前选中元素身上的关联（从**源码标记**反推）。
	 *
	 * 源码是唯一事实来源 —— 不额外维护一份会漂移的缓存。
	 *
	 * @returns { from, mounts, actions } —— `mounts` / `actions` 是关联数组。
	 */
	linksOfSelected() {
		const empty = { from: null, mounts: [], actions: [] };
		if (this.selected === null || this.selected === undefined) return empty;
		const from = this.selected.getAttribute?.("data-dsh-id") ?? null;
		if (from === null || from === "") return empty;

		const all = [];
		for (const entry of this.frames?.values?.() ?? []) {
			const doc = entry?.iframe?.contentDocument ?? null;
			if (doc !== null && doc !== undefined) all.push(...collectLinksFromDocument(doc));
		}
		return {
			from,
			mounts: all.filter((l) => l.from === from && l.kind === LINK_KINDS.mount),
			actions: all.filter((l) => l.from === from && l.kind === LINK_KINDS.action)
		};
	}

	/**
	 * 取画板上所有可关联的图层（供选择模式列出/校验）。
	 *
	 * @returns [{ element, id, label }] —— 同一画板内、排除自身。
	 */
	linkCandidates() {
		const out = [];
		const doc = this.activeEntry?.iframe?.contentDocument ?? null;
		if (doc === null || doc === undefined) return out;
		for (const node of doc.querySelectorAll("*")) {
			if (node === this.selected) continue;
			// body / html 不是"图层"，它们没有可控的位置和尺寸
			if (node === doc.body || node === doc.documentElement) continue;
			const id = node.getAttribute?.("data-dsh-id") ?? null;
			out.push({ element: node, id, label: elementLabel(node) });
		}
		return out;
	}

	/**
	 * 给选中元素与目标元素建立一条关联，并**写进源码**。
	 *
	 * ## 两道必须先做的事
	 *
	 * ① **两个元素都要有 `data-dsh-id`** —— 关联靠它指向对方。
	 *    新建的 id 必须**立刻写回源码**，否则刷新一次关联就断了
	 *   （DOM 上的属性会随重载消失，而源码里没有）。
	 *
	 * ② **镶嵌要过 `canMount`** —— 互相跟随不防环就是死循环，
	 *    而且不是报错，是把页面卡死。
	 *
	 * @param target - 目标元素。
	 * @param spec - { kind, direction, action, target: 应用路径, message, tone }。
	 * @returns { ok, error }。
	 */
	linkTo(target, spec = {}) {
		if (this.selected === null || this.selected === undefined) {
			return { ok: false, error: "先选中一个图层" };
		}
		if (target === null || target === undefined) return { ok: false, error: "没有目标图层" };
		if (target === this.selected) return { ok: false, error: "不能关联到自己" };

		const from = ensureLinkId(this.selected);
		const to = ensureLinkId(target);

		// ① 新生成的 id 必须先落盘：只挂在 DOM 上，刷新就没了
		if (from.created) this.declareOn(this.selected, { "data-dsh-id": from.id });
		if (to.created) this.declareOn(target, { "data-dsh-id": to.id });

		const kind = spec.kind === LINK_KINDS.action ? LINK_KINDS.action : LINK_KINDS.mount;

		if (kind === LINK_KINDS.mount) {
			// ② 防环：镶嵌是"挂在身上"，成环就是死循环
			const all = [];
			for (const entry of this.frames?.values?.() ?? []) {
				const doc = entry?.iframe?.contentDocument ?? null;
				if (doc !== null && doc !== undefined) all.push(...collectLinksFromDocument(doc));
			}
			const check = canMount(all, from.id, to.id);
			if (check.ok === false) return { ok: false, error: check.reason };

			this.declareOn(this.selected, {
				"data-mount": to.id,
				"data-mount-dir": spec.direction === LINK_DIRECTIONS.both ? "both" : "one"
			});
			return { ok: true, error: null, summary: `镶嵌到「${elementLabel(target)}」` };
		}

		// 功能关联：写语义标记，不参与环判定（A 跳 B、B 跳 A 是合法的）
		const attrs = { "data-action": String(spec.action ?? "navigate") };
		if (spec.targetUrl !== undefined && spec.targetUrl !== null) attrs["data-target"] = spec.targetUrl;
		if (spec.message !== undefined && spec.message !== null) attrs["data-message"] = spec.message;
		if (spec.tone !== undefined && spec.tone !== null) attrs["data-tone"] = spec.tone;
		this.declareOn(this.selected, attrs);
		return { ok: true, error: null, summary: `功能：${attrs["data-action"]}` };
	}

	/**
	 * 删掉选中元素上的一条关联（也写回源码）。
	 *
	 * @param kind - mount / action。
	 * @returns { ok }。
	 */
	unlink(kind) {
		if (this.selected === null || this.selected === undefined) return { ok: false };
		if (kind === LINK_KINDS.mount) {
			this.declareOn(this.selected, { "data-mount": null, "data-mount-dir": null });
			return { ok: true };
		}
		this.declareOn(this.selected, {
			"data-action": null, "data-target": null, "data-message": null, "data-tone": null
		});
		return { ok: true };
	}

	/**
	 * 对**指定元素**（不一定是当前选中）声明一组属性。
	 *
	 * 和 `declare` 的区别：那个作用于 `this.selected`，而这个要能改"正在被关联的
	 * 另一个元素"（给它补 `data-dsh-id`）。所以先把选中态临时切过去，
	 * 发完立刻切回来 —— 否则用户会发现"我只是建了个关联，选中项却跳走了"。
	 *
	 * @param element - 目标元素。
	 * @param declarations - 要写的属性（`null` 表示删除）。
	 * @returns { void }。
	 */
	declareOn(element, declarations) {
		const previous = this.selected;
		const previousEntry = this.activeEntry;
		// 找到这个元素属于哪块画板，否则 `sendMutate` 的 boardPath 是错的
		let owner = null;
		for (const entry of this.frames?.values?.() ?? []) {
			let doc = null;
			try {
				doc = entry?.iframe?.contentDocument ?? null;
			} catch {
				doc = null;
			}
			if (doc !== null && doc.contains(element)) { owner = entry; break; }
		}
		if (owner === null) return;

		this.selected = element;
		this.activeEntry = owner;
		this.declare(declarations);
		this.selected = previous;
		this.activeEntry = previousEntry;
	}

	/**
	 * 让某个元素"闪一下"，告诉用户它落在哪。
	 *
	 * 用户的要求：「放置之后的图表呈选中状态，**增加高亮显示**方便用户知道在哪」。
	 *
	 * 选中框已经有了，但新元素出现在一个密集的画板里时，光靠一圈细边框
	 * 还是不容易一眼找到 —— **闪一下**是最直接的提示。
	 *
	 * 用 `outline` 而不是 `border`：outline **不参与布局**，
	 * 加一圈不会把元素和它的邻居挤动（这点在画板里特别重要）。
	 *
	 * 用完就清干净：这几个属性是**临时**的，留在行内样式里会被
	 * 面板当成"这个元素本来就有 outline"读出来，用户下次改样式时就莫名其妙。
	 *
	 * @param element - 要闪的元素。
	 * @returns { void }。
	 */
	flashPlaced(element) {
		if (element === null || element === undefined) return;
		try {
			element.style.outline = "3px solid #1a73e8";
			element.style.outlineOffset = "2px";
			const clear = () => {
				element.style.outline = "";
				element.style.outlineOffset = "";
			};
			// 亮 700ms 再收掉，够看见但不烦人
			this.flashTimers = this.flashTimers ?? new Set();
			const timer = window.setTimeout(() => {
				this.flashTimers.delete(timer);
				clear();
			}, 700);
			this.flashTimers.add(timer);
		} catch { /* 闪一下失败不影响主流程 */ }
	}

	/**
	 * 在选中元素与父/子之间跳转。
	 * @param direction - "parent" | "child"。
	 */
	selectRelative(direction) {
		if (this.selected === null) return;
		const next = direction === "parent"
			? this.selected.parentElement
			: [...(this.selected.children ?? [])][0];
		if (next === null || next === undefined) return;
		const doc = this.selected.ownerDocument;
		if (next === doc.documentElement || next === doc.body) return;
		this.revertPreview();
		this.selected = next;
		this.located = null;
		this.send({ type: "select", hint: describeElement(next), boardPath: this.boardPathOf(this.activeEntry) });
		this.syncBoxes();
		this.refreshPanel();
	}

	/**
	 * 提交一组样式声明（面板改参数走这里）。
	 *
	 * @param declarations - { [property]: value|null }。
	 */
	/**
	 * 从图层树选中一个元素。
	 *
	 * 与在画板里点选走**同一条后续流程**（定位 + 面板 + 选中框），
	 * 区别只是「哪个元素」由树指定而不是由命中测试决定。
	 * 不这么做的话图层树会变成一套平行逻辑，两边状态迟早对不上。
	 *
	 * ## 为什么收的是 boardId 而不是 entry 对象
	 *
	 * 外壳那边的画板条目字段叫 `frame`，编辑层内部叫 `iframe`——**两套形状**。
	 * 早先直接把外壳的条目传进来，`entry.iframe` 就是 undefined，
	 * `elementScreenRect` 抛错、中断在通知之前；表现是「点了图层行，
	 * 画布选中了但树里不亮」。让编辑层按 id 解析自己的条目，这类形状错配就不可能发生。
	 *
	 * @param element - 要选中的元素。
	 * @param boardId - 它所属画板的 id。
	 */
	selectFromTree(element, boardId) {
		const entry = this.frames.get(boardId);
		if (element === null || element === undefined || entry === undefined) return;
		this.activeId = entry.id;
		this.activeEntry = entry;
		this.revertPreview();
		this.selected = element;
		this.located = null;
		this.placePanel();
		this.panel.root.style.display = "";
		this.syncBoxes();
		this.refreshPanel();
		this.onStatus("", "正在定位源码…");
		this.send({ type: "select", hint: describeElement(element), boardPath: this.boardPathOf(entry) });
		this.notifySelection();
	}

	/**
	 * 图层树悬停预览：只画高亮框，不改变选中。
	 * @param element - 元素。
	 * @param boardId - 所属画板 id。
	 */
	previewFromTree(element, boardId) {
		const entry = this.frames.get(boardId);
		if (entry === undefined) return;
		this.hovered = element;
		this.hoverEntry = entry;
		this.syncBoxes();
	}

	/** 清掉图层树的悬停预览。 */
	clearTreePreview() {
		this.hovered = null;
		this.hoverEntry = null;
		this.syncBoxes();
	}

	/**
	 * 元素或它的任一祖先是否被锁定。
	 *
	 * 必须往上找：锁的是容器时，里面所有内容都不该被点中——
	 * 只判断元素自己，「锁住背景」就完全达不到目的（点它的子元素照样选中）。
	 *
	 * @param element - 元素。
	 * @returns 是否锁定。
	 */
	isLockedFrom(element) {
		const check = this.isLocked;
		if (typeof check !== "function") return false;
		let current = element;
		while (current !== null && current !== undefined) {
			if (check(current) === true) return true;
			current = current.parentElement;
		}
		return false;
	}

	/**
	 * 面板的**实时预览**：把声明直接写到元素的 inline style 上，**不碰源码**。
	 *
	 * 为什么与 declare 分成两条路：输入框每敲一个字符就落盘，会写出几十个快照、
	 * 几十次 git 提交，撤销栈也被灌满。预览只动内存里的样式，落盘仍然只有一次
	 *（回车 / 失焦 / 取色器关闭时）。
	 *
	 * 代价是预览改写了 inline style，所以：
	 * 1. 首次碰到某个属性时记下**原值**（`previewOrigin`），落盘失败时据此还原
	 * 2. 落盘成功会重载画板，预览自然被真实值取代
	 *
	 * @param declarations - { [property]: value|null }。
	 */
	previewFromPanel(declarations) {
		if (this.selected === null || this.selected === undefined) return;
		this.previewOrigin = this.previewOrigin ?? {};
		this.previewTarget = this.selected;
		for (const [key, value] of Object.entries(declarations ?? {})) {
			// 只在**第一次**碰到这个属性时记原值。记晚了记到的就是上一次预览的值，
			// 落盘失败时"还原"会还原成一个中间态。
			if (!(key in this.previewOrigin)) {
				this.previewOrigin[key] = this.selected.style.getPropertyValue(key);
			}
			if (value === null || value === "") this.selected.style.removeProperty(key);
			else this.selected.style.setProperty(key, String(value));
		}
		// 节流版：拖参数滑块时每帧最多重绘一次（见 scheduleSyncBoxes）。
		// 直接调 syncBoxes 的话，每敲一下数值都会强制一次布局 → 面板发粘、框跟不上手。
		this.scheduleSyncBoxes();
	}

	/**
	 * 把实时预览回滚到预览开始前的状态。
	 *
	 * 用在两处：落盘失败、以及换了选中元素（旧元素的预览不该继续留在页面上）。
	 */
	revertPreview() {
		const origin = this.previewOrigin;
		const target = this.previewTarget;
		this.previewOrigin = null;
		this.previewTarget = null;
		if (origin === null || origin === undefined || target === null || target === undefined) return;
		for (const [key, value] of Object.entries(origin)) {
			// 原值为空串 = 本来就没有这个 inline 声明 → 移除，而不是写一个空值
			if (value === "") target.style.removeProperty(key);
			else target.style.setProperty(key, value);
		}
	}

	/**
	 * 图层树要用的几个入口。
	 *
	 * 都放在编辑层而不是外壳：外壳拿不到 iframe 里的元素细节
	 *（describeElement 要用 computed style、class、文本等），
	 * 而且这样「画布点选」与「树上操作」走的是**同一套描述逻辑**，
	 * 不会出现两边对同一个元素给出不同线索、定位结果打架的情况。
	 */

	/**
	 * 描述一个元素（供宿主定位）。
	 * @param element - 元素。
	 * @returns 线索对象。
	 */
	describeForTree(element) {
		return describeElement(element);
	}

	/**
	 * 取一个元素已经定位好的位置，用作 pin。
	 *
	 * 结构改动必须带 pin：宿主对结构变更不做猜测（插错地方很难发现），
	 * 而选中时已经定位过一次，直接复用那个结果即可。
	 *
	 * @param element - 元素。
	 * @returns { file, line } 或 undefined。
	 */
	pinForTree(element) {
		if (this.located === null || this.located === undefined) return undefined;
		if (this.selected !== element) return undefined;
		return { file: this.located.file, line: this.located.line };
	}

	/**
	 * 取元素的外层 HTML（「用 div 包裹」要用）。
	 * @param element - 元素。
	 * @returns HTML 字符串。
	 */
	outerHtmlForTree(element) {
		try {
			return element.outerHTML;
		} catch {
			return "";
		}
	}

	/**
	 * 从图层树改样式（眼睛图标的显示/隐藏走这条）。
	 * @param element - 元素。
	 * @param boardId - 画板 id。
	 * @param declarations - 样式声明。
	 */
	declareFromTree(element, boardId, declarations) {
		this.selectFromTree(element, boardId);
		this.declare(declarations);
	}

	/**
	 * 发一次结构改动。
	 * @param kind - "duplicate" | "remove" | "insert" | "move"。
	 * @param hint - 元素线索。
	 * @param boardPath - 画板路径。
	 * @param payload - 额外参数。
	 * @param pin - 已定位的位置。
	 */
	sendMutate(kind, hint, boardPath, payload, pin, entry) {
		// 记下**这次改动实际作用在哪块画板**。
		//
		// 回执到达时优先用它，而不是 `this.activeEntry`：
		// 用户可能对着 A 板画形状、而"激活"的是 B 板（多点几下就会这样），
		// 那时重载的是 B —— 表现就是"图形还是没出现"，会被当成没修好。
		this.pendingMutateEntry = entry ?? null;
		this.send({ type: "mutate", kind, hint, boardPath, payload, pin });
	}

	/**
	 * 通知外部「选中变了」。
	 *
	 * 图层树要靠它把对应行高亮并滚进视野。没有这个回调，
	 * 在画板里点选之后树里毫无反应，用户就不知道自己落在哪一层。
	 */
	notifySelection() {
		// 选中变了 → 顺手刷新"画板上已有的值"（面板上每个字段下面那排快选）。
		//
		// 放在这里而不是每次打开面板时现算：收集要遍历画板里**每一个元素**并
		// 逐个读计算样式，是个实打实的开销；而选中变化的频率低得多。
		this.refreshPalette();
		this.onSelectionChange?.(this.selected);
	}

	/**
	 * 取消当前选中。
	 *
	 * ## 为什么要单独一个方法（用户报的「退出选中后还有浮窗和选中框」）
	 *
	 * 清选中原来是**内联**写的（`this.selected = null; this.syncBoxes();`），
	 * 只在"落盘后重载"那几处用到。Esc 在外面自己拼，结果拼漏了东西：
	 *
	 *   - **检查器浮窗**：它读的是 `editor.selected`（外壳的 `syncInspector`），
	 *     不通知外壳 → 浮窗继续显示上一个元素（截图里那个 `div.path`）
	 *   - **画板选中框**：那是外壳的 `state.selectedId`，
	 *     和"元素选中"是**两件事**，只清元素的话框还留在画布上
	 *
	 * 所以这里一次做全：清元素 → 收框 → **通知外壳**
	 *（连带刷图层树 / 检查器 / 形状面板）。
	 *
	 * @returns { boolean } 之前是否有选中 —— 调用方据此决定提示语。
	 */
	clearSelection() {
		const hadSelection = this.selected !== null && this.selected !== undefined;
		this.selected = null;
		this.located = null;
		// 收掉选中框、角上的把手和尺寸角标
		this.syncBoxes();
		// 通知外壳：检查器浮窗、形状面板、图层树高亮全跟着走
		this.notifySelection();
		return hadSelection;
	}

	/**
	 * 重新收集"画板上已经在用的值"（颜色 / 字体 / 字号 / 整套文字样式）。
	 *
	 * 结果缓存在 `this.palette`，面板通过 `getPalette()` **同步**取用 ——
	 * 面板渲染是同步的，不能等 Promise。
	 *
	 * ## 为什么处处防御
	 *
	 * 它挂在 `notifySelection()` 上，而那是**极热的路径**：任何构造方式、
	 * 任何调用顺序都会走到。只加一句 `this.frames.values()` 就让
	 * `remove-and-reload-harness` 整个炸掉（那里构造的 editor 没有 frames）。
	 *
	 * **规律**：往热门路径上加副作用时，必须考虑"最小构造"——
	 * 测试、嵌入、以及将来任何不完整的使用方式。收集失败不该影响业务，
	 * 这里连"没有 frames"都算收集失败。
	 *
	 * @returns { void }。
	 */
	refreshPalette() {
		try {
			const docs = [];
			for (const entry of this.frames?.values?.() ?? []) {
				const doc = entry?.iframe?.contentDocument ?? null;
				if (doc !== null && doc !== undefined) docs.push(doc);
			}
			this.palette = collectPalette(docs);
		} catch {
			// 面板打不开比"没有快选"严重得多 —— 出错就退回空列表
			this.palette = EMPTY_PALETTE;
		}
	}

	declare(declarations) {
		if (this.selected === null) return;
		// 一次面板改动 / 拖动写回的 trace
		this.beginTrace("declare");
		// **必须挂上 pendingCommit**，否则写回成功后 settleCommit 会直接返回：
		// 不刷新画板、不刷新面板、不报状态。
		//
		// 实测症状正是这三件事同时发生：面板里选了形状立刻弹回默认、
		// 页面看不出任何变化，但手动刷新后又变成刚选的那个——
		// 因为**源码其实写进去了**，只是没人把新值取回来。
		// 拖动路径一直是好的，就是因为它有这一行。
		this.pendingCommit = {
			node: this.selected,
			entry: this.activeEntry,
			origin: {
				transform: this.selected.style.transform || "",
				width: this.selected.style.width || "",
				height: this.selected.style.height || ""
			},
			// 重发用：用户换候选位置时要原样再发一次。
			declarations,
			hint: describeElement(this.selected)
		};
		this.onStatus("", "正在写入…");
		this.send({ type: "declare", hint: describeElement(this.selected), declarations, boardPath: this.boardPathOf(this.activeEntry), pin: this.pinOf() });
	}

	/**
	 * 画板里的按键。
	 *
	 * ## 为什么必须在这里再挂一份（实测踩过）
	 *
	 * 外壳的 `window` 上有快捷键监听，但**画板是 iframe**——
	 * iframe 里的按键事件**不会冒泡到父文档**。
	 *
	 * 用户的操作顺序恰恰是：**点画板选中形状 → 按 Delete**。
	 * 这时焦点在画板里，外壳那个监听**根本收不到**，表现就是
	 * 「删除功能做了，但按了没反应」。
	 *
	 * 同理，撤销/重做在外壳里绑了 Ctrl+Z，在画板里也按不动。
	 *
	 * ## 职责边界
	 *
	 * 这里**只处理元素级**的操作。删整块画板不归这儿管——
	 * 编辑层不知道画板列表，越权去删会删错东西。
	 *
	 * @param event - 键盘事件。
	 */
	onFrameKey(event) {
		// 在画板自己的输入框里打字时不要抢键（否则退格会删元素）
		const target = event.target;
		const view = target?.ownerDocument?.defaultView ?? null;
		if (view !== null
			&& (target instanceof view.HTMLInputElement || target instanceof view.HTMLTextAreaElement)) {
			return;
		}
		if (target?.isContentEditable === true) return;

		const mod = event.ctrlKey || event.metaKey;
		if (mod && event.key.toLowerCase() === "z") {
			event.preventDefault();
			this.history(event.shiftKey ? "redo" : "undo");
			return;
		}
		if (mod && event.key.toLowerCase() === "y") {
			event.preventDefault();
			this.history("redo");
			return;
		}
		// 其余带修饰键的组合交还给画板自己的页面
		if (mod) return;

		// ---- Esc：转发给外壳统一处理 ----
		//
		// 焦点在画板里时，键盘事件**冒泡不到外壳的 window**，
		// 所以外壳的 Esc 处理收不到它 —— 用户点画板元素选中后按 Esc
		// 会"退不出选中，只能刷新"（用户原话）。
		//
		// 这里不自己实现一套 Esc 逻辑（两套迟早漂移），
		// 而是**转发给外壳的 `handleEscape`**，保证两个入口语义完全一致。
		if (event.key === "Escape") {
			this.onEscape?.();
			return;
		}

		if (event.key !== "Delete" && event.key !== "Backspace") return;
		// 没有选中元素就什么都不做（**不要**退化成删画板）
		if (this.selected === null || this.selected === undefined) return;
		event.preventDefault();
		this.removeSelected();
	}

	/**
	 * 当前选中元素**已知的源码位置**，用作写回的 `pin`。
	 *
	 * ## 为什么必须带（2026-10-07 实测）
	 *
	 * 用户报：「移动一个组件时，**另一个没被选中的组件会随机偏移**，
	 * 甚至会带着已经移动过的那个一起偏」，并怀疑"组件之间有依赖关系"。
	 *
	 * 他感觉到的"依赖"是真的，但发生在**写回定位**上：
	 * 拖动写回走 `declare`，而定位是**按内容猜**的。
	 * 多个组件 class 相同、文本相同、尺寸相近时打分**完全一样** →
	 * `apply` 在歧义时会**自动挑一个**（`remove` 会拒绝，`apply` 不会，
	 * 因为"直接拒绝"会让用户卡死）→ 位移被写进了**另一个组件**的源码里。
	 *
	 * 而位置其实**早就知道了**：选中元素时宿主回过 `located: {file, line}`。
	 * 带上它，写回就是**精确**的，不再靠猜。
	 *
	 * 拿不到时返回 `undefined` —— 宿主会退回原来的"按线索猜"。
	 * **不能因为拿不到就报错**，那是把一条本来可用的路径变成不可用。
	 *
	 * ## ⚠️ 必须传"这次要改的那个元素"
	 *
	 * 反例（实测，用户报的"另一个组件跟着偏移"就是这么来的）：
	 * 选中 A 之后**直接按住 B 拖**——`drag.node` 是 B，而 `located` 还是 A 的位置。
	 * 拿 A 的 pin 去写 B 的位移，**B 的改动就落进了 A 的源码**。
	 * 所以只有"要改的元素就是当前选中那个"时，这个位置才可信。
	 *
	 * @param element - 这次要改的元素（不传则不校验，按当前选中算）。
	 * @returns { {file: string, line: number}|undefined }。
	 */
	pinOf(element) {
		if (element !== undefined && element !== null && element !== this.selected) return undefined;
		const located = this.located;
		if (located === null || located === undefined) return undefined;
		if (typeof located.file !== "string" || located.file === "") return undefined;
		if (typeof located.line !== "number" || located.line <= 0) return undefined;
		return { file: located.file, line: located.line };
	}

	/**
	 * 撤销 / 重做。
	 *
	 * ## 为什么要单独一个方法（不能直接 `send({type:"undo"})`）
	 *
	 * 撤销**没有 `pendingCommit`**，而 `settleCommit` 第一行就是
	 * 「拿不到 commit 直接 return」——于是：
	 * 宿主真的撤销了、文件真的回滚了、回执也回来了，
	 * 但**画板不重载**，用户看到的还是旧画面 → 「撤销没反应」。
	 *
	 * 实测就是这么回事：删除和撤销一起报"不行"，但**两个原因完全不同**——
	 * 删除是被宿主拒了（定位不唯一），撤销是**画板没刷新**。
	 *
	 * @param type - "undo" 或 "redo"。
	 * @returns {boolean} 是否发出去了（socket 没开时返回 false）。
	 */
	history(type) {
		this.pendingHistoryReload = type;
		const sent = this.send({ type });
		// 没发出去就别留着等回执，否则下一次 applied 会被误认成撤销
		if (sent === false) this.pendingHistoryReload = null;
		return sent;
	}

	/**
	 * 撤销/重做的回执：宿主已经改回来了，**必须重载画板才看得见**。
	 *
	 * 选中清掉：撤销之后原来那个元素可能已经不存在（比如撤掉了"插入"），
	 * 留着一个游离引用会让选中框停在错的地方。
	 *
	 * @param payload - 回执。
	 */
	afterHistoryReload(payload) {
		if (payload.ok === false) {
			this.onStatus("err", payload.message ?? "撤销/重做失败");
			return;
		}
		this.onStatus("ok", payload.message ?? "已撤销");
		// 预览要撤掉：撤销改变的是源码，页面上那份行内预览已经不是事实了
		this.revertPreview();
		this.selected = null;
		this.located = null;
		this.syncBoxes();
		this.notifySelection();
		this.hideCandidates();
		const entry = this.activeEntry;
		if (entry !== undefined && entry !== null) this.reloadBoard(entry);
	}

	/**
	 * 删除当前选中的元素。
	 *
	 * ## 为什么必须有这个方法（不能让它去调 `removeBoard`）
	 *
	 * 实测踩到的 bug：外壳里 `Delete` 键绑的是 `removeBoard(state.selectedId)`——
	 * 那是**删整块画板**。用户选中一个自己画的形状按 Delete，
	 * 期望删形状，结果**整块画板没了**。
	 *
	 * 根因是「选中的元素」和「选中的画板」是两个不同的东西，
	 * 而键盘只有一套。判定必须由**同时知道这两者**的这一层做，
	 * 所以放在这里：`this.selected` 是元素，`this.activeEntry` 是画板。
	 *
	 * @returns {boolean} 是否真的发出了删除请求（false = 没删，原因已报给界面）。
	 */
	removeSelected() {
		if (this.selected === null || this.selected === undefined) return false;
		const entry = this.activeEntry;
		if (entry === undefined || entry === null) {
			this.onStatus("err", "不知道这个元素属于哪块画板，没法删除");
			return false;
		}
		// 画板重载后旧引用会游离到文档之外。游离节点删不掉，定位也必然失败，
		// 所以先挡掉——**并且说明原因**，静默失败是最难查的一类。
		if (this.selected.isConnected === false) {
			this.onStatus("warn", "这个元素已经不在画板上了（可能刚重载过），请重新点选一次再删");
			return false;
		}
		const hint = describeElement(this.selected);
		this.onStatus("", `正在删除 <${String(hint.tag ?? "元素")}>…`);
		this.sendMutate("remove", hint, this.boardPathOf(entry));
		return true;
	}

	/**
	 * 读元素**当前生效**的样式（计算值），供面板显示。
	 *
	 * ## 为什么不能用行内样式
	 *
	 * 面板原先读的是 `element.style`（行内样式）。可真实项目的样式几乎都在 class 里，
	 * 行内是空的——于是面板全白、看着像坏了，用户根本无从下手改。
	 * 这正是「选中了却改不了」的直接原因。
	 *
	 * 读计算值符合直觉：面板显示你看到的颜色/字号，改了就写成行内样式覆盖它
	 * （与浏览器 DevTools 的行为一致）。
	 *
	 * @param element - 元素。
	 * @returns { [cssProperty]: string }。
	 */
	readEffectiveStyles(element) {
		const KEYS = [
			"color", "font-size", "font-weight", "line-height", "text-align",
			"background-color", "border-radius", "border-width", "border-color", "opacity", "box-shadow",
			"padding", "margin", "gap",
			"width", "height", "display", "flex-direction", "align-items", "justify-content",
			"clip-path"
		];
		const out = {};
		let computed;
		try {
			computed = element.ownerDocument.defaultView.getComputedStyle(element);
		} catch {
			return readInlineStyles(element);
		}
		for (const key of KEYS) {
			const value = computed.getPropertyValue(key);
			if (value !== "" && value !== undefined) out[key] = value.trim();
		}
		// 行内已有的值优先（那是用户/插件刚写进去的，最贴近「当前设定」）。
		return { ...out, ...readInlineStyles(element) };
	}

	/**
	 * 刷新面板内容。
	 */
	refreshPanel() {
		// 再次定位时画板可能已经被移除。
		if (this.selected !== null && this.activeEntry === undefined) {
			const owning = [...this.frames.values()].find((entry) => entry.iframe.contentDocument === this.selected.ownerDocument);
			if (owning !== undefined) this.activeEntry = owning;
		}
		if (this.selected === null) return;
		this.panel.update({
			tagName: this.selected.tagName.toLowerCase(),
			location: this.located,
			styles: this.readEffectiveStyles(this.selected),
			pending: this.pending,
			canUndo: this.canUndo,
			canRedo: this.canRedo,
			hasChild: this.selected.children.length > 0
		});
	}

	// #endregion

	/** 销毁（插件卸载或画布关闭时）。 */
	destroy() {
		for (const entry of this.frames.values()) this.detach(entry);
		this.frames.clear();
		this.socket?.close();
		this.host.remove();
	}
}
