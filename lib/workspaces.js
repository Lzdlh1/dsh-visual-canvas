/**
 * 画布布局文件（`.dsh-canvas/workspaces.json`）的读写与校验。
 *
 * ## 为什么它是 P1 的第一步
 *
 * 这个文件的格式一旦定错，画布 UI、规格沉淀、团队协作全都要返工。
 * 而且它有一个硬要求：**进版本库、多人共用、能干净合并**。所以这里的每个设计
 * 决定都是为「git 友好」服务的，不是随手选的。
 *
 * ## 文件长什么样
 *
 * ```jsonc
 * {
 *   "version": 1,
 *   "workspaces": [
 *     {
 *       "id": "login",
 *       "name": "登录",
 *       "path": "/login",
 *       "device": "desktop",
 *       "rect": { "x": 0, "y": 0, "w": 1440, "h": 900 },
 *       "spec": "登录页要突出第三方登录入口"
 *     }
 *   ]
 * }
 * ```
 *
 * ## 为「可合并」做的五件事
 *
 * 1. **稳定键序**：固定字段顺序（id → name → path → device → rect → spec），
 *    否则同一份内容在不同机器上序列化出不同文本，diff 全是噪声。
 * 2. **不写时间戳/机器信息/绝对路径**：这些每次都变，会让每次保存都产生假改动。
 *    `path` 只存应用内的相对路由（`/login`），不存文件系统路径。
 * 3. **统一换行 LF + 结尾换行**：跨平台不产生整文件 diff。
 * 4. **保留未知字段**：旧版本插件读到新版本写的字段时不得抹掉它们
 *    （否则一个人用旧插件打开一次，就把别人的新数据清空了）。
 * 5. **写入前做冲突检测**：文件在读取后被外部改过就拒绝写入，让用户先决定，
 *    而不是静默覆盖同事的改动。
 *
 * ## 什么**不**放这里
 *
 * 视口状态（上次缩放多少、平移到哪里）是**每个人自己的**，不该进共享文件。
 * 它存在 `$DSH_HOME` 下（见 viewStatePath），这样团队成员的视图互不干扰。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeTextAtomic } from "./ops.js";

/** 布局文件相对项目根的路径。 */
export const WORKSPACES_RELATIVE_PATH = ".dsh-canvas/workspaces.json";

/** 当前 schema 版本。 */
export const WORKSPACES_VERSION = 1;

/**
 * 设备预设。
 *
 * 尺寸用「逻辑像素」，与设计工具一致：画板宽度就是页面渲染宽度，
 * 缩放只影响显示，不影响页面自身的响应式断点。
 */
export const DEVICE_PRESETS = {
	phone: { label: "手机", width: 390, height: 844 },
	"phone-large": { label: "大屏手机", width: 430, height: 932 },
	tablet: { label: "平板", width: 834, height: 1112 },
	desktop: { label: "桌面", width: 1440, height: 900 },
	"desktop-wide": { label: "宽屏桌面", width: 1920, height: 1080 }
};

/** 字段输出顺序（稳定键序）。未列出的未知字段排在最后，且保持原顺序。 */
const KEY_ORDER = ["id", "name", "path", "device", "rect", "spec"];

/** 画板矩形内的字段顺序。 */
const RECT_KEY_ORDER = ["x", "y", "w", "h"];

/** 新建画板时与已有画板的间距。 */
const LAYOUT_GAP = 80;

/**
 * 计算文本哈希（用于冲突检测）。
 * @param text - 文本。
 * @returns 十六进制哈希。
 */
