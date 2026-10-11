/**
 * 写回层：把「画布上的一次改动」翻译成「源码里最小的一个 patch」。
 *
 * ## 设计约束（安全第一）
 *
 * 1. **受约束编辑**：只允许「改某个已存在元素的样式 / 文本」，不做结构重构。
 *    自由绝对定位落不了盘——这正是调研里那条硬结论（能改真源码就必须落在 CSS 语义里）。
 * 2. **最小 patch**：只替换属性值那一段字符，其余一个字节不动。
 * 3. **可校验**：patch 后做一次括号/引号配平检查，不平就整体拒绝。
 * 4. **可回滚**：由 ops 层记录 before 文本，配合 git 检查点。
 *
 * ## 策略
 *
 * | 策略 | 适用 | 落点 |
 * |---|---|---|
 * | `inline` | **任意栈** | 目标元素开标签上的 `style` 属性（已存在则合并） |
 * | `cssFile` | 有全局 CSS 文件 | 追加一条 `.dsh-<hash>` 规则到项目 CSS |
 * | `tailwind` | Tailwind 项目 | 在 `className` 里替换工具类（P2，需要映射表） |
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { upsertAttribute, findAttribute } from "./attributes.js";

/** 会被当作「项目样式表」的文件名模式。 */
const CSS_FILE_PATTERN = /\.(css|scss|sass|less|styl)$/iu;

/** 样式表搜索时跳过的目录。 */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit"]);

/** 允许写入的内联样式属性白名单：只碰表现层，不碰布局模型。 */
export const STYLE_PROPERTIES = new Set([
	"color", "background", "background-color", "background-image", "background-size", "background-position",
	"font-size", "font-weight", "font-family", "font-style", "line-height", "letter-spacing", "text-align",
	"text-decoration", "text-transform", "white-space", "word-break",
	"border", "border-color", "border-width", "border-style", "border-radius",
	"box-shadow", "opacity", "filter", "backdrop-filter", "mix-blend-mode",
	// clip-path 是纯表现层（形状预设用它，不改盒模型），与白名单的原意一致。
	"clip-path",
	"padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
	"margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
	"width", "min-width", "max-width", "height", "min-height", "max-height",
	"gap", "row-gap", "column-gap",
	"display", "flex-direction", "align-items", "justify-content", "flex-wrap",
	"position", "top", "right", "bottom", "left", "z-index",
	"overflow", "cursor", "transition", "transform", "aspect-ratio", "object-fit"
]);

/**
 * 探测项目的样式方案与框架。
 *
 * @param root - 项目根目录。
 * @returns { framework, styleSystem, cssFiles, evidence }。
 */
export function detectProject(root) {
	const evidence = [];
	let pkg = null;
	try {
		const pkgPath = join(root, "package.json");
		if (existsSync(pkgPath)) {
			pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
			evidence.push(`package.json`);
		}
	} catch {
		evidence.push("package.json 解析失败");
	}

	const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
	const has = (name) => Object.hasOwn(deps, name);

	let framework = "unknown";
	if (has("next")) framework = "next";
	else if (has("nuxt")) framework = "nuxt";
	else if (has("@sveltejs/kit") || has("svelte")) framework = "svelte";
	else if (has("vue")) framework = "vue";
	else if (has("astro")) framework = "astro";
	else if (has("solid-js")) framework = "solid";
	else if (has("react")) framework = "react";
	else if (pkg !== null) framework = "vanilla";

	let styleSystem = "unknown";
	if (has("tailwindcss")) styleSystem = "tailwind";
	else if (has("styled-components") || has("@emotion/react") || has("@emotion/styled")) styleSystem = "css-in-js";
	else if (has("sass") || has("sass-embedded")) styleSystem = "scss";
	else if (existsSync(join(root, "src", "styles")) || existsSync(join(root, "src", "assets"))) styleSystem = "css";

	const cssFiles = findStylesheets(root);
	if (styleSystem === "unknown" && cssFiles.length > 0) styleSystem = "css";
	if (cssFiles.length > 0) evidence.push(`${cssFiles.length} 个样式表`);

	return { framework, styleSystem, cssFiles, hasPackageJson: pkg !== null, evidence };
}

/**
 * 找出项目里的样式表（限定深度与数量，避免大仓库扫描）。
 * @param root - 项目根。
 * @returns 相对路径数组。
 */
