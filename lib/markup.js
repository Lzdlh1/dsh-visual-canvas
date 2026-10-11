/**
 * 源码里的**元素级**操作：找出一个元素的完整范围、插入、删除。
 *
 * ## 为什么单独成模块
 *
 * 之前的 `applyInlineStyle` 只改**已有开标签的属性**，只需要找到那个标签的起止。
 * 而「新建图层 / 复制 / 删除 / 调序」需要知道**整个元素从哪到哪**——
 * 包括它的子元素和闭合标签。
 *
 * 范围算错不是「功能不生效」，而是**直接把源码改坏**（少删一个闭合标签、
 * 多删一个兄弟节点）。所以这里全是纯字符串逻辑：不碰文件、不碰 DOM，
 * 可以拿真实 HTML 片段反复验。
 *
 * ## 必须绕开的坑（每一个都能让范围算错）
 *
 * - `<!-- <div> -->` 注释里的标签不算数
 * - `<div title="a > b">` 属性值里的 `>` 不是标签结束
 * - `<script>const s = "<div>"</script>` 脚本串里的标签不算数
 * - `<br>` `<img>` 这类空元素没有闭合标签，自身就是完整范围
 * - `<div/>` 自闭合写法同理
 */

/** 空元素：没有闭合标签，开标签自身就是整个元素。 */
export const VOID_TAGS = new Set([
	"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
	"meta", "param", "source", "track", "wbr"
]);

/** 内容不是标记的标签：里面的 `<div>` 是纯文本。 */
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);

/**
 * 从某个偏移开始，跳过一个「不是标记」的区段。
 *
 * 返回跳过后的位置；不在任何特殊区段里就返回原位置。
 *
 * @param source - 全文。
 * @param index - 当前位置（指向 `<`）。
 * @returns 新的位置。
 */
function skipNonMarkup(source, index) {
	// 注释：`<!-- ... -->`，里面的标签不算数
	if (source.startsWith("<!--", index)) {
		const end = source.indexOf("-->", index + 4);
		return end < 0 ? source.length : end + 3;
	}
	// CDATA / 声明：`<!DOCTYPE ...>`、`<![CDATA[ ... ]]>`
	if (source.startsWith("<!", index)) {
		const end = source.indexOf(">", index + 2);
		return end < 0 ? source.length : end + 1;
	}
	return index;
}

/**
 * 从一个开标签的 `<` 开始，找到这个开标签的结束位置（`>` 之后）。
 *
 * @param source - 全文。
 * @param start - 指向 `<`。
 * @returns 结束偏移（不含）；找不到返回 -1。
 */
function findTagEnd(source, start) {
	let index = start;
	while (index < source.length) {
		const ch = source[index];
		if (ch === '"' || ch === "'") {
			// 属性值里的 `>` 不是标签结束——这是最常见的错法
			const close = source.indexOf(ch, index + 1);
			if (close < 0) return -1;
			index = close + 1;
			continue;
		}
		if (ch === ">") return index + 1;
		index += 1;
	}
	return -1;
}

/**
 * 找出一整个元素的范围（含子元素与闭合标签）。
 *
 * @param source - 全文。
 * @param openStart - 开标签 `<` 的偏移。
 * @returns { start, end, innerStart, innerEnd, selfClosed } 或 null。
 *   start/end 是整个元素；innerStart/innerEnd 是内容区（用于"插到里面"）。
 */
export function findElementRange(source, openStart) {
	if (source[openStart] !== "<") return null;
	const nameMatch = /^<([a-zA-Z][\w:-]*)/u.exec(source.slice(openStart, openStart + 64));
	if (nameMatch === null) return null;
	const tag = nameMatch[1].toLowerCase();

	const openEnd = findTagEnd(source, openStart);
	if (openEnd < 0) return null;
	const openText = source.slice(openStart, openEnd);
	const selfClosed = /\/\s*>$/u.test(openText);

	// 空元素、自闭合写法：开标签就是整个元素
	if (selfClosed || VOID_TAGS.has(tag)) {
		return { start: openStart, end: openEnd, innerStart: openEnd, innerEnd: openEnd, selfClosed: true };
	}

	// 从内容起点往后扫，按同类标签的嵌套深度配对
	let index = openEnd;
	let depth = 1;
	while (index < source.length) {
		const lt = source.indexOf("<", index);
		if (lt < 0) break;
		const skipped = skipNonMarkup(source, lt);
		if (skipped !== lt) { index = skipped; continue; }

		// 闭合标签
		if (source.startsWith("</", lt)) {
			const gt = source.indexOf(">", lt);
			if (gt < 0) return null;
			const closeName = source.slice(lt + 2, gt).trim().toLowerCase();
			if (closeName === tag) {
				depth -= 1;
				if (depth === 0) {
					return { start: openStart, end: gt + 1, innerStart: openEnd, innerEnd: lt, selfClosed: false };
				}
			}
			index = gt + 1;
			continue;
		}

		const inner = /^<([a-zA-Z][\w:-]*)/u.exec(source.slice(lt, lt + 64));
		if (inner === null) { index = lt + 1; continue; }
		const innerName = inner[1].toLowerCase();
		const innerEnd = findTagEnd(source, lt);
		if (innerEnd < 0) return null;

		// 内容不是标记的标签：整段跳过，别去解析里面的假标签
		if (RAW_TEXT_TAGS.has(innerName)) {
			const close = source.toLowerCase().indexOf(`</${innerName}`, innerEnd);
			index = close < 0 ? source.length : close;
			continue;
		}
		if (innerName === tag && !/\/\s*>$/u.test(source.slice(lt, innerEnd))) depth += 1;
		index = innerEnd;
	}
	// 没有闭合标签（片段/模板里常见）：退化成"到文件末尾"
	return { start: openStart, end: source.length, innerStart: openEnd, innerEnd: source.length, selfClosed: false, unclosed: true };
}