export function hashText(text) {
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/**
 * 布局文件的绝对路径。
 * @param root - 项目根。
 * @returns 绝对路径。
 */
export function workspacesPath(root) {
	return join(root, WORKSPACES_RELATIVE_PATH);
}

/**
 * 视图状态的存放路径（本地、不进版本库）。
 *
 * @param dshHome - $DSH_HOME。
 * @param root - 项目根。
 * @returns 绝对路径。
 */
export function viewStatePath(dshHome, root) {
	// 用项目根的哈希做文件名：不同项目各存一份，且不泄露路径结构。
	const key = createHash("sha256").update(root, "utf8").digest("hex").slice(0, 16);
	return join(dshHome, "visual-canvas", "views", `${key}.json`);
}

/**
 * 生成一个稳定、URL 安全的 id。
 *
 * 为什么不用随机 uuid：id 会出现在文件里，随机 id 让 diff 无法阅读、也无法手写。
 * 用内容派生的短 id，人看得懂，也便于手写配置。
 *
 * @param base - 派生来源（通常是 name 或 path）。
 * @param taken - 已占用的 id 集合。
 * @returns 唯一 id。
 */
export function deriveId(base, taken = new Set()) {
	const slug = String(base ?? "")
		.trim()
		.toLowerCase()
		// 保留中日韩与字母数字，其余折成连字符
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 40);
	let candidate = slug === "" ? "workspace" : slug;
	let index = 2;
	while (taken.has(candidate)) {
		candidate = `${slug === "" ? "workspace" : slug}-${index}`;
		index += 1;
	}
	return candidate;
}

/**
 * 归一化一个画板条目。
 *
 * @param raw - 原始对象。
 * @param index - 它在数组里的位置（用于报错定位）。
 * @param taken - 已占用的 id 集合；会被就地更新。
 * @returns { value } 或 { error }。
 */
export function normalizeWorkspace(raw, index = 0, taken = new Set()) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { error: `第 ${index + 1} 项不是对象` };
	}
	const has = (key) => Object.hasOwn(raw, key);

	// id：缺失或非法就派生一个（宽容，但不静默丢弃整条）。
	let id = typeof raw.id === "string" && raw.id.trim() !== "" ? raw.id.trim() : "";
	if (id === "" || taken.has(id)) id = deriveId(has("name") ? raw.name : raw.path, taken);
	taken.add(id);

	// path：只接受应用内的相对路由。
	const rawPath = typeof raw.path === "string" ? raw.path.trim() : "";
	if (rawPath === "") return { error: `第 ${index + 1} 项（${id}）缺少 path` };
	if (/^[a-z][a-z0-9+.-]*:/iu.test(rawPath) || rawPath.startsWith("//")) {
		return { error: `第 ${index + 1} 项（${id}）的 path 必须是应用内相对路径，收到 ${rawPath}` };
	}
	const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;

	// device：未知值退化为 desktop（不报错——预设会随版本增减）。
	const device = typeof raw.device === "string" && Object.hasOwn(DEVICE_PRESETS, raw.device) ? raw.device : "desktop";
	const preset = DEVICE_PRESETS[device];

	// rect：缺字段就用预设补齐。
	const rectRaw = raw.rect !== null && typeof raw.rect === "object" ? raw.rect : {};
	const numbers = {};
	for (const key of RECT_KEY_ORDER) {
		const value = Number(rectRaw[key]);
		numbers[key] = Number.isFinite(value) ? Math.round(value) : undefined;
	}
	const rect = {
		x: numbers.x ?? 0,
		y: numbers.y ?? 0,
		w: numbers.w ?? preset.width,
		h: numbers.h ?? preset.height
	};
	if (rect.w < 80) rect.w = 80;
	if (rect.h < 80) rect.h = 80;

	const name = typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : path;
	const spec = typeof raw.spec === "string" ? raw.spec : "";

	// 保留未知字段（前向兼容：旧插件不得抹掉新字段）。
	const known = new Set(KEY_ORDER);
	const extras = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!known.has(key)) extras[key] = value;
	}

	return { value: { id, name, path, device, rect, spec, ...extras } };
}

/**
 * 按稳定键序序列化画板。
 *
 * @param workspace - 归一化后的画板。
 * @returns 新对象（键序固定，未知字段在后）。
 */
function orderWorkspace(workspace) {
	const out = {};
	for (const key of KEY_ORDER) {
		if (key === "rect") {
			const rect = {};
			for (const rectKey of RECT_KEY_ORDER) rect[rectKey] = workspace.rect?.[rectKey] ?? 0;
			out.rect = rect;
			continue;
		}
		out[key] = workspace[key];
	}
	for (const [key, value] of Object.entries(workspace)) {
		if (!KEY_ORDER.includes(key)) out[key] = value;
	}
	return out;
}

