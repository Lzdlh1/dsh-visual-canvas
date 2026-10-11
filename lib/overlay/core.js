/**
 * 覆盖层主体：注入到被代理页面里的可视化编辑器。
 *
 * ## 结构
 *
 * - 一个 Shadow DOM 宿主 → 面板样式与宿主页面的 CSS 完全隔离
 * - 选中高亮框 / 悬停提示（同样在 Shadow DOM 里，用绝对定位覆盖）
 * - WebSocket 连回 DSH 宿主：送「选中线索 + 声明改动」，收「定位结果 + 状态」
 *
 * ## 元素 → 源码 的线索怎么来
 *
 * 覆盖层自己不解析源码，只负责**尽可能多地带回线索**，由宿主侧决定怎么用：
 *
 * | 线索 | 来源 | 用途 |
 * |---|---|---|
 * | `file` / `line` | React fiber 的 `_debugSource`、Vue 组件实例、Svelte 元数据 | A/B 档精确映射 |
 * | `chain` | 向上遍历 DOM 收集的 标签+class 序列 | 消歧 |
 * | `texts` | 元素自身与前几层子元素的可见文本 | C 档搜索 |
 * | `classes` | 元素与祖先的 class 名（过滤掉工具类） | C 档搜索 |
 * | `tag` / `id` | 元素自身 | 精确定位标签 |
 *
 * 这套线索对**任何框架**都成立——最坏情况退化成「按文本搜源码」，
 * 这正是「不挑技术栈」的兜底。
 */

import { EditorPanel, PANEL_CSS, el } from "./editor.js";

/** 面板不参与选择/拖拽的容器标识。 */
const HOST_ID = "__dsh_visual_canvas__";

