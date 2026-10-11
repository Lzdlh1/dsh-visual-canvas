/**
 * 设计库的 API：把 `library.js` 的纯能力包成一组可按名字调用的动作。
 *
 * ## 为什么和 HTTP 分开
 *
 * `library.js` 管"怎么解析、怎么落盘"，这一层管"允许外部做哪些事、参数怎么校验"，
 * HTTP 那层只管收发。分开之后这一层可以直接在测试里调用——
 * 端口、请求对象、响应对象都不需要造。
 *
 * ## 动作表是白名单
 *
 * 外部只能按 `action` 名字调用这里列出的动作，**不能传路径**。
 * 库目录由 `root` 决定，库 id 会被净化，所以界面那边没有任何机会把文件写到别处。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importGoogleCopy, listLibraries, removeLibrary, sanitizeLibraryId } from "./library.js";

/** 上传的 zip 大小上限（解码后）。45KB 的设计包很常见，留足余量但不放任。 */
const MAX_ZIP_BYTES = 24 * 1024 * 1024;

/**
 * 净化图标文件名。
 *
 * 名字来自界面，而它会被拼进路径——不净化就等于把「读任意文件」的能力交出去。
 * 允许中文（设计师会用中文命名图标），但不允许任何路径成分。
 *
 * @param name - 图标名。
 * @returns 安全文件名（不含扩展名）。
 */
export function sanitizeAssetName(name) {
	return String(name ?? "")
		.replace(/\.svg$/iu, "")
		.replace(/[^\p{L}\p{N}._-]+/gu, "-")
		.replace(/\.{2,}/gu, ".")
		.replace(/^[.-]+/u, "")
		.replace(/[.-]+$/u, "")
		.slice(0, 64);
}

/**
 * 创建一个库 API。
 *
 * @param options - { root, logger }。root 是库根目录（绝对路径）。
 * @returns { dispatch }。
 */
