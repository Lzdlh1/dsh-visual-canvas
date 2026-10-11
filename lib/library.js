/**
 * 设计库：导入、存储、检索组件 / 令牌 / 界面。
 *
 * ## 为什么是"全局库 + 项目隔离"
 *
 * 库放在 `$DSH_HOME/visual-canvas/libraries/`，**不属于任何项目**——一套设计规范
 * 是跨项目复用的资产，跟着项目走会导致每个新项目都要重新导入一遍。
 * 而"用这个库做出来的界面"是项目的东西，写进项目源码，两者天然分开。
 *
 * ## 为什么要有"导入器"这一层
 *
 * 外部设计包的格式五花八门。这里用 **Google Copy 格式**作为第一种支持：
 * 它是"设计规范包"而不是"组件代码包"，两者的差别很重要——
 *
 * - `components/*.json` 是**描述性元数据**（anatomy / variants / structurePatterns），
 *   **不含任何标记**
 * - 真正的标记在 `preview/component-*.html` 里（`<style>` + 各变体标本）
 *
 * 所以"可插入的组件"必须从两处**合成**：元数据决定它叫什么、属于哪类，
 * preview 决定它长什么样、由哪些标签构成。只读其中一处都凑不出能用的东西。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readZipEntries } from "./zip.js";

// #region 纯解析

/**
 * 解析 CSS 里的自定义属性，按选择器分块。
 *
 * 结果形如 `[{ selector: ":root", vars: { "--primary": "#4285f4" } }]`。
 * 暗色主题在多数设计包里就是另一个选择器块（`.dark` 或媒体查询里的 `:root`），
 * 所以按块返回、由调用方决定怎么归类，比在这里硬编码"哪个是暗色"稳。
 *
 * @param css - CSS 文本。
 * @returns 块数组。
 */
export function parseCssVariables(css) {
	const out = [];
	// 匹配「选择器 { ... }」。设计包里的令牌文件结构很规整，
	// 不做完整的 CSS 解析（那需要处理嵌套、注释、转义），够用即可。
	const blockPattern = /([^{}]+)\{([^{}]*)\}/gu;
	let match;
	while ((match = blockPattern.exec(css)) !== null) {
		const selector = match[1].trim().split("\n").pop().trim();
		const vars = {};
		const varPattern = /(--[\w-]+)\s*:\s*([^;]+);/gu;
		let decl;
		while ((decl = varPattern.exec(match[2])) !== null) {
			vars[decl[1]] = decl[2].trim();
		}
		if (Object.keys(vars).length > 0) out.push({ selector, vars });
	}
	return out;
}

/**
 * 把令牌按用途分组。
 *
 * 分组只是**给人看的**（界面上分节显示），不参与任何逻辑判断——
 * 所以用名字启发式就够了，不会因为某个包命名古怪就出错。
 *
 * @param vars - { name: value }。
 * @returns { colors, typography, shape, other }，每项是 [{ name, value }]。
 */
export function groupTokens(vars) {
	const colors = [];
	const typography = [];
	const shape = [];
	const other = [];
	for (const [name, value] of Object.entries(vars ?? {})) {
		const key = name.slice(2);
		const entry = { name, value };
		const looksColor = /^#|^rgb|^hsl|^oklch|^color\(/iu.test(value);
		if (looksColor) colors.push(entry);
		else if (/^--font/u.test(name) || /family|weight|tracking|leading|text-/u.test(key)) typography.push(entry);
		else if (/radius|spacing|shadow|border-width/u.test(key)) shape.push(entry);
		else other.push(entry);
	}
	return { colors, typography, shape, other };
}

/**
 * 从 preview HTML 里抽出可复用的样式与变体标本。
 *
 * ## 为什么用正则而不是 DOM
 *
 * 宿主侧没有 DOM。而这些 preview 文件是**机器生成、结构高度统一**的
 *（一个 `<style>` + 若干 `<div class="row">`），受限解析完全够用。
 *
 * **但不能假设它一定长这样。** 所以：解析不出变体时**降级**成"整个 body 当作一个标本"，
 * 而不是返回空——用户导入一个略有差异的包，也应该能拿到东西，
 * 只是拿到的粒度粗一些。
 *
 * @param html - preview HTML。
 * @param slug - 组件 slug（用来判断哪个元素是"这个组件"）。
 * @returns { styles, specimens }。specimens 每项 { label, markup }。
 */
