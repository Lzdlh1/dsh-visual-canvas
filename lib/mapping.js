/**
 * 映射层：把一个 DOM 元素定位回「源文件 + 行 + 列」。
 *
 * ## 三档策略
 *
 * | 档 | 手段 | 覆盖 | 精度 |
 * |---|---|---|---|
 * | A | 编译期注入 `data-dsh-src`（可选的 Vite 插件） | React / Vue / Svelte | 精确到行 |
 * | B | 浏览器侧读组件内部信息（React fiber 的 `_debugSource`、Vue 的组件实例） | 主流框架 | 精确到行（dev 构建） |
 * | C | 宿主侧按文本 / class 名搜索源码 | **任意栈** | 到文件，行需确认 |
 *
 * 为什么要 C 档兜底：只要项目能跑起来，元素上总有可辨识的文本或 class 名，
 * 拿它去源码里搜通常能命中唯一位置。这是「不挑技术栈」的最后一道保障——
 * 即使框架完全陌生，也还能编辑，只是需要用户确认行号。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { isInside } from "./util.js";

/** 参与搜索的源码扩展名。 */
const SOURCE_EXT = new Set([
	".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts",
	".vue", ".svelte", ".astro", ".html", ".htm", ".php", ".erb", ".cshtml", ".twig", ".jinja", ".j2"
]);

/** 搜索时跳过的目录。 */
const SKIP_DIRS = new Set([
	"node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit",
	".output", ".cache", "coverage", ".turbo", ".vercel", "vendor", "__pycache__",
	// 插件自己的测试与演示目录：它们里面写着**示例标记**（比如断言里的
	// `'<aside class="side">'`），逐行打分时会被当成真正的源码命中，
	// 凭空造出一堆候选 → 定位变"不唯一" → `apply` 自动挑一个（实测栽过）。
	"test", "demo", ".dsh-canvas"
]);

/** 单次搜索的文件数上限（防大仓库卡死）。 */
const MAX_SCAN_FILES = 4000;

/** 单文件读取上限。 */
const MAX_FILE_BYTES = 1024 * 1024;

/**
 * 解析浏览器传来的定位线索。
 *
 * @param root - 项目根目录。
 * @param hint - 覆盖层送来的线索：
 *   { file?: string, line?: number, column?: number, tag?: string,
 *     text?: string[], classes?: string[], id?: string, chain?: string[] }
 * @param options - { maxCandidates }。
 * @returns { file, line, column, confidence, strategy, candidates, reason } 定位结果。
 */
export function resolveSource(root, hint, options = {}) {
	const maxCandidates = options.maxCandidates ?? 5;
	/**
	 * 调用方给过 pin（精确位置），但**校验没过**。
	 *
	 * 这种情况必须记下来：后面的搜索如果也不唯一，**绝不能再"自动挑一个"**——
	 * 而 pin 恰恰是"我确定是这个位置"的意思，它失效了还去猜，
	 * 就是把改动写到**另一个元素**上（用户实测：移动 A，B 跟着偏移，
	 * 还以为组件之间有依赖）。
	 */
	let pinFailed = false;

	// ---- 零档：调用方**钉住了**位置（用户在候选列表里点了一个）。
	//
	// 这是「定位但不猜」的另一半：工具不替你猜，但你说用哪个就用哪个，不再重新搜索。
	// 少了这一条，用户面对「找到 5 个相似位置」时根本没有出路。
	if (options.pin !== undefined && options.pin !== null && typeof options.pin.file === "string") {
		const pinned = locateInFile(root, options.pin.file, options.pin.line, hint?.texts, hint?.classes);
		if (pinned !== null) {
			return {
				...pinned,
				confidence: "pinned",
				strategy: "user-pin",
				candidates: [],
				reason: null,
				pinFailed: false
			};
		}
		pinFailed = true;
	}

	// ---- A / B 档：浏览器直接给出了文件（可能来自编译期注入或 fiber debugSource）
	if (typeof hint?.file === "string" && hint.file !== "") {
		// 注意字段名是 texts / classes（复数）——与覆盖层送来的协议一致。
		const located = locateInFile(root, hint.file, hint.line, hint.texts, hint.classes);
		if (located !== null) {
			return {
				...located,
				confidence: located.exact ? "exact" : "file-only",
				strategy: hint.strategy ?? "runtime",
				candidates: [],
				reason: located.exact ? null : "只定位到文件，未找到精确行（可手动确认）"
			};
		}
	}

	// ---- C 档：按文本 / class / 标签搜索源码
	const scored = searchProject(root, hint, maxCandidates);
	if (scored.length === 0) {
		return {
			file: null,
			line: null,
			column: null,
			confidence: "none",
			strategy: "search",
			candidates: [],
			reason: "在项目里没搜到匹配的源码位置（可能内容来自依赖库或运行时拼接）"
		};
	}

	const best = scored[0];
	// 只有一个候选且分数明显领先：给 file+line；否则只给文件与候选列表，让用户选。
	const decisive = scored.length === 1 || best.score >= (scored[1]?.score ?? 0) + 3;
	return {
		file: best.file,
		line: best.line,
		column: 1,
		confidence: decisive ? "inferred" : "ambiguous",
		strategy: "search",
		candidates: scored.slice(0, maxCandidates),
		reason: decisive ? null : `找到 ${scored.length} 个相似位置，请确认用哪一个`,
		// 见函数开头：pin 失效时，调用方**不该**再走"自动挑一个"
		pinFailed
	};
}

