/**
 * 形状参数面板：调选中图形的外观与语义。
 *
 * ## 为什么单独一个面板，而不是塞进样式面板
 *
 * 样式面板回答的是"这个元素现在是什么样式"（一堆 CSS 属性）。
 * 而画形状时用户想的是"**我要一个什么样的组件**"——填充、描边、作用、交互。
 * 两者的心智模型不同：前者是查，后者是造。
 * 混在一起会让两边都变长，而且画完一个矩形要在一堆继承来的属性里找自己的那几项。
 *
 * ## 分组照 Office「插入形状」
 *
 * 填充 / 线条 / 圆角 —— 这三组是画图形时**立刻要用**的。
 * 作用和交互属于"这个组件是干什么的"，放后面。
 *
 * ## 每个控件都带实时预览
 *
 * 拖动滑块和取色时走 `onPreview`（只改 DOM），松手/失焦才走 `onCommit`（写源码）。
 * 和样式面板同一条通路——**这样调试手感一致，也不会因为拖动而写出一堆中间状态**。
 */

/**
 * 常用填充色。给一排快捷色比让用户每次都开取色器快得多。
 *
 * ⚠️ **全部用真实色值，绝不能用外壳的 CSS 令牌。**
 * 这里写下的值会被当成**元素的内联样式**发给画板，而画板里没有我们外壳的
 * `--accent` 这类变量——写 `var(--accent)` 进去，画板解析为空、元素变成透明，
 * 用户看到的是「点了没反应」。**同一个坑在 shell.js 的默认样式里已经踩过一次。**
 */
const SWATCHES = ["#4285f4", "#1e8e3e", "#f9ab00", "#d93025", "#5f6368", "#9334e6", "#ffffff", "#000000"];

/** 默认填充：真实色值，且与绘制时的默认色一致。 */
const DEFAULT_FILL = "#4285f4";

/**
 * 建一个形状面板。
 *
 * @param options - {
 *   root: 容器,
 *   el: 建元素工具,
 *   onPreview: (declarations) => void  只改 DOM，不写源码
 *   onCommit: (declarations) => void   写源码
 *   onRevert: () => void               放弃预览
 *   onStatus: (tone, text) => void
 *   onAttr: (attrs) => void            写 data-* 语义标记
 *   getTargets: () => [{ value, label }]       可选的目标界面（画板列表）
 *   getLinks: () => { mounts, actions }        当前元素身上的关联（从源码反推）
 *   linkLabel: (dshId) => string               把 dsh-id 翻成可读名字
 *   onStartLink: () => void                    进入"选择图层"模式
 *   onUnlink: (kind) => void                   删掉一条关联
 * }
 * @returns { render, setSelection }
 */

/**
 * 需要"出现延迟"的效果 —— 都是**加载态**。
 *
 * ## 为什么默认是 300ms 而不是 0
 *
 * 调研里给了一条反直觉但我认为正确的建议：
 *
 * > 把 `skeleton` 的默认延迟设成 **300ms** 而不是 0。
 * > 200ms 就返回的请求闪一下骨架屏是**纯噪声**，比不显示还糟。
 * > 设计工具给什么默认值，就是在教用户怎么用它。
 *
 * 业界最常见的加载态问题不是"没有 loading"，而是**"loading 闪得太快"**。
 * 所以这里把 300 作为面板上显示的默认值，并且**写进源码**（`data-delay`）——
 * 运行时读到它就知道"这个时间内回来了就别显示占位"。
 *
 * 光靠设计工具本身管不了时序（画布是静态的），
 * 但**把这个约定写进标记**是它能做的最有用的事。
 */
const DELAY_EFFECTS = ["skeleton", "skeleton-wave", "skeleton-to-content", "spin", "progress-fill", "progress-indeterminate"];

/**
 * 需要"选一个目标"的动作 —— 只有这些才显示目标下拉。
 *
 * 调研（shadcn/Radix、Material）里所有交互都是**动作 + 目标**成对的：
 * Radix 的 Trigger 和 Content 隐式配对，Headless UI 靠 `data-headlessui-state`
 * 在组件树里传递。所以"打开弹层"也要能指定打开哪个。
 */
const NEEDS_TARGET = ["navigate", "scrollTo", "open", "focus"];