export function createLibraryApi(options) {
	const root = options.root;
	const logger = options.logger;

	/**
	 * 读一个库里的某个 JSON 文件。
	 * @param id - 库 id。
	 * @param file - 文件名。
	 * @returns 解析结果，读不到返回 null。
	 */
	const readJson = (id, file) => {
		try {
			return JSON.parse(readFileSync(join(root, sanitizeLibraryId(id), file), "utf8"));
		} catch {
			return null;
		}
	};

	/**
	 * 净化库 id。
	 *
	 * 这里是**唯一的**写路径入口，所以净化放在这里而不是散在各处——
	 * 少一处就等于多一个能写到库目录之外的机会。
	 * @param id - 原始 id。
	 * @returns 安全 id。
	 */
	function sanitizeLibraryId(id) {
		return String(id ?? "").replace(/[^\w.-]/gu, "-");
	}

	/**
	 * 执行一个动作。
	 *
	 * @param action - 动作名。
	 * @param payload - 参数。
	 * @returns 结果对象（失败时 { ok: false, error }）。
	 */
	async function dispatch(action, payload = {}) {
		switch (action) {
			case "libraries": {
				return { ok: true, libraries: listLibraries(root) };
			}

			case "components": {
				const all = readJson(payload.library, "components.json");
				if (all === null) return { ok: false, error: `库里没有组件数据：${payload.library}` };
				// 列表不需要把每个组件的 CSS 和标本全带上——那会让响应大出一个量级，
				// 而界面在真正插入之前用不到它们。
				return {
					ok: true,
					components: all.map((item) => ({
						slug: item.slug,
						name: item.name,
						category: item.category,
						keyInsight: item.keyInsight,
						hasMarkup: item.hasMarkup,
						specimenCount: item.specimens?.length ?? 0,
						scope: item.scope ?? "library"
					}))
				};
			}

			case "component": {
				const all = readJson(payload.library, "components.json");
				if (all === null) return { ok: false, error: `库里没有组件数据：${payload.library}` };
				const found = all.find((item) => item.slug === payload.slug);
				if (found === undefined) return { ok: false, error: `找不到组件：${payload.slug}` };
				return { ok: true, component: found };
			}

			case "tokens": {
				const tokens = readJson(payload.library, "tokens.json");
				if (tokens === null) return { ok: false, error: `库里没有令牌数据：${payload.library}` };
				return { ok: true, tokens };
			}

			case "screen": {
				try {
					const html = readFileSync(join(root, sanitizeLibraryId(payload.library), "screens", `${sanitizeLibraryId(payload.slug)}.html`), "utf8");
					return { ok: true, html };
				} catch {
					return { ok: false, error: `找不到界面：${payload.slug}` };
				}
			}

			case "screens": {
				const list = readJson(payload.library, "screens.json");
				return { ok: true, screens: list ?? [] };
			}

			case "docs": {
				return { ok: true, docs: readJson(payload.library, "docs.json") ?? [] };
			}

			// ---- 图标
			//
			// 列表和内容分两个动作：一个库常有几十个图标，列表只给名字（界面画网格用），
			// 真正取 SVG 内容时才逐个请求。合成一个动作会让首次打开面板就要传几百 KB。
			case "assets": {
				try {
					const names = readdirSync(join(root, sanitizeLibraryId(payload.library), "assets"))
						.filter((name) => /\.svg$/iu.test(name))
						.sort();
					return { ok: true, assets: names.map((name) => ({ name: name.replace(/\.svg$/iu, ""), file: name })) };
				} catch {
					return { ok: true, assets: [] };
				}
			}

			case "asset": {
				// 文件名来自界面，必须净化后再拼——不净化就是"读任意文件"
				const file = `${sanitizeAssetName(payload.name)}.svg`;
				try {
					return { ok: true, svg: readFileSync(join(root, sanitizeLibraryId(payload.library), "assets", file), "utf8") };
				} catch {
					return { ok: false, error: `找不到图标：${payload.name}` };
				}
			}

			case "import": {
				const id = sanitizeLibraryId(payload.id ?? "");
				if (id === "") return { ok: false, error: "库 id 不能为空" };
				let bytes;
				if (typeof payload.zipBase64 === "string" && payload.zipBase64 !== "") {
					bytes = Buffer.from(payload.zipBase64, "base64");
					if (bytes.length === 0) return { ok: false, error: "上传的内容是空的" };
					if (bytes.length > MAX_ZIP_BYTES) {
						return { ok: false, error: `包太大了（${Math.round(bytes.length / 1024 / 1024)}MB，上限 ${MAX_ZIP_BYTES / 1024 / 1024}MB）` };
					}
				} else if (typeof payload.zipPath === "string" && payload.zipPath !== "") {
					if (!existsSync(payload.zipPath)) return { ok: false, error: `找不到文件：${payload.zipPath}` };
					bytes = readFileSync(payload.zipPath);
				} else {
					return { ok: false, error: "要导入得给 zipBase64（上传）或 zipPath（本机路径）" };
				}
				try {
					mkdirSync(root, { recursive: true });
				} catch { /* 已存在 */ }
				const result = importGoogleCopy(root, id, bytes);
				if (result.error !== undefined) return { ok: false, error: result.error };
				logger?.info?.(`[visual-canvas] 导入设计库 ${id}（组件 ${result.meta.counts.components}）`);
				return { ok: true, library: result.meta };
			}

			case "remove": {
				const id = sanitizeLibraryId(payload.id ?? "");
				if (id === "") return { ok: false, error: "库 id 不能为空" };
				return removeLibrary(root, id);
			}

			case "save-component": {
				const id = sanitizeLibraryId(payload.library ?? "");
				if (id === "") return { ok: false, error: "要指定存进哪个库" };
				const name = String(payload.name ?? "").trim();
				if (name === "") return { ok: false, error: "组件名不能为空" };
				const markup = String(payload.markup ?? "").trim();
				if (markup === "") return { ok: false, error: "没有可保存的标记（先在画布上选中一个元素）" };

				const dir = join(root, id);
				if (!existsSync(dir)) return { ok: false, error: `库不存在：${id}` };
				const file = join(dir, "components.json");
				let all;
				try {
					all = JSON.parse(readFileSync(file, "utf8"));
				} catch {
					all = [];
				}
				if (!Array.isArray(all)) all = [];

				// slug 从名字推导。重名就加后缀而不是覆盖——覆盖会**悄悄毁掉**用户之前存的组件。
				//
				// 用 `\p{L}` 而不是 `\w`：JS 的 `\w` 只匹配 ASCII，中文名会被整段抹掉，
				// 于是「我的卡片」「登录按钮」全都退化成同一个通用 slug，再排成一列
				// component / component-2 / component-3 —— 完全看不出谁是谁。
				const base = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 48) || "component";
				let slug = base;
				let n = 2;
				while (all.some((item) => item.slug === slug)) {
					slug = `${base}-${n}`;
					n += 1;
				}

				const record = {
					slug,
					name,
					category: String(payload.category ?? "custom"),
					keyInsight: String(payload.keyInsight ?? ""),
					anatomy: [],
					variants: {},
					structurePatterns: [],
					childComponents: [],
					structures: [],
					styles: String(payload.styles ?? ""),
					specimens: [{ label: name, markup }],
					hasMarkup: true,
					// 标出来源：从画布存的和从设计包导入的，在界面上要能区分
					scope: "saved",
					savedAt: new Date().toISOString()
				};
				all.push(record);
				try {
					writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, "utf8");
				} catch (error) {
					return { ok: false, error: `写入失败：${String(error?.message ?? error)}` };
				}
				return { ok: true, component: { slug: record.slug, name: record.name, hasMarkup: true, scope: "saved" } };
			}

			default:
				return { ok: false, error: `不认识的库动作：${action}` };
		}
	}

	return { dispatch };
}
