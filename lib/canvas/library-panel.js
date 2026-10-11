/**
 * 设计库面板：**用视觉呈现，而不是列出代码**。
 *
 * ## 最重要的一条设计原则
 *
 * 用户读不懂"代码语言"。把令牌列成 `--primary-foreground  #ffffff` 那种文本行，
 * 等于要求用户先在脑子里把十六进制翻译成颜色、把令牌名翻译成用途——
 * 而那正是工具该替他做的判断。
 *
 * 所以：
 * - **颜色** → 色块 + 人话名（「主色上的文字」），十六进制退到次要位置
 * - **组件** → 沙箱 iframe 里**真渲染出来**，看到的就是插进画板后的样子
 * - **图形** → 图标网格，直接画 SVG（只写 "arrow-down" 等于让用户读文件名猜形状）
 * - **规范** → 文档原文（讲的是"为什么这么定"，别处看不到）
 *
 * ## 组件预览为什么用 iframe + srcdoc
 *
 * 组件 CSS 是整份设计包的规则（`.btn`、`.card`……），直接塞进外壳文档会
 * **污染画布工具自己的样式**——`body{}` 这类选择器会改到工具的界面。
 * iframe 是天生的隔离边界，而且 sandbox 留空即不执行脚本，预览纯静态、无副作用。
 */

/** 页签。 */
const TABS = [
	{ id: "theme", label: "主题" },
	{ id: "components", label: "组件" },
	{ id: "graphics", label: "图形" },
	{ id: "spec", label: "规范" }
];

/**
 * 把 SVG 文本变成可插入的节点。
 *
 * ## 为什么不用 innerHTML
 *
 * 图标来自**外部设计包**（用户导入的 zip），内容不由我们控制。
 * `innerHTML = 外部字符串` 等于把任意脚本/事件属性的注入面交出去。
 * `DOMParser` 在**独立文档**里解析、不执行任何东西，再 `importNode` 进来——
 * 效果一样但没有那个面。
 *
 * 解析失败返回 null（调用方跳过这个图标），而不是抛错中断整个网格。
 *
 * @param text - SVG 文本。
 * @returns 节点或 null。
 */
function svgNode(text) {
	try {
		const doc = new DOMParser().parseFromString(String(text ?? ""), "image/svg+xml");
		const svg = doc.documentElement;
		if (svg === null || svg.nodeName === "parsererror") return null;
		const node = document.importNode(svg, true);
		// 图标尺寸由网格统一控制，别让它按自己带的 width/height 撑破格子
		node.setAttribute("width", "100%");
		node.setAttribute("height", "100%");
		return node;
	} catch {
		return null;
	}
}

/**
 * 长按检测：按住不动一小会儿，就当成"我要把这个组件抓起来"。
 *
 * ## 为什么用长按而不是直接拖
 *
 * 卡片本身要能**滚动**、上面还有「插入」按钮，直接按下即拖会和这两件事打架：
 * 用户想滚动列表，结果把组件甩出去了。长按是一个明确的意图表达
 *（和手机上"长按拖动图标"是同一个心智模型）。
 *
 * ## 阈值（**有出处的实测值，不是拍脑袋**）
 *
 * - **时间**：**400ms** —— 对齐 Android 原生（AOSP `ViewConfiguration`
 *   的 `DEFAULT_LONG_PRESS_TIMEOUT`）。Chromium 用的是 500ms，
 *   但这里是**桌面端鼠标操作**，400ms 更跟手；两者都在"明显长于点击"的区间里。
 *   （原来写的是 300ms —— 比 Android 原生还短，容易把"手抖了一下"误判成长按。）
 * - **位移**：**8px** —— 对齐 AOSP / Chromium 的 touch slop。
 *   超过就说明用户在滚动列表，立刻取消。
 *
 * @param node - 卡片节点。
 * @param payload - { markup, label, onGrab }。
 * @returns { void }。
 */