/**
 * 定位不唯一时，替用户挑一个，并如实说明「我挑了哪个、还有几个备选」。
 *
 * ## 为什么是「自动挑 + 说出来 + 可改」而不是「直接拒绝」
 *
 * 直接拒绝安全，但用户会卡死——工具说「请确认用哪一个」却不给确认入口，
 * 实测就是「拖了半天写不进去」。反过来闷头猜一个更糟：错了会改坏别的文件。
 *
 * 折中是：**按分数挑最像的那个，明确告诉你挑了谁，并允许一键换成别的**。
 * 这样默认路径能用，代价（万一挑错）也看得见、改得动。
 *
 * @param located - resolveSource 的结果。
 * @param hint - 元素线索（用于重挑）。
 * @returns 补齐了 autoPicked 字段的定位结果。
 */
export function autoPickCandidate(located, hint) {
	if (located.confidence !== "ambiguous" || located.candidates.length === 0) return located;
	const picked = located.candidates[0];
	return {
		...located,
		// **必须把 file/line 一起改掉**。
		//
		// 早先这里只加了 autoPicked 字段、没动 file/line，于是「自动挑选」只是
		// **报告**了一个选择：实际写入用的还是 resolveSource 最初给的 best.file
		//（分数最高的那个）。表现是状态栏说「已自动选 A」、文件却改在了 B，
		// 而且按画板路径学到的偏好完全不起作用——重排的只是候选数组，没人读它。
		file: picked.file,
		line: picked.line,
		// 保持 ambiguous：这是**如实**标注「我是猜的」，界面要把它显示出来。
		autoPicked: { file: picked.file, line: picked.line, score: picked.score, excerpt: picked.excerpt },
		reason: `定位不唯一：已自动选 ${picked.file}:${picked.line}，另有 ${located.candidates.length - 1} 个候选可换`
	};
}

/**
 * 在指定文件里定位行号。
 *
 * @param root - 项目根。
 * @param file - 相对或绝对路径。
 * @param line - 提示行号（1-based）。
 * @param texts - 元素文本线索。
 * @param classes - class 名线索。
 * @returns { file, line, column, exact } 或 null（文件不存在）。
 */