/**
 * 序列化整份布局（稳定、git 友好）。
 *
 * @param doc - { version, workspaces }。
 * @returns 文本（LF 换行、结尾有换行）。
 */
export function serializeWorkspaces(doc) {
	const payload = {
		version: doc.version ?? WORKSPACES_VERSION,
		workspaces: (doc.workspaces ?? []).map((item) => orderWorkspace(item))
	};
	// 保留顶层的未知字段（同样为了前向兼容）。
	for (const [key, value] of Object.entries(doc)) {
		if (key !== "version" && key !== "workspaces") payload[key] = value;
	}
	return `${JSON.stringify(payload, null, 2).replace(/\r\n/gu, "\n")}\n`;
}

/**
 * 读取布局文件。
 *
 * @param root - 项目根。
 * @returns {
 *   exists, hash, doc: { version, workspaces }, warnings: string[]
 * }。
 */
export function readWorkspaces(root) {
	const absolute = workspacesPath(root);
	if (!existsSync(absolute)) {
		return { exists: false, hash: null, doc: { version: WORKSPACES_VERSION, workspaces: [] }, warnings: [] };
	}
	let text;
	try {
		text = readFileSync(absolute, "utf8");
	} catch (error) {
		return {
			exists: false,
			hash: null,
			doc: { version: WORKSPACES_VERSION, workspaces: [] },
			warnings: [`读取 ${WORKSPACES_RELATIVE_PATH} 失败：${String(error?.message ?? error)}`]
		};
	}

	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return {
			exists: true,
			hash: hashText(text),
			doc: { version: WORKSPACES_VERSION, workspaces: [] },
			warnings: [`${WORKSPACES_RELATIVE_PATH} 不是合法 JSON：${String(error?.message ?? error)}`]
		};
	}

	const warnings = [];
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		warnings.push(`${WORKSPACES_RELATIVE_PATH} 顶层必须是对象`);
		return { exists: true, hash: hashText(text), doc: { version: WORKSPACES_VERSION, workspaces: [] }, warnings };
	}

	const version = Number.isInteger(parsed.version) ? parsed.version : WORKSPACES_VERSION;
	if (version > WORKSPACES_VERSION) {
		warnings.push(`布局文件版本 ${version} 高于本插件支持的 ${WORKSPACES_VERSION}；未知字段会被原样保留，但新特性无法显示`);
	}

	const taken = new Set();
	const workspaces = [];
	const rawList = Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
	for (const [index, item] of rawList.entries()) {
		const result = normalizeWorkspace(item, index, taken);
		if (result.error !== undefined) {
			// 明确报告被跳过的条目，而不是静默丢弃（用户需要知道自己的配置没生效）。
			warnings.push(`已跳过：${result.error}`);
			continue;
		}
		workspaces.push(result.value);
	}

	// 把顶层未知字段带进 doc，写入时原样保留。
	const extras = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (key !== "version" && key !== "workspaces") extras[key] = value;
	}

	return { exists: true, hash: hashText(text), doc: { version, workspaces, ...extras }, warnings };
}

/**
 * 写入布局文件（原子 + 冲突检测 + git 友好序列化）。
 *
 * @param root - 项目根。
 * @param doc - { version, workspaces }。
 * @param options - { expectHash }：读取时拿到的哈希；文件已被外部改动则拒绝写入。
 * @returns { ok, hash, path } 或 { ok: false, error }。
 */