/** 认为「工具类」的 class 名模式（Tailwind 等）：这类名字搜源码命中率低。 */
const UTILITY_CLASS = /^(?:[a-z]+-)?(?:\[|[a-z0-9]+(?:-[a-z0-9./[\]]+)*)$/u;

/**
 * 从元素上取框架内部的源文件信息。
 *
 * React（dev 构建）会在 fiber 上挂 `_debugSource`；
 * Vue 3 的组件实例有 `__vueParentComponent`；
 * Svelte 有 `__svelte_meta`。
 *
 * @param element - DOM 元素。
 * @returns { file, line } 或 null。
 */
export function frameworkSource(element) {
	// React：沿 fiber 链找最近的 _debugSource
	let node = element;
	for (let depth = 0; node !== null && depth < 40; depth += 1) {
		for (const key of Object.keys(node)) {
			if (!key.startsWith("__reactFiber$") && !key.startsWith("__reactInternalInstance$")) continue;
			let fiber = node[key];
			for (let hop = 0; fiber !== null && hop < 20; hop += 1) {
				const source = fiber._debugSource ?? fiber.memoizedProps?.__source;
				if (source !== undefined && typeof source.fileName === "string") {
					return { file: source.fileName, line: source.lineNumber ?? null, strategy: "fiber" };
				}
				fiber = fiber.return;
			}
		}
		node = node.parentElement;
	}

	// Vue 3
	let current = element;
	for (let depth = 0; current !== null && depth < 20; depth += 1) {
		const instance = current.__vueParentComponent;
		if (instance !== undefined) {
			const file = instance.type?.__file ?? instance.type?.__fileName;
			if (typeof file === "string") return { file, line: null, strategy: "vue" };
		}
		current = current.parentElement;
	}

	// Svelte
	let svelteNode = element;
	for (let depth = 0; svelteNode !== null && depth < 20; depth += 1) {
		const meta = svelteNode.__svelte_meta;
		if (meta !== undefined && typeof meta.loc?.file === "string") {
			return { file: meta.loc.file, line: meta.loc.line ?? null, strategy: "svelte" };
		}
		svelteNode = svelteNode.parentElement;
	}

	return null;
}

/**
 * 收集元素的可见文本（自身 + 浅层子元素）。
 * @param element - DOM 元素。
 * @returns 文本数组（去重、限长）。
 */
export function collectTexts(element) {
	const out = [];
	const push = (value) => {
		const text = String(value ?? "").replace(/\s+/gu, " ").trim();
		if (text.length < 3 || text.length > 120) return;
		if (!out.includes(text)) out.push(text);
	};
	// 直接子文本节点
	for (const child of element.childNodes) {
		if (child.nodeType === 3) push(child.textContent);
	}
	// 浅层子元素的文本
	for (const child of element.children) {
		const direct = [...child.childNodes].filter((item) => item.nodeType === 3).map((item) => item.textContent).join(" ");
		push(direct);
		if (out.length >= 6) break;
	}
	if (out.length === 0) push(element.textContent);
	return out.slice(0, 6);
}

/**
 * 收集元素与祖先的 class 名（过滤掉工具类与过短的名字）。
 * @param element - DOM 元素。
 * @returns class 名数组。
 */
export function collectClasses(element) {
	const out = [];
	let node = element;
	for (let depth = 0; node !== null && depth < 4; depth += 1) {
		for (const name of node.classList ?? []) {
			if (name.length < 3 || name.length > 60) continue;
			if (out.includes(name)) continue;
			// 优先保留「看起来像语义命名」的（含 - 或 _ 或驼峰），跳过纯工具类噪声。
			if (UTILITY_CLASS.test(name) && out.length >= 4) continue;
			out.push(name);
		}
		node = node.parentElement;
	}
	return out.slice(0, 10);
}

/**
 * 收集从根到元素的标签链路。
 * @param element - DOM 元素。
 * @returns 形如 ["main", "section.card", "div"] 的数组。
 */
export function collectChain(element) {
	const parts = [];
	let node = element;
	for (let depth = 0; node !== null && node.tagName !== undefined && depth < 6; depth += 1) {
		const tag = node.tagName.toLowerCase();
		if (tag === "html" || tag === "body") break;
		const first = node.classList?.[0];
		parts.unshift(first === undefined ? tag : `${tag}.${first}`);
		node = node.parentElement;
	}
	return parts;
}

/**
 * 定位时用来**区分同类元素**的内联样式键。
 *
 * 为什么是这两个：画出来的形状是一堆 `div.dsh-shape`，
 * 源码行除了 `left` / `top` 几乎一模一样。不带坐标的话，
 * 按 class / tag / chain 打分它们**完全同分** → 判为"定位不唯一" →
 * `remove` 这类会破坏内容的操作被**直接拒绝** → 用户"画得出来、删不掉"。
 */
const LOCATE_STYLE_KEYS = ["left", "top"];

/**
 * 取几个能区分同类元素的内联样式值。
 * @param element - DOM 元素。
 * @returns { [key]: string }；一个都没有时返回 undefined。
 */
function locateStyle(element) {
	const out = {};
	for (const key of LOCATE_STYLE_KEYS) {
		// `style` 可能是真的 CSSStyleDeclaration（有 getPropertyValue），
		// 也可能是测试里的普通对象 —— 两种都兜住
		const fromGetter = element.style?.getPropertyValue?.(key);
		const value = typeof fromGetter === "string" && fromGetter !== "" ? fromGetter : element.style?.[key];
		if (typeof value === "string" && value !== "") out[key] = value;
	}
	return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * 把元素的信息打包成给宿主的线索。
 * @param element - DOM 元素。
 * @returns 线索对象。
 */
export function describeElement(element) {
	const framework = frameworkSource(element);
	const rect = element.getBoundingClientRect();
	return {
		tag: element.tagName.toLowerCase(),
		id: element.id === "" ? undefined : element.id,
		texts: collectTexts(element),
		classes: collectClasses(element),
		chain: collectChain(element),
		file: framework?.file,
		line: framework?.line ?? undefined,
		strategy: framework?.strategy ?? "search",
		rect: { width: Math.round(rect.width), height: Math.round(rect.height) },
		// 具体原因见 LOCATE_STYLE_KEYS 的注释
		style: locateStyle(element)
	};
}

/**
 * 读取元素上「已经写在源码里」的内联样式（不是计算样式）。
 *
 * 面板要显示的是**能被写回的值**，所以读内联 style 与 class 上的常见属性，
 * 而不是 getComputedStyle（那会把浏览器默认值也写进源码）。
 *
 * @param element - DOM 元素。
 * @returns { [property]: string }。
 */
export function readInlineStyles(element) {
	const out = {};
	for (const [key, value] of Object.entries(element.style ?? {})) {
		if (typeof value !== "string" || value === "") continue;
		out[key] = value;
	}
	return out;
}

/**
 * 覆盖层。
 */
export class Overlay {
	/**
	 * @param options - { endpoint: WebSocket 地址 }。
	 */
	constructor(options) {
		this.endpoint = options.endpoint;
		this.selected = null;
		this.hovered = null;
		this.enabled = true;
		this.socket = null;
		this.reconnectDelay = 500;
		this.shadow = null;
		this.pendingCount = 0;
		this.canUndo = false;
		this.canRedo = false;
		this.drag = null;
		this.build();
		this.connect();
	}

	/**
	 * 建立 Shadow DOM 与面板。
	 */
	build() {
		const host = el("div", { id: HOST_ID });
		host.style.cssText = "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483000;";
		this.host = host;
		this.shadow = host.attachShadow({ mode: "open" });
		const style = document.createElement("style");
		style.textContent = PANEL_CSS;
		this.shadow.append(style);

		// 高亮框与标签
		this.box = el("div", {
			style: {
				position: "fixed", pointerEvents: "none", border: "1px solid #4f8cff",
				background: "rgba(79,140,255,.12)", borderRadius: "2px", display: "none", zIndex: "2147483001"
			}
		});
		this.hoverBox = el("div", {
			style: {
				position: "fixed", pointerEvents: "none", border: "1px dashed #9aa0a6",
				display: "none", zIndex: "2147483000"
			}
		});
		this.badge = el("div", {
			style: {
				position: "fixed", pointerEvents: "none", background: "#4f8cff", color: "#fff",
				font: "11px/1.5 ui-monospace, Consolas, monospace", padding: "1px 5px",
				borderRadius: "3px", display: "none", zIndex: "2147483002", whiteSpace: "nowrap"
			}
		});
		this.panel = new EditorPanel({
			onDeclare: (declarations) => this.declare(declarations),
			onUndo: () => this.send({ type: "undo" }),
			onRedo: () => this.send({ type: "redo" }),
			onApplyPending: () => this.send({ type: "applyPending" }),
			onDiscardPending: () => this.send({ type: "discardPending" }),
			onPickParent: () => this.selectRelative("parent"),
			onPickChild: () => this.selectRelative("child")
		});
		this.shadow.append(this.hoverBox, this.box, this.badge, this.panel.root);
		this.buildHandles();
		document.documentElement.append(host);
		this.bindEvents();
	}

	/**
	 * 构建拖拽与缩放手柄（挂在选中框上）。
	 *
	 * 为什么用「拖拽 → transform / width」而不是自由绝对定位：
	 * 落盘必须是 CSS 语义（transform、width 等），自由绝对定位无法确定性映射回源码。
	 * 所以这里拖出来的位移会变成 `transform: translate(Xpx, Ypx)`，尺寸变成 width/height。
	 */
	buildHandles() {
		this.box.style.pointerEvents = "auto";
		this.box.style.cursor = "move";
		this.handles = {};
		const corners = [
			["nw", "cursor: nwse-resize; left: -5px; top: -5px;"],
			["ne", "cursor: nesw-resize; right: -5px; top: -5px;"],
			["sw", "cursor: nesw-resize; left: -5px; bottom: -5px;"],
			["se", "cursor: nwse-resize; right: -5px; bottom: -5px;"]
		];
		for (const [name, css] of corners) {
			const handle = el("div", {
				style: {
					position: "absolute", width: "9px", height: "9px", background: "#4f8cff",
					border: "1.5px solid #fff", borderRadius: "2px", pointerEvents: "auto"
				}
			});
			handle.style.cssText += css;
			handle.addEventListener("pointerdown", (event) => this.beginResize(event, name));
			this.handles[name] = handle;
			this.box.append(handle);
		}
		this.box.addEventListener("pointerdown", (event) => this.beginMove(event));
	}

	/**
	 * 开始拖动位置。
	 * @param event - PointerEvent。
	 */
	beginMove(event) {
		if (this.selected === null) return;
		if (event.target !== this.box) return;
		event.preventDefault();
		event.stopPropagation();
		const rect = this.selected.getBoundingClientRect();
		this.drag = {
			mode: "move",
			startX: event.clientX,
			startY: event.clientY,
			originLeft: rect.left,
			originTop: rect.top,
			appliedX: 0,
			appliedY: 0
		};
		this.rememberOriginals("move");
		this.capture(event);
	}

	/**
	 * 开始缩放尺寸。
	 * @param event - PointerEvent。
	 * @param corner - 角名（nw/ne/sw/se）。
	 */
	beginResize(event, corner) {
		if (this.selected === null) return;
		event.preventDefault();
		event.stopPropagation();
		const rect = this.selected.getBoundingClientRect();
		this.drag = {
			mode: "resize",
			corner,
			startX: event.clientX,
			startY: event.clientY,
			originWidth: rect.width,
			originHeight: rect.height,
			appliedWidth: Math.round(rect.width),
			appliedHeight: Math.round(rect.height)
		};
		this.rememberOriginals("resize");
		this.capture(event);
	}

	/**
	 * 接管指针事件（拖到窗口外也不丢）。
	 * @param event - PointerEvent。
	 */
	capture(event) {
		if (event.pointerId !== undefined && typeof this.box.setPointerCapture === "function") {
			// 尽力捕获；失败也不影响（window 上的监听已覆盖移出元素的情况）。
			try {
				this.box.setPointerCapture(event.pointerId);
			} catch {
				// 忽略
			}
		}
		const onMove = (moveEvent) => this.onDragMove(moveEvent);
		const onUp = () => {
			window.removeEventListener("pointermove", onMove, true);
			window.removeEventListener("pointerup", onUp, true);
			this.endDrag();
		};
		window.addEventListener("pointermove", onMove, true);
		window.addEventListener("pointerup", onUp, true);
	}

	/**
	 * 拖动中：实时预览。
	 * @param event - PointerEvent。
	 */
	onDragMove(event) {
		if (this.drag === null || this.selected === null) return;
		event.preventDefault();
		if (this.drag.mode === "move") {
			const dx = Math.round(event.clientX - this.drag.startX);
			const dy = Math.round(event.clientY - this.drag.startY);
			this.drag.appliedX = dx;
			this.drag.appliedY = dy;
			this.selected.style.transform = `translate(${dx}px, ${dy}px)`;
			this.syncBoxes();
			return;
		}
		// 缩放：按拖动的角算增量（左/上角同时影响宽高）
		const dx = Math.round(event.clientX - this.drag.startX);
		const dy = Math.round(event.clientY - this.drag.startY);
		const signX = this.drag.corner.includes("e") ? 1 : -1;
		const signY = this.drag.corner.includes("s") ? 1 : -1;
		const width = Math.max(8, Math.round(this.drag.originWidth + dx * signX));
		const height = Math.max(8, Math.round(this.drag.originHeight + dy * signY));
		this.drag.appliedWidth = width;
		this.drag.appliedHeight = height;
		this.selected.style.width = `${width}px`;
		this.selected.style.height = `${height}px`;
		this.syncBoxes();
	}

	/**
	 * 拖动结束：把预览值转成声明发给宿主。
	 *
	 * 这里会先把预览用的内联样式**还原**，再发声明——否则 HMR 重渲染后
	 * 会叠加出两条一样的声明，源码里也看不出是谁写的。
	 */
	endDrag() {
		if (this.drag === null || this.selected === null) {
			this.drag = null;
			return;
		}
		const drag = this.drag;
		this.drag = null;
		const element = this.selected;

		if (drag.mode === "move") {
			element.style.transform = drag.originalTransform ?? "";
			if (drag.appliedX === 0 && drag.appliedY === 0) return;
			this.declareAndReport({ transform: `translate(${drag.appliedX}px, ${drag.appliedY}px)` });
			return;
		}
		const width = drag.appliedWidth;
		const height = drag.appliedHeight;
		element.style.width = drag.originalWidth ?? "";
		element.style.height = drag.originalHeight ?? "";
		const declarations = {};
		if (width !== Math.round(drag.originWidth)) declarations.width = `${width}px`;
		if (height !== Math.round(drag.originHeight)) declarations.height = `${height}px`;
		if (Object.keys(declarations).length === 0) return;
		this.declareAndReport(declarations);
	}

	/**
	 * 提交声明并把结果写进面板状态。
	 * @param declarations - 样式声明。
	 */
	declareAndReport(declarations) {
		this.panel.setStatus("info", `提交改动：${Object.entries(declarations).map(([key, value]) => `${key}=${value}`).join(", ")}`);
		this.declare(declarations);
	}

	/**
	 * 记录拖动前的样式，供还原使用。
	 * @param mode - "move" | "resize"。
	 */
	rememberOriginals(mode) {
		if (this.selected === null) return;
		if (mode === "move") {
			this.drag.originalTransform = this.selected.style.transform;
			return;
		}
		this.drag.originalWidth = this.selected.style.width;
		this.drag.originalHeight = this.selected.style.height;
	}

	/**
	 * 绑定全局事件。
	 */
	bindEvents() {
		document.addEventListener("mousemove", (event) => this.onMouseMove(event), true);
		document.addEventListener("click", (event) => this.onClick(event), true);
		document.addEventListener("keydown", (event) => this.onKeyDown(event), true);
		window.addEventListener("scroll", () => this.syncBoxes(), true);
		window.addEventListener("resize", () => this.syncBoxes());
	}

	/**
	 * 连接宿主 WebSocket。
	 */
	connect() {
		try {
			this.socket = new WebSocket(this.endpoint);
		} catch (error) {
			this.panel.setStatus("err", `无法连接宿主：${String(error?.message ?? error)}`);
			return;
		}
		this.socket.addEventListener("open", () => {
			this.reconnectDelay = 500;
			this.panel.setStatus("ok", "已连接 DSH 画布宿主");
			this.send({ type: "hello", url: location.href });
		});
		this.socket.addEventListener("message", (event) => this.onMessage(event));
		this.socket.addEventListener("close", () => {
			this.panel.setStatus("err", "与宿主断开，正在重连…");
			window.setTimeout(() => this.connect(), this.reconnectDelay);
			this.reconnectDelay = Math.min(this.reconnectDelay * 2, 8000);
		});
		this.socket.addEventListener("error", () => {
			this.panel.setStatus("err", "WebSocket 出错");
		});
	}

	/**
	 * 发送一条消息。
	 * @param payload - 消息体。
	 */
	send(payload) {
		if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) return;
		this.socket.send(JSON.stringify(payload));
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
			this.located = payload.location;
			// 徽标也要跟着更新——它显示的正是「文件:行」，
			// 只刷新面板会让徽标一直停在「只有标签名」的状态。
			this.syncBoxes();
			this.refreshPanel();
			// 状态栏也要收尾：否则会一直停在「正在定位源码…」，让人以为卡住了。
			const location = payload.location;
			if (location === null || location === undefined || location.file === null || location.file === undefined) {
				this.panel.setStatus("warn", location?.reason ?? "没能在项目里找到这个元素的源码位置");
			} else if (location.confidence === "ambiguous") {
				this.panel.setStatus("warn", location.reason ?? "定位不唯一，请确认候选");
			} else {
				const mark = location.confidence === "exact" ? "" : "（按内容匹配，请核对）";
				this.panel.setStatus("ok", `已定位 ${location.file}:${location.line}${mark}`);
			}
			return;
		}
		if (payload.type === "applied") {
			// HMR 会让页面自己更新；这里只更新面板状态。
			this.pendingCount = payload.pending ?? 0;
			this.canUndo = payload.canUndo ?? this.canUndo;
			this.canRedo = payload.canRedo ?? this.canRedo;
			this.panel.setStatus(payload.ok === false ? "err" : "ok", payload.message ?? (payload.ok === false ? "改动失败" : "已写入源码"));
			this.refreshPanel();
			return;
		}
		if (payload.type === "state") {
			this.pendingCount = payload.pending ?? 0;
			this.canUndo = payload.canUndo === true;
			this.canRedo = payload.canRedo === true;
			this.refreshPanel();
			return;
		}
		if (payload.type === "toggle") {
			this.enabled = payload.enabled === true;
			this.host.style.display = this.enabled ? "" : "none";
			return;
		}
	}

	/**
	 * 鼠标移动：更新悬停高亮。
	 * @param event - MouseEvent。
	 */
	onMouseMove(event) {
		if (!this.enabled || this.drag !== null) return;
		const target = this.hitTest(event);
		if (target === this.hovered) return;
		this.hovered = target;
		this.syncBoxes();
	}

	/**
	 * 点击：选中 / 取消选中。
	 * @param event - MouseEvent。
	 */
	onClick(event) {
		if (!this.enabled) return;
		if (this.isPanelEvent(event)) return;
		const target = this.hitTest(event);
		if (target === null) {
			this.select(null);
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		this.select(target);
	}

	/**
	 * 键盘：Esc 取消选择 / 删除。
	 * @param event - KeyboardEvent。
	 */
	onKeyDown(event) {
		if (event.key === "Escape") {
			this.select(null);
			return;
		}
		if (!this.enabled) return;
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
			event.preventDefault();
			this.send({ type: event.shiftKey ? "redo" : "undo" });
		}
	}

	/**
	 * 事件是否发生在面板里。
	 * @param event - Event。
	 * @returns 是否在面板内。
	 */
	isPanelEvent(event) {
		const path = event.composedPath?.() ?? [];
		return path.includes(this.panel.root);
	}

	/**
	 * 取鼠标下的元素（跳过覆盖层自身）。
	 * @param event - MouseEvent。
	 * @returns 元素或 null。
	 */
	hitTest(event) {
		const stack = document.elementsFromPoint(event.clientX, event.clientY);
		for (const node of stack) {
			if (node === this.host || this.host.contains(node)) continue;
			if (node.nodeType !== 1) continue;
			if (node === document.documentElement || node === document.body) continue;
			return node;
		}
		return null;
	}

	/**
	 * 选中一个元素（null 表示取消）。
	 * @param element - DOM 元素或 null。
	 */
	select(element) {
		this.selected = element;
		if (element === null) {
			this.box.style.display = "none";
			this.badge.style.display = "none";
			this.located = null;
			this.panel.setStatus("info", "未选中元素");
			return;
		}
		this.syncBoxes();
		const hint = describeElement(element);
		this.located = null;
		this.panel.setStatus("info", "正在定位源码…");
		this.send({ type: "select", hint });
		this.refreshPanel();
	}

	/**
	 * 在选中元素与父/子之间跳转。
	 * @param direction - "parent" | "child"。
	 */
	selectRelative(direction) {
		if (this.selected === null) return;
		if (direction === "parent") {
			const parent = this.selected.parentElement;
			if (parent !== null && parent !== document.body) this.select(parent);
			return;
		}
		const child = [...this.selected.children].find((node) => node.nodeType === 1);
		if (child !== undefined) this.select(child);
	}

	/**
	 * 提交一组样式声明。
	 * @param declarations - { [property]: value|null }。
	 */
	declare(declarations) {
		if (this.selected === null) return;
		const hint = describeElement(this.selected);
		this.send({ type: "declare", hint, declarations });
	}

	/**
	 * 同步高亮框位置。
	 */
	syncBoxes() {
		if (this.hovered !== null && this.hovered !== this.selected && this.enabled) {
			const rect = this.hovered.getBoundingClientRect();
			Object.assign(this.hoverBox.style, {
				display: "block",
				left: `${rect.left}px`, top: `${rect.top}px`,
				width: `${rect.width}px`, height: `${rect.height}px`
			});
		} else {
			this.hoverBox.style.display = "none";
		}
		if (this.selected === null) {
			this.box.style.display = "none";
			this.badge.style.display = "none";
			return;
		}
		const rect = this.selected.getBoundingClientRect();
		Object.assign(this.box.style, {
			display: "block",
			left: `${rect.left}px`, top: `${rect.top}px`,
			width: `${rect.width}px`, height: `${rect.height}px`
		});
		Object.assign(this.badge.style, {
			display: "block",
			left: `${rect.left}px`,
			top: `${Math.max(0, rect.top - 20)}px`,
			text: ""
		});
		this.badge.textContent = this.located == null
			? this.selected.tagName.toLowerCase()
			: `${this.selected.tagName.toLowerCase()} · ${this.located.file}:${this.located.line}`;
	}

	/**
	 * 刷新面板内容。
	 */
	refreshPanel() {
		if (this.selected === null) return;
		this.panel.update({
			tagName: this.selected.tagName.toLowerCase(),
			location: this.located,
			styles: readInlineStyles(this.selected),
			pending: this.pendingCount,
			canUndo: this.canUndo,
			canRedo: this.canRedo,
			hasChild: this.selected.children.length > 0
		});
	}
}

/**
 * 入口：等 DOM 就绪后挂载覆盖层。
 * @param endpoint - WebSocket 地址。
 * @returns 覆盖层实例。
 */
export function mount(endpoint) {
	const start = () => new Overlay({ endpoint });
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", start, { once: true });
		return null;
	}
	return start();
}