function attachLongPress(node, payload) {
	/** 长按判定时长（ms）。见上方说明的出处。 */
	const LONG_PRESS_MS = 400;
	/** 位移容差（px）。超过即认为用户在滚动。 */
	const SLOP_PX = 8;

	let timer = null;
	const cancel = () => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	};

	node.addEventListener("pointerdown", (event) => {
		if (event.button !== 0) return;
		const startX = event.clientX;
		const startY = event.clientY;

		/** 手指/鼠标挪太多 = 在滚动列表，不是要抓组件。 */
		const onMove = (moveEvent) => {
			if (Math.abs(moveEvent.clientX - startX) > SLOP_PX || Math.abs(moveEvent.clientY - startY) > SLOP_PX) {
				cancel();
				node.removeEventListener("pointermove", onMove);
			}
		};
		node.addEventListener("pointermove", onMove);
		node.addEventListener("pointerup", () => node.removeEventListener("pointermove", onMove), { once: true });

		cancel();
		timer = setTimeout(() => {
			timer = null;
			// 长按成立：交给外壳接管（它负责画 ghost、跟鼠标、判定落点）
			payload.onGrab?.({ markup: payload.markup, label: payload.label, x: startX, y: startY });
		}, LONG_PRESS_MS);
	});

	for (const type of ["pointerup", "pointercancel", "pointerleave", "blur"]) {
		node.addEventListener(type, cancel);
	}
}

/**
 * 建一个库面板。
 *
 * @param options - {
 *   root, apiBase, el,
 *   onStatus, onInsert, onApply, onInjectLibraryStyle, hasLibraryStyle, onSaveSelection,
 *   onGrab
 * }
 * @returns { refresh, getLibraryId }。
 */
