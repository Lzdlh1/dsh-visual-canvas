/**
 * 画布与 Agent 之间的桥。
 *
 * ## 它解决的问题（也是这个产品的核心问题）
 *
 * 用户说「这个按钮太丑了」——单独听这句话，模型无法行动。但如果同时收到
 * 「画板=登录页、路径=/login、元素=`<button class="btn-primary">`、源码 `Login.tsx:42`」，
 * 它就能直接动手。
 *
 * **「用户无法表达清楚需求、无法定位需求」在技术上的对应物，就是上下文传递不完整。**
 * 这个模块负责把「用户指着的东西」和「用户说的话」打包成一条模型能执行的消息。
 *
 * ## 为什么用 sessionController.prompt 而不是自己做 LLM 调用
 *
 * 插件不该、也不能自己调模型（凭据、计费、会话历史都在 DSH 手里）。
 * DSH 的 `sessionController.prompt` 正好是「往某个会话里投递一条用户消息」，
 * 于是画布上的输入框和聊天框里打字走的是**同一条路**——Agent 不需要知道
 * 消息是从画布来的，它的工具、上下文、历史全都一致。
 *
 * ## 目标会话怎么确定
 *
 * 插件本身不属于任何会话，所以按优先级取：
 *
 * 1. **工具调用记下来的会话**：只要 Agent 用过一次 `canvas_*` 工具，
 *    我们就确切知道哪个会话在看这块画布（`exec.agent.id`）——最可靠。
 * 2. **按项目目录匹配**：`sessionController.list()` 返回的每个会话都带 `cwd`，
 *    挑目录与 `projectRoot` 相同的；多个时优先「正在运行」再取最近活跃的。
 * 3. 都不行就**明确报错并告诉用户怎么办**，而不是猜一个会话把消息投错地方。
 */

import { randomUUID } from "node:crypto";

/**
 * DSH 的图片服务接受的媒体类型。
 *
 * 和 `ImageMediaType` 一致（`'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'`）。
 * **在发给宿主之前就检查** —— 让用户看到"这张图格式不支持"，
 * 比让宿主的校验报一个带错误码的异常友好得多。
 */
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/**
 * 解析 data URL 成宿主能收的字节。
 *
 * 浏览器端 `FileReader.readAsDataURL` 给的就是这个格式，
 * 所以注释卡片那边**不需要知道 Uint8Array 是什么** —— 传字符串过来就行。
 *
 * 导出是为了能单独测：它是"用户选的图能不能发出去"这条路上的第一道关，
 * 而且**失败方式全是静默的**（解析不出来就返回 null，界面只会说"不是有效的图片"）。
 *
 * @param url - `data:image/png;base64,xxxx` 这样的串。
 * @returns { data: Buffer, mediaType } 或 null（不是合法的 base64 data URL）。
 */
export function decodeDataUrl(url) {
	const match = /^data:([^;,]+);base64,([\s\S]+)$/u.exec(String(url ?? ""));
	if (match === null) return null;
	try {
		return { mediaType: match[1].toLowerCase(), data: Buffer.from(match[2], "base64") };
	} catch {
		return null;
	}
}

/**
 * 归一化路径用于比较（Windows 大小写不敏感、分隔符不统一）。
 * @param value - 路径。
 * @returns 归一化字符串。
 */
function normalizePath(value) {
	return String(value ?? "")
		.replace(/\\/gu, "/")
		.replace(/\/+$/u, "")
		.toLowerCase();
}

/**
 * 把画布上选中的东西写成模型能读的上下文。
 *
 * 刻意用紧凑的键值格式而不是长句：模型读结构化信息更准，
 * 而且用户一眼能看出「它到底被告知了什么」。
 *
 * @param selection - {
 *   board?: { name, path, device, rect, spec },
 *   element?: { tag, texts, classes, file, line, confidence },
 *   note?: string
 * }。
 * @returns 文本（可能是空串）。
 */