export function findStylesheets(root) {
	const out = [];
	const walk = (dir, depth) => {
		if (out.length >= 200 || depth > 6) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (out.length >= 200) return;
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
				walk(join(dir, entry.name), depth + 1);
				continue;
			}
			if (!entry.isFile()) continue;
			if (!CSS_FILE_PATTERN.test(entry.name)) continue;
			out.push(relative(root, join(dir, entry.name)).split(sep).join("/"));
		}
	};
	walk(root, 0);
	// 入口样式优先：index / main / global / app 开头。
	out.sort((a, b) => rankCss(a) - rankCss(b) || a.length - b.length);
	return out;
}

/**
 * 样式表的优先级排序（越小越优先）。
 * @param path - 相对路径。
 * @returns 名次。
 */
function rankCss(path) {
	const base = path.split("/").pop() ?? path;
	if (/^(index|main|global|globals|app|style|styles)\./iu.test(base)) return 0;
	if (/global/iu.test(base)) return 1;
	return 2;
}

/**
 * 找出一行上的开标签区间。
 *
 * 支持三种形态（跨框架）：
 * - JSX / Vue / Svelte：`<div className="x">`、`<div :class="x">`
 * - 纯 HTML：`<div class="x">`
 * - 自闭合：`<img src="x" />`
 *
 * @param lines - 文件所有行。
 * @param line - 目标行（1-based）。
 * @param tag - 提示的标签名（可选，用于在多标签行里选对那个）。
 * @param needle - 额外线索（文本或 class），用于多标签时消歧。
 * @returns { start, end, tagName } 字符区间（基于全文偏移）或 null。
 */
