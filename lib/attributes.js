/**
 * 属性追加 / 替换的唯一实现。
 *
 * 为什么单独抽出来：内联样式、Tailwind class、源码定位插件注入的 `data-*`，
 * 本质都是「在开标签里改一个属性」。三处必须共用同一段拼接逻辑，否则实现会各自漂移。
 *
 * 设计要点：
 * - **幂等**：属性已存在就换值，不存在才插入；重复调用结果一致。
 * - **保排版**：只替换值所在的字符区间，标签其余部分一个字节都不动。
 * - **不依赖 AST**：文本层面「找开标签 → 改属性」，
 *   于是 JSX / Vue / Svelte / 纯 HTML / 各类模板一视同仁。
 */

/**
 * 在标签文本里找某个属性的位置。
 *
 * 支持四种写法：`attr="v"`、`attr='v'`、`attr={expr}`、`attr={\`v\`}`。
 *
 * @param tagText - 只含开标签的文本（以 `<` 开头，以 `>` 或 `/>` 结尾）。
 * @param name - 属性名（不含引号）。
 * @returns { start, end, quote, valueStart, valueEnd } 或 null。
 *   start/end 是整个属性（含名与值）的区间；valueStart/valueEnd 是「值」的区间（不含包裹符号）。
 *
 * **已知限制**：花括号表达式按「第一个 `}`」收尾，不解析字符串字面量里的括号。
 * 例如 `style={{ color: "a}b" }}` 会被截断到字符串里的那个 `}`。
 * 实际影响极小——样式值里出现 `}` 几乎不可能，而且补丁还要过 {@link validatePatch} 配平校验，
 * 校验不过就整体拒绝落盘，不会写坏文件。
 */
export function findAttribute(tagText, name) {
	const pattern = new RegExp(`(^|[\\s{])(${name})\\s*=\\s*`, "u");
	const found = pattern.exec(tagText);
	if (found === null) return null;

	let cursor = found.index + found[1].length;
	const start = cursor;
	cursor += found[2].length;
	// 跳过空白与等号。
	while (cursor < tagText.length && /[\s=]/u.test(tagText[cursor])) cursor += 1;
	if (cursor >= tagText.length) return null;

	const open = tagText[cursor];
	let close;
	if (open === '"' || open === "'") {
		close = tagText.indexOf(open, cursor + 1);
		if (close < 0) return null;
		return { start, end: close + 1, open, valueStart: cursor + 1, valueEnd: close };
	}
	if (open === "{") {
		// 花括号表达式：按嵌套深度找到匹配的 `}`。
		let depth = 0;
		for (let i = cursor; i < tagText.length; i += 1) {
			if (tagText[i] === "{") depth += 1;
			else if (tagText[i] === "}") {
				depth -= 1;
				if (depth === 0) return { start, end: i + 1, open, valueStart: cursor + 1, valueEnd: i };
			}
		}
		return null;
	}
	return null;
}

/**
 * 合并一条属性：存在则替换值，不存在则在标签末尾（`>` 或 `/>` 之前）插入。
 *
 * @param tagText - 开标签文本。
 * @param name - 属性名。
 * @param value - 新值（裸值，不含引号或花括号）。
 * @param style - 值形态：`"double"` | `"single"` | `"braces"` | `"backtick"`。
 *   `"braces"` 与 `"backtick"` 都渲染成 `{...}`；区别只在后者外面套反引号。
 * @returns { text, replaced } 新标签文本与是否替换了已有属性。
 */
export function mergeAttribute(tagText, name, value, style = "double") {
	const rendered = style === "braces"
		? `{${value}}`
		: style === "backtick"
			? `{\`${value}\`}`
			: style === "single"
				? `'${value}'`
				: `"${value}"`;

	const existing = findAttribute(tagText, name);
	if (existing === null) {
		// 插入规则：在 `>`（或 `/>`）之前插一个 ` name="value"`。
		// 先把 `>` 前的尾随空白吃掉，再补一个空格——这样无论原标签是
		// `<img src="x" />` 还是 `<img src="x"/>`，结果都恰好一个空格，不会粘连也不会双空格。
		const closing = /\/?>$/u.exec(tagText);
		if (closing === null) return { text: tagText, replaced: false };
		const head = tagText.slice(0, closing.index).replace(/\s+$/u, "");
		const tail = tagText.slice(closing.index);
		return { text: `${head} ${name}=${rendered}${tail}`, replaced: false };
	}

	// 替换：保留原有包裹符号，只换里面的内容。
	const { open, valueStart, valueEnd } = existing;
	if (open === "{" && (style === "braces" || style === "backtick")) {
		// 花括号 → 花括号：保留反引号（如果有），只换内容。
		const inner = tagText.slice(valueStart, valueEnd);
		const isTemplate = /^\s*`[\s\S]*`\s*$/u.test(inner);
		const body = style === "backtick" || isTemplate ? `\`${value}\`` : value;
		return { text: `${tagText.slice(0, valueStart)}${body}${tagText.slice(valueEnd)}`, replaced: true };
	}
	if (open === '"' || open === "'") {
		const body = style === "single" ? `'${value}'` : `"${value}"`;
		const withoutValue = `${tagText.slice(0, existing.start)}${name}=`;
		return { text: `${withoutValue}${body}${tagText.slice(existing.end)}`, replaced: true };
	}
	// 形态变了（如原来是表达式、现在要给字符串）：整段替换。
	return { text: `${tagText.slice(0, existing.start)}${name}=${rendered}${tagText.slice(existing.end)}`, replaced: true };
}

/**
 * 把一条属性合并进「文件全文」的某个开标签。
 *
 * @param fileText - 文件全文。
 * @param range - 开标签区间 [start, end)。
 * @param name - 属性名。
 * @param value - 新值。
 * @param style - 值形态。
 * @returns { text, replaced } 新全文与是否替换。
 */
export function upsertAttribute(fileText, range, name, value, style = "double") {
	const tagText = fileText.slice(range[0], range[1]);
	const merged = mergeAttribute(tagText, name, value, style);
	if (merged.text === tagText) return { text: fileText, replaced: false };
	return {
		text: `${fileText.slice(0, range[0])}${merged.text}${fileText.slice(range[1])}`,
		replaced: merged.replaced
	};
}