export function createLibraryPanel(options) {
	const { root, apiBase, el } = options;
	let libraries = [];
	let currentId = null;
	let tab = "theme";
	let query = "";
	/** 预览文档（令牌 + 全部组件 CSS），拼一次缓存住。 */
	let previewDoc = null;

	/**
	 * 调库 API。
	 * @param action - 动作。
	 * @param params - 参数。
	 * @param method - GET / POST。
	 * @returns 结果对象。
	 */
	async function call(action, params = {}, method = "GET") {
		try {
			if (method === "GET") {
				const url = new URL(apiBase, location.href);
				url.searchParams.set("action", action);
				for (const [k, v] of Object.entries(params)) {
					if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
				}
				return await (await fetch(url, { headers: { "sec-fetch-site": "same-origin" } })).json();
			}
			return await (await fetch(apiBase, {
				method: "POST",
				headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
				body: JSON.stringify({ action, ...params })
			})).json();
		} catch (error) {
			return { ok: false, error: `连不上库服务：${String(error?.message ?? error)}` };
		}
	}

	/**
	 * 拼组件预览用的 CSS（令牌 + 全部组件样式）。
	 *
	 * 缓存：库没换就不重算，否则每切一次页签都要重新拉一遍所有组件。
	 * @returns CSS 文本。
	 */
	async function getPreviewCss() {
		if (previewDoc !== null) return previewDoc;
		const tokens = await call("tokens", { library: currentId });
		let css = "";
		if (tokens.ok !== false) {
			const vars = Object.entries(tokens.tokens?.light ?? {}).map(([k, v]) => `${k}: ${v};`).join("");
			css += `:root{${vars}}\n`;
		}
		const list = await call("components", { library: currentId });
		for (const item of list.ok === false ? [] : list.components) {
			const one = await call("component", { library: currentId, slug: item.slug });
			if (one.ok !== false) css += `${one.component.styles ?? ""}\n`;
		}
		previewDoc = css;
		return previewDoc;
	}

	/**
	 * 确保画板里有库样式，没有就先注入。
	 * @returns 是否已就绪（false 表示刚发起注入，需要用户再点一次）。
	 */
	async function ensureLibraryStyle() {
		if (options.hasLibraryStyle?.() === true) return true;
		options.onInjectLibraryStyle?.(await getPreviewCss(), currentId);
		return false;
	}

	/**
	 * 点一个条目。
	 * @param kind - 类别。
	 * @param item - 条目。
	 */
	async function activate(kind, item) {
		if (kind === "theme") {
			// 按用途猜该改哪个属性。猜错了用户还能在样式面板里改；
			// 让他先想"这个令牌对应哪个 CSS 属性"才是真的难。
			const property = /foreground/u.test(item.name) ? "color" : "background-color";
			options.onApply?.({ [property]: item.value }, item.label);
			return;
		}
		if (kind === "components") {
			if (!await ensureLibraryStyle()) {
				options.onStatus?.("", "已把库样式注入画板，再点一次即可插入组件");
				return;
			}
			const one = await call("component", { library: currentId, slug: item.slug });
			if (one.ok === false) { options.onStatus?.("err", one.error); return; }
			const specimen = one.component.specimens?.[0];
			if (specimen === undefined) {
				options.onStatus?.("err", `「${item.name}」没有可插入的标记（这个组件在设计包里只有描述）`);
				return;
			}
			options.onInsert?.({ markup: specimen.markup, label: item.name });
			return;
		}
		if (kind === "graphics") {
			const one = await call("asset", { library: currentId, name: item.name });
			if (one.ok === false) { options.onStatus?.("err", one.error); return; }
			options.onInsert?.({ markup: one.svg, label: item.name });
		}
	}

	// #region 各页签

	/**
	 * 主题：按用途分组 + 色块。
	 * @returns 节点数组。
	 */
	async function renderTheme() {
		const result = await call("tokens", { library: currentId });
		if (result.ok === false) return [el("div", { class: "library-empty", text: result.error })];
		const groups = result.tokens.colorGroups ?? [];
		if (groups.length === 0) return [el("div", { class: "library-empty", text: "这个库没有颜色令牌。" })];
		const out = [];
		for (const group of groups) {
			out.push(el("div", { class: "library-group", text: group.label }));
			out.push(el("div", { class: "library-swatches" }, group.tokens.map((token) => el("button", {
				class: "library-swatch-card",
				type: "button",
				title: `${token.name}\n点击应用到画布上选中的元素`,
				onClick: () => void activate("theme", token)
			}, [
				el("span", { class: "library-chip", style: { background: token.value } }),
				el("span", { class: "library-chip-name", text: token.label }),
				el("span", { class: "library-chip-value", text: token.value })
			]))));
		}
		return out;
	}

	/**
	 * 组件：真渲染预览 + 插入按钮。
	 * @returns 节点数组。
	 */
	async function renderComponents() {
		const list = await call("components", { library: currentId });
		if (list.ok === false) return [el("div", { class: "library-empty", text: list.error })];
		const needle = query.trim().toLowerCase();
		const shown = needle === "" ? list.components
			: list.components.filter((c) => `${c.name} ${c.category}`.toLowerCase().includes(needle));
		if (shown.length === 0) return [el("div", { class: "library-empty", text: "没有匹配的组件。" })];

		const css = await getPreviewCss();
		const out = [];
		for (const item of shown) {
			const one = await call("component", { library: currentId, slug: item.slug });
			const specimen = one.ok === false ? undefined : one.component.specimens?.[0];
			const card = el("div", { class: "library-card" }, [
				el("div", { class: "library-card-head" }, [
					el("span", { class: "library-card-name", text: item.name }),
					el("span", { class: "library-card-cat", text: item.category }),
					el("button", {
						class: "library-card-add",
						type: "button",
						text: "插入",
						title: "插入到画布上选中的元素里",
						onClick: () => void activate("components", item)
					})
				])
			]);
			if (specimen === undefined) {
				card.append(el("div", { class: "library-card-note", text: "这个组件在设计包里只有描述，没有可插入的标记。" }));
			} else {
				// ★ **长按卡片 → 抓起来拖到画板上**（比"先选中元素再点插入"直接得多）。
				//
				// 拖拽的其余部分（ghost、跟鼠标、落点判定）在外壳那边：
				// 这里只负责"识别出长按"并把组件交出去。
				attachLongPress(card, {
					markup: specimen.markup,
					label: item.name,
					onGrab: options.onGrab
				});
				// 沙箱 iframe + srcdoc 隔离设计包的 CSS。sandbox 留空 = 不执行脚本。
				card.append(el("iframe", {
					class: "library-card-preview",
					sandbox: "",
					scrolling: "no",
					srcdoc: `<!doctype html><meta charset="utf-8"><style>${css}
						html,body{margin:0;padding:10px;background:#fff;color:#0e1115;font:13px/1.5 sans-serif}
						</style>${specimen.markup}`
				}));
			}
			if (typeof item.keyInsight === "string" && item.keyInsight !== "") {
				card.append(el("div", { class: "library-card-note", text: item.keyInsight }));
			}
			out.push(card);
		}
		return out;
	}

	/**
	 * 图形：图标网格。
	 * @returns 节点数组。
	 */
	async function renderGraphics() {
		const list = await call("assets", { library: currentId });
		if (list.ok === false) return [el("div", { class: "library-empty", text: list.error })];
		const needle = query.trim().toLowerCase();
		const shown = needle === "" ? list.assets : list.assets.filter((a) => a.name.toLowerCase().includes(needle));
		if (shown.length === 0) return [el("div", { class: "library-empty", text: "这个库没有图标。" })];

		const grid = el("div", { class: "library-icons" });
		for (const asset of shown) {
			const cell = el("button", {
				class: "library-icon",
				type: "button",
				title: `${asset.name}\n点击插入到画布选中元素，或长按拖进画板`,
				onClick: () => void activate("graphics", asset)
			});
			const one = await call("asset", { library: currentId, name: asset.name });
			const art = one.ok === false ? null : svgNode(one.svg);
			if (art !== null) cell.append(el("span", { class: "library-icon-art" }, [art]));
			cell.append(el("span", { class: "library-icon-name", text: asset.name }));

			// ★ **图形也要能长按拖走**，和组件一致。
			//
			// 用户报「还是无法拖走」时拖的正是**图形页签**下的图标 ——
			// 而长按只挂在了组件卡片上，图形这一路只有点击插入。
			// 两处能力不一致，用户根本分不出哪个能拖（界面长得也差不多）。
			if (one.ok !== false && typeof one.svg === "string" && one.svg.trim() !== "") {
				attachLongPress(cell, { markup: one.svg, label: asset.name, onGrab: options.onGrab });
			}
			grid.append(cell);
		}
		return [grid];
	}

	/**
	 * 规范：文档。
	 * @returns 节点数组。
	 */
	async function renderSpec() {
		const result = await call("docs", { library: currentId });
		if (result.ok === false) return [el("div", { class: "library-empty", text: result.error })];
		if ((result.docs ?? []).length === 0) return [el("div", { class: "library-empty", text: "这个库没有附带文档。" })];
		return result.docs.map((doc) => el("details", { class: "library-doc", open: true }, [
			el("summary", { text: doc.title }),
			// 文档是 Markdown 原文，这里**原样显示**不渲染成 HTML：
			// 渲染要引 Markdown 解析器（新依赖），而原文里"为什么这么定"的判断
			// 读起来并不依赖排版。
			el("pre", { class: "library-doc-text", text: doc.text })
		]));
	}

	// #endregion

	/** 重绘面板。 */
	async function refresh() {
		const list = await call("libraries");
		libraries = list.ok === false ? [] : list.libraries;
		if (libraries.length === 0) {
			root.replaceChildren(el("div", {
				class: "library-empty",
				text: "还没有设计库。点上面的「导入设计包」选一个 Google Copy 格式的 zip。"
			}));
			return;
		}
		if (currentId === null || !libraries.some((l) => l.id === currentId)) {
			currentId = libraries[0].id;
			previewDoc = null;
		}

		const body = tab === "theme" ? await renderTheme()
			: tab === "components" ? await renderComponents()
				: tab === "graphics" ? await renderGraphics()
					: await renderSpec();

		root.replaceChildren(
			el("div", { class: "library-head" }, [
				el("select", {
					class: "library-select",
					onChange: (event) => {
						currentId = event.target.value;
						previewDoc = null;
						void refresh();
					}
				}, libraries.map((l) => el("option", {
					value: l.id,
					text: `${l.brandName || l.name}（${l.counts?.components ?? 0} 组件 / ${l.counts?.assets ?? 0} 图标）`,
					selected: l.id === currentId
				}))),
				el("button", {
					class: "library-act",
					type: "button",
					text: "＋",
					title: "把画布上选中的元素存为组件",
					onClick: () => options.onSaveSelection?.(currentId)
				})
			]),
			el("div", { class: "library-tabs" }, TABS.map((t) => el("button", {
				type: "button",
				text: t.label,
				"aria-pressed": t.id === tab ? "true" : "false",
				onClick: () => { tab = t.id; void refresh(); }
			}))),
			el("input", {
				class: "library-search",
				type: "search",
				placeholder: "搜索…",
				value: query,
				onInput: (event) => { query = event.target.value; void refresh(); }
			}),
			el("div", { class: "library-list" }, body)
		);
	}

	return { refresh, getLibraryId: () => currentId };
}