export function findOpeningTag(lines, line, tag, needle, options = {}) {
	// 先算每行在全文里的起始偏移。必须按「原文的实际换行宽度」累加，
	// 不能假设每行末尾只有一个 \n —— CRLF 文件会整体错位。
	const offsets = lineOffsets(lines);
	const startLine = Math.max(0, Math.min(lines.length - 1, line - 1));
	const lookBack = options.lookBack ?? 3;
	const lookAhead = options.lookAhead ?? 8;

	// 在提示行前后找候选，取「离提示行最近」的那个。
	// 行号可能来自编译期注入（**先往后找会让它落到同一文件里错误的元素上**，改错代码）。
	const hits = [];
	const from = Math.max(0, startLine - lookBack);
	const to = Math.min(lines.length - 1, startLine + lookAhead);
	for (let i = from; i <= to; i += 1) {
		const candidates = scanTags(lines[i], tag);
		if (candidates.length === 0) continue;
		const picked = pickTag(candidates, lines[i], needle);
		if (picked === null) continue;
		hits.push({ start: offsets[i] + picked.start, end: offsets[i] + picked.end, tagName: picked.tagName, lineNumber: i + 1, distance: Math.abs(i - startLine) });
	}

	// 跨行标签：本行以标签名或未闭合属性结尾时，拼接后续行再找。
	const unfinished = /<[A-Za-z][\w.:-]*(\s|$)/u.test(lines[startLine])
		&& !/>/u.test(lines[startLine].slice(lines[startLine].lastIndexOf("<")));
	if (unfinished) {
		for (let j = startLine + 1; j < Math.min(lines.length, startLine + 5); j += 1) {
			const joined = `${lines[startLine]}\n${lines.slice(startLine + 1, j + 1).join("\n")}`;
			const spanned = scanTags(joined, tag);
			if (spanned.length === 0) continue;
			const picked = pickTag(spanned, joined, needle);
			if (picked === null) continue;
			const start = offsets[startLine] + picked.start;
			const lineOfEnd = startLine + (joined.slice(0, picked.end).split("\n").length - 1);
			const endWithinLine = picked.end - (joined.lastIndexOf("\n", picked.end - 1) + 1);
			hits.push({ start, end: offsets[lineOfEnd] + endWithinLine, tagName: picked.tagName, lineNumber: startLine + 1, distance: 0 });
			break;
		}
	}

	if (hits.length === 0 && options.global === true) {
		/*
		 * ## 全文兜底 —— 窗口内找不到时再全文找一遍
		 *
		 * ### 为什么需要（用户报的「组件拖动不进去」）
		 *
		 * `line` 是**定位器按内容猜**出来的，它可能落在 CSS 规则或注释里。
		 * 实测：`prototype.html:42` 命中的是 CSS 注释里的那行
		 * `* comment-card / menu / prompt-bar / status-bar` ——
		 * 因为文件顶部那一大段注释**罗列了所有组件的类名**，
		 * 而定位器只按文本匹配，分不清"注释里提到的名字"和"真正的元素"。
		 *
		 * 那个位置前后 11 行当然没有 `<footer>`，于是直接失败。
		 * 用户看到的是「在 prototype.html:42 附近没找到可编辑的开标签」，
		 * **而他完全不知道自己哪里做错了** —— 拖放动作本身没有任何问题。
		 *
		 * ### 为什么要求「唯一命中」
		 *
		 * 会用 `tag` + `needle`（类名/文本）去全文匹配，**只有恰好命中一处**才采纳。
		 * 命中多处说明这些线索不足以确定是哪个元素 ——
		 * 宁可继续失败，也不能把改动写到另一个元素上
		 *（`ops.js` 里对 `ambiguous` 的保守处理是同一个道理）。
		 *
		 * ### 调用方要显式开启
		 *
		 * 默认关闭（`options.global`）。只有**纯增量**的操作
		 *（插入新元素）才该开 —— 那种操作挑错了位置，画布上不会出现东西、
		 * Ctrl+Z 一下就回去了，风险远小于"功能完全不可用"。
		 * 删除/移动这类**破坏性**操作必须保持严格。
		 */
		const global = [];
		/** 强线索：类名/文本这类长度 ≥3 的片段才够用来消歧。 */
		const strong = (Array.isArray(needle) ? needle : [])
			.filter((value) => typeof value === "string" && value.length >= 3);

		for (let i = 0; i < lines.length; i += 1) {
			const candidates = scanTags(lines[i], tag);
			if (candidates.length === 0) continue;
			const picked = pickTag(candidates, lines[i], needle);
			if (picked === null) continue;

			/*
			 * ★ **必须自己再验一遍 needer**，不能只信 `pickTag`。
			 *
			 * `pickTag` 对"该行只有一个候选"是**直接返回**的、根本不看线索：
			 *
			 * ```js
			 * if (candidates.length === 1) return candidates[0];
			 * ```
			 *
			 * 窗口内这么做没问题（附近只有一两个标签，定位给的行号本身就是线索）。
			 * 但**全文扫描**下它会让同 tag 的无关元素全进候选 ——
			 * 原型里有两个 `<footer>`（`.prompt-bar` 和 `.status-bar`），
			 * 于是"唯一命中"永远不成立，兜底等于没写。
			 *
			 * 所以这里要求：**该标签自身必须包含线索**，否则跳过。
			 * 这样 `.prompt-bar` 会被筛掉，只剩真正那个 `.status-bar`。
			 */
			if (strong.length > 0) {
				const inner = lines[i].slice(picked.start, picked.end);
				if (!strong.some((value) => inner.includes(value))) continue;
			}

			global.push({
				start: offsets[i] + picked.start,
				end: offsets[i] + picked.end,
				tagName: picked.tagName,
				lineNumber: i + 1,
				distance: Math.abs(i - startLine)
			});
		}
		// 唯一命中才采纳；0 个仍然失败，多个说明线索不够、不敢猜
		if (global.length === 1) return global[0];
	}

	if (hits.length === 0) return null;
	hits.sort((a, b) => a.distance - b.distance || a.start - b.start);
	return hits[0];
}

/**
 * 每行的起始字符偏移。
 * @param lines - 所有行。
 * @returns 偏移数组。
 */
function lineOffsets(lines) {
	const offsets = [];
	let total = 0;
	for (const line of lines) {
		offsets.push(total);
		total += line.length + 1; // 统一按 \n 计（split 已吃掉 \r 时这里也一致）
	}
	return offsets;
}

/**
 * 在一行里扫描所有开标签。
 *
 * 正则拆开写是为了避免回溯歧义：标签名、属性串、自闭合斜杠三段分开，
 * 属性串允许双引号 / 单引号 / 花括号（不跨层）以及非引号字符。
 *
 * @param text - 行文本。
 * @param tag - 期望的标签名（可选）。
 * @returns [{ start, end, tagName }]。
 */