/**
 * 需要"文案 + 语气"的动作 —— 这些都是**反馈类**，要告诉用户发生了什么。
 *
 * 之前写的是 `action !== "navigate"`（"不是跳转就显示"）：
 * 动作只有四个的时候凑巧对，加到二十几个之后就明显错了 ——
 * "复制""下载""上一步"这些动作根本没有文案可填。
 */
const FEEDBACK_ACTIONS = ["toast", "alert", "progress", "snackbar", "confirm"];

export function createShapePanel(options) {
	const { root, el, onPreview, onCommit } = options;
	/** 当前选中的元素与它所在的画板。 */
	let selection = null;
	/** 当前外观，用于面板回显。 */
	let current = {};

	/**
	 * 把一次改动走预览还是提交。
	 * @param declarations - 声明对象。
	 * @param commit - true = 写源码。
	 */
	const push = (declarations, commit) => {
		if (commit === true) onCommit?.(declarations);
		else onPreview?.(declarations);
	};

	/**
	 * 一行"标签 + 控件"。
	 * @param label - 标签文字。
	 * @param controls - 控件节点。
	 * @returns 行节点。
	 */
	const row = (label, controls) => el("div", { class: "sp-row" }, [
		el("span", { class: "sp-label", text: label }),
		el("span", { class: "sp-control" }, controls)
	]);

	/**
	 * 取色 + 快捷色。
	 * @param value - 当前值。
	 * @param onSet - (value, commit) => void。
	 * @returns 控件数组。
	 */
	const colorControl = (value, onSet) => {
		const picker = el("input", {
			class: "sp-color",
			type: "color",
			// 取色器只认 #rrggbb。计算样式回来的是 rgb(...) 时回退到默认色，
			// 否则 input[type=color] 会拒绝这个值、显示成黑色
			value: /^#[0-9a-f]{6}$/iu.test(value) ? value : DEFAULT_FILL,
			onInput: (event) => onSet(event.target.value, false),
			onChange: (event) => onSet(event.target.value, true)
		});
		const swatches = SWATCHES.map((c) => el("button", {
			class: "sp-swatch",
			type: "button",
			title: c,
			style: { background: c },
			onClick: () => onSet(c, true)
		}));
		return [picker, el("span", { class: "sp-swatches" }, swatches)];
	};

	/**
	 * 数值滑块 + 数字框。
	 * @param value - 当前值（px）。
	 * @param min - 最小。
	 * @param max - 最大。
	 * @param onSet - (value, commit) => void。
	 * @returns 控件数组。
	 */
	const numberControl = (value, min, max, onSet) => {
		const range = el("input", {
			class: "sp-range", type: "range", min: String(min), max: String(max), value: String(value),
			onInput: (event) => onSet(Number(event.target.value), false),
			onChange: (event) => onSet(Number(event.target.value), true)
		});
		const num = el("input", {
			class: "sp-number", type: "number", min: String(min), max: String(max), value: String(value),
			onInput: (event) => onSet(Number(event.target.value), false),
			onChange: (event) => onSet(Number(event.target.value), true)
		});
		return [range, num, el("span", { class: "sp-unit", text: "px" })];
	};

	/**
	 * 开关。
	 * @param on - 是否开。
	 * @param onSet - (on) => void。
	 * @returns 按钮节点。
	 */
	const toggle = (on, onSet) => el("button", {
		class: `sp-toggle${on ? " is-on" : ""}`,
		type: "button",
		"aria-pressed": on ? "true" : "false",
		text: on ? "有" : "无",
		onClick: () => onSet(!on)
	});

	/** 重绘。 */
	function render() {
		if (selection === null) {
			root.replaceChildren(el("div", {
				class: "sp-empty",
				text: "在画板上画一个图形，或点选一个已画的图形，这里就会出现它的参数。"
			}));
			return;
		}
		const fill = current.background ?? DEFAULT_FILL;
		const hasFill = current.background !== "transparent" && current.background !== "none";
		const lineOn = current.borderStyle !== "none" && Number.parseFloat(current.borderWidth ?? "0") > 0;
		const lineWidth = Number.parseFloat(current.borderWidth ?? "1") || 1;
		const lineColor = current.borderColor && current.borderColor.startsWith("#") ? current.borderColor : "#1a73e8";
		const radius = Number.parseFloat(current.borderRadius ?? "0") || 0;
		const role = current.__role ?? "functional";
		const effect = current.__effect ?? "none";
		const interact = current.__interact ?? "click";
		const action = current.__action ?? "none";
		const target = current.__target ?? "";
		/** 可选的目标界面：由外壳给（画板列表）。 */
		const targets = options.getTargets?.() ?? [];

		// ---- 关联：从**源码标记**反推当前元素身上的边，不维护第二份缓存
		const linkInfo = options.getLinks?.() ?? { mounts: [], actions: [] };
		const links = [
			...linkInfo.mounts.map((l) => ({
				...l,
				kind: "mount",
				label: options.linkLabel?.(l.to) ?? l.to
			})),
			...linkInfo.actions.map((l) => ({
				...l,
				kind: "action",
				label: l.to !== null && l.to !== undefined && l.to !== "" ? l.to : (l.action ?? "功能")
			}))
		];
		/** 新建关联时选的类型：镶嵌 / 功能。 */
		const linkKind = current.__linkKind ?? "mount";
		/** 镶嵌的方向：单向 / 双向。 */
		const linkDir = current.__linkDir ?? "one";

		root.replaceChildren(
			el("div", { class: "sp-head", text: "形状" }),

			el("div", { class: "sp-group" }, [
				el("div", { class: "sp-group-title", text: "填充" }),
				row("颜色", colorControl(fill, (v, commit) => {
					current.background = v;
					push({ background: v }, commit);
				})),
				row("填充", toggle(hasFill, (on) => {
					// "无填充"写成 transparent 而不是删掉声明——删掉会退回继承来的背景色，
					// 那是**另一个颜色**，不是"没有"
					current.background = on ? fill : "transparent";
					push({ background: current.background }, true);
					render();
				}))
			]),

			el("div", { class: "sp-group" }, [
				el("div", { class: "sp-group-title", text: "线条" }),
				row("有无", toggle(lineOn, (on) => {
					current.borderStyle = on ? "solid" : "none";
					// 关掉时同时把宽度归零：只写 border-style:none 时，
					// 某些浏览器仍会为 border-width 留出空间，看起来"边框没了但位置还在"
					push(on ? { "border-style": "solid", "border-width": `${lineWidth}px` } : { "border-style": "none", "border-width": "0" }, true);
					render();
				})),
				row("颜色", colorControl(lineColor, (v, commit) => {
					current.borderColor = v;
					push({ "border-color": v }, commit);
				})),
				row("粗细", numberControl(lineWidth, 0, 20, (v, commit) => {
					current.borderWidth = `${v}px`;
					push({ "border-width": `${v}px`, "border-style": v > 0 ? "solid" : "none" }, commit);
				}))
			]),

			el("div", { class: "sp-group" }, [
				el("div", { class: "sp-group-title", text: "圆角" }),
				row("半径", numberControl(radius, 0, 60, (v, commit) => {
					current.borderRadius = `${v}px`;
					push({ "border-radius": `${v}px` }, commit);
				}))
			]),

			el("div", { class: "sp-group" }, [
				el("div", { class: "sp-group-title", text: "作用" }),
				row("类型", [
					el("select", {
						class: "sp-select",
						onChange: (event) => {
							current.__role = event.target.value;
							options.onAttr?.({ role: event.target.value });
						}
					}, [
						el("option", { value: "functional", text: "功能组件（可点击/可交互）", selected: role === "functional" }),
						el("option", { value: "background", text: "背景组件（纯装饰）", selected: role === "background" })
					])
				])
			]),

			el("div", { class: "sp-group" }, [
				el("div", { class: "sp-group-title", text: "交互方式" }),
				row("触发", [
					el("select", {
						class: "sp-select",
						onChange: (event) => {
							current.__interact = event.target.value;
							options.onAttr?.({ interact: event.target.value });
						}
					}, [
						el("option", { value: "none", text: "无交互", selected: interact === "none" }),

						// 分组：一次列出十几个不分组的选项没法找。
						// 取值和说明来自对 Apple HIG / Android / WCAG / NN/g 的调研，
						// 「慎用」「仅桌面」这些标注是**调研里的明确结论**，不是保守起见。
						el("optgroup", { label: "指针" }, [
							el("option", { value: "click", text: "点击", selected: interact === "click" }),
							el("option", { value: "doubleclick", text: "双击（移动端慎用：会被当成缩放）", selected: interact === "doubleclick" }),
							el("option", { value: "rightclick", text: "右键菜单", selected: interact === "rightclick" }),
							el("option", { value: "hover", text: "悬停（**仅桌面**，触摸设备没有）", selected: interact === "hover" }),
							el("option", { value: "focus", text: "键盘聚焦（无障碍，Tab 到就触发）", selected: interact === "focus" })
						]),
						el("optgroup", { label: "触摸·按住类" }, [
							el("option", { value: "longpress", text: "长按", selected: interact === "longpress" }),
							el("option", { value: "longpress-drag", text: "长按后拖动（排序用）", selected: interact === "longpress-drag" }),
							el("option", { value: "drag", text: "拖动", selected: interact === "drag" })
						]),
						el("optgroup", { label: "触摸·滑动类（方向必须分开标）" }, [
							// ⚠️ 滑动**不能只写一个 `swipe`** —— 左滑删除和右滑返回
							// 是完全不同的行为，合并标注等于没说。
							el("option", { value: "swipe-left", text: "左滑（删除）", selected: interact === "swipe-left" }),
							el("option", { value: "swipe-right", text: "右滑（返回）", selected: interact === "swipe-right" }),
							el("option", { value: "swipe-up", text: "上滑（关闭抽屉）", selected: interact === "swipe-up" }),
							el("option", { value: "swipe-down", text: "下滑", selected: interact === "swipe-down" }),
							el("option", { value: "edge-swipe", text: "边缘滑（⚠️ 会和系统手势冲突）", selected: interact === "edge-swipe" })
						]),
						el("optgroup", { label: "容器级" }, [
							el("option", { value: "scroll", text: "滚动", selected: interact === "scroll" }),
							el("option", { value: "scrollintoview", text: "滚入视口（曝光埋点）", selected: interact === "scrollintoview" }),
							el("option", { value: "pull-to-refresh", text: "下拉刷新", selected: interact === "pull-to-refresh" })
						]),
						el("optgroup", { label: "表单" }, [
							el("option", { value: "submit", text: "回车提交", selected: interact === "submit" })
						])
					])
				])
			]),

			el("div", { class: "sp-group" }, [
				el("div", { class: "sp-group-title", text: "关联" }),

				// ---- 已有的人工关联（镶嵌 / 功能），从**源码标记**反推
				...(links.length === 0
					? [el("div", { class: "sp-empty-inline", text: "还没有关联。点下面的「＋」选一个图层。" })]
					: links.map((link) => row(link.kind === "mount" ? "镶嵌" : "功能", [
						el("span", {
							class: "sp-link-target",
							text: link.label ?? link.to ?? "?",
							title: link.to ?? ""
						}),
						link.kind === "mount"
							? el("span", { class: "sp-link-dir", text: link.direction === "both" ? "双向" : "单向" })
							: el("span", { class: "sp-link-dir", text: link.action ?? "" }),
						el("button", {
							class: "sp-link-del",
							type: "button",
							text: "×",
							title: "删掉这条关联",
							onClick: () => {
								options.onUnlink?.(link.kind);
								render();
							}
						})
					]))),

				// ---- 新建：进入**选择模式**，在画布/图层树上点目标（可多选）
				row("", [
					el("button", {
						class: "sp-add-link",
						type: "button",
						text: "＋ 添加关联",
						title: "点这里，然后在画布上点要关联的图层（可多选，Esc 结束）",
						// 把当前选的类型/方向/行为一起交出去 ——
						// 外壳那边点完图层就要用它们建边，回头再问面板要会很绕
						onClick: () => options.onStartLink?.({
							kind: current.__linkKind ?? "mount",
							direction: current.__linkDir ?? "one",
							action: current.__action ?? "navigate",
							targetUrl: current.__target ?? null,
							message: current.__message ?? null,
							tone: current.__tone ?? "info"
						})
					})
				]),

				// ---- 关联类型：镶嵌 / 功能
				row("类型", [
					el("select", {
						class: "sp-select",
						onChange: (event) => {
							current.__linkKind = event.target.value;
							render();
						}
					}, [
						el("option", { value: "mount", text: "镶嵌（挂在底座上，跟着动）", selected: linkKind === "mount" }),
						el("option", { value: "action", text: "功能（点击做什么）", selected: linkKind === "action" })
					])
				]),

				// ---- 镶嵌：方向（单向 / 双向）
				linkKind === "mount" ? row("方向", [
					el("select", {
						class: "sp-select",
						onChange: (event) => {
							current.__linkDir = event.target.value;
						}
					}, [
						el("option", { value: "one", text: "单向（它跟底座动）", selected: linkDir === "one" }),
						el("option", { value: "both", text: "双向（互相跟随）", selected: linkDir === "both" })
					])
				]) : null,

				// ---- 功能：A 关联页面/状态、B 状态弹窗
				linkKind === "action" ? row("行为", [
					el("select", {
						class: "sp-select",
						onChange: (event) => {
							current.__action = event.target.value;
							// 任何变化都重绘：选「跳转」要出现目标下拉，
							// 选弹窗类要出现文案输入框（原来只在 none 时重绘，漏过一次）
							render();
						}
					}, [
						// 分组排列。取值来自对 shadcn/Radix、Material、Ant Design 的调研 ——
						// 它们对"交互"的建模是**动作 + 目标**：`open` 要配一个要打开的东西，
						// `navigate` 要配一个要去的地方。所以下面按"目标类型"分组，
						// 每组的动作需要填的东西是一样的。
						el("optgroup", { label: "导航（需要目标）" }, [
							el("option", { value: "navigate", text: "打开某个界面", selected: action === "navigate" }),
							el("option", { value: "back", text: "返回上一页", selected: action === "back" }),
							el("option", { value: "next", text: "下一步", selected: action === "next" }),
							el("option", { value: "prev", text: "上一步", selected: action === "prev" }),
							el("option", { value: "scrollTo", text: "滚动到某处", selected: action === "scrollTo" })
						]),
						el("optgroup", { label: "浮层" }, [
							el("option", { value: "open", text: "打开弹层", selected: action === "open" }),
							el("option", { value: "close", text: "关闭弹层", selected: action === "close" }),
							el("option", { value: "confirm", text: "危险操作二次确认", selected: action === "confirm" })
						]),
						el("optgroup", { label: "状态切换" }, [
							el("option", { value: "toggle", text: "切换开关", selected: action === "toggle" }),
							el("option", { value: "expand", text: "展开", selected: action === "expand" }),
							el("option", { value: "collapse", text: "收起", selected: action === "collapse" }),
							el("option", { value: "select", text: "选中", selected: action === "select" }),
							el("option", { value: "deselect", text: "取消选中", selected: action === "deselect" })
						]),
						el("optgroup", { label: "表单" }, [
							el("option", { value: "submit", text: "提交表单", selected: action === "submit" }),
							el("option", { value: "reset", text: "重置表单", selected: action === "reset" }),
							el("option", { value: "validate", text: "只校验不提交", selected: action === "validate" }),
							el("option", { value: "focus", text: "聚焦到某个输入框", selected: action === "focus" })
						]),
						el("optgroup", { label: "数据" }, [
							el("option", { value: "copy", text: "复制（要配成功反馈）", selected: action === "copy" }),
							el("option", { value: "download", text: "下载 / 导出", selected: action === "download" }),
							el("option", { value: "share", text: "分享", selected: action === "share" }),
							el("option", { value: "refresh", text: "重新拉取数据", selected: action === "refresh" }),
							el("option", { value: "upload", text: "选择文件并上传", selected: action === "upload" }),
							el("option", { value: "filter", text: "打开筛选器", selected: action === "filter" }),
							el("option", { value: "sort", text: "按某列排序", selected: action === "sort" })
						]),
						el("optgroup", { label: "反馈（只留标记，行为由你的应用决定）" }, [
							el("option", { value: "toast", text: "轻提示", selected: action === "toast" }),
							el("option", { value: "alert", text: "警示弹窗", selected: action === "alert" }),
							el("option", { value: "progress", text: "进度条", selected: action === "progress" }),
							el("option", { value: "snackbar", text: "带撤销的操作条", selected: action === "snackbar" })
						])
					])
				]) : null,

				linkKind === "action" && NEEDS_TARGET.includes(action) ? row("目标", [
					el("select", {
						class: "sp-select",
						onChange: (event) => {
							current.__target = event.target.value;
						}
					}, [
						el("option", { value: "", text: "选一个…", selected: !target }),
						...targets.map((t) => el("option", {
							value: t.value,
							text: t.label,
							selected: t.value === target
						}))
					])
				]) : null,

				linkKind === "action" && FEEDBACK_ACTIONS.includes(action) ? row("文案", [
					el("input", {
						class: "sp-text",
						type: "text",
						placeholder: "弹窗里显示什么",
						value: current.__message ?? "",
						onInput: (event) => {
							current.__message = event.target.value;
						}
					})
				]) : null,

				linkKind === "action" && FEEDBACK_ACTIONS.includes(action) ? row("语气", [
					el("select", {
						class: "sp-select",
						onChange: (event) => {
							current.__tone = event.target.value;
						}
					}, [
						el("option", { value: "info", text: "普通", selected: (current.__tone ?? "info") === "info" }),
						el("option", { value: "warn", text: "警告", selected: current.__tone === "warn" }),
						el("option", { value: "error", text: "错误", selected: current.__tone === "error" })
					])
				]) : null
			].filter(Boolean)),

			el("div", { class: "sp-group" }, [
				el("div", { class: "sp-group-title", text: "效果" }),
				row("样式", [
					el("select", {
						class: "sp-select",
						onChange: (event) => {
							current.__effect = event.target.value;
							options.onAttr?.({ effect: event.target.value });
							// **任何变化都要重绘**：选「悬停浮窗」时要立刻出现内容输入框，
							// 不重绘的话用户填不了内容，会以为这个效果就长那样。
							render();
						}
					}, [
						el("option", { value: "none", text: "无", selected: effect === "none" }),

						// 分组用 <optgroup>：三十多个效果平铺一列就没法找了
						el("optgroup", { label: "按压" }, [
							el("option", { value: "press", text: "按压（键盘感·沉下去再弹起）", selected: effect === "press" }),
							el("option", { value: "press-scale", text: "缩一下（圆形按钮/图标）", selected: effect === "press-scale" }),
							el("option", { value: "press-soft", text: "轻按（大面积卡片）", selected: effect === "press-soft" }),
							el("option", { value: "press-glow", text: "边框高亮（不移动）", selected: effect === "press-glow" }),
							el("option", { value: "press-hold", text: "长按蓄力（按住变大）", selected: effect === "press-hold" }),
							el("option", { value: "ripple", text: "涟漪（点击扩散）", selected: effect === "ripple" }),
							el("option", { value: "ripple-center", text: "中心波纹", selected: effect === "ripple-center" })
						]),
						el("optgroup", { label: "悬停" }, [
							el("option", { value: "float", text: "漂浮（轻微上浮 + 阴影）", selected: effect === "float" }),
							el("option", { value: "hover-lift", text: "抬升带倾斜（被拿起来看）", selected: effect === "hover-lift" }),
							el("option", { value: "hover-shadow", text: "阴影加深（位置不动）", selected: effect === "hover-shadow" }),
							el("option", { value: "hover-glow", text: "流光边框", selected: effect === "hover-glow" }),
							el("option", { value: "hover-slide-right", text: "右移（暗示往那边去）", selected: effect === "hover-slide-right" }),
							el("option", { value: "hover-sink", text: "下沉", selected: effect === "hover-sink" }),
							el("option", { value: "hover-gradient", text: "底色渐变滑过", selected: effect === "hover-gradient" }),
							el("option", { value: "hover-underline", text: "下划线展开（文字用）", selected: effect === "hover-underline" }),
							el("option", { value: "hover-rotate", text: "图标转一圈", selected: effect === "hover-rotate" }),
							el("option", { value: "hover-menu", text: "悬停浮窗（菜单）", selected: effect === "hover-menu" }),
							el("option", { value: "hover-tip", text: "悬停提示（气泡）", selected: effect === "hover-tip" }),
							el("option", { value: "hover-check", text: "悬停出打勾", selected: effect === "hover-check" })
						]),
						el("optgroup", { label: "变化" }, [
							el("option", { value: "morph-plus", text: "＋ 变 ×（旋转）", selected: effect === "morph-plus" }),
							el("option", { value: "morph-hamburger", text: "☰ 变 ✕（汉堡菜单）", selected: effect === "morph-hamburger" }),
							el("option", { value: "morph-arrow", text: "箭头翻转", selected: effect === "morph-arrow" }),
							el("option", { value: "morph-switch", text: "开关滑动", selected: effect === "morph-switch" }),
							el("option", { value: "morph-check", text: "勾选高亮", selected: effect === "morph-check" }),
							el("option", { value: "morph-flip", text: "3D 翻面", selected: effect === "morph-flip" }),
							el("option", { value: "morph-expand", text: "展开（悬停变大）", selected: effect === "morph-expand" })
						]),
						el("optgroup", { label: "出现" }, [
							el("option", { value: "pop", text: "弹入（出现时弹一下）", selected: effect === "pop" }),
							el("option", { value: "enter-fade", text: "淡入", selected: effect === "enter-fade" }),
							el("option", { value: "enter-slide-up", text: "从下滑入", selected: effect === "enter-slide-up" }),
							el("option", { value: "enter-zoom", text: "缩放弹入", selected: effect === "enter-zoom" }),
							el("option", { value: "enter-stagger", text: "逐条错峰（列表用）", selected: effect === "enter-stagger" }),
							el("option", { value: "skeleton", text: "骨架屏（加载占位）", selected: effect === "skeleton" })
						]),
						el("optgroup", { label: "状态" }, [
							el("option", { value: "pulse", text: "呼吸（持续缩放）", selected: effect === "pulse" }),
							el("option", { value: "spin", text: "转圈（加载中）", selected: effect === "spin" }),
							el("option", { value: "pulse-dot", text: "脉冲点（有新消息）", selected: effect === "pulse-dot" }),
							el("option", { value: "progress-fill", text: "进度推进", selected: effect === "progress-fill" })
						]),
						el("optgroup", { label: "氛围" }, [
							el("option", { value: "gradient-flow", text: "渐变流动", selected: effect === "gradient-flow" }),
							el("option", { value: "glow-breathe", text: "光晕呼吸", selected: effect === "glow-breathe" }),
							el("option", { value: "typewriter", text: "打字机", selected: effect === "typewriter" })
						]),

						// ---- 第三批（调研 Animate.css / Hover.css / SpinKit / Material / NNG 后补充）
						el("optgroup", { label: "点击反馈" }, [
							el("option", { value: "active-bounce", text: "弹一下（过冲回弹）", selected: effect === "active-bounce" }),
							el("option", { value: "active-press-down", text: "用力下压（阴影收紧）", selected: effect === "active-press-down" }),
							el("option", { value: "active-ring-out", text: "点击光环（向外扩散）", selected: effect === "active-ring-out" }),
							el("option", { value: "active-border-pulse", text: "边框脉冲", selected: effect === "active-border-pulse" }),
							el("option", { value: "active-shake", text: "错误抖动（拒绝语义）", selected: effect === "active-shake" }),
							el("option", { value: "active-flash", text: "错误闪红", selected: effect === "active-flash" }),
							el("option", { value: "field-invalid", text: "校验失败（红框，输了才报）", selected: effect === "field-invalid" })
						]),
						el("optgroup", { label: "悬停补充" }, [
							el("option", { value: "hover-fill-up", text: "底部填充（导航/标签页）", selected: effect === "hover-fill-up" }),
							el("option", { value: "hover-shine", text: "扫光掠过", selected: effect === "hover-shine" }),
							el("option", { value: "hover-shrink", text: "悬停收缩（比放大克制）", selected: effect === "hover-shrink" }),
							el("option", { value: "hover-icon-nudge", text: "图标轻推", selected: effect === "hover-icon-nudge" }),
							el("option", { value: "input-focus-glow", text: "输入框聚焦光", selected: effect === "input-focus-glow" })
						]),
						el("optgroup", { label: "出现补充" }, [
							el("option", { value: "enter-fade-up-soft", text: "轻柔上浮（密集列表用）", selected: effect === "enter-fade-up-soft" }),
							el("option", { value: "enter-fade-blur", text: "模糊聚焦入场", selected: effect === "enter-fade-blur" }),
							el("option", { value: "enter-dialog-pop", text: "弹窗弹出", selected: effect === "enter-dialog-pop" }),
							el("option", { value: "banner-slide", text: "横幅滑入（从顶上推下）", selected: effect === "banner-slide" }),
							el("option", { value: "inline-msg-in", text: "行内提示淡入", selected: effect === "inline-msg-in" }),
							el("option", { value: "list-item-exit", text: "删除淡出", selected: effect === "list-item-exit" }),
							el("option", { value: "collapse-reveal", text: "展开收起（悬停展开）", selected: effect === "collapse-reveal" }),
							el("option", { value: "skeleton-to-content", text: "骨架→内容（延迟显现）", selected: effect === "skeleton-to-content" })
						]),
						el("optgroup", { label: "状态与反馈" }, [
							el("option", { value: "save-flash", text: "保存成功闪一下", selected: effect === "save-flash" }),
							el("option", { value: "row-flash", text: "新增行高亮", selected: effect === "row-flash" }),
							el("option", { value: "new-content-ring", text: "新内容高亮环", selected: effect === "new-content-ring" }),
							el("option", { value: "pulse-ring", text: "徽标光环（未读）", selected: effect === "pulse-ring" }),
							el("option", { value: "badge-bounce", text: "角标弹跳", selected: effect === "badge-bounce" }),
							el("option", { value: "dots-pulse", text: "三点脉冲（输入中）", selected: effect === "dots-pulse" }),
							el("option", { value: "skeleton-wave", text: "骨架呼吸（大列表用）", selected: effect === "skeleton-wave" }),
							el("option", { value: "progress-indeterminate", text: "不定进度条", selected: effect === "progress-indeterminate" })
						]),
						el("optgroup", { label: "只留标记（行为由你的应用决定）" }, [
							el("option", { value: "toast", text: "提示条", selected: effect === "toast" }),
							el("option", { value: "progress", text: "进度条", selected: effect === "progress" }),
							el("option", { value: "modal", text: "弹窗", selected: effect === "modal" })
						])
					])
				]),

				// ★ **效果预览块**：当场就能试，不用"先选中元素、再移开鼠标去悬停"。
				//
				// 关键是它带着**同一个 `data-effect`**，所以吃的是同一份
				// `EFFECT_CSS`（外壳也注入一份）—— 预览里看到的就是实际效果，
				// 不是"另做一套演示"。两套实现迟早会不一致。
				effect === "none" ? null : el("div", { class: "sp-preview-wrap" }, [
					el("span", { class: "sp-preview-hint", text: "预览：" }),
					el("div", {
						class: "sp-preview",
						"data-effect": effect,
						// 需要内容的效果把用户填的值也带上，否则预览里是空的
						...(effect === "hover-menu" ? { "data-menu": current.__menu ?? "菜单…" } : {}),
						...(effect === "hover-tip" ? { "data-tip": current.__tip ?? "提示…" } : {}),
						text: "试试"
					})
				]),

				// 加载态效果：**出现延迟**。
				//
				// 这条是"设计工具能给运行时帮的最大的忙" —— 画布是静态的，
				// 管不了"多久才该显示占位"这件事；但把约定**写进标记**
				//（`data-delay="300"`）之后，用户的应用读到就知道该怎么按规矩来。
				...DELAY_EFFECTS.includes(effect)
					? [row("延迟", [
						el("input", {
							class: "sp-number",
							type: "number",
							min: "0",
							step: "50",
							value: current.__delay ?? "300",
							onInput: (event) => {
								current.__delay = event.target.value;
								options.onAttr?.({ delay: event.target.value });
							}
						}),
						el("span", { class: "sp-unit", text: "ms 内不问就绪" })
					])]
					: [],

				// 需要内容的效果：内容由**用户**填，工具不伪造
				//（真的菜单要有真的条目，那是他的东西）
				...(["hover-menu", "hover-tip"].includes(effect)
					? [row(effect === "hover-menu" ? "菜单文本" : "提示文本", [
						el("input", {
							class: "sp-text",
							type: "text",
							placeholder: effect === "hover-menu" ? "如「重命名 / 删除」" : "如「点击展开」",
							value: (effect === "hover-menu" ? current.__menu : current.__tip) ?? "",
							onInput: (event) => {
								const key = effect === "hover-menu" ? "__menu" : "__tip";
								current[key] = event.target.value;
								options.onAttr?.(effect === "hover-menu"
									? { menu: event.target.value }
									: { tip: event.target.value });
							}
						})
					])]
					: [])
			])
		);
	}

	return {
		/** 更新选中项并重绘。 */
		setSelection(next) {
			selection = next;
			current = next?.style ?? {};
			render();
		},
		/** 外部改了样式（比如撤销）后刷新回显。 */
		refresh() { render(); },
		render
	};
}