export function writeWorkspaces(root, doc, options = {}) {
	const absolute = workspacesPath(root);

	if (typeof options.expectHash === "string" && existsSync(absolute)) {
		const current = hashText(readFileSync(absolute, "utf8"));
		if (current !== options.expectHash) {
			// 与写回源码同一套哲学：宁可拒绝，也不静默覆盖别人的改动。
			return {
				ok: false,
				error: `${WORKSPACES_RELATIVE_PATH} 在本次编辑期间被外部修改过（可能是同事的改动或 git 切换）。请刷新画布后重试，以免覆盖。`
			};
		}
	}

	const text = serializeWorkspaces(doc);
	try {
		mkdirSync(dirname(absolute), { recursive: true });
		writeTextAtomic(absolute, text);
	} catch (error) {
		return { ok: false, error: `写入 ${WORKSPACES_RELATIVE_PATH} 失败：${String(error?.message ?? error)}` };
	}
	return { ok: true, hash: hashText(text), path: WORKSPACES_RELATIVE_PATH };
}

/**
 * 为新画板找一个不重叠的位置（放在已有画板右侧）。
 *
 * @param workspaces - 现有画板数组。
 * @param width - 新画板宽度。
 * @returns { x, y }。
 */
export function nextSlot(workspaces, width) {
	if (workspaces.length === 0) return { x: 0, y: 0 };
	let right = Number.NEGATIVE_INFINITY;
	let top = Number.POSITIVE_INFINITY;
	for (const item of workspaces) {
		right = Math.max(right, item.rect.x + item.rect.w);
		top = Math.min(top, item.rect.y);
	}
	// 注意别用 `top = Math.min(top, y)` 且初值取 0：那样永远回不到已有画板的实际顶部，
	// 新画板会跟自己「对齐」到 0 而不是跟别人对齐（踩过一次）。
	if (!Number.isFinite(top)) top = 0;
	return { x: right + LAYOUT_GAP, y: top };
}

/**
 * 新建一个画板。
 *
 * @param doc - 当前布局。
 * @param input - { name, path, device, spec, width, height }。
 * @returns { ok, value, doc } 或 { ok: false, error }。
 */
export function addWorkspace(doc, input) {
	const rawPath = typeof input?.path === "string" ? input.path.trim() : "";
	if (rawPath === "") return { ok: false, error: "必须提供画板路径（应用内路由，如 /login）" };
	if (/^[a-z][a-z0-9+.-]*:/iu.test(rawPath) || rawPath.startsWith("//")) {
		return { ok: false, error: `path 必须是应用内相对路径，收到 ${rawPath}` };
	}
	const device = typeof input.device === "string" && Object.hasOwn(DEVICE_PRESETS, input.device) ? input.device : "desktop";
	const preset = DEVICE_PRESETS[device];
	const width = Number.isFinite(Number(input.width)) ? Math.round(Number(input.width)) : preset.width;
	const height = Number.isFinite(Number(input.height)) ? Math.round(Number(input.height)) : preset.height;

	const taken = new Set((doc.workspaces ?? []).map((item) => item.id));
	const id = typeof input.id === "string" && input.id.trim() !== "" && !taken.has(input.id.trim())
		? input.id.trim()
		: deriveId(input.name ?? rawPath, taken);
	const slot = nextSlot(doc.workspaces ?? [], width);
	const entry = normalizeWorkspace({
		id,
		name: typeof input.name === "string" && input.name.trim() !== "" ? input.name.trim() : rawPath,
		path: rawPath,
		device,
		rect: { x: slot.x, y: slot.y, w: width, h: height },
		spec: typeof input.spec === "string" ? input.spec : "",
		...Object.fromEntries(Object.entries(input).filter(([key]) => !["id", "name", "path", "device", "rect", "spec", "width", "height"].includes(key)))
	}, (doc.workspaces ?? []).length, taken);
	if (entry.error !== undefined) return { ok: false, error: entry.error };

	return {
		ok: true,
		value: entry.value,
		doc: { ...doc, workspaces: [...(doc.workspaces ?? []), entry.value] }
	};
}

/**
 * 更新一个画板。
 *
 * @param doc - 当前布局。
 * @param id - 画板 id。
 * @param patch - 要合并的字段。
 * @returns { ok, value, doc } 或 { ok: false, error }。
 */
