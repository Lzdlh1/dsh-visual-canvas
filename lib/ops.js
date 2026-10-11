/**
 * 操作层：画布上的一次改动，从「意图」到「落盘 / 预览 / 撤销」的完整管道。
 *
 * ## 一次改动的生命周期
 *
 * ```
 * 覆盖层发来 op（选中元素 + 声明 + 线索）
 *        ↓ ① 定位：线索 → 源文件:行:标签
 *        ↓ ② 写回：生成补丁（只改属性值那一段）
 *        ↓ ③ 校验：配平 / 行数 / 体积，不过就整体拒绝
 *        ↓ ④ 冲突检测：磁盘内容是否还是我们读到的那个版本
 *        ↓ ⑤ 快照：把「将被改的文件」原文存起来（撤销用）
 *        ↓ ⑥ 落盘（原子写）或存入待确认队列
 * ```
 *
 * ## 为什么快照是主撤销机制、git 只是附加
 *
 * 用 git 当撤销栈会和用户自己的未提交改动纠缠不清。这里改成：
 * **每次落盘前把被改文件的原文存进插件自己的快照目录**，撤销就是按快照还原。
 * git 提交只作为可选的人工审计痕迹（见 git.js 的说明）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { applyInlineStyle, detectProject, findOpeningTag } from "./styles.js";
import { findAttribute, upsertAttribute } from "./attributes.js";
import { findElementRange, insertElement, removeElement, sliceElement } from "./markup.js";
import { autoPickCandidate, resolveSource } from "./mapping.js";
import { commitCanvasChange, createSnapshotDir, readSnapshot, saveSnapshot } from "./git.js";
import { isInside } from "./util.js";

/**
 * `attrs` 操作**允许写的属性名**（白名单）。
 *
 * 三类：
 * - `data-*` —— 我们自己的语义标记（作用 / 交互方式 / 效果 / 关联）
 * - `role` / `aria-*` —— **无障碍正式接口**。用户的应用和读屏软件都认这些，
 *   不需要读我们的文档；而且它们不会随用户换框架而过时
 * - `tabindex` —— 让元素能被键盘聚焦。`role="button"` 必须配 `tabindex="0"`
 *   才真的是个能用的按钮，否则键盘用户 Tab 不到它
 *
 * **为什么坚持白名单而不是"随便写"**：这是往用户源码里插的属性，
 * 放开等于把 `onclick` / `style` / `href` / `src` 也放进来 ——
 * 那既能让工具改坏页面，也让"这个工具会往我源码里写什么"变得无法预期。
 */
const ATTR_NAME_OK = /^(?:data-[a-z0-9-]+|role|aria-[a-z]+|tabindex)$/u;
import { createLogger, newTrace } from "./log.js";

/**
 * 把线索压成一行短摘要 —— 日志里要能**一眼看出"靠什么找的"**。
 *
 * 直接塞整个 hint 会有几十行（`texts` 可能很长），把关键信息淹没掉。
 * 这里只留定位真正用得上的几项。
 *
 * @param hint - 线索对象。
 * @returns 形如 `div.side texts=2 file=- line=- +style` 的短串。
 */
export function summarizeHint(hint) {
	if (hint === null || hint === undefined) return "(无)";
	const tag = String(hint.tag ?? "?");
	const classes = Array.isArray(hint.classes) && hint.classes.length > 0
		? `.${hint.classes.slice(0, 3).join(".")}`
		: "";
	const texts = Array.isArray(hint.texts) ? hint.texts.length : 0;
	const file = typeof hint.file === "string" && hint.file !== "" ? hint.file : "-";
	const line = typeof hint.line === "number" ? hint.line : "-";
	// `style` 是 2026-10-07 加的坐标线索（区分同类图形），在不在很关键
	const style = hint.style === undefined ? "" : " +style";
	return `${tag}${classes} texts=${texts} file=${file} line=${line}${style}`;
}

/**
 * 删除时**绝对不许碰**的标签。
 *
 * 这几个是文档的骨架：删掉任何一个，画板文件就废了。
 * 判断基于**源码文本里真实的标签名**，不看前端传来的描述——
 * 前端可以传错，源码不会骗人。
 *
 * @type {Set<string>}
 */
const elementTagsProtect = new Set(["body", "html", "head"]);

/**
 * 原子写文本：先写同目录临时文件再改名，避免写到一半崩掉留下半个文件。
 *
 * @param path - 目标绝对路径。
 * @param content - 文本内容。
 */
