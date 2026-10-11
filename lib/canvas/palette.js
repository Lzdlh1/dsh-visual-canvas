/**
 * 画板调色板：收集**整个画布上已经在用的**颜色与文字样式。
 *
 * ## 为什么要有它
 *
 * 用户的原话：「颜色和文字这种则直接在侧边栏放置，选中组件时弹出的侧边栏
 * 可以直接选中**已有组件的颜色和字体**」。
 *
 * 需求背后是个真实痛点：改样式时每次都要**手输**颜色值 / 字体名 ——
 * 而正确答案往往**就在画板上**（旁边那个按钮就是这个蓝）。
 * 让人去记 `#4285f4` 或者翻源码，是工具该替他做的事。
 *
 * ## 设计要点
 *
 * 1. **纯函数、无依赖**：输入是一组 `document`，输出是排好序的候选值。
 *    不碰 DOM 之外的任何东西，所以能直接跑离线测试。
 * 2. **归一化后再去重**：浏览器读出来是 `rgb(66, 133, 244)`，
 *    而用户写的是 `#4285f4` —— 不归一化的话同一个颜色会出现两次。
 * 3. **按使用次数排序**：用得多的排前面。画板上出现 12 次的那个蓝，
 *    比某个只用过 1 次的边角颜色更可能是用户想要的那个。
 * 4. **跳过透明与默认值**：`rgba(0, 0, 0, 0)` 到处都是，列出来只会淹没真正的候选。
 *
 * @module palette
 */

/** 取色时看的属性（三个都算"颜色"）。 */
const COLOR_KEYS = ["color", "background-color", "border-top-color"];

/** 组成"一套文字样式"的属性。 */
const TEXT_KEYS = ["font-family", "font-size", "font-weight", "line-height"];

/** 完全透明 / 空值这种没有意义的候选。 */
const TRANSPARENT = new Set(["rgba(0, 0, 0, 0)", "transparent", ""]);

/** 最多返回多少个（面板上排不下更多，也没必要）。 */
const MAX_COLORS = 24;
const MAX_FONTS = 8;
const MAX_TEXT_STYLES = 12;

/**
 * 把浏览器读出的颜色转成 `#rrggbb`（认不出来就原样返回）。
 *
 * `getComputedStyle` 永远给 `rgb()` / `rgba()`，而用户和设计稿里写的是 hex ——
 * 不统一的话同一个颜色会在候选里出现两次，看着像两个不同的值。
 *
 * @param value - 计算样式里的颜色串。
 * @returns `#rrggbb` / `#rrggbbaa`，或原样返回。
 */
export function normalizeColor(value) {
	const text = String(value ?? "").trim().toLowerCase();
	if (text === "") return "";
	const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)$/u.exec(text);
	if (match === null) return text;

	const hex = (part) => Math.max(0, Math.min(255, Math.round(Number(part)))).toString(16).padStart(2, "0");
	/**
	 * alpha 单独换算：它是 **0~1** 的小数，不能和 0~255 的通道共用 `hex`
	 *（第一版直接调 `hex(a)`，`0.5` 被 round 成 1 → 得到 `01`，半透明全错）。
	 */
	const alphaHex = (value) => {
		const n = Math.max(0, Math.min(1, Number(value)));
		return Math.round(n * 255).toString(16).padStart(2, "0");
	};
	const [, r, g, b, a] = match;
	// 透明度不是 1 就带上 aa 段（半透明是真实意图，不能丢）
	if (a !== undefined && Number(a) < 1) return `#${hex(r)}${hex(g)}${hex(b)}${alphaHex(a)}`;
	return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * 从一个文档里收集候选值。
 *
 * @param doc - 画板的 document。
 * @param bucket - { colors: Map, fonts: Map, styles: Map }（会被就地累加）。
 * @param limit - 最多扫多少个元素（防超大页面卡住）。
 * @returns { void }。
 */