export function locateInFile(root, file, line, texts, classes) {
	const absolute = isInside(root, file) ? file : join(root, file);
	if (!existsSync(absolute) || !statSync(absolute).isFile()) return null;
	const content = readFileSync(absolute, "utf8");
	const lines = content.split(/\r?\n/u);
	const rel = relative(root, absolute).split(sep).join("/");

	// 给了行号且行号在范围内：先校验那一行附近有没有线索，有就采信。
	const clues = hasClues(texts, classes);
	if (Number.isInteger(line) && line >= 1 && line <= lines.length) {
		const near = lines.slice(Math.max(0, line - 3), Math.min(lines.length, line + 2)).join("\n");
		if (matchesAny(near, texts, classes) || !clues) {
			return { file: rel, line, column: 1, exact: true };
		}
	}

	// 行号缺失 / 越界 / 对不上：**优先按线索在文件内搜**（线索比行号更可靠，
	// 行号可能来自编译期注入而整体偏移）。取全文里「离提示行最近」的那条匹配。
	if (clues) {
		const nearest = findNearestLine(lines, line, texts, classes);
		if (nearest !== null) return { file: rel, line: nearest, column: 1, exact: true };
	}

	const clamped = Number.isInteger(line) ? Math.max(1, Math.min(line, lines.length)) : 1;
	return { file: rel, line: clamped, column: 1, exact: false };
}

/**
 * 在全文里找离提示行最近的一条匹配。
 *
 * 为什么要「最近」而不是「第一个」：提示行号可能整体偏移（编译期注入常见偏一两行），
 * 若从夹紧后的行号往后扫，会命中文件里**另一个**同样带该线索的元素，改错地方。
 *
 * @param lines - 文件所有行。
 * @param hintLine - 提示行号（可能越界或为 null）。
 * @param texts - 文本线索。
 * @param classes - class 线索。
 * @returns 行号或 null。
 */
function findNearestLine(lines, hintLine, texts, classes) {
	const pivot = Number.isInteger(hintLine) ? hintLine : 1;
	let best = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let i = 0; i < lines.length; i += 1) {
		if (!matchesAny(lines[i], texts, classes)) continue;
		const distance = Math.abs(i + 1 - pivot);
		if (distance < bestDistance) {
			best = i + 1;
			bestDistance = distance;
		}
	}
	return best;
}

/**
 * 从 startLine 起在若干行内找第一个匹配线索的行。
 * @param lines - 文件所有行。
 * @param startLine - 起始行（1-based）。
 * @param texts - 文本线索。
 * @param classes - class 线索。
 * @param window - 搜索行数。
 * @returns 行号或 null。
 */
function findLineNear(lines, startLine, texts, classes, window) {
	const from = Math.max(0, startLine - 1);
	const to = Math.min(lines.length, from + window);
	for (let i = from; i < to; i += 1) {
		if (matchesAny(lines[i], texts, classes)) return i + 1;
	}
	return null;
}

/**
 * 判断一段文本是否命中任一提示线索。
 * @param haystack - 被搜索文本。
 * @param texts - 文本线索。
 * @param classes - class 线索。
 * @returns 是否命中。
 */
export function matchesAny(haystack, texts, classes) {
	const text = String(haystack ?? "");
	if (Array.isArray(classes)) {
		for (const cls of classes) {
			if (typeof cls !== "string" || cls.length < 3) continue;
			if (text.includes(cls)) return true;
		}
	}
	if (Array.isArray(texts)) {
		for (const value of texts) {
			if (typeof value !== "string") continue;
			const needle = value.trim();
			if (needle.length < 3) continue;
			// 源码里的文本可能带引号 / 被拆行，取前若干字符做包含匹配。
			if (text.includes(needle.slice(0, 40))) return true;
		}
	}
	return false;
}

/**
 * 是否有可用的线索。
 * @param texts - 文本线索。
 * @param classes - class 线索。
 * @returns 是否有。
 */
function hasClues(texts, classes) {
	return (Array.isArray(texts) && texts.length > 0) || (Array.isArray(classes) && classes.length > 0);
}

/**
 * 插件自己的界面文件 —— **搜索时一律跳过**。
 *
 * 它们和用户画板里的 class 名**天然会撞**：外壳自己就有一份
 * `<aside class="side">` 的界面结构，用户的原型里也有一个 `.side`。
 * 两边同分 → 判为"定位不唯一" → `apply` 自动挑一个 → 可能挑到插件自己的文件上，
 * 宿主拿那个行号去改，用户看到的是
 * 「没能写入源码：在 xxx 附近没找到可编辑的开标签（已撤回预览）」——
 * 也就是"松手弹回去了"。
 *
 * 实测（2026-10-07）：候选列表里 5 条有 1 条来自 `lib/canvas/shell.html`。
 */
