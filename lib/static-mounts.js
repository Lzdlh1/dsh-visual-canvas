/**
 * 静态挂载：把本地目录直接挂到画布端口下，不必另起一个 dev server。
 *
 * ## 为什么需要
 *
 * 画板默认走代理转发到 `target`（你的 dev server）。但有些页面根本没有 dev server：
 * 插件自带的设计原型、纯静态的演示页、导出后的构建产物……为了看它们而专门起一个
 * 进程，既多一个要维护的东西，也意味着「DSH 一重启就得记得把它拉起来」。
 *
 * 挂载之后这些页面由**画布自己**（同一个端口、同一个进程）提供——
 * 打开画布就能看到，没有额外的生命周期要管。
 *
 * ## 安全边界
 *
 * 这个功能等于「把本地目录暴露到 HTTP 上」，所以两道硬约束：
 *
 * 1. **只读**：只应答 GET / HEAD，别的一律 403。挂载不提供任何写入能力。
 * 2. **不可越出挂载目录**：路径先解码再规范化，解析结果必须仍在挂载根之内，
 *    否则 `../` 就能读到整个磁盘。这一条是硬性的，不做「尽力而为」。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

/** 扩展名 → content-type。只列画布场景真会用到的，不追求齐全。 */
const TYPES = new Map([
	[".html", "text/html; charset=utf-8"],
	[".htm", "text/html; charset=utf-8"],
	[".css", "text/css; charset=utf-8"],
	[".js", "application/javascript; charset=utf-8"],
	[".mjs", "application/javascript; charset=utf-8"],
	[".json", "application/json; charset=utf-8"],
	[".svg", "image/svg+xml"],
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".gif", "image/gif"],
	[".webp", "image/webp"],
	[".ico", "image/x-icon"],
	[".woff", "font/woff"],
	[".woff2", "font/woff2"],
	[".txt", "text/plain; charset=utf-8"],
	[".map", "application/json; charset=utf-8"]
]);

/**
 * 规范化挂载配置。
 *
 * 两种写法：
 * - `{ path: "/ui", dir: "demo" }`  → 挂一个**目录**（`/ui/anything` 都能取）
 * - `{ path: "/plugin-ui", file: "lib/canvas/ui/prototype.html" }` → 挂**单个文件**
 *
 * 单文件形式是为自包含页面准备的：原型就是一个不依赖任何外部资源的 HTML，
 * 为它挂一整个目录既没必要，也得让 `/plugin-ui` 恰好叫 `index.html` 才行。
 *
 * `dir` / `file` 是相对路径时按项目根解析；绝对路径原样用。
 * 坏条目直接丢掉而不是抛错——一条配错不该让整个插件起不来。
 *
 * @param raw - 配置里的值。
 * @param root - 项目根（用于解析相对路径）。
 * @returns 规范化后的挂载数组：[{ path, dir }] 或 [{ path, file }]。
 */
export function normalizeMounts(raw, root) {
	if (!Array.isArray(raw)) return [];
	const base = root === "" ? process.cwd() : root;
	const out = [];
	for (const item of raw) {
		if (item === null || typeof item !== "object") continue;
		const path = typeof item.path === "string" ? item.path.trim() : "";
		const dir = typeof item.dir === "string" ? item.dir.trim() : "";
		const file = typeof item.file === "string" ? item.file.trim() : "";
		if (path === "" || (dir === "" && file === "")) continue;
		// 挂载点必须是绝对路径，否则会和 __canvas__ 之类的内部路由撞上
		if (!path.startsWith("/") || path.startsWith("/__")) continue;
		const mountPath = path.length > 1 ? path.replace(/\/+$/u, "") : path;
		// file 优先：同时给了两个时按更具体的那个来，避免行为含糊
		out.push(file !== "" ? { path: mountPath, file: resolve(base, file) } : { path: mountPath, dir: resolve(base, dir) });
	}
	// 长路径优先：`/ui/proto` 应该赢过 `/ui`，否则更具体的挂载永远匹配不到
	return out.sort((a, b) => b.path.length - a.path.length);
}

/**
 * 判断请求路径命中了哪个挂载，并算出要读的文件。
 *
 * @param mounts - normalizeMounts 的结果。
 * @param pathname - 请求路径（不含查询串）。
 * @returns { mount, file } 或 null。file 为 null 表示命中但被拒绝。
 */
export function matchMount(mounts, pathname) {
	for (const mount of mounts) {
		if (pathname !== mount.path && !pathname.startsWith(`${mount.path}/`)) continue;
		// 单文件挂载：只有挂载点本身可访问，子路径一律拒绝
		// （没有目录可以逃逸，但也不该让 `/plugin-ui/anything` 表现成"存在"）
		if (mount.file !== undefined) {
			const extra = pathname.slice(mount.path.length);
			if (extra !== "" && extra !== "/") return { mount, file: null, reason: "单文件挂载不接受子路径" };
			return { mount, file: mount.file };
		}
		let rest = pathname.slice(mount.path.length);
		if (rest === "" || rest === "/") rest = "/index.html";
		// 先解码再规范化：`%2e%2e%2f` 这种绕过必须在解码**之后**判断
		let decoded;
		try {
			decoded = decodeURIComponent(rest);
		} catch {
			return { mount, file: null, reason: "路径编码非法" };
		}
		if (decoded.includes("\0")) return { mount, file: null, reason: "路径含空字节" };
		const file = normalize(join(mount.dir, decoded));
		// **硬边界**：解析结果必须仍在挂载根之内。没有这一条，`../` 就能读整个磁盘。
		if (file !== mount.dir && !file.startsWith(`${mount.dir}${sep}`)) {
			return { mount, file: null, reason: "路径越出挂载目录" };
		}
		return { mount, file };
	}
	return null;
}

/**
 * 读一个挂载文件。
 *
 * 目录请求按 `index.html` 处理；命中目录但没有 index 时返回目录清单，
 * 便于排查「挂上了但打开是 404」这类问题。
 *
 * @param file - 绝对路径。
 * @returns { status, type, body } 或 { status, error }。
 */
export function readMountFile(file) {
	if (!existsSync(file)) return { status: 404, error: "文件不存在" };
	let stat;
	try {
		stat = statSync(file);
	} catch (error) {
		return { status: 500, error: `无法读取：${String(error?.message ?? error)}` };
	}
	if (stat.isDirectory()) {
		const index = join(file, "index.html");
		if (existsSync(index)) return readMountFile(index);
		return { status: 403, error: "这是一个目录，且没有 index.html" };
	}
	try {
		const body = readFileSync(file);
		return { status: 200, type: TYPES.get(extname(file).toLowerCase()) ?? "application/octet-stream", body };
	} catch (error) {
		return { status: 500, error: `读取失败：${String(error?.message ?? error)}` };
	}
}

/**
 * 判断一个请求路径是否命中任何挂载（外壳用它决定画板该走本地还是走代理）。
 *
 * @param mounts - 挂载数组。
 * @param pathname - 请求路径。
 * @returns 是否命中。
 */
export function hasMount(mounts, pathname) {
	return matchMount(mounts, pathname) !== null;
}