export function writeTextAtomic(path, content) {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.canvas-tmp-${process.pid}-${Date.now()}`;
	writeFileSync(temp, content, "utf8");
	try {
		renameSync(temp, path);
	} catch (error) {
		// 改名失败（跨设备等）：退回直接写，并清掉临时文件。
		try {
			writeFileSync(path, content, "utf8");
		} finally {
			rmSync(temp, { force: true });
		}
		void error;
	}
}

/**
 * 画布会话：维护待确认改动、撤销栈与落盘。
 */
export class CanvasSession {
	/**
	 * @param options - {
	 *   root: 项目根,
	 *   snapshotRoot: 快照根目录,
	 *   autoApply: 是否默认直接落盘,
	 *   gitCheckpoints: 是否建 git 提交,
	 *   logger: 可选日志
	 * }
	 */
	constructor(options) {
		this.root = options.root;
		this.snapshotRoot = options.snapshotRoot;
		this.autoApply = options.autoApply !== false;
		this.gitCheckpoints = options.gitCheckpoints !== false;
		this.logger = options.logger;
		/** 待确认的改动（autoApply=false 时用到）。 */
		this.pending = [];
		/** 撤销栈：每项 { id, files, snapshotDir, summary, at }。 */
		this.history = [];
		/** 重做栈。 */
		this.future = [];
		/** 序号，用于快照目录命名与操作 id。 */
		this.counter = 0;
		/**
		 * 「画板路径 → 源文件」的学习表。
		 *
		 * ## 为什么需要它（这是定位准不准的关键）
		 *
		 * 定位是**按内容匹配**猜文件的：同一个文案在多个文件里出现时，分数打平，
		 * 只能按文件名排序挑一个——实测因此把本该写进原型文件的尺寸，
		 * 写进了插件的真实外壳 `lib/canvas/shell.html`，**破坏了真实 UI 的布局**。
		 *
		 * 而这一层信息其实一直都在：用户看的是**哪块画板**。`/plugin-ui` 这个路径
		 * 对应哪个文件，用户第一次选对之后就是个确定的事实，不该每次重新猜。
		 *
		 * 所以：写入成功后记下 `路径 → 文件`；下次这个路径下的元素优先该文件。
		 */
		this.locateMap = this.loadLocateMap();
		/** 项目探测结果（惰性，带缓存）。 */
		this._project = null;
	}

	/**
	 * 探测项目（带缓存）。
	 * @returns 探测结果。
	 */
	project() {
		if (this._project === null) this._project = detectProject(this.root);
		return this._project;
	}

	/**
	 * 读「画板路径 → 文件」学习表。
	 *
	 * 存在 `$DSH_HOME/visual-canvas/locate-map.json`（快照目录的兄弟），
	 * 属于**本机资产**而不是项目资产——它是「你这个项目里哪个路径对应哪个文件」的
	 * 经验，不该提交进别人的仓库，但跨会话保留才有意义（不然每次重启都要重学）。
	 *
	 * @returns { [boardPath: string]: string }。
	 */
	loadLocateMap() {
		try {
			const file = join(dirname(this.snapshotRoot), "locate-map.json");
			if (!existsSync(file)) return {};
			const parsed = JSON.parse(readFileSync(file, "utf8"));
			return parsed !== null && typeof parsed === "object" ? parsed : {};
		} catch {
			// 学习表坏了不该影响主流程：当作空的，重新学。
			return {};
		}
	}

	/**
	 * 判断一个项目相对路径是不是「自己的快照备份」。
	 *
	 * 快照默认放在 `$DSH_HOME`（项目外），但配置允许改到项目里——
	 * 那样定位器就会把备份文件也当成候选源文件。**改自己的备份**是最糟的一类 bug：
	 * 不报错、看起来生效了，但源码永远没变，而且回滚链也跟着坏。
	 * 所以在写入与学习两处都拦掉。
	 *
	 * @param file - 项目相对路径。
	 * @returns 是否位于快照目录内。
	 */
	isSnapshotPath(file) {
		try {
			const snapshotDir = resolve(this.snapshotRoot);
			const target = resolve(this.root, file);
			return target === snapshotDir || target.startsWith(`${snapshotDir}${sep}`);
		} catch {
			return false;
		}
	}

	/**
	 * 记下「这个画板路径对应哪个文件」。
	 *
	 * @param boardPath - 画板的应用路径（如 /plugin-ui）。
	 * @param file - 实际写入的项目相对路径。
	 */
	rememberLocate(boardPath, file) {
		if (typeof boardPath !== "string" || boardPath === "" || typeof file !== "string") return;
		if (this.isSnapshotPath(file)) return;
		if (this.locateMap[boardPath] === file) return;
		this.locateMap[boardPath] = file;
		try {
			const dir = dirname(this.snapshotRoot);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "locate-map.json"), `${JSON.stringify(this.locateMap, null, 2)}\n`, "utf8");
			this.logger?.info?.("learn-board-file", { boardPath, file });
		} catch (error) {
			this.logger?.warn?.("learn-board-file-failed", { boardPath, file, error });
		}
	}

	/**
	 * 给定位线索补上「这块画板对应哪个文件」。
	 *
	 * ## 为什么需要（2026-10-07，日志里 82 条 warn 的来源）
	 *
	 * 用户画布上有**两块内容相似的画板**（`prototype.html` 和 `prototype-v2.html`），
	 * 里面有同名元素（`div.body`、`span.layer-name` 等）。只按内容打分必然歧义：
	 *
	 *     hint=div.body   ambiguous
	 *     candidates=[prototype.html:533(6分), prototype-v2.html:215(5分), prototype.html:476(5分)]
	 *
	 * 而**「用户在看哪块画板」是确定的事实** —— `locateMap` 早就把
	 * 「画板路径 → 文件」学下来了。带上 `file` 就让定位只在那一个文件里找，
	 * 歧义从根上消失（而不是等它歧义了再去重排候选）。
	 *
	 * 找不到也不怕：`resolveSource` 在指定文件里没命中时会**自动退回全项目搜索**，
	 * 所以这只是"优先"，不是"限定"，不会把可用路径变不可用。
	 *
	 * @param element - 原始线索。
	 * @param boardPath - 画板路径（如 `/plugin-ui`）。
	 * @returns 补了 `file` 的线索；没学到时原样返回。
	 */
	hintForBoard(element, boardPath) {
		if (typeof boardPath !== "string" || boardPath === "") return element;
		const learned = this.locateMap[boardPath];
		if (typeof learned !== "string" || learned === "") return element;
		return { ...element, file: learned };
	}

	/**
	 * 定位一个元素到源码。
	 *
	 * ## 为什么这里必须记日志
	 *
	 * 2026-10-07 那个「拖动后弹回原位」的问题排查了六轮，**根子全在定位**：
	 * 定位器挑中了哪一行、有哪些候选在竞争，外面完全看不到。
	 * 最后是靠"逐行打印打分 + 看候选列表"才一次看清四个真因。
	 * 这几条日志就是为了让下一次**不用再写那个诊断脚本**。
	 *
	 * @param hint - 覆盖层送来的线索。
	 * @param options - { pin?: { file, line }, trace?: string }。
	 * @returns 定位结果。
	 */
	locate(hint, options) {
		const started = Date.now();
		const located = resolveSource(this.root, hint, options);
		// 不唯一 / 没找到 → warn（这两种正是出问题的前兆）
		const level = located.confidence === "ambiguous" || located.file === null ? "warn" : "info";
		this.logger?.[level]?.("locate", {
			trace: options?.trace,
			hint: summarizeHint(hint),
			pin: options?.pin,
			confidence: located.confidence,
			file: located.file,
			line: located.line,
			reason: located.reason,
			// **候选列表是排查"定位到哪儿去了"的关键**：
			// 看前三条就知道是谁在跟正确结果竞争（实测那次是插件自己的
			// shell.html 和代码注释里的示例标记）。
			candidates: (located.candidates ?? []).slice(0, 3).map((c) => `${c.file}:${c.line}(${c.score}分)`),
			ms: Date.now() - started
		});
		return located;
	}

	/**
	 * 应用一次改动（带日志的外层）。
	 *
	 * **成功也记**：否则"日志里没有"就分不清是"没执行"还是"执行成功了"——
	 * 排查时这两种情况的下一步动作完全相反。
	 *
	 * @param request - 同 `_apply`，另可带 `trace`。
	 * @returns `_apply` 的结果。
	 */
	async apply(request) {
		const trace = typeof request?.trace === "string" ? request.trace : newTrace();
		let result;
		try {
			result = await this._apply(request, trace);
		} catch (error) {
			// 抛异常这种情况最需要日志：界面通常只显示一句"失败"，看不到栈
			this.logger?.error?.("apply-throw", { trace, hint: summarizeHint(request?.element), error });
			throw error;
		}
		const ok = result?.ok !== false;
		this.logger?.[ok ? "info" : "warn"]?.("apply", {
			trace,
			ok,
			hint: summarizeHint(request?.element),
			declarations: Object.keys(request?.declarations ?? {}).slice(0, 8),
			pin: request?.pin === undefined ? undefined : `${request.pin.file}:${request.pin.line}`,
			boardPath: request?.boardPath,
			// 目标位置：写回"写到哪里去了"一眼可见
			file: result?.op?.file ?? result?.located?.file,
			line: result?.op?.line ?? result?.located?.line,
			confidence: result?.located?.confidence,
			// 失败原因原样记（用户界面上的"已撤回预览"就是这一条）
			error: ok ? undefined : result?.error
		});
		return result;
	}

	/**
	 * 应用一次改动（真正的实现）。
	 *
	 * @param request - {
	 *   element: { file?, line?, tag?, texts?, classes?, id?, strategy? },
	 *   declarations: { [property]: value|null },
	 *   pin?: { file, line },   // 用户在候选列表里钉住的位置
	 *   apply?: boolean   // 覆盖会话默认：true 立即落盘，false 只预览
	 * }
	 * @param trace - 链路 id（外层生成，透传给 locate）。
	 * @returns { ok, op } 或 { ok: false, error }。
	 */
	async _apply(request, trace) {
		const element = request?.element ?? {};
		const declarations = request?.declarations ?? {};
		if (Object.keys(declarations).length === 0) return { ok: false, error: "没有要应用的样式改动" };

		const boardPath = request?.boardPath;
		// ① 定位。带 pin 时不再重新搜索——用户已经明确说了用哪个。
		let located = this.locate(this.hintForBoard(element, boardPath), { ...(request?.pin === undefined ? {} : { pin: request.pin }), trace });
		if (located.file === null) {
			return { ok: false, error: located.reason ?? "无法把该元素定位到源码", located };
		}
		// 定位到快照备份上就直接拒绝：改备份等于没改源码，而且会毁掉回滚链。
		if (this.isSnapshotPath(located.file)) {
			return {
				ok: false,
				error: `定位到了快照备份（${located.file}），拒绝写入。请把 snapshotRoot 移出项目目录，或改用候选里别的文件。`,
				located
			};
		}
		if (located.confidence === "ambiguous") {
			// **先按「这块画板以前对应哪个文件」重排候选**——这是让自动挑选变准的关键。
			//
			// 分数是「这行源码像不像那个元素」，它分不出「原型里的那个 span」和
			// 「真实外壳里的那个 span」（文案一模一样，分数打平）。
			// 但「用户正在看哪块画板」是确定的事实：同一个路径上一次写进了哪个文件，
			// 这一次大概率还是那个。实测正是缺了这一层，才把尺寸写进了插件真实的外壳。
			const preferred = typeof boardPath === "string" ? this.locateMap[boardPath] : undefined;
			if (preferred !== undefined) {
				const index = located.candidates.findIndex((item) => item.file === preferred);
				if (index > 0) {
					const [picked] = located.candidates.splice(index, 1);
					located.candidates.unshift({ ...picked, learned: true });
				} else if (index === 0) {
					located.candidates[0] = { ...located.candidates[0], learned: true };
				}
			}
			// 定位不唯一：**自动挑一个并如实说明**，而不是直接拒绝。
			//
			// 直接拒绝看着安全，实测的后果是用户卡死——工具说「请确认用哪一个」，
			// 却不给确认的入口，于是「拖了半天写不进去」。
			// 现在默认挑最像的那个、把「我是猜的 + 还有哪些候选」一并回给界面，
			// 由界面显示出来并提供一键更换。
			//
			// ⚠️ **但有一种情况绝不能猜**：调用方给过 pin（精确位置），而它校验没过。
			//
			// 用户实测：「移动一个组件时，另一个没被选中的组件会随机偏移，
			// 甚至会带着已经移动过的那个一起偏」——就是这里挑错了元素，
			// 位移被写进了**别人的源码**。他以为组件之间有依赖，其实是定位猜错。
			//
			// pin 失效说明"我认定的那个位置已经对不上了"，这时再去猜
			// 等于把风险转嫁给用户的数据。宁可让他重新点一次。
			if (located.pinFailed === true) {
				return {
					ok: false,
					error: `改动位置已失效，且按内容找到 ${located.candidates.length} 个相似位置，不做猜测。`
						+ "请重新点选那个元素再改一次。",
					located
				};
			}
			located = autoPickCandidate(located, element);
		}

		// ② 写回
		const syntax = element.syntax;
		const patch = applyInlineStyle(this.root, {
			file: located.file,
			line: located.line,
			tag: element.tag,
			needle: [...(Array.isArray(element.texts) ? element.texts : []), ...(Array.isArray(element.classes) ? element.classes : [])]
		}, declarations, syntax === undefined ? {} : { syntax });
		if (patch.error !== undefined) return { ok: false, error: patch.error, located };

		const absolute = join(this.root, located.file);
		if (!isInside(this.root, absolute)) return { ok: false, error: "定位结果落在项目之外，已拒绝" };
		if (!existsSync(absolute)) return { ok: false, error: `源文件不存在: ${located.file}` };

		const before = readFileSync(absolute, "utf8");
		if (before !== patch.text && patch.changed === false) {
			return { ok: false, error: "改动没有产生实际差异（可能值相同）" };
		}
		if (before === patch.text) {
			return { ok: true, op: { id: this.nextId(), changed: false, summary: "内容无变化，未写盘", file: located.file, line: patch.line } };
		}

		this.counter += 1;
		const id = this.nextId();
		const op = {
			id,
			file: located.file,
			line: patch.line,
			tagName: patch.tagName,
			summary: patch.summary,
			declarations,
			confidence: located.confidence,
			strategy: located.strategy,
			// 把定位的「不确定性」一起带出去：界面要靠它显示
			//「我是自动选的 X，还有 N 个候选」并允许一键更换。
			autoPicked: located.autoPicked,
			candidates: located.candidates,
			locateReason: located.reason,
			// 带上画板路径：写入成功后用它把「路径 → 文件」记进学习表。
			boardPath: typeof request?.boardPath === "string" ? request.boardPath : undefined,
			before,
			after: patch.text,
			at: new Date().toISOString()
		};

		const shouldApply = request?.apply === undefined ? this.autoApply : request.apply === true;
		if (!shouldApply) {
			this.pending.push(op);
			return { ok: true, op: { ...this.publicOp(op), applied: false, preview: true } };
		}
		return this.commit(op);
	}

	/**
	 * 元素级改动：复制 / 删除 / 插入 / 移动（带日志的外层）。
	 *
	 * 与 `apply` 同样**成功也记**。
	 *
	 * @param request - 同 `_mutate`，另可带 `trace`。
	 * @returns `_mutate` 的结果。
	 */
	async mutate(request) {
		const trace = typeof request?.trace === "string" ? request.trace : newTrace();
		let result;
		try {
			result = await this._mutate(request, trace);
		} catch (error) {
			this.logger?.error?.("mutate-throw", { trace, kind: request?.kind, hint: summarizeHint(request?.element), error });
			throw error;
		}
		const ok = result?.ok !== false;
		this.logger?.[ok ? "info" : "warn"]?.("mutate", {
			trace,
			ok,
			kind: request?.kind,
			hint: summarizeHint(request?.element),
			pin: request?.pin === undefined ? undefined : `${request.pin.file}:${request.pin.line}`,
			boardPath: request?.boardPath,
			file: result?.op?.file ?? result?.located?.file,
			line: result?.op?.line ?? result?.located?.line,
			confidence: result?.located?.confidence,
			error: ok ? undefined : result?.error
		});
		return result;
	}

	/**
	 * 元素级改动：复制 / 删除 / 插入 / 移动（真正的实现）。
	 *
	 * 与 `apply` 分开是因为它们改的是**结构**而不是属性：`apply` 只需要找到开标签，
	 * 这里需要整个元素的范围（含子元素与闭合标签），算错就是直接把源码改坏。
	 * 但两者共用同一套定位、快照、撤销流程——撤销靠的是 before/after 全文，
	 * 结构改动天然也适用，不需要另建一套。
	 *
	 * @param request - { kind, element, boardPath, pin, payload }。
	 *   kind: "duplicate" | "remove" | "insert" | "move"
	 *   payload: insert/move 用 { position, markup } 或 { targetHint, position }
	 * @param trace - 链路 id（外层生成，透传给 locate）。
	 * @returns { ok, op } 或 { ok: false, error }。
	 */
	async _mutate(request, trace) {
		const kind = request?.kind;
		const element = request?.element ?? {};
		const boardPath = request?.boardPath;
		// 同 `_apply`：先按「这块画板对应哪个文件」限定，从源头避免跨画板歧义
		let located = this.locate(this.hintForBoard(element, boardPath), { ...(request?.pin === undefined ? {} : { pin: request.pin }), trace });
		if (located.file === null) {
			return { ok: false, error: located.reason ?? "无法把该元素定位到源码", located };
		}
		if (this.isSnapshotPath(located.file)) {
			return { ok: false, error: `定位到了快照备份（${located.file}），拒绝改动`, located };
		}

		// **只要「学到的文件」在候选里，就优先它。**
		//
		// 早先这里只在 `confidence === "ambiguous"` 时才重排，结果实测漏掉一类：
		// 定位器给出别的置信度（如 weak）但候选里就有学到的那个文件时，
		// 重排不生效，形状被写进了**另一个同名的文件**——画面上看不出区别，
		// 但改的是错的文件，属于最难发现的一类错误。
		//
		// 为什么敢这么做：**「学到的文件」是事实不是猜测**。
		// 用户在看哪块画板是确定的，同一路径上次写进哪个文件也是确定的。
		// 定位器的分数是"这行源码像不像那个元素"——它分不出两个内容雷同的文件，
		// 而"上次写的是哪个"恰好能分。
		if (typeof boardPath === "string") {
			const preferred = this.locateMap[boardPath];
			if (preferred !== undefined && preferred !== located.file) {
				const index = (located.candidates ?? []).findIndex((item) => item.file === preferred);
				if (index >= 0) {
					const [picked] = located.candidates.splice(index, 1);
					located = {
						...located,
						file: picked.file,
						line: picked.line,
						confidence: "learned",
						candidates: [{ ...picked, learned: true }, ...located.candidates]
					};
				}
			}
		}

		const absolute = join(this.root, located.file);
		if (!existsSync(absolute)) return { ok: false, error: `源文件不存在: ${located.file}` };
		const before = readFileSync(absolute, "utf8");
		const lines = before.split(/\r?\n/u);

		// 结构改动**默认不接受猜**：定位不唯一时按内容匹配可能选中另一个同名元素，
		// 那会把结构插到错误的地方。属性改错了还能看出来，结构改错了很难判断。
		//
		// **但 `insert` 是例外，而且必须是例外。**
		//
		// 理由和 `apply` 里那条注释是同一个：直接拒绝看着安全，实测的后果是**用户卡死**。
		// 实测场景：画一个矩形，锚点 `<div id="app">` 在本项目的两个文件里都存在，
		// 定位器看到 2 个候选就拒绝 —— 用户画得出来、松手没反应，
		// 而且**没有任何办法自己走出来**（建立「画板 → 文件」映射的唯一途径是改样式，
		// 可他只是想画个形状）。
		//
		// 插入是**纯增量**：挑错了文件，画布上不会出现东西，或者出现的位置一眼能看出不对，
		// Ctrl+Z 一下就回去了。风险远小于"功能整个不可用"。
		// 删除/移动/复制不适用这条——它们会**破坏已有内容**，挑错了代价不可逆。
		if (located.confidence === "ambiguous") {
			if (kind === "insert") {
				// 自动挑一个，并如实说明「我是猜的 + 还有哪些候选」，
				// 由界面显示出来、提供一键更换。
				located = autoPickCandidate(located, element);
			} else {
				const picked = autoPickCandidate(located, element);
				return {
					ok: false,
					error: `定位不唯一，结构改动不做猜测：最像的是 ${picked.autoPicked.file}:${picked.autoPicked.line}，`
						+ `另有 ${located.candidates.length - 1} 个候选。请先在候选列表里选定要改哪一个。`,
					located: picked
				};
			}
		}

		const tagRange = findOpeningTag(lines, located.line ?? 1, element.tag, [
			...(Array.isArray(element.texts) ? element.texts : []),
			...(Array.isArray(element.classes) ? element.classes : [])
		], {
			// ★ 只有 `insert`（纯增量）才允许全文兜底。
			//
			// 定位器给的行号可能落在 CSS 规则或注释里（实测 `prototype.html:42`
			// 命中的是注释中罗列的类名），那种位置附近找不到开标签。
			// 插入挑错了位置风险很小（画布上不会出现东西，Ctrl+Z 就回去了），
			// 而"功能完全不可用"的代价大得多 —— 用户拖什么进来都不行。
			//
			// `duplicate` / `move` / `remove` 这类**破坏性**操作不开：
			// 它们挑错了会改动别的元素，那是不可逆的。
			global: kind === "insert"
		});
		if (tagRange === null) {
			return { ok: false, error: `在 ${located.file}:${located.line ?? 1} 附近没找到可编辑的开标签` };
		}
		const range = findElementRange(before, tagRange.start);
		if (range === null) {
			return { ok: false, error: "无法确定这个元素的完整范围（源码结构可能不完整）" };
		}

		let next;
		let summary;
		if (kind === "duplicate") {
			// 复制：把原文再插一份到后面。这是「新建组件」最常用的起点。
			const text = sliceElement(before, range);
			const result = insertElement(before, range, text, request?.payload?.position === "before" ? "before" : "after");
			if (result.error !== undefined) return { ok: false, error: result.error };
			next = result.text;
			summary = `复制 <${range.tag ?? element.tag ?? "元素"}>`;
		} else if (kind === "remove") {
			// ⚠️ **删除是唯一会毁掉已有内容的操作，必须在这里设卡。**
			//
			// `removeElement` 只做字符串切片，**没有任何判断**：
			// range 指到哪儿就删到哪儿。而 range 是从「元素描述」推出来的，
			// 一旦指到 `<body>`，**整个画板文件就废了**——
			// 没有撤销、没有备份（快照是插件自己的，不是原文件）。
			//
			// 这里的两道卡都**只看源码文本**，不看前端传来的 `element.tag`：
			// 前端可以传错，源码不会骗人。
			const sliceText = before.slice(range.start, range.end).trimStart();
			const realTag = /^<([a-zA-Z][\w-]*)/u.exec(sliceText)?.[1]?.toLowerCase() ?? "";
			if (elementTagsProtect.has(realTag)) {
				return {
					ok: false,
					error: `拒绝删除 <${realTag}>：它是页面的根节点，删掉整个画板就没了。`
						+ "如果要删的是里面的内容，请先选中那个子元素。"
				};
			}
			// 第二道卡：不管想删什么，**覆盖文件大部分内容一律拒绝**。
			// 正常元素不可能占掉 80% 的源码；出现这种情况一定是范围算错了。
			const coverage = (range.end - range.start) / Math.max(1, before.length);
			if (coverage > 0.8) {
				return {
					ok: false,
					error: `拒绝删除：这段范围覆盖了文件 ${Math.round(coverage * 100)}% 的内容，`
						+ "不像是单个元素（可能是定位范围算错了）。"
				};
			}
			const result = removeElement(before, range);
			if (result.error !== undefined) return { ok: false, error: result.error };
			next = result.text;
			summary = `删除 <${element.tag ?? "元素"}>`;
		} else if (kind === "insert") {
			const position = request?.payload?.position ?? "inside-end";
			const markup = request?.payload?.markup;
			if (typeof markup !== "string" || markup.trim() === "") {
				return { ok: false, error: "没有要插入的内容" };
			}
			const result = insertElement(before, range, markup, position);
			if (result.error !== undefined) return { ok: false, error: result.error };
			next = result.text;
			summary = `新建 ${markup.trim().slice(0, 24)}`;
		} else if (kind === "attrs") {
			// 改 HTML 属性（`data-*` 语义标记 + ARIA）。
			//
			// **为什么单独一类**：`declare` 走样式通路，只认 CSS 声明。
			// 而"这个组件是背景还是功能""点击后干什么"不是样式，是语义——
			// 塞进 style 里既不合规范，运行时也读不到。
			//
			// 值传 `null` 或空串表示**删掉这个属性**（而不是写成 "null" 字符串）。
			const attrs = request?.payload?.attrs;
			if (attrs === undefined || typeof attrs !== "object" || attrs === null) {
				return { ok: false, error: "没有要改的属性" };
			}
			// **白名单，不是黑名单**。这是往用户源码里写的东西，
			// 放开成"任意属性"等于把 `onclick` / `style` / `href` 也放进来，
			 // 那就成了一条能改坏页面的通道。
			//
			// 允许三类：
			//   - `data-*`：我们自己的语义标记
			//   - `role` / `aria-*`：**无障碍正式接口**，用户的应用和读屏软件都认
			//   - `tabindex`：让元素能被键盘聚焦（`role="button"` 配 `tabindex="0"`
			//     才真的能用键盘操作，只有 role 是半个按钮）
			const bad = Object.keys(attrs).find((k) => !ATTR_NAME_OK.test(k));
			if (bad !== undefined) {
				return { ok: false, error: `不允许改属性「${bad}」（只允许 data-* / role / aria-* / tabindex）` };
			}
			// 开标签区间。注意 `upsertAttribute` 收的是**数组** `[start, end)`——
			// 传对象进去两个下标都是 undefined，切出来会变成全文，
			// 属性插不进去、还静默返回"没有差异"。
			const openStart = range.start;
			// `let`：每改一条属性，开标签长度就变，右边界要跟着走
			let openEnd = range.innerStart ?? range.end;
			let text = before;
			for (const [name, value] of Object.entries(attrs)) {
				if (value === null || value === undefined || value === "") {
					const found = findAttribute(text.slice(openStart, openEnd), name);
					if (found === null) continue;
					// 删属性：把这段整个切掉。**不能**交给 upsert 写空值——
					// 那会留下 `data-role=""`，属性还在，运行时仍然会读到它。
					text = text.slice(0, openStart + found.start) + text.slice(openStart + found.end);
					continue;
				}
				const lengthBefore = text.length;
				const result = upsertAttribute(text, [openStart, openEnd], name, String(value));
				if (result.error !== undefined) return { ok: false, error: result.error };
				text = result.text;
				// **每改一次，开标签的长度就变了**，右边界必须跟着走。
				// 不跟的话第二条属性会切在一个截断的标签上——表现为
				// "第一条属性加上了，后面的静默没加"（实测就是这么踩到的）。
				openEnd += text.length - lengthBefore;
			}
			next = text;
			summary = `改属性 ${Object.entries(attrs).map(([k, v]) => (v === null || v === "" ? `-${k}` : `${k}=${v}`)).join(" ")}`.slice(0, 60);
		} else if (kind === "move") {
			// 移动 = 先摘出来、再插到目标旁边。
			// 必须**先删后插**并重新定位目标：删除会改变所有后续偏移，
			// 拿着旧偏移去插会错位（这类 bug 表现为"元素跑到别处去了"）。
			const targetHint = request?.payload?.target;
			if (targetHint === undefined) return { ok: false, error: "移动需要指定目标元素" };
			const targetLocated = this.locate(targetHint);
			if (targetLocated.file !== located.file) {
				return { ok: false, error: "暂不支持跨文件移动元素" };
			}
			const text = sliceElement(before, range);
			const cut = removeElement(before, range);
			if (cut.error !== undefined) return { ok: false, error: cut.error };
			const targetRange = findElementRange(cut.text, findOpeningTag(cut.text.split(/\r?\n/u), targetLocated.line ?? 1, targetHint.tag, [
				...(Array.isArray(targetHint.texts) ? targetHint.texts : []),
				...(Array.isArray(targetHint.classes) ? targetHint.classes : [])
			])?.start ?? -1);
			if (targetRange === null) return { ok: false, error: "移动后找不到目标位置" };
			const placed = insertElement(cut.text, targetRange, text, request?.payload?.position ?? "after");
			if (placed.error !== undefined) return { ok: false, error: placed.error };
			next = placed.text;
			summary = `移动 <${element.tag ?? "元素"}>`;
		} else {
			return { ok: false, error: `不认识的改动类型：${kind}` };
		}

		if (next === before) return { ok: false, error: "改动没有产生实际差异" };

		this.counter += 1;
		const op = {
			id: this.nextId(),
			file: located.file,
			line: located.line,
			tagName: element.tag,
			summary: `${summary}（${located.file}:${located.line}）`,
			kind,
			confidence: located.confidence,
			boardPath: typeof request?.boardPath === "string" ? request.boardPath : undefined,
			before,
			after: next,
			at: new Date().toISOString()
		};
		const shouldApply = request?.apply === undefined ? this.autoApply : request.apply === true;
		if (!shouldApply) {
			this.pending.push(op);
			return { ok: true, op: { ...this.publicOp(op), applied: false, preview: true } };
		}
		return this.commit(op);
	}

	/**
	 * 把一条操作真正写盘。
	 *
	 * @param op - 操作对象（含 before/after）。
	 * @returns { ok, op } 或 { ok: false, error }。
	 */
	async commit(op) {
		const absolute = join(this.root, op.file);
		// ④ 冲突检测：磁盘内容已被外部改动时拒绝写入，而不是覆盖别人的修改。
		const current = readFileSync(absolute, "utf8");
		if (current !== op.before) {
			return {
				ok: false,
				error: `${op.file} 在画布编辑期间被外部改动过，为避免覆盖你的修改，本次不改。请刷新画布后重试。`
			};
		}

		// ⑤ 快照
		const label = `${String(this.counter).padStart(4, "0")}-${Date.now()}`;
		const snapshotDir = createSnapshotDir(this.snapshotRoot, label);
		saveSnapshot(snapshotDir, this.root, [op.file]);

		// ⑥ 落盘
		try {
			writeTextAtomic(absolute, op.after);
		} catch (error) {
			rmSync(snapshotDir, { recursive: true, force: true });
			return { ok: false, error: `写盘失败：${error?.message ?? error}` };
		}

		let git = null;
		if (this.gitCheckpoints) {
			git = await commitCanvasChange(this.root, [op.file], `[canvas] ${op.summary} (${op.file}:${op.line})`);
		}

		this.history.push({ id: op.id, files: [op.file], snapshotDir, summary: op.summary, at: op.at });
		this.future.length = 0;
		this.pending = this.pending.filter((item) => item.id !== op.id);

		// 写成功了才记：这样学到的映射一定对应「确实改对过」的位置。
		// 记早（比如定位一成功就记）会把猜测也固化成"经验"。
		this.rememberLocate(op.boardPath, op.file);

		return { ok: true, op: { ...this.publicOp(op), applied: true, backup: snapshotDir, git } };
	}

	/**
	 * 把待确认队列里的改动落盘。
	 * @param id - 操作 id；不传则全部落盘。
	 * @returns 结果汇总。
	 */
	async applyPending(id) {
		const targets = id === undefined ? [...this.pending] : this.pending.filter((item) => item.id === id);
		if (targets.length === 0) return { ok: false, error: "没有待确认的改动" };
		const results = [];
		for (const op of targets) {
			// 同一文件的多条待确认改动：后一条的 before 已过期，重算。
			const absolute = join(this.root, op.file);
			const current = existsSync(absolute) ? readFileSync(absolute, "utf8") : "";
			if (current !== op.before) {
				const refreshed = applyInlineStyle(this.root, {
					file: op.file,
					line: op.line,
					tag: op.tagName,
					needle: []
				}, op.declarations, { syntax: undefined });
				if (refreshed.error !== undefined) {
					results.push({ id: op.id, ok: false, error: refreshed.error });
					continue;
				}
				op.before = current;
				op.after = refreshed.text;
			}
			const result = await this.commit(op);
			results.push({ id: op.id, ...result });
		}
		return { ok: results.every((item) => item.ok !== false), results };
	}

	/**
	 * 丢弃待确认改动。
	 * @param id - 操作 id；不传则全部丢弃。
	 * @returns { ok, discarded }。
	 */
	discardPending(id) {
		const before = this.pending.length;
		this.pending = id === undefined ? [] : this.pending.filter((item) => item.id !== id);
		return { ok: true, discarded: before - this.pending.length };
	}

	/**
	 * 撤销最近一次落盘。
	 * @returns { ok, op } 或 { ok: false, error }。
	 */
	async undo() {
		const entry = this.history.pop();
		if (entry === undefined) return { ok: false, error: "没有可撤销的改动" };
		const restored = [];
		for (const file of entry.files) {
			const original = readSnapshot(entry.snapshotDir, file);
			if (original === null) {
				this.history.push(entry);
				return { ok: false, error: `快照里找不到 ${file} 的原始内容，无法撤销` };
			}
			const absolute = join(this.root, file);
			const current = existsSync(absolute) ? readFileSync(absolute, "utf8") : "";
			writeTextAtomic(absolute, original);
			restored.push({ file, before: current, after: original });
		}
		this.future.push({ ...entry, restored });
		if (this.gitCheckpoints) {
			await commitCanvasChange(this.root, entry.files, `[canvas] 撤销：${entry.summary}`);
		}
		return { ok: true, op: { id: entry.id, summary: entry.summary, files: entry.files, restored: restored.map((item) => item.file) } };
	}

	/**
	 * 重做最近一次撤销。
	 * @returns { ok, op } 或 { ok: false, error }。
	 */
	async redo() {
		const entry = this.future.pop();
		if (entry === undefined || !Array.isArray(entry.restored)) return { ok: false, error: "没有可重做的改动" };
		const files = [];
		for (const item of entry.restored) {
			writeTextAtomic(join(this.root, item.file), item.before);
			files.push(item.file);
		}
		this.history.push({ id: entry.id, files: entry.files, snapshotDir: entry.snapshotDir, summary: entry.summary, at: entry.at });
		if (this.gitCheckpoints) {
			await commitCanvasChange(this.root, files, `[canvas] 重做：${entry.summary}`);
		}
		return { ok: true, op: { id: entry.id, summary: entry.summary, files } };
	}

	/**
	 * 生成新操作 id。
	 * @returns id 字符串。
	 */
	nextId() {
		return `op-${Date.now().toString(36)}-${(this.counter + 1).toString(36)}`;
	}

	/**
	 * 把内部操作裁剪成可发给客户端的形状（不含整份文件内容）。
	 * @param op - 内部操作。
	 * @returns 公开形状。
	 */
	publicOp(op) {
		return {
			id: op.id,
			file: op.file,
			line: op.line,
			tagName: op.tagName,
			summary: op.summary,
			confidence: op.confidence,
			strategy: op.strategy,
			// 定位的「不确定性」要传到界面：不传的话，界面只知道成功/失败，
			// 没法告诉用户「我是自动选的，还能换」——而这正是 C 方案的关键承诺。
			autoPicked: op.autoPicked,
			candidates: op.candidates,
			locateReason: op.locateReason,
			at: op.at
		};
	}

	/**
	 * 会话状态摘要（给 Agent 与面板用）。
	 * @returns 状态对象。
	 */
	status() {
		const project = this.project();
		return {
			root: this.root,
			framework: project.framework,
			styleSystem: project.styleSystem,
			cssFiles: project.cssFiles,
			autoApply: this.autoApply,
			gitCheckpoints: this.gitCheckpoints,
			pending: this.pending.map((op) => this.publicOp(op)),
			historyDepth: this.history.length,
			redoDepth: this.future.length,
			lastChange: this.history.length === 0 ? null : this.publicOp({ ...this.history[this.history.length - 1], before: "", after: "" })
		};
	}
}