export function scanTags(text, tag) {
	const out = [];
	const pattern = /<([A-Za-z][\w.:-]*)((?:\s+(?:"[^"]*"|'[^']*'|\{[^{}]*\}|[^>"'\s])+)*)\s*(\/?)>/gu;
	let found;
	while ((found = pattern.exec(text)) !== null) {
		const tagName = found[1];
		if (tag !== undefined && tag !== "" && tagName.toLowerCase() !== String(tag).toLowerCase()) continue;
		out.push({ start: found.index, end: found.index + found[0].length, tagName });
	}
	return out;
}

/**
 * 一行里有多个候选标签时挑一个。
 * @param candidates - 候选标签。
 * @param text - 行文本。
 * @param needle - 线索（文本片段或 class 名）。
 * @returns 选中项或 null。
 */
function pickTag(candidates, text, needle) {
	if (candidates.length === 1) return candidates[0];
	if (Array.isArray(needle) && needle.length > 0) {
		for (const candidate of candidates) {
			const inner = text.slice(candidate.start, candidate.end);
			if (needle.some((value) => typeof value === "string" && value.length >= 3 && inner.includes(value))) return candidate;
		}
	}
	return candidates[0];
}

/**
 * 把样式声明合并进元素的内联 style。
 *
 * 这是**唯一对所有技术栈都成立**的写回方式：不管 JSX / Vue / Svelte / 纯 HTML，
 * 往开标签上写 style 都能生效。
 *
 * @param root - 项目根。
 * @param target - { file, line, tag, needle }。
 * @param declarations - { [property]: value }，值为 null 表示删除该声明。
 * @param options - { syntax }：`"jsx"` | `"html"` | `"vue"`。
 * @returns { changed, text, file, line, tagName, summary } 或 { error }。
 */
export function applyInlineStyle(root, target, declarations, options = {}) {
	if (target?.file === undefined) return { error: "没有定位到源文件" };
	const absolute = join(root, target.file);
	if (!existsSync(absolute)) return { error: `源文件不存在: ${target.file}` };
	const original = readFileSync(absolute, "utf8");
	const lines = original.split(/\r?\n/u);

	const tagRange = findOpeningTag(lines, target.line ?? 1, target.tag, target.needle);
	if (tagRange === null) {
		return { error: `在 ${target.file}:${target.line ?? 1} 附近（前后几行内）没找到可编辑的开标签` };
	}
	// 用「实际命中的那一行」而不是提示行号：提示可能来自编译期注入，会偏一两行，
	// 记错行号会让 ops 层的撤销与 diff 指向错误位置。
	const actualLine = tagRange.lineNumber ?? target.line ?? 1;

	const tagText = original.slice(tagRange.start, tagRange.end);
	// 把源码与偏移一起传进去：光看扩展名会把「模板字符串里的 HTML」误判成 JSX，
	// 写出浏览器会静默忽略的 style={{...}}（踩过一次，演示站点就是这么坏的）。
	const syntax = options.syntax ?? guessSyntax(target.file, original, tagRange.start);
	const existing = findAttribute(tagText, syntax === "jsx" ? "style" : "style");

	// 读出已有声明，合并本次改动。
	const current = existing === null ? {} : parseStyleValue(tagText.slice(existing.valueStart, existing.valueEnd), syntax);
	const next = { ...current };
	for (const [property, value] of Object.entries(declarations ?? {})) {
		const key = property.trim().toLowerCase();
		if (value === null || value === "") delete next[key];
		else next[key] = String(value);
	}
	if (Object.keys(next).length === 0) {
		// 全部删空：把 style 属性整个移除。
		if (existing === null) return { changed: false };
		const stripped = `${tagText.slice(0, existing.start)}${tagText.slice(existing.end)}`;
		const nextText = `${original.slice(0, tagRange.start)}${stripped}${original.slice(tagRange.end)}`;
		const check = validatePatch(original, nextText);
		if (!check.ok) return { error: `补丁校验失败：${check.reason}` };
		return {
			changed: true,
			text: nextText,
			file: target.file,
			line: actualLine,
			tagName: tagRange.tagName,
			summary: "清空内联样式"
		};
	}

	const serialized = serializeStyleValue(next, syntax, tagText, existing);
	const merged = upsertAttribute(original, [tagRange.start, tagRange.end], "style", serialized.value, serialized.style);
	const check = validatePatch(original, merged.text);
	if (!check.ok) return { error: `补丁校验失败：${check.reason}` };

	return {
		changed: merged.text !== original,
		text: merged.text,
		file: target.file,
		line: actualLine,
		tagName: tagRange.tagName,
		summary: summarize(declarations)
	};
}

/**
 * 判断某个偏移是否落在**模板字符串**（反引号）内部。
 *
 * 用途：`.js` / `.mjs` / `.ts` 里的标签可能是两种完全不同的东西——
 * - JSX 元素（React 组件）→ 样式要写成 `style={{ color: "red" }}`
 * - 模板字符串里的 HTML（生成页面的服务端代码）→ 样式要写成 `style="color: red"`
 *
 * 写错的那一种浏览器会**静默忽略**（`style={{...}}` 在 HTML 里是无效属性值），
 * 于是「改了源码但页面没变」——这个坑真实发生过（演示站点的 server.mjs）。
 *
 * 做法：从文件开头数**未转义**的反引号，奇数为在模板字符串内。
 * 这不是完整词法分析（注释里的反引号也会被算进去），但足以覆盖实际形态，
 * 且配合下面的「必须看起来像 HTML 文档」二次确认，误判代价可控。
 *
 * @param source - 文件全文。
 * @param offset - 目标偏移。
 * @returns 是否在模板字符串内。
 */
export function insideTemplateLiteral(source, offset) {
	let count = 0;
	const end = Math.min(offset, source.length);
	for (let i = 0; i < end; i += 1) {
		const ch = source[i];
		if (ch === "\\") {
			i += 1;
			continue;
		}
		if (ch === "`") count += 1;
	}
	return count % 2 === 1;
}

/**
 * 取包含该偏移的模板字符串开头的文本（用于判断它是不是 HTML 文档）。
 *
 * @param source - 文件全文。
 * @param offset - 目标偏移。
 * @returns 从最近的未配对反引号到偏移的文本；找不到则返回 ""。
 */
function enclosingTemplateHead(source, offset) {
	let count = 0;
	let opener = -1;
	const end = Math.min(offset, source.length);
	for (let i = 0; i < end; i += 1) {
		const ch = source[i];
		if (ch === "\\") {
			i += 1;
			continue;
		}
		if (ch === "`") {
			count += 1;
			if (count % 2 === 1) opener = i;
		}
	}
	return opener < 0 ? "" : source.slice(opener, end);
}

/**
 * 猜源文件的语法风格。
 *
 * 仅凭扩展名不够：`.mjs` 可能是 React 组件，也可能是生成 HTML 的服务端代码
 * （后者要把样式写成 HTML 属性，写成 JSX 花括号浏览器会忽略）。
 * 所以当调用方能提供源码与偏移时，按**上下文**再判一次。
 *
 * @param file - 相对路径。
 * @param source - 可选；文件全文。
 * @param offset - 可选；目标标签在全文中的偏移。
 * @returns `"jsx"` | `"html"` | `"vue"`。
 */
export function guessSyntax(file, source, offset) {
	const ext = extname(String(file ?? "")).toLowerCase();
	if (ext === ".vue") return "vue";
	if (ext === ".jsx" || ext === ".tsx") return "jsx";
	if (ext === ".html" || ext === ".htm") return "html";

	// JS 家族（.js/.mjs/.cjs/.ts/.astro…）：默认 JSX，但如果这个标签落在
	// 「看起来是 HTML 文档」的模板字符串里，就必须用 HTML 属性写法。
	if (typeof source === "string" && Number.isInteger(offset) && insideTemplateLiteral(source, offset)) {
		const head = enclosingTemplateHead(source, offset);
		// 二次确认：模板开头确实是一份 HTML 文档，而不是恰好含反引号的普通 JSX 文件。
		if (/<!doctype\s+html|<html[\s>]/iu.test(head)) return "html";
	}
	return "jsx";
}

/**
 * 解析已有的 style 值。
 * @param inner - 属性值内部文本。
 * @param syntax - 语法风格。
 * @returns 声明对象。
 */
export function parseStyleValue(inner, syntax) {
	const text = String(inner ?? "").trim();
	const out = {};
	if (text === "") return out;

	if (text.startsWith("{") && text.endsWith("}")) {
		// JSX 对象写法：{ color: "red", fontSize: 12 }
		const body = text.slice(1, -1);
		const pattern = /([A-Za-z-][\w-]*)\s*:\s*("([^"]*)"|'([^']*)'|`([^`]*)`|([^,}]+))/gu;
		let found;
		while ((found = pattern.exec(body)) !== null) {
			const key = camelToKebab(found[1]);
			const value = (found[3] ?? found[4] ?? found[5] ?? found[6] ?? "").trim();
			out[key] = value;
		}
		return out;
	}

	// 字符串写法：color: red; font-size: 12px
	for (const part of text.split(";")) {
		const at = part.indexOf(":");
		if (at < 0) continue;
		const key = part.slice(0, at).trim().toLowerCase();
		const value = part.slice(at + 1).trim();
		if (key !== "" && value !== "") out[key] = value;
	}
	return out;
}

/**
 * 序列化 style 值。
 *
 * @param declarations - 声明对象。
 * @param syntax - 语法风格。
 * @param tagText - 开标签文本（用于判断已有属性的书写风格）。
 * @param existing - 已有 style 属性（可为 null）。
 * @returns { value, style } 值文本与 upsertAttribute 需要的形式。
 */
export function serializeStyleValue(declarations, syntax, tagText, existing) {
	if (syntax === "jsx") {
		// JSX 里 style 必须是对象。对「纯像素数值」的属性剥掉 px 写成数字，
		// 这与 React 的惯例一致（fontSize: 14 等价于 "14px"），也更像人手写的。
		const parts = Object.entries(declarations).map(([key, value]) => {
			const camel = kebabToCamel(key);
			const pxOnly = /^(-?\d+(?:\.\d+)?)px$/u.exec(String(value).trim());
			if (pxOnly !== null && NUMERIC_STYLE.has(key)) return `${camel}: ${pxOnly[1]}`;
			const bareNumber = /^-?\d+(?:\.\d+)?$/u.test(String(value).trim());
			if (bareNumber && NUMERIC_STYLE.has(key)) return `${camel}: ${value}`;
			return `${camel}: "${escapeQuoted(value)}"`;
		});
		return { value: `{ ${parts.join(", ")} }`, style: "braces" };
	}
	const text = Object.entries(declarations).map(([key, value]) => `${key}: ${value}`).join("; ");
	return { value: text, style: "double" };
}

/** 在 JSX 里可以写成数字（不带引号）的样式属性。 */
const NUMERIC_STYLE = new Set([
	"font-size", "font-weight", "line-height", "letter-spacing", "opacity", "z-index",
	"width", "height", "min-width", "max-width", "min-height", "max-height",
	"padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
	"margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
	"gap", "row-gap", "column-gap", "top", "right", "bottom", "left", "border-radius", "border-width"
]);

/**
 * 转义双引号。
 * @param value - 原值。
 * @returns 转义后的值。
 */
function escapeQuoted(value) {
	return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/**
 * 属性名 kebab → camel。
 * @param key - kebab 名。
 * @returns camel 名。
 */
export function kebabToCamel(key) {
	return String(key).replace(/-([a-z])/gu, (_all, letter) => letter.toUpperCase());
}

/**
 * 属性名 camel → kebab。
 * @param key - camel 名。
 * @returns kebab 名。
 */
export function camelToKebab(key) {
	return String(key).replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * 补丁后的配平校验：引号、花括号、尖括号必须成对，且文件非空。
 *
 * 这是防止「改坏源码」的最后一道闸门——不平就整体拒绝，宁可不改。
 *
 * @param before - 原文。
 * @param after - 补丁后文本。
 * @returns { ok, reason? }。
 */
export function validatePatch(before, after) {
	if (typeof after !== "string" || after.trim() === "") return { ok: false, reason: "补丁后内容为空" };
	if (after.length > before.length * 3 + 1024) return { ok: false, reason: "补丁后体积异常膨胀" };

	const pairs = [['"', '"'], ["'", "'"], ["{", "}"], ["(", ")"], ["[", "]"]];
	for (const [open, close] of pairs) {
		const openCount = countChar(after, open);
		const closeCount = countChar(after, close);
		if (open === close) {
			if (openCount % 2 !== 0) return { ok: false, reason: `${open} 数量为奇数（引号未闭合）` };
			continue;
		}
		if (openCount !== closeCount) return { ok: false, reason: `${open}${close} 不配平（${openCount} vs ${closeCount}）` };
	}
	// 行数不能变（我们只改一行内的属性）。
	const beforeLines = before.split("\n").length;
	const afterLines = after.split("\n").length;
	if (beforeLines !== afterLines) return { ok: false, reason: `行数变化（${beforeLines} → ${afterLines}）` };
	return { ok: true };
}

/**
 * 统计字符出现次数。
 * @param text - 文本。
 * @param char - 字符。
 * @returns 次数。
 */
function countChar(text, char) {
	let count = 0;
	for (const item of text) if (item === char) count += 1;
	return count;
}

/**
 * 生成改动摘要。
 * @param declarations - 声明对象。
 * @returns 摘要文本。
 */
function summarize(declarations) {
	const entries = Object.entries(declarations ?? {});
	if (entries.length === 0) return "无改动";
	return entries.map(([key, value]) => (value === null || value === "" ? `移除 ${key}` : `${key}: ${value}`)).join("；");
}