export function describeSelection(selection) {
	if (selection === null || selection === undefined) return "";
	const lines = ["【画布上下文】"];
	const board = selection.board;
	// 至少要有个名字或路径才值得写出来——否则退化对象会产出
	// 「画板：(未命名)」这种噪声，模型读了也没用。
	const hasBoard = board !== undefined && board !== null
		&& ((typeof board.name === "string" && board.name.trim() !== "") || (typeof board.path === "string" && board.path.trim() !== ""));
	if (hasBoard) {
		const rect = board.rect ?? {};
		lines.push(`画板：${typeof board.name === "string" && board.name.trim() !== "" ? board.name.trim() : board.path}`);
		if (board.path !== undefined) lines.push(`应用路径：${board.path}`);
		if (board.device !== undefined) {
			lines.push(`设备：${board.device}${rect.w === undefined ? "" : ` ${rect.w}×${rect.h}`}`);
		}
		if (typeof board.spec === "string" && board.spec.trim() !== "") lines.push(`该画板的规格：${board.spec.trim()}`);
	}
	const element = selection.element;
	if (element !== undefined && element !== null) {
		const parts = [];
		if (element.tag !== undefined) parts.push(`<${element.tag}>`);
		if (Array.isArray(element.texts) && element.texts.length > 0) parts.push(`文本「${element.texts[0]}」`);
		if (Array.isArray(element.classes) && element.classes.length > 0) parts.push(`class=${element.classes.slice(0, 3).join(" ")}`);
		if (parts.length > 0) lines.push(`选中元素：${parts.join(" ")}`);
		if (element.file !== undefined) {
			lines.push(`源码位置：${element.file}:${element.line ?? "?"}（置信度 ${element.confidence ?? "未知"}）`);
		}
	}
	if (typeof selection.note === "string" && selection.note.trim() !== "") lines.push(`补充：${selection.note.trim()}`);
	// 只有标题行说明什么都没选中，那就不要这一段。
	return lines.length <= 1 ? "" : lines.join("\n");
}

/**
 * 组装发给 Agent 的完整消息。
 *
 * @param options - { text, selection }。
 * @returns 消息文本。
 */
export function composeMessage(options) {
	const text = String(options.text ?? "").trim();
	const context = describeSelection(options.selection);
	if (context === "") return text;
	return `${context}\n\n用户说：${text}`;
}

/**
 * 画布 → Agent 的桥。
 */
export class PromptBridge {
	/**
	 * @param options - {
	 *   getSessionController: () => service | undefined,
	 *   projectRoot, prefix, logger
	 * }。
	 */
	constructor(options) {
		this.getSessionController = options.getSessionController;
		/** 取 DSH 的 attachments 服务（注释卡片发图片要用）。 */
		this.getAttachments = options.getAttachments;
		this.projectRoot = options.projectRoot;
		this.prefix = options.prefix;
		this.logger = options.logger;
		/** 从 canvas_* 工具调用里学到的会话 id。 */
		this.learnedSessionId = null;
		/** 最近一次发送结果（供界面显示）。 */
		this.last = null;
	}

	/**
	 * 记下「哪个会话在用画布」。由工具执行时调用。
	 *
	 * @param sessionId - 会话 id。
	 */
	noteSession(sessionId) {
		if (typeof sessionId !== "string" || sessionId === "") return;
		if (this.learnedSessionId !== sessionId) {
			this.logger?.info?.(`[visual-canvas] 画布已绑定到会话 ${sessionId}`);
		}
		this.learnedSessionId = sessionId;
	}