export function extractPreview(html, slug) {
	const styles = /<style[^>]*>([\s\S]*?)<\/style>/iu.exec(html)?.[1]?.trim() ?? "";
	const body = /<body[^>]*>([\s\S]*?)<\/body>/iu.exec(html)?.[1]?.trim() ?? html;

	const specimens = [];
	// 逐行块解析：`<div class="row">` 里通常是「一个标签 + 若干同族元素」
	const rowPattern = /<div class="row">([\s\S]*?)<\/div>/gu;
	let row;
	while ((row = rowPattern.exec(body)) !== null) {
		const inner = row[1];
		const label = /<span class="label">([\s\S]*?)<\/span>/iu.exec(inner)?.[1]?.trim() ?? "";
		// 去掉标签本身，剩下的每个顶层元素各算一个标本
		const rest = inner.replace(/<span class="label">[\s\S]*?<\/span>/iu, "");
		const elementPattern = /<([a-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>|<([a-z][\w-]*)\b[^>]*\/?>/giu;
		let element;
		while ((element = elementPattern.exec(rest)) !== null) {
			const markup = element[0].trim();
			if (markup === "") continue;
			specimens.push({ label: label === "" ? slug : label, markup });
		}
	}

	if (specimens.length === 0) {
		// 降级：结构不认识就把整段当标本。宁可粒度粗，也不要让用户导入后空手而归。
		return { styles, specimens: [{ label: slug, markup: body, fallback: true }] };
	}
	return { styles, specimens };
}

/**
 * 把颜色令牌按**用途**分组，并给出人话名字。
 *
 * ## 为什么要语义分组，而不是按名字字母序排
 *
 * 设计令牌的原始名（`--primary-foreground`）是给代码用的。直接列出来，
 * 用户看到的是"一堆代码"，不知道该挑哪个——**这正是工具该替他做的判断**。
 * 按用途分组之后，用户先想"我要背景色还是文字色"，再在那一组里挑。
 *
 * ## 名字给两份
 *
 * `--primary-foreground` 保留（写代码、搜索时要用），同时给人话名（「主色上的文字」）。
 * 只给中文名的话，用户想搜 `foreground` 就搜不到了。
 *
 * @param vars - { name: value }，值应为颜色。
 * @returns [{ id, label, tokens: [{ name, label, value }] }]。
 */
export function groupColorTokens(vars) {
	/** 常见令牌名 → 人话。没收录的退回原名去 `--`。 */
	const HUMAN = {
		background: "页面背景", foreground: "正文文字", card: "卡片背景", "card-foreground": "卡片文字",
		popover: "浮层背景", "popover-foreground": "浮层文字", primary: "主色", "primary-foreground": "主色上的文字",
		secondary: "次要色", "secondary-foreground": "次要色上的文字", muted: "弱化背景", "muted-foreground": "弱化文字",
		accent: "强调色", "accent-foreground": "强调色上的文字", destructive: "危险色", "destructive-foreground": "危险色上的文字",
		border: "边框", input: "输入框描边", ring: "聚焦环",
		sidebar: "侧栏背景", "sidebar-foreground": "侧栏文字", "sidebar-primary": "侧栏主色",
		"sidebar-primary-foreground": "侧栏主色上的文字", "sidebar-accent": "侧栏强调色",
		"sidebar-accent-foreground": "侧栏强调色上的文字", "sidebar-border": "侧栏边框", "sidebar-ring": "侧栏聚焦环"
	};
	/**
	 * 给人话名字。
	 * @param name - 令牌名。
	 * @returns 人话名。
	 */
	const humanize = (name) => {
		const key = name.replace(/^--/u, "");
		if (HUMAN[key] !== undefined) return HUMAN[key];
		const chart = /^chart-(\d+)$/u.exec(key);
		if (chart !== null) return `图表色 ${chart[1]}`;
		return key;
	};

	// 顺序即优先级。**取第一个命中的组，不是所有命中的组**——
	// 否则 `--card-foreground` 会同时进「背景」（含 card）和「文字」（含 -foreground），
	// 用户在两个地方看到同一个令牌，不知道该改哪个。
	const groups = [
		{ id: "text", label: "文字", match: (k) => /-foreground$/u.test(k) || k === "foreground" },
		{ id: "status", label: "状态", match: (k) => /destructive|danger|error|warning|success|info/u.test(k) },
		{ id: "border", label: "边框与分隔", match: (k) => /border/u.test(k) },
		{ id: "bg", label: "背景", match: (k) => /^(background|card|popover|muted|secondary|accent|sidebar|input)$/u.test(k) },
		{ id: "accent", label: "主色与强调", match: (k) => /^(primary|secondary|accent|ring|chart-\d+|sidebar-primary|sidebar-accent)$/u.test(k) }
	];

	const out = groups.map((g) => ({ id: g.id, label: g.label, tokens: [] }));
	const rest = { id: "other", label: "其他", tokens: [] };
	for (const [name, value] of Object.entries(vars ?? {})) {
		const key = name.replace(/^--/u, "");
		const entry = { name, label: humanize(name), value };
		// 注意这里用**下标回写 out**，而不是往 groups 里那个对象上 push：
		// groups 的项只有 { id, label, match }，**没有 tokens 数组**。
		// 早先直接 `hit.tokens.push(...)`，`hit.tokens` 是 undefined，导入直接抛错。
		const index = groups.findIndex((g) => g.match(key));
		if (index >= 0) out[index].tokens.push(entry);
		else rest.tokens.push(entry);
	}
	return [...out, rest].filter((g) => g.tokens.length > 0);
}

/**
 * 解析一个 Google Copy 格式的设计包。
 *
 * @param entries - readZipEntries 的结果（每项 { name, data }）。
 * @param fallbackName - 包里读不到名字时的兜底（一般传 zip 的文件名）。
 * @returns { library, tokens, components, screens, assets, docs } 或 { error }。
 */
export function parseGoogleCopy(entries, fallbackName = "") {
	const files = entries.filter((entry) => entry.directory !== true);
	/** 按后缀找文件。包里可能有一层或多层目录前缀，所以用后缀匹配。 */
	const find = (suffix) => files.find((entry) => entry.name === suffix || entry.name.endsWith(`/${suffix}`));
	const text = (entry) => entry?.data.toString("utf8") ?? "";

	const indexEntry = find("components/index.json");
	const cssEntry = find("colors_and_type.css");
	if (indexEntry === undefined && cssEntry === undefined) {
		return { error: "这不像 Google Copy 设计包：既没有 components/index.json，也没有 colors_and_type.css" };
	}

	let index = {};
	if (indexEntry !== undefined) {
		try {
			index = JSON.parse(text(indexEntry));
		} catch (error) {
			return { error: `components/index.json 不是合法 JSON：${String(error?.message ?? error)}` };
		}
	}

	/*
	 * ## 名字的回退链（用户报的「设计包不能正确识别」）
	 *
	 * 原来是 `index.name ?? index.brandName ?? index.library ?? "未命名设计包"`，
	 * 而**有 7 个库全叫「未命名设计包」** —— 那些包的
	 * components/index.json 里压根没有名字字段。
	 * 结果下拉框里 7 个一模一样的条目，**根本分不清谁是谁**。
	 *
	 * 兜底改成**调用方给的名字**（= zip 文件名去掉 .zip）：
	 * `Vercel-Copy.zip` → `Vercel`。它一定存在，而且是用户自己起的名，
	 * 比一个所有包共用的占位词有辨识度得多。
	 *
	 * ⚠️ 顺带处理 `index.library` 的占位值：它常常就是字符串 `"unknown"`，
	 * 直接采用的话会得到一堆叫 unknown 的库（同一个毛病换个词）。
	 * 所以回退链里过滤掉它。
	 */
	const named = [index.name, index.brandName, index.library, fallbackName]
		.map((value) => (typeof value === "string" ? value.trim() : ""))
		.find((value) => value !== "" && value.toLowerCase() !== "unknown");
	const library = {
		library: named ?? "unknown",
		name: named ?? "未命名设计包",
		brandName: index.brandName ?? "",
		productType: index.productType ?? "",
		kitType: index.kitType ?? "",
		language: index.language ?? "",
		crossComponentPatterns: Array.isArray(index.crossComponentPatterns) ? index.crossComponentPatterns : []
	};

	// ---- 令牌
	const blocks = parseCssVariables(text(cssEntry));
	// 第一个块通常是亮色（`:root`）；暗色块的判断放宽一点，避免因为选择器
	// 写法不同（`.dark` / `[data-theme=dark]` / 媒体查询里的 `:root`）就丢掉暗色。
	const light = blocks[0]?.vars ?? {};
	let dark = {};
	for (const block of blocks.slice(1)) {
		if (/dark|\.dark|prefers-color-scheme/iu.test(block.selector) && Object.keys(block.vars).length > Object.keys(dark).length) {
			dark = block.vars;
		}
	}
	const tokens = {
		light,
		dark,
		// 通用分组（字体/形状用）
		groups: groupTokens(light),
		// **颜色单独按用途分组**：颜色是用户最常挑的一类，
		// 按 --name 字母序排等于让用户读代码。
		colorGroups: groupColorTokens(Object.fromEntries(
			Object.entries(light).filter(([, v]) => /^#|^rgb|^hsl|^oklch|^color\(/iu.test(v))
		))
	};

	// ---- 组件：元数据（index + 单个 json）+ 标记（preview）两处合成
	const components = [];
	for (const summary of Array.isArray(index.components) ? index.components : []) {
		const slug = summary.slug;
		if (typeof slug !== "string" || slug === "") continue;
		let detail = {};
		const detailEntry = find(`components/${slug}.json`);
		if (detailEntry !== undefined) {
			try {
				detail = JSON.parse(text(detailEntry));
			} catch { /* 单个组件坏了不该拖垮整包导入 */ }
		}
		const previewEntry = find(`preview/component-${slug}.html`);
		const preview = previewEntry === undefined
			? { styles: "", specimens: [] }
			: extractPreview(text(previewEntry), slug);

		components.push({
			slug,
			name: detail.name ?? summary.name ?? slug,
			category: detail.category ?? summary.category ?? "",
			keyInsight: detail.keyInsightSeed ?? summary.keyInsight ?? "",
			anatomy: detail.anatomy ?? [],
			variants: detail.variants ?? {},
			structurePatterns: detail.structurePatterns ?? [],
			childComponents: detail.childComponents ?? [],
			structures: detail.structures ?? [],
			/** 组件的 CSS 规则（用 var(--token) 引用令牌）。 */
			styles: preview.styles,
			/** 可插入的变体标本。 */
			specimens: preview.specimens,
			/** 没有 preview 时标记出来——界面上要能看出"这个组件只有描述、没法插入" */
			hasMarkup: preview.specimens.length > 0
		});
	}

	// ---- 界面（整页）
	const screens = [];
	for (const entry of files) {
		const match = /(?:^|\/)(ui_kits|screens|pages)\/(.+)\/index\.html$/u.exec(entry.name);
		if (match === null) continue;
		screens.push({
			slug: match[2].replace(/[^\w-]/gu, "-"),
			name: match[2],
			html: text(entry)
		});
	}

	// ---- 图标等素材
	const assets = files
		.filter((entry) => /(?:^|\/)assets\//u.test(entry.name))
		.map((entry) => ({ name: entry.name.split("/").pop(), path: entry.name, data: entry.data }));

	// ---- 文档
	//
	// 设计包里的 README / SKILL 不是装饰：它们讲的是**这套规范为什么这么定**
	//（"为什么按钮是平的""为什么卡片不投影"）。这些判断依据在别处看不到，
	// 所以必须一起带进库、并在界面上能读到，否则用户只能看到一堆孤立的令牌值。
	const docs = [];
	for (const [file, title] of [["README.md", "说明"], ["SKILL.md", "使用规范"]]) {
		const entry = find(file);
		if (entry === undefined) continue;
		docs.push({ file, title, text: text(entry) });
	}

	return { library, tokens, components, screens, assets, docs };
}

// #endregion

// #region 存储

/** 库文件名。 */
const LIBRARY_FILE = "library.json";

/**
 * 净化库 id，让它能安全地当目录名。
 *
 * ## 为什么必须只有这一处
 *
 * 这是**唯一的**写路径入口。净化逻辑散在各处，就等于每多一处就多一个
 * 能写到库目录之外的机会。所以导入、删除、API 三处都调这一个函数。
 *
 * ## 规则
 *
 * - 只留 `\w`、点、横线（其余一律换成横线）
 * - **折叠连续的点**：`..` 在任何路径运算里都是"上一级"的意思，
 *   留着它即使当前拼出来安全，也迟早被某处路径计算利用
 * - 不能以点或横线开头/结尾：隐藏文件、相对路径、Windows 不接受的结尾
 *
 * @param id - 原始 id。
 * @returns 安全 id（可能为空串，调用方必须判空）。
 */
export function sanitizeLibraryId(id) {
	return String(id ?? "")
		.replace(/[^\w.-]/gu, "-")
		.replace(/\.{2,}/gu, ".")
		.replace(/^[.-]+/u, "")
		.replace(/[.-]+$/u, "")
		.slice(0, 64);
}

/**
 * 载入一个库。
 * @param dir - 库目录。
 * @returns 库对象，或 null。
 */
export function loadLibrary(dir) {
	try {
		return JSON.parse(readFileSync(join(dir, LIBRARY_FILE), "utf8"));
	} catch {
		return null;
	}
}

/**
 * 列出所有库（只读元信息，不载入组件）。
 * @param root - 库根目录。
 * @returns 库数组。
 */
export function listLibraries(root) {
	if (!existsSync(root)) return [];
	const out = [];
	for (const name of readdirSync(root)) {
		const dir = join(root, name);
		const meta = loadLibrary(dir);
		if (meta !== null) out.push(meta);
	}
	return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/**
 * 把解析好的设计包落盘。
 *
 * @param root - 库根目录。
 * @param id - 库 id（目录名）。
 * @param parsed - parseGoogleCopy 的结果。
 * @returns { dir } 或 { error }。
 */
export function saveLibrary(root, id, parsed) {
	if (typeof id !== "string" || id === "") return { error: "库 id 不能为空" };
	// 目录名要能安全用在路径里：用户可能从包名推导 id，里面带斜杠就会写错地方
	const safe = sanitizeLibraryId(id);
	if (safe === "") return { error: `库 id 不合法：${id}` };
	const dir = join(root, safe);
	try {
		mkdirSync(dir, { recursive: true });
		const meta = {
			id: safe,
			...parsed.library,
			importedAt: new Date().toISOString(),
			counts: {
				components: parsed.components.length,
				screens: parsed.screens.length,
				assets: parsed.assets.length,
				tokens: Object.keys(parsed.tokens.light).length
			}
		};
		writeFileSync(join(dir, LIBRARY_FILE), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
		writeFileSync(join(dir, "tokens.json"), `${JSON.stringify(parsed.tokens, null, 2)}\n`, "utf8");
		writeFileSync(join(dir, "components.json"), `${JSON.stringify(parsed.components, null, 2)}\n`, "utf8");
		writeFileSync(join(dir, "docs.json"), `${JSON.stringify(parsed.docs ?? [], null, 2)}\n`, "utf8");
		writeFileSync(join(dir, "screens.json"), `${JSON.stringify(parsed.screens.map((s) => ({ slug: s.slug, name: s.name })), null, 2)}\n`, "utf8");
		// 界面是整页 HTML，单独放，避免和组件挤在一个大 JSON 里
		const screensDir = join(dir, "screens");
		mkdirSync(screensDir, { recursive: true });
		for (const screen of parsed.screens) {
			writeFileSync(join(screensDir, `${screen.slug}.html`), screen.html, "utf8");
		}
		// 素材（图标等）也要落盘。
		//
		// 之前这里只把数量写进 counts 却没写文件——元信息说"40 个素材"，
		// 目录里一个都没有。这类"账实不符"最难发现：界面上显示得好好的，
		// 真去用的时候才发现取不到。
		const assetsDir = join(dir, "assets");
		// 目录必须先建。少了这一句，下面每个 writeFileSync 都抛 ENOENT，
		// 而被 try 吞掉之后只剩下一个 assets: 0 —— 静默失败。
		mkdirSync(assetsDir, { recursive: true });
		let assetCount = 0;
		for (const asset of parsed.assets) {
			// 素材名来自包内路径，可能带子目录；只取文件名并净化，避免越出 assets/
			const safeName = String(asset.name ?? "").replace(/[^\w.-]/gu, "-");
			if (safeName === "") continue;
			try {
				writeFileSync(join(assetsDir, safeName), asset.data);
				assetCount += 1;
			} catch {
				// 单个素材写不进去不该让整个导入失败
			}
		}
		return { dir, meta: { ...meta, counts: { ...meta.counts, assets: assetCount } } };
	} catch (error) {
		return { error: `写入库失败：${String(error?.message ?? error)}` };
	}
}

/**
 * 直接从一个 zip 字节导入。
 *
 * @param root - 库根目录。
 * @param id - 库 id。
 * @param bytes - zip 字节。
 * @returns { dir, meta } 或 { error }。
 */
export function importGoogleCopy(root, id, bytes) {
	const zip = readZipEntries(bytes);
	if (zip.error !== undefined) return { error: zip.error };
	const parsed = parseGoogleCopy(zip.entries, readableLibraryName(id));
	if (parsed.error !== undefined) return parsed;
	return saveLibrary(root, id, parsed);
}

/**
 * 把库 id 变成适合显示的名字。
 *
 * id 来自 zip 文件名，而下载/另存会给重复文件加 `-Copy`、`-Copy-1` 这类后缀 ——
 * 直接用会显示成 `Vercel-Copy-1`，虽然能区分但很难看。
 * 这里把它们剥掉、把分隔符换成空格：
 *
 *   `Vercel-Copy`     → `Vercel`
 *   `TraeWork-Copy-1` → `TraeWork`
 *   `21th-Copy`       → `21th`
 *
 * **只在包里读不到名字时才会用到**（见 `parseGoogleCopy` 的回退链），
 * 所以剥错也不影响本来就有名字的包。
 *
 * @param id - 库 id。
 * @returns 可显示的名字（可能为空串，调用方自己兜底）。
 */
export function readableLibraryName(id) {
	return String(id ?? "")
		// 去掉文件管理器/浏览器下载加的重复副本后缀
		.replace(/-copy(-\d+)?$/iu, "")
		// 连字符和下划线换成空格，连续的分隔符合并
		.replace(/[-_]+/gu, " ")
		.trim();
}

/**
 * 读一个库里某个组件的完整记录。
 * @param root - 库根目录。
 * @param id - 库 id。
 * @param slug - 组件 slug。
 * @returns 组件对象，或 null。
 */
export function getComponent(root, id, slug) {
	try {
		const all = JSON.parse(readFileSync(join(root, id, "components.json"), "utf8"));
		return all.find((item) => item.slug === slug) ?? null;
	} catch {
		return null;
	}
}

/**
 * 删库。
 * @param root - 库根目录。
 * @param id - 库 id。
 * @returns { ok } 或 { error }。
 */
export function removeLibrary(root, id) {
	const safe = sanitizeLibraryId(id);
	// 路径必须确认在库根之内再删——id 来自界面，不该有机会指到别处
	const dir = join(root, safe);
	if (!dir.startsWith(root)) return { error: "拒绝：路径越出库目录" };
	try {
		rmSync(dir, { recursive: true, force: true });
		return { ok: true };
	} catch (error) {
		return { error: `删除失败：${String(error?.message ?? error)}` };
	}
}

// #endregion