function collectFromDocument(doc, bucket, limit) {
	if (doc === null || doc === undefined) return;
	let nodes;
	try {
		nodes = doc.querySelectorAll("*");
	} catch {
		return;
	}
	const view = doc.defaultView ?? globalThis;
	const total = Math.min(nodes.length, limit);

	for (let i = 0; i < total; i += 1) {
		const node = nodes[i];
		// **跳过插件自己注入到画板文档里的界面**。
		//
		// 选中框 / 手柄挂在外壳文档，扫不到；但**形状预览是插在画板里的**
		//（`#__dsh_shape_preview__`，见 shapes.js）。不过滤的话，
		// 工具的粉色会混进用户的色板里。
		//
		// `[data-dsh-ui]` 是给以后新增的注入元素留的通用标记。
		if (typeof node.closest === "function"
			&& node.closest("[data-dsh-ui], #__dsh_shape_preview__") !== null) continue;

		let style;
		try {
			style = view.getComputedStyle(node);
		} catch {
			continue;
		}
		if (style === null || style === undefined) continue;

		for (const key of COLOR_KEYS) {
			const raw = style.getPropertyValue(key);
			if (TRANSPARENT.has(raw)) continue;
			const color = normalizeColor(raw);
			if (color === "") continue;
			bucket.colors.set(color, (bucket.colors.get(color) ?? 0) + 1);
		}

		// ---- 文字样式：只有真的带文字的节点才算，否则整页都是同一个默认值
		const text = String(node.textContent ?? "").trim();
		if (text === "") continue;
		const family = String(style.getPropertyValue("font-family") ?? "").trim();
		const size = String(style.getPropertyValue("font-size") ?? "").trim();
		const weight = String(style.getPropertyValue("font-weight") ?? "").trim();
		const leading = String(style.getPropertyValue("line-height") ?? "").trim();
		if (family === "") continue;

		bucket.fonts.set(family, (bucket.fonts.get(family) ?? 0) + 1);

		// 整套文字样式：四个属性合成一个 key，一键应用时四个一起写
		const combo = [family, size, weight, leading].join("|");
		if (!bucket.styles.has(combo)) {
			bucket.styles.set(combo, { family, size, weight, leading, count: 0 });
		}
		bucket.styles.get(combo).count += 1;
	}
}

/**
 * 收集整个画布上"已经在用"的颜色与文字样式。
 *
 * @param docs - 各画板的 document 数组（拿不到的传 null 即可）。
 * @param options - { perDoc?: 每块画板最多扫多少元素 }。
 * @returns { colors, fonts, textStyles }，各自按使用次数降序。
 */
export function collectPalette(docs, options = {}) {
	const limit = Number.isInteger(options.perDoc) ? options.perDoc : 1500;
	const bucket = { colors: new Map(), fonts: new Map(), styles: new Map() };

	for (const doc of docs ?? []) collectFromDocument(doc, bucket, limit);

/** 按次数降序、次数相同按值排序（保证结果稳定，测试才可断言）。 */
	const ranked = (map, max) => [...map.entries()]
		.sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
		.slice(0, max);

	const textStyles = [...bucket.styles.values()]
		.sort((a, b) => b.count - a.count || a.family.localeCompare(b.family))
		.slice(0, MAX_TEXT_STYLES);

	/**
	 * 从一个字段上摘出"用过的值"。
	 *
	 * 字号 / 字重 / 行高**没有独立的收集**——它们本来就来自"整套文字样式"，
	 * 从那里面摘出来即可（同一套样式出现多次，值只会记一次）。
	 * 这样三个字段的快选列表天然和整体一致，不会出现"列表里有、画板上根本没有"的值。
	 *
	 * @param key - 字段名（size / weight / leading）。
	 * @returns [{ value, count }]，按出现次数降序。
	 */
	const derived = (key) => {
		const seen = new Map();
		for (const style of textStyles) {
			const value = style[key];
			if (typeof value !== "string" || value === "") continue;
			seen.set(value, (seen.get(value) ?? 0) + style.count);
		}
		return ranked(seen, 8).map(([value, count]) => ({ value, count }));
	};

	return {
		colors: ranked(bucket.colors, MAX_COLORS).map(([value, count]) => ({ value, count })),
		fonts: ranked(bucket.fonts, MAX_FONTS).map(([value, count]) => ({ value, count })),
		textStyles,
		sizes: derived("size"),
		weights: derived("weight"),
		leadings: derived("leading")
	};
}

export { COLOR_KEYS, TEXT_KEYS, TRANSPARENT };