	/**
	 * 找一个可以接收消息的会话。
	 *
	 * @returns { ok: true, sessionId, source } 或 { ok: false, error, hint }。
	 */
	async resolveTarget() {
		const controller = this.getSessionController?.();
		if (controller === undefined || controller === null) {
			return {
				ok: false,
				error: "DSH 的会话服务不可用，画布无法把指令发给 Agent。",
				hint: "这通常意味着插件加载时 DSH 版本不含 sessionController；请更新 DSH 或改用手工方式（在聊天框里描述）。"
			};
		}

		if (this.learnedSessionId !== null) {
			return { ok: true, sessionId: this.learnedSessionId, source: "tool" };
		}

		// 退而求其次：按项目目录匹配会话。
		//
		// ## ⚠️ 精确匹配不够用（这就是"AI 指令不可用"反复出现的原因）
		//
		// 原来只做精确匹配：`会话 cwd === 项目根`。
		// 但真实用法几乎对不上 —— 用户在 `D:\DSH` 里跟 Agent 说话，
		// 而画布项目的根是 `D:\DSH\插件开发\dsh-visual-canvas`。
		// **两者永远不相等**，于是每次 DSH 重启后都必须由 Agent
		// 调一次画布工具才能绑定，否则界面一直显示"AI 指令不可用"。
		//
		// 所以加一层**上下级目录**匹配：会话 cwd 是项目根的祖先
		//（或反之）。同一个 DSH 实例里，这种包含关系足以说明
		// "这个会话在看这个项目下的东西"。
		//
		// 优先级严格保持：精确 > 上级 > 下级。同一档里仍然
		// 优先「正在运行」再取「最近活跃」。**匹配依据会一路报到界面上**，
		// 用户能看到消息投给了哪个会话、按什么规则挑的。
		try {
			const controllerSignal = AbortSignal.timeout(3000);
			const value = await controller.list({}, controllerSignal);
			const items = Array.isArray(value?.items) ? value.items : [];
			const wanted = normalizePath(this.projectRoot);

			let matching = items.filter((item) => normalizePath(item?.cwd) === wanted);
			let source = "cwd";
			if (matching.length === 0) {
				matching = items.filter((item) => {
					const cwd = normalizePath(item?.cwd);
					if (cwd === "") return false;
					// 会话在项目之上（D:\DSH 之于 D:\DSH\插件开发\xxx）
					// 或会话在项目之下（在子目录里开的会话）
					return wanted.startsWith(`${cwd}/`) || cwd.startsWith(`${wanted}/`);
				});
				source = "cwd-ancestor";
			}

			if (matching.length > 0) {
				// 优先正在运行的，其次最近活跃的。
				matching.sort((a, b) => {
					if (a.running !== b.running) return a.running ? -1 : 1;
					return Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0);
				});
				return { ok: true, sessionId: matching[0].sessionId, source, cwd: matching[0].cwd };
			}
			if (items.length === 0) {
				return {
					ok: false,
					error: "找不到可用的 DSH 会话。",
					hint: "先在这个 DSH 里开一个会话，或在聊天框里让 Agent 看一眼画布（会调用一次画布工具，之后画布就知道该发给谁了）。"
				};
			}
			return {
				ok: false,
				error: `没有会话的工作目录与项目根一致，也没有上下级关系（项目根：${this.projectRoot}）。`,
				hint: "让 Agent 在目标会话里调用一次画布工具（例如问它「画布上有什么」），画布就会绑定到那个会话。"
			};
		} catch (error) {
			return {
				ok: false,
				error: `列取会话失败：${String(error?.message ?? error)}`,
				hint: "让 Agent 调用一次画布工具即可直接绑定会话，不依赖这条路径。"
			};
		}
	}

	/**
	 * 当前可用性（供界面显示，不产生副作用）。
	 *
	 * @returns { available, sessionId, source, error, hint }。
	 */
	async status() {
		const target = await this.resolveTarget();
		if (target.ok !== true) {
			return { available: false, error: target.error, hint: target.hint, last: this.last };
		}
		return { available: true, sessionId: target.sessionId, source: target.source, last: this.last };
	}

	/**
	 * 把一条画布指令发给 Agent。
	 *
	 * @param request - { text, selection, message, images }。
	 *   `message` 是**已经拼好的完整文本**（注释卡片那条路会自己拼，
	 *   因为它要带元素尺寸颜色这些 `composeMessage` 不知道的东西）；
	 *   给了它就原样用，否则用 `composeMessage` 从 `text` + `selection` 拼。
	 *   `images` 是 data URL 数组（`data:image/png;base64,...`）。
	 * @returns { ok, sessionId, mode, message, imageCount } 或 { ok: false, error, hint }。
	 */
	async send(request) {
		const text = String(request?.text ?? "").trim();
		const prebuilt = typeof request?.message === "string" ? request.message.trim() : "";
		const images = Array.isArray(request?.images) ? request.images : [];
		// **有图就能发** —— 用户有时只想贴张截图说"照这个改"，一个字都不打。
		// 强制要求文字反而挡住了最自然的用法。
		if (text === "" && prebuilt === "" && images.length === 0) {
			return { ok: false, error: "指令是空的。" };
		}

		const target = await this.resolveTarget();
		if (target.ok !== true) return target;

		const message = prebuilt !== "" ? prebuilt : composeMessage({ text, selection: request?.selection });

		// ---- 图片：先存成持久引用，再当成 content part 投递
		//
		// 走的是 DSH 自己的 `attachments` 服务（`saveImages` → `ImageAttachmentRef`），
		// 不自己写文件。理由：它**校验收到的字节**（尺寸、像素、媒体类型），
		// 并且返回的是内容寻址的引用 —— 我们自己存的话，
		// 既要重新实现一遍校验，还会在用户的磁盘上留一堆不认识的文件。
		let content = [{ type: "text", text: message }];
		if (images.length > 0) {
			const saved = await this.saveImages(images);
			if (saved.ok !== true) return saved;
			content = [...content, ...saved.parts];
		}

		const controller = this.getSessionController();
		try {
			await controller.prompt({
				requestId: randomUUID(),
				sessionId: target.sessionId,
				// queue：等当前回合结束后处理。画布上的指令不该打断 Agent 正在做的事。
				mode: "queue",
				content
			}, AbortSignal.timeout(30_000));
			this.last = { at: Date.now(), text: message, sessionId: target.sessionId, images: images.length };
			return {
				ok: true,
				sessionId: target.sessionId,
				source: target.source,
				mode: "queue",
				message,
				imageCount: content.length - 1
			};
		} catch (error) {
			const detail = String(error?.message ?? error);
			this.logger?.warn?.(`[visual-canvas] 投递画布指令失败：${detail}`);
			return {
				ok: false,
				error: `投递失败：${detail}`,
				hint: "会话可能已关闭。让 Agent 重新调用一次画布工具即可重新绑定。"
			};
		}
	}

	/**
	 * 把 data URL 图片存成持久的图片引用。
	 *
	 * @param images - data URL 数组。
	 * @returns { ok: true, parts } 或 { ok: false, error, hint }。
	 */
	async saveImages(images) {
		const attachments = this.getAttachments?.();
		if (attachments === undefined || attachments === null) {
			return { ok: false, error: "附件服务不可用，发不了图片。", hint: "这条通道需要 DSH 的 attachments 服务。" };
		}

		const inputs = [];
		for (const [index, url] of images.entries()) {
			const decoded = decodeDataUrl(url);
			if (decoded === null) {
				return { ok: false, error: `第 ${index + 1} 张图不是有效的 base64 图片。` };
			}
			if (!ALLOWED_IMAGE_TYPES.includes(decoded.mediaType)) {
				return {
					ok: false,
					error: `第 ${index + 1} 张图的格式（${decoded.mediaType}）不支持。`,
					hint: `只支持 ${ALLOWED_IMAGE_TYPES.join(" / ")}。`
				};
			}
			inputs.push({ data: decoded.data, mediaType: decoded.mediaType, name: `canvas-comment-${index + 1}` });
		}

		try {
			const refs = await attachments.saveImages(inputs);
			return { ok: true, parts: refs.map((attachment) => ({ type: "image", attachment })) };
		} catch (error) {
			const detail = String(error?.message ?? error);
			this.logger?.warn?.(`[visual-canvas] 存图片失败：${detail}`);
			return {
				ok: false,
				error: `存图片失败：${detail}`,
				hint: "可能是图片太大或像素过高，超过 DSH 的图片限制。"
			};
		}
	}
}