/**
 * 取某一行的缩进（制表符或空格），用于让插入的内容与邻居对齐。
 *
 * @param source - 全文。
 * @param offset - 该行内的任意偏移。
 * @returns 缩进字符串。
 */
export function indentAt(source, offset) {
	const lineStart = source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
	const line = source.slice(lineStart, offset);
	const indent = /^[\t ]*/u.exec(line)?.[0] ?? "";
	return indent;
}

/**
 * 猜这份源码用的是什么缩进单位。
 *
 * 硬编码 `\t` 会往空格缩进的文件里塞制表符，diff 一片红。
 * 判断很简单：有行以制表符开头就用制表符，否则用两个空格。
 *
 * @param source - 全文。
 * @returns 缩进单位。
 */
export function detectIndentUnit(source) {
	for (const line of source.split("\n")) {
		if (line.startsWith("\t")) return "\t";
	}
	return "  ";
}

/**
 * 把一个元素插到目标元素的相对位置。
 *
 * @param source - 全文。
 * @param range - findElementRange 的结果。
 * @param markup - 要插入的标记（可多行；会按目标缩进对齐）。
 * @param position - "before" | "after" | "inside-start" | "inside-end"。
 * @returns { text, offset } 或 { error }。offset 是插入起点的偏移。
 */
export function insertElement(source, range, markup, position) {
	if (range === null || range === undefined) return { error: "没有可用的元素范围" };
	const body = String(markup ?? "").trim();
	if (body === "") return { error: "要插入的内容为空" };

	if (position === "before" || position === "after") {
		const indent = indentAt(source, range.start);
		const firstLineStart = source.lastIndexOf("\n", Math.max(0, range.start - 1)) + 1;
		const lastLineEnd = source.indexOf("\n", range.end);
		const lineEnd = lastLineEnd < 0 ? source.length : lastLineEnd;
		// 元素是否**独占自己那几行**：前后没有别的兄弟。
		// 这决定要不要换行——行内元素（`<p>前<span>x</span>后</p>`）插成独立行会改排版。
		const aloneOnLines = source.slice(firstLineStart, range.start).trim() === ""
			&& source.slice(range.end, lineEnd).trim() === "";

		if (aloneOnLines) {
			// **插到行边界**，不是元素边界。
			// 早先在 range.end 直接插 `内容\n缩进`，内容会和元素挤在同一行：
			//     <li>一</li><li>二</li>
			// 因为 range.end 是元素自身的结束、位于换行符**之前**。
			const at = position === "before" ? firstLineStart : lineEnd + 1;
			const text = `${indent}${body}\n`;
			return { text: `${source.slice(0, at)}${text}${source.slice(at)}`, offset: at, length: text.length };
		}

		// 行内插入：不加任何空白，紧贴元素
		const at = position === "before" ? range.start : range.end;
		return { text: `${source.slice(0, at)}${body}${source.slice(at)}`, offset: at, length: body.length };
	}

	if (position === "inside-start" || position === "inside-end") {
		if (range.selfClosed === true) {
			return { error: "这是一个空元素（没有闭合标签），不能往里插内容" };
		}
		const unit = detectIndentUnit(source);
		const parentIndent = indentAt(source, range.start);
		const childIndent = parentIndent + unit;
		const at = position === "inside-start" ? range.innerStart : range.innerEnd;
		const lines = body.split("\n").map((line) => `${childIndent}${line}`).join("\n");
		const content = `${lines}\n`;

		// 插入点所在行、它前面已有的空白
		const lineStart = source.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
		const beforeOnLine = source.slice(lineStart, at);

		if (beforeOnLine.trim() === "") {
			// 插入点在行首（前面只有缩进）→ 把新内容铺在这一行**之前**，
			// 原有的缩进留给父元素的闭合标签。多插一个 \n 就会多出空行。
			const text = `${content}`;
			return { text: `${source.slice(0, lineStart)}${text}${source.slice(lineStart)}`, offset: lineStart, length: text.length };
		}

		// 插入点前面还有兄弟内容（同一行）→ 另起一行，收尾回到父元素缩进
		const text = `\n${content}${parentIndent}`;
		return { text: `${source.slice(0, at)}${text}${source.slice(at)}`, offset: at, length: text.length };
	}

	return { error: `不认识的位置：${position}` };
}

/**
 * 删掉一个元素的完整范围（连同它前后的空白，避免留下空行）。
 *
 * @param source - 全文。
 * @param range - findElementRange 的结果。
 * @returns { text } 或 { error }。
 */
export function removeElement(source, range) {
	if (range === null || range === undefined) return { error: "没有可用的元素范围" };
	let start = range.start;
	let end = range.end;
	// 元素**独占一行**时，把它那行的缩进和换行一起吃掉，否则会剩下一行空白
	const lineStart = source.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
	const before = source.slice(lineStart, start);
	if (before.trim() === "") {
		start = lineStart;
	}
	while (end < source.length && (source[end] === " " || source[end] === "\t")) end += 1;
	if (source[end] === "\r") end += 1;
	if (source[end] === "\n") end += 1;
	return { text: source.slice(0, start) + source.slice(end) };
}

/**
 * 在源码里找出一段标记（用于「复制」后重新插入）。
 *
 * @param source - 全文。
 * @param range - findElementRange 的结果。
 * @returns 那段原文。
 */
export function sliceElement(source, range) {
	if (range === null || range === undefined) return "";
	return source.slice(range.start, range.end);
}