const PLUGIN_UI_FILES = new Set(["lib/canvas/shell.html", "lib/canvas/shell.css"]);

/**
 * 这一行是不是**注释**。
 *
 * 注释里经常写着示例标记（比如本文档里就引用过 `<aside class="side">`），
 * 逐行打分时它们**会被当成真正的源码命中**，凭空制造出一堆候选。
 * 实测那次 5 个候选里有 **3 个是我自己写的注释**。
 *
 * @param line - 源码行。
 * @returns 是注释行则 true。
 */
function isCommentLine(line) {
	const text = String(line ?? "").trim();
	return text.startsWith("//")
		|| text.startsWith("/*")
		|| text.startsWith("*")
		|| text.startsWith("<!--")
		|| text.startsWith("#");
}

/**
 * 在项目里搜源码，按线索命中度打分。
 *
 * @param root - 项目根。
 * @param hint - 线索对象。
 * @param limit - 返回条数上限。
 * @returns [{ file, line, score, excerpt }] 按分数降序。
 */
export function searchProject(root, hint, limit = 5) {
	const files = [];
	collectSourceFiles(root, files, 0);
	const results = [];
	for (const file of files) {
		const rel = relative(root, file).split(sep).join("/");
		// 插件自己的界面文件跳过（原因见 PLUGIN_UI_FILES）
		if (PLUGIN_UI_FILES.has(rel)) continue;
		// 插件自己的代码 / 测试目录也跳过（原因见 SKIP_DIRS）
		if (rel.split("/").some((part) => SKIP_DIRS.has(part))) continue;
		const content = readTextCapped(file);
		if (content === null) continue;
		const lines = content.split(/\r?\n/u);
		for (let i = 0; i < lines.length; i += 1) {
			// 注释行跳过（原因见 isCommentLine）
			if (isCommentLine(lines[i])) continue;
			const score = scoreLine(lines[i], hint);
			if (score <= 0) continue;
			results.push({
				file: rel,
				line: i + 1,
				score,
				excerpt: lines[i].trim().slice(0, 160)
			});
		}
	}
	results.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
	return results.slice(0, limit * 3).filter((item, index, all) => {
		// 同一文件同一行只留一条。
		return all.findIndex((other) => other.file === item.file && other.line === item.line) === index;
	}).slice(0, limit);
}

/**
 * 给一行源码打匹配分。
 * @param line - 源码行。
 * @param hint - 线索。
 * @returns 分数（0 = 不匹配）。
 */
