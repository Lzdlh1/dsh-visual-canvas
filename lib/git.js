/**
 * Git 检查点：把「画布改动」与「你的工作区状态」安全地分开。
 *
 * ## 为什么用 git 当撤销栈（借鉴 layrr 的做法）
 *
 * 撤销「一次画布改动」有几种做法：自己存全文快照、写临时文件、或者用 git。
 * 前两种要么占空间、要么和用户自己的编辑混在一起分不开。git 的好处是：
 *
 * - **精确到一次改动**：每次落盘前记一次检查点，撤销就是回到上一个检查点；
 * - **不碰你的干活现场**：检查点只记录「被改的文件」，你自己未提交的改动不受影响；
 * - **可审计**：`git log` 里能看到画布改过什么。
 *
 * ## 实现选择：用 stash 的轻量替代 —— 直接读 blob
 *
 * 我们**不**用 `git stash`（它会动工作区，可能与用户的 stash 冲突）。
 * 改为：落盘前把「将被修改的文件」的原始内容存进插件自己的快照目录
 * （`$DSH_HOME/visual-canvas/snapshots/<会话>/<序号>/`）。
 * 这样撤销**完全不依赖 git 状态**，而 git 只用来做「可选的人工审计」。
 *
 * 也就是说：快照是主撤销机制，git 是附加的可见性。
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 执行一条 git 命令。
 *
 * @param root - 工作目录。
 * @param args - 参数数组。
 * @returns { code, stdout, stderr }。
 */
export function git(root, args) {
	return new Promise((resolvePromise) => {
		execFile("git", args, { cwd: root, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
			resolvePromise({
				code: error?.code ?? (error === null ? 0 : 1),
				stdout: String(stdout ?? ""),
				stderr: String(stderr ?? "")
			});
		});
	});
}

/**
 * 判断目录是不是 git 仓库。
 * @param root - 目录。
 * @returns 是否是仓库。
 */
export async function isGitRepo(root) {
	const result = await git(root, ["rev-parse", "--is-inside-work-tree"]);
	return result.code === 0 && result.stdout.trim() === "true";
}

/**
 * 创建一个快照目录。
 *
 * @param snapshotRoot - 快照根目录。
 * @param label - 目录名（通常用时间戳 + 序号）。
 * @returns 目录绝对路径。
 */
export function createSnapshotDir(snapshotRoot, label) {
	const dir = join(snapshotRoot, label);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * 把一组文件的内容存进快照目录。
 *
 * @param snapshotDir - 快照目录。
 * @param root - 项目根。
 * @param files - 相对路径数组。
 * @returns { saved: string[], missing: string[] }。
 */
export function saveSnapshot(snapshotDir, root, files) {
	const saved = [];
	const missing = [];
	for (const file of files) {
		const absolute = join(root, file);
		if (!existsSync(absolute)) {
			missing.push(file);
			continue;
		}
		// 用一层扁平化命名，避免子目录结构：把 / 换成 __。
		const flat = file.replace(/[/\\]/gu, "__");
		writeFileSync(join(snapshotDir, flat), readFileSync(absolute), "utf8");
		saved.push(file);
	}
	// 附一份索引，撤销时才知道该往哪还原。
	writeFileSync(join(snapshotDir, "_index.json"), JSON.stringify({ files: saved, missing }, null, 2), "utf8");
	return { saved, missing };
}

/**
 * 读取快照里某个文件的原始内容。
 *
 * @param snapshotDir - 快照目录。
 * @param file - 相对路径。
 * @returns 内容或 null。
 */
export function readSnapshot(snapshotDir, file) {
	const flat = String(file).replace(/[/\\]/gu, "__");
	const path = join(snapshotDir, flat);
	if (!existsSync(path)) return null;
	return readFileSync(path, "utf8");
}

/**
 * 读取快照索引。
 * @param snapshotDir - 快照目录。
 * @returns { files, missing } 或 null。
 */
export function readSnapshotIndex(snapshotDir) {
	const path = join(snapshotDir, "_index.json");
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/**
 * 尝试为一次落盘建一个 git 提交（可选，失败不影响主流程）。
 *
 * 只提交被画布改动的文件，**不碰你其他未提交的内容**，
 * 所以提交里不会混进你正在写的代码。
 *
 * @param root - 项目根。
 * @param files - 相对路径数组。
 * @param message - 提交信息。
 * @returns { committed, reason? }。
 */
export async function commitCanvasChange(root, files, message) {
	if (!(await isGitRepo(root))) return { committed: false, reason: "不是 git 仓库，跳过提交" };
	if (files.length === 0) return { committed: false, reason: "没有文件" };

	const add = await git(root, ["add", "--", ...files]);
	if (add.code !== 0) return { committed: false, reason: `git add 失败: ${add.stderr.trim()}` };

	// 用 pathspec 限定提交范围，避免带上用户的其他暂存内容。
	const commit = await git(root, ["commit", "-m", message, "--", ...files]);
	if (commit.code !== 0) {
		const text = `${commit.stdout}\n${commit.stderr}`;
		if (/nothing to commit|no changes added/iu.test(text)) return { committed: false, reason: "没有变化可提交" };
		return { committed: false, reason: `git commit 失败: ${commit.stderr.trim() || commit.stdout.trim()}` };
	}
	const head = await git(root, ["rev-parse", "--short", "HEAD"]);
	return { committed: true, sha: head.stdout.trim() };
}

/**
 * 取某个文件的 git diff（用于「改动前预览」）。
 *
 * @param root - 项目根。
 * @param file - 相对路径。
 * @returns diff 文本（可能为空）。
 */
export async function gitDiff(root, file) {
	if (!(await isGitRepo(root))) return "";
	const result = await git(root, ["diff", "--no-color", "--", file]);
	return result.stdout;
}
