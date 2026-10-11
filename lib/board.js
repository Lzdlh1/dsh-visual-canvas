/**
 * 画板会话：画布外壳与布局文件之间的那一层。
 *
 * ## 为什么逻辑放在 Node 侧而不是浏览器里
 *
 * 三个理由，每个都来自实际的坑：
 *
 * 1. **可测**：外壳里的逻辑只能靠真浏览器点，而这里的每个分支都能用 harness 断言。
 * 2. **冲突检测必须在写文件的那一侧**：文件在读取后被同事改过就要拒绝写入，
 *    这个判断只有拿着哈希的一方能做。
 * 3. **未来 Agent 要能用同一套操作**：`canvas_board` 工具会调这里，
 *    与人在画布上拖拽走同一条路径——就像样式写回那样。
 *
 * ## 状态
 *
 * 持有当前布局与它的哈希。写之前比对哈希：不一致就拒绝，让用户先刷新。
 * 这与写回源码的哲学一致：**宁可拒绝，也不静默覆盖别人的改动**。
 */

import { existsSync } from "node:fs";

import {
	DEVICE_PRESETS,
	addWorkspace,
	frameUrl,
	readViewState,
	readWorkspaces,
	removeWorkspace,
	updateWorkspace,
	viewStatePath,
	writeViewState,
	writeWorkspaces,
	WORKSPACES_RELATIVE_PATH
} from "./workspaces.js";

/**
 * 画板会话。
 */
export class BoardSession {
	/**
	 * @param options - { root, dshHome, prefix, logger }。
	 */
	constructor(options) {
		this.root = options.root;
		this.dshHome = options.dshHome;
		this.prefix = options.prefix;
		this.logger = options.logger;
		/** 当前布局与它的哈希（哈希用于写入前的冲突检测）。 */
		this.doc = { version: 1, workspaces: [] };
		this.hash = null;
		this.warnings = [];
		/** 本机视图状态（缩放/平移），不进版本库。 */
		this.view = { zoom: 1, x: 40, y: 40 };
		/**
		 * 当前激活的画板 id。
		 *
		 * **刻意不持久化**：「我刚才在看哪块画板」是会话内的临时状态，
		 * 写进共享布局文件只会给团队制造无意义的 diff。
		 * 但它要留在内存里，因为 Agent 与指令上下文都需要知道「现在指的是哪块」。
		 */
		this.activeId = null;
		this.reload();
	}

	/**
	 * 从磁盘重新读取布局与本机视图状态。
	 * @returns { warnings }。
	 */
	reload() {
		const read = readWorkspaces(this.root);
		this.doc = read.doc;
		this.hash = read.hash;
		this.warnings = read.warnings;

		const savedView = readViewState(viewStatePath(this.dshHome, this.root));
		if (savedView !== null) this.view = savedView;

		if (read.warnings.length > 0) {
			for (const line of read.warnings) this.logger?.warn?.(`[visual-canvas] 布局文件：${line}`);
		}
		return { warnings: this.warnings };
	}

	/**
	 * 给外壳用的完整快照。
	 *
	 * 带上 `frameUrl` 是刻意的：URL 的拼法只在一个地方定义（workspaces.js），
	 * 外壳不自己拼字符串——否则改路由方案时两边会不一致。
	 *
	 * @returns 快照对象。
	 */
	snapshot() {
		return {
			file: WORKSPACES_RELATIVE_PATH,
			exists: existsSync(`${this.root}/${WORKSPACES_RELATIVE_PATH}`) || this.doc.workspaces.length > 0,
			version: this.doc.version,
			prefix: this.prefix,
			devices: DEVICE_PRESETS,
			view: this.view,
			activeId: this.activeId,
			warnings: this.warnings,
			workspaces: (this.doc.workspaces ?? []).map((item) => ({
				...item,
				frameUrl: frameUrl(this.prefix, item.path)
			}))
		};
	}

	/**
	 * 执行一个操作。
	 *
	 * @param action - {
	 *   type: "add" | "update" | "remove" | "view" | "reload",
	 *   ...操作参数
	 * }。
	 * @returns { ok, board?, warnings?, error?, value? }。
	 */
	apply(action) {
		const type = String(action?.type ?? "");
		if (type === "reload") {
			this.reload();
			return { ok: true, board: this.snapshot(), warnings: this.warnings };
		}
		if (type === "view") {
			// 视图状态是本机的，不需要冲突检测，也不写进项目文件。
			const zoom = Number(action.zoom);
			const x = Number(action.x);
			const y = Number(action.y);
			if (Number.isFinite(zoom)) this.view = { ...this.view, zoom: Math.min(4, Math.max(0.02, zoom)) };
			if (Number.isFinite(x)) this.view = { ...this.view, x };
			if (Number.isFinite(y)) this.view = { ...this.view, y };
			writeViewState(viewStatePath(this.dshHome, this.root), this.view);
			return { ok: true, view: this.view };
		}
		if (type === "select") {
			// 选中哪块画板：只在内存里记，不落盘（见 activeId 的说明）。
			const id = typeof action.id === "string" && action.id !== "" ? action.id : null;
			this.activeId = this.doc.workspaces?.some((item) => item.id === id) === true ? id : null;
			return { ok: true, activeId: this.activeId };
		}

		// 改布局的操作：写之前先比对哈希，避免覆盖别人的改动。
		let result;
		if (type === "add") result = addWorkspace(this.doc, action);
		else if (type === "update") result = updateWorkspace(this.doc, action.id, action.patch ?? {});
		else if (type === "remove") result = removeWorkspace(this.doc, action.id);
		else return { ok: false, error: `未知操作：${type || "(空)"}` };

		if (result.ok !== true) return { ok: false, error: result.error };

		const written = writeWorkspaces(this.root, result.doc, { expectHash: this.hash ?? undefined });
		if (written.ok !== true) {
			// 冲突或写失败：**不改内存里的 doc**，否则界面会显示一个磁盘上不存在的状态。
			return { ok: false, error: written.error, conflict: true };
		}

		this.doc = result.doc;
		this.hash = written.hash;
		this.warnings = [];
		const board = this.snapshot();
		// 返回的 value 要与 board.workspaces 里的条目形状一致（含 frameUrl），
		// 否则调用方拿到一个「缺字段」的对象，还得自己去列表里再找一遍。
		const changed = result.value ?? result.removed;
		const decorated = changed === undefined
			? undefined
			: board.workspaces.find((item) => item.id === changed.id) ?? changed;
		return { ok: true, board, value: decorated };
	}
}