export function scoreLine(line, hint) {
	const text = String(line ?? "");
	let score = 0;

	// id 是最强的信号。
	if (typeof hint?.id === "string" && hint.id.length >= 3 && text.includes(hint.id)) score += 4;

	// class 名：每个命中加 2 分。
	//
	// ⚠️ **必须整词匹配，不能用 `includes`。**
	//
	// 实测（2026-10-07 用户报「拖得动、松手弹回」）：
	// 选中 `<aside class="side">` 时，`includes("side")` 会**同时命中**
	//
	//     行477  <aside class="side">            ← 真正要改的
	//     行531  <div class="side-foot">6 个图层</div>   ← 也被判为匹配
	//     行486  <div class="side-list layer-tree">      ← 同样
	//
	// 三行同分 → 判为"定位不唯一" → `apply` 会**自动挑一个** → 挑到 531 行 →
	// 宿主拿着这个行号去找 `<aside>` 开标签，**找不到 → 拒绝写回 → 撤回预览** →
	// 用户看到的就是"松手弹回去了"。
	//
	// 要求 class 名前后是空白/引号/行首行尾，`side` 就不会再匹配 `side-foot`。
	if (Array.isArray(hint?.classes)) {
		for (const cls of hint.classes) {
			if (typeof cls !== "string" || cls.length < 3) continue;
			const escaped = cls.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
			if (new RegExp(`(?:^|[\\s"'\`])${escaped}(?:[\\s"'\`]|$)`, "u").test(text)) score += 2;
		}
	}

	// 可见文本：命中加 3 分（文本比 class 更能唯一定位）。
	if (Array.isArray(hint?.texts)) {
		for (const value of hint.texts) {
			const needle = String(value ?? "").trim();
			if (needle.length < 3) continue;
			if (text.includes(needle.slice(0, 40))) score += 3;
		}
	}

	// 内联样式（left / top）：**区分同类元素的关键信号**。
	//
	// 画出来的形状是一堆 `div.dsh-shape`，源码行除了坐标几乎一模一样——
	// 按 class / tag / chain 打分它们**完全同分**，于是判为"定位不唯一"，
	// 而 `remove` 这类会破坏内容的操作**被直接拒绝** → 用户"画得出来、删不掉"。
	//
	// 加 5 分：`resolveSource` 判定"明确"的门槛是比第二名高 3 分，5 足够拉开。
	if (hint?.style !== undefined && hint.style !== null && typeof hint.style === "object") {
		for (const [key, value] of Object.entries(hint.style)) {
			if (typeof value !== "string" || value === "") continue;
			// ⚠️ **冒号后面可能有空格**，必须容忍。
			//
			// 插件插入时生成的是 `left:52px`（无空格），
			// 而面板写回会**重新格式化**成 `left: 52px`（有空格）——
			// 于是同一个元素可能两种写法都有，而用户画板上**多数是带空格的那种**
			//（凡是被面板改过一次就会变成它）。
			//
			// 第一版写的是 `text.includes(\`${key}:${value}\`)`，只认无空格的那种，
			// **对画板上大多数元素完全失效**——那是"改了却没生效"的典型。
			const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
			if (new RegExp(`${key}\\s*:\\s*${escaped}`, "u").test(text)) score += 5;
		}
	}

	// 标签名：**有效信号**，加 2 分（原先 1 分）。
	//
	// 为什么提到 2：`resolveSource` 判定"明确"的门槛是**比第二名高 3 分**。
	// 实测那次 `<aside class="side">` 拿 class(2)+tag(1)+chain(1)=4 分，
	// 而 `view.js` 里一行 `const side = Math.max(width, height)` 靠 class 名拿 2 分 ——
	// **只差 2 分，不够 decisive**，于是又被判成"不唯一"、又要自动挑一个。
	// 标签匹配是实打实的结构信号，值这个分。
	if (score > 0 && typeof hint?.tag === "string" && hint.tag !== "" && new RegExp(`<${hint.tag}[\\s/>]`, "iu").test(text)) {
		score += 2;
	}

	// 组件链路：出现链上任一组件名再加分。
	if (score > 0 && Array.isArray(hint?.chain)) {
		for (const part of hint.chain) {
			if (typeof part === "string" && part.length >= 3 && text.includes(part)) score += 1;
		}
	}

	return score;
}

/**
 * 递归收集源码文件（有数量与深度上限）。
 * @param dir - 起始目录。
 * @param out - 输出数组。
 * @param depth - 当前深度。
 */
export function collectSourceFiles(dir, out, depth) {
	if (out.length >= MAX_SCAN_FILES || depth > 12) return;
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (out.length >= MAX_SCAN_FILES) return;
		if (entry.name.startsWith(".") && entry.name !== ".storybook") {
			if (SKIP_DIRS.has(entry.name) || entry.isDirectory()) continue;
		}
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			collectSourceFiles(full, out, depth + 1);
			continue;
		}
		if (!entry.isFile()) continue;
		const ext = extname(entry.name).toLowerCase();
		if (!SOURCE_EXT.has(ext)) continue;
		// 明显是产物的文件跳过。
		if (/\.min\.(js|css)$/iu.test(entry.name) || /\.bundle\.js$/iu.test(entry.name)) continue;
		out.push(full);
	}
}

/**
 * 读取文件内容（带大小上限）。
 * @param file - 文件路径。
 * @returns 内容或 null。
 */
function readTextCapped(file) {
	try {
		const info = statSync(file);
		if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
		return readFileSync(file, "utf8");
	} catch {
		return null;
	}
}