export function updateWorkspace(doc, id, patch) {
	const list = doc.workspaces ?? [];
	const index = list.findIndex((item) => item.id === id);
	if (index < 0) return { ok: false, error: `找不到画板 ${id}` };

	const current = list[index];
	const merged = {
		...current,
		...patch,
		// rect 是部分更新：只覆盖给了的键。
		rect: patch?.rect === undefined ? current.rect : { ...current.rect, ...patch.rect },
		// id 不可改（它是规格与笔记的锚点）。
		id: current.id
	};
	const taken = new Set(list.map((item) => item.id));
	taken.delete(current.id);
	const result = normalizeWorkspace(merged, index, taken);
	if (result.error !== undefined) return { ok: false, error: result.error };

	const next = [...list];
	next[index] = result.value;
	// 未知字段可能被 patch 覆盖，这里把它们并回来。
	for (const [key, value] of Object.entries(patch ?? {})) {
		if (!KEY_ORDER.includes(key)) next[index][key] = value;
	}
	return { ok: true, value: next[index], doc: { ...doc, workspaces: next } };
}

/**
 * 删除一个画板。
 *
 * @param doc - 当前布局。
 * @param id - 画板 id。
 * @returns { ok, removed, doc } 或 { ok: false, error }。
 */
export function removeWorkspace(doc, id) {
	const list = doc.workspaces ?? [];
	const index = list.findIndex((item) => item.id === id);
	if (index < 0) return { ok: false, error: `找不到画板 ${id}` };
	return {
		ok: true,
		removed: list[index],
		doc: { ...doc, workspaces: list.filter((_, at) => at !== index) }
	};
}

/**
 * 画板在代理里的访问地址。
 *
 * 用独立的一段前缀 `__frame__`，与覆盖层文件（`__canvas__`）分开，
 * 这样代理可以一眼区分「这是画布要嵌的页面」与「这是插件自己的资源」。
 *
 * @param prefix - 代理前缀（如 "/canvas"）。
 * @param path - 应用内路由（如 "/login"）。
 * @returns 路径（如 "/canvas/__frame__/login"）。
 */
export function frameUrl(prefix, path) {
	const clean = String(path ?? "/");
	const suffix = clean.startsWith("/") ? clean : `/${clean}`;
	return `${prefix}/__frame__${suffix === "/" ? "/" : suffix}`;
}

/**
 * 从 `__frame__` 请求路径反解出上游路径。
 *
 * @param pathname - 请求路径。
 * @param prefix - 代理前缀。
 * @returns 上游路径，或 null（不是 frame 请求）。
 */
export function frameUpstreamPath(pathname, prefix) {
	const base = `${prefix}/__frame__`;
	if (pathname !== base && !pathname.startsWith(`${base}/`)) return null;
	const rest = pathname.slice(base.length);
	return rest === "" ? "/" : rest;
}

/**
 * 读取本机视图状态（缩放/平移）。缺失或损坏都返回 null，由调用方用默认值。
 *
 * @param path - 视图状态文件路径。
 * @returns { zoom, x, y } 或 null。
 */
export function readViewState(path) {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		const zoom = Number(parsed?.zoom);
		const x = Number(parsed?.x);
		const y = Number(parsed?.y);
		if (!Number.isFinite(zoom) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
		// 缩放限制在与画布一致的范围内，避免坏数据把界面搞成不可用。
		return { zoom: Math.min(4, Math.max(0.02, zoom)), x, y };
	} catch {
		return null;
	}
}

/**
 * 写入本机视图状态。失败不抛错（视图状态丢了无所谓）。
 *
 * @param path - 路径。
 * @param view - { zoom, x, y }。
 */
export function writeViewState(path, view) {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeTextAtomic(path, `${JSON.stringify({ zoom: view.zoom, x: view.x, y: view.y })}\n`);
	} catch {
		// 视图状态是可有可无的，写不进去就算了。
	}
}

/**
 * 清理布局文件（仅用于测试与「重置画布」）。
 * @param root - 项目根。
 */
export function removeWorkspacesFile(root) {
	const absolute = workspacesPath(root);
	try {
		rmSync(absolute, { force: true });
	} catch {
		// 忽略
	}
}
