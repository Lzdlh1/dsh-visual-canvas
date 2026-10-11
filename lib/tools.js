/**
 * 给 DSH Agent 的画布工具。
 *
 * ## 为什么不用 MCP
 *
 * 调研里 zuoge 用 MCP canvas 是因为它要接**外部** agent（Claude Code / Codex）。
 * 你的 Agent 就是 DSH 自己，所以直接用 `ctx.tools.register` 注册成本地工具：
 * 延迟更低、上下文更连贯，也不需要跨进程协议。
 * 若将来要接外部 agent，把同一组操作暴露成 MCP 即可（操作语义已经在 ops 层统一）。
 *
 * ## 工具清单
 *
 * | 工具 | 作用 |
 * |---|---|
 * | `canvas_status` | 看当前画布会话：项目栈、待确认改动、撤销深度 |
 * | `canvas_locate` | 把一个元素的线索定位到源码（Agent 想改但不知道在哪时用） |
 * | `canvas_style` | 对已定位的元素应用样式改动（走与人类相同的写回管道） |
 * | `canvas_undo` / `canvas_redo` | 撤销 / 重做最近一次画布改动 |
 * | `canvas_pending` | 落盘或丢弃待确认的改动 |
 *
 * 关键约束：**所有写操作都走 CanvasSession**，与人手拖拽共享同一条管道
 * （快照 → 补丁 → 配平校验 → 冲突检测 → 原子写），所以两者不会互相打架。
 */

import { defineTool } from "./tool-def.js";

/** 元素线索的形状说明（几个工具共用）。 */
const HINT_PROPERTIES = {
	file: { type: "string", description: "源文件相对路径（可选，来自编译期注入或运行时栈）" },
	line: { type: "integer", description: "行号（可选）" },
	tag: { type: "string", description: "HTML 标签名，如 div" },
	texts: {
		type: "array",
		description: "元素上的可见文本片段，用于在源码里搜索",
		items: { type: "string" }
	},
	classes: {
		type: "array",
		description: "元素上的 class 名",
		items: { type: "string" }
	}
};

/**
 * 把一次操作的结果转成模型可读的文本。
 * @param result - CanvasSession 的返回。
 * @returns 文本。
 */
function describeResult(result) {
	if (result.ok === false) return `失败：${result.error}`;
	const op = result.op ?? {};
	if (op.preview === true) return `已加入待确认（未落盘）：${op.summary} → ${op.file}:${op.line}`;
	if (op.changed === false) return `无需改动：${op.summary}`;
	const backup = op.backup === undefined ? "" : `，快照 ${op.backup}`;
	const git = op.git?.committed === true ? `，git ${op.git.sha}` : "";
	return `已写入 ${op.file}:${op.line}（${op.summary}）${backup}${git}`;
}

/**
 * 创建画布工具集。
 *
 * @param options - {
 *   session: CanvasSession,
 *   getSelection: () => ({ hint, label }) | null,   // 当前画布上选中的元素（可选）
 *   onSessionSeen: (sessionId) => void,             // 学到「哪个会话在用画布」
 *   getBoardContext: () => object | null,           // 画布上的选中画板（供指令上下文）
 *   logger: 可选日志
 * }
 * @returns 待 ctx.tools.register 的工具定义数组。
 */
export function createCanvasTools(options) {
	const session = options.session;
	const getSelection = options.getSelection ?? (() => null);
	const onSessionSeen = options.onSessionSeen ?? (() => {});
	const getBoardContext = options.getBoardContext ?? (() => null);
	/**
	 * 取指令通道状态（可选）。
	 *
	 * 加它是为了**让"绑没绑上"这件事可见**：
	 * 「AI 指令不可用」背后可能是三种原因 —— 没学到会话、
	 * 会话列表里没有 cwd 匹配的、会话服务拿不到 —— 而它们从界面上
	 * **看起来一模一样**。让 `canvas_status` 直接报出来，就不用靠猜。
	 */
	const getPromptStatus = options.getPromptStatus ?? null;

	/** 是否已经记过入参形状（只记一次，不刷日志）。 */
	let trackSeen = false;

	/**
	 * 记「工具 execute 到底收到几个参数」。
	 *
	 * ⚠️ **不能用 `options.logger`** —— 那是 DSH 的 logger，
	 * 它写到 DSH 自己的日志里，**不在 `~/.dsh/visual-canvas/logs/`**。
	 * 我第一版写的就是 `options.logger?.info?.()`，结果日志里什么都没有，
	 * 还以为是"没重启"。现在改成把形状**塞进 `canvas_status` 的返回值** ——
	 * 那是 Agent 一定能看到的地方。
	 */
	let trackShape = null;

	/**
	 * 包住 execute，先把「哪个会话在用画布」记下来。
	 *
	 * 为什么要这一步：`sessionController.prompt` 需要一个 `sessionId`，
	 * 而插件本身不属于任何会话。工具调用的 `exec.agent` 恰好带着它——
	 * 这是**唯一确定**「谁在看这块画布」的来源，比按目录猜可靠得多。
	 *
	 * ## ⚠️ 这里曾经因为**猜签名**而静默失效
	 *
	 * DSH 的 API 是 `tools.execute(exec: ToolExecutionInput)` —— **一个参数**。
	 * 但本文件的工具都写成 `execute(args)` / `execute()`（用参数对象），
	 * 两种读法互相矛盾，而**两种情况下代码都不报错**：
	 *
	 *   - 若 DSH 真传 `(args, exec)`：原来的 `(args, exec) =>` 是对的
	 *   - 若 DSH 只传 `(exec)`：`args` 拿到的是 `exec`、`exec` 是 `undefined`
	 *     → `exec?.agent?.id` 恒为 undefined → **会话永远绑不上**，
	 *       而界面上只表现为「AI 指令不可用」，**一点错误信息都没有**
	 *
	 * 所以现在：**两种形状都认**，并且把第一次见到的真实形状记进日志。
	 * 不这么写的话，下次改 DSH 版本又得重新猜一遍。
	 *
	 * @param run - 真正的执行函数。
	 * @returns 包装后的执行函数。
	 */
	const track = (run) => (first, second) => {
		// 只在第一次调用时看清楚"到底传了几个参数、长什么样"。
		// 记在变量里（会出现在 canvas_status 的输出里），不写日志 ——
		// 见上面 `trackShape` 的说明。
		if (trackSeen === false) {
			trackSeen = true;
			const shape = {
				argCount: second === undefined ? 1 : 2,
				firstKeys: first === null || typeof first !== "object" ? typeof first : Object.keys(first).slice(0, 12),
				hasAgentOnFirst: typeof first?.agent?.id === "string",
				hasAgentOnSecond: typeof second?.agent?.id === "string"
			};
			trackShape = shape;
			options.logger?.info?.(`[visual-canvas] 工具 execute 的入参形状：${JSON.stringify(shape)}`);
		}

		// 会话 id 可能在第一个参数上（DSH 只传 exec 的情形），
		// 也可能在第二个参数上（传 args + exec 的情形）。两边都找。
		const exec = second ?? first;
		const id = exec?.agent?.id;
		if (typeof id === "string" && id !== "") onSessionSeen(id);

		// 参数对象同理：两个参数的形状下它就是第一个；一个参数的形状下
		// 它在 `exec.arguments` / `exec.input` 里（两种命名 DSH 都用过）。
		const args = second === undefined
			? (first?.arguments ?? first?.input ?? first)
			: first;
		return run(args, exec);
	};

	const tools = [
		defineTool({
			name: "canvas_status",
			description: "查看可视化画布会话的状态：项目技术栈与样式方案、当前是否有选中元素、待确认改动、可撤销次数。在动手改 UI 之前先调它了解现状。",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: true,
					required: ["framework", "styleSystem", "autoApply", "pending", "historyDepth", "summary"],
					properties: {
						framework: { type: "string" },
						styleSystem: { type: "string" },
						autoApply: { type: "boolean" },
						pending: { type: "integer" },
						historyDepth: { type: "integer" },
						summary: { type: "string" }
					}
				},
				render: (_args, value) => [{ type: "text", text: value.summary }]
			},
			async execute() {
				const status = session.status();
				const selected = getSelection();
				const lines = [
					`项目根：${status.root}`,
					`框架：${status.framework}｜样式方案：${status.styleSystem}`,
					`改动模式：${status.autoApply ? "直接落盘" : "先预览待确认"}`,
					`待确认改动：${status.pending.length} 条｜可撤销：${status.historyDepth} 次｜可重做：${status.redoDepth} 次`,
					selected === null ? "画布当前没有选中元素" : `画布选中：${selected.label}`
				];

				// ★ 指令通道状态 —— **不加这段就没法判断「AI 指令不可用」的原因**。
				//
				// 那个现象背后有三种完全不同的原因，而界面上长得一模一样：
				//   ① 没学到会话（工具没被调用过，或 `track` 没拿到 exec）
				//   ② 学到了，但 `sessionController.list()` 里没有 cwd 匹配的
				//   ③ 会话服务本身拿不到
				if (getPromptStatus !== null) {
					try {
						const prompt = await getPromptStatus();
						if (prompt?.available === true) {
							lines.push(`指令通道：✓ 已绑定会话 …${String(prompt.sessionId).slice(-12)}（来源：${prompt.source}）`);
						} else {
							lines.push(`指令通道：✗ 不可用 —— ${prompt?.error ?? "未知原因"}`);
							if (prompt?.hint !== undefined) lines.push(`  怎么办：${prompt.hint}`);
						}
					} catch (error) {
						lines.push(`指令通道：✗ 查询失败 —— ${String(error?.message ?? error)}`);
					}
				} else {
					lines.push("指令通道：✗ 未接入（插件没给 getPromptStatus）");
				}

				// ★ 工具入参形状 —— 只在第一次调用时有值。
				//
				// 这是为了**把"猜签名"这件事变成可验证的**：
				// `track` 需要 `exec.agent.id`，但 DSH 到底传一个参数还是两个，
				// 我拿不到类型定义（app.asar 是打包文件）。
				// 报出来之后就不用再猜了。
				if (trackShape !== null) {
					lines.push(`工具入参形状：${JSON.stringify(trackShape)}`
						+ (trackShape.hasAgentOnFirst || trackShape.hasAgentOnSecond
							? "（拿到了 agent，会话可绑定）"
							: "（**没拿到 agent —— 这就是绑不上的原因**）"));
				} else {
					lines.push("工具入参形状：（还没记录到）");
				}

				// 画布上的画板列表：Agent 想「改登录页」时需要知道它对应哪个路径。
				const boardContext = getBoardContext();
				if (boardContext !== null && boardContext !== undefined) {
					const workspaces = Array.isArray(boardContext.workspaces) ? boardContext.workspaces : [];
					if (workspaces.length === 0) {
						lines.push("画布上还没有画板");
					} else {
						lines.push(`画布上有 ${workspaces.length} 块画板：`,
							...workspaces.map((item) => `  - ${item.name}（${item.path}，${item.device} ${item.rect?.w}×${item.rect?.h}）`
								+ (typeof item.spec === "string" && item.spec.trim() !== "" ? ` 规格：${item.spec.trim()}` : "")));
					}
					if (typeof boardContext.selectedId === "string" && boardContext.selectedId !== "") {
						const active = workspaces.find((item) => item.id === boardContext.selectedId);
						if (active !== undefined) lines.push(`当前激活画板：${active.name}（${active.path}）`);
					}
				}
				if (status.cssFiles.length > 0) lines.push(`项目样式表：${status.cssFiles.slice(0, 5).join(", ")}`);
				if (status.pending.length > 0) {
					lines.push("待确认明细：", ...status.pending.map((op) => `  - ${op.summary} → ${op.file}:${op.line}`));
				}
				return Promise.resolve({
					framework: status.framework,
					styleSystem: status.styleSystem,
					autoApply: status.autoApply,
					pending: status.pending.length,
					historyDepth: status.historyDepth,
					workspaces: boardContext?.workspaces?.length ?? 0,
					summary: lines.join("\n")
				});
			},			presentCall: () => ({ card: "generic", title: "查看画布状态", kind: "read" })
		}),

		defineTool({
			name: "canvas_locate",
			description: "把一个界面元素定位到源码位置。线索可以是源文件+行号（精确），也可以是标签名+可见文本+class（按内容搜索）。返回置信度与候选位置；不唯一时不要动手改，先让用户确认。",
			parameters: {
				file: HINT_PROPERTIES.file,
				line: HINT_PROPERTIES.line,
				tag: HINT_PROPERTIES.tag,
				texts: HINT_PROPERTIES.texts,
				classes: HINT_PROPERTIES.classes
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true,
					required: ["found", "confidence", "summary"],
					properties: {
						found: { type: "boolean" },
						file: { type: "string" },
						line: { type: "integer" },
						confidence: { type: "string" },
						summary: { type: "string" }
					}
				},
				render: (_args, value) => [{ type: "text", text: value.summary }]
			},
			execute(args) {
				const located = session.locate(args);
				if (located.file === null) {
					return Promise.resolve({ found: false, confidence: located.confidence, summary: located.reason ?? "没有找到匹配的源码位置" });
				}
				const candidates = located.candidates ?? [];
				const lines = [
					`定位到 ${located.file}:${located.line}（置信度 ${located.confidence}）`,
					located.reason === null || located.reason === undefined ? "" : `注意：${located.reason}`
				].filter((line) => line !== "");
				if (candidates.length > 1) {
					lines.push("候选位置：", ...candidates.map((item) => `  - ${item.file}:${item.line}　${item.excerpt ?? ""}`));
				}
				return Promise.resolve({
					found: true,
					file: located.file,
					line: located.line,
					confidence: located.confidence,
					summary: lines.join("\n")
				});
			},
			presentCall: (args) => ({ card: "generic", title: `定位元素 ${args.tag ?? ""}`, kind: "read" })
		}),

		defineTool({
			name: "canvas_style",
			description: "对一个界面元素应用样式改动，走与人手拖拽完全相同的写回管道（最小补丁 + 配平校验 + 冲突检测 + 快照可撤销）。声明用 CSS 属性名（kebab-case），值为 null 表示移除该声明。改动是否立即落盘取决于会话设置，返回里会说明。",
			parameters: {
				file: HINT_PROPERTIES.file,
				line: HINT_PROPERTIES.line,
				tag: HINT_PROPERTIES.tag,
				texts: HINT_PROPERTIES.texts,
				classes: HINT_PROPERTIES.classes,
				declarations: {
					type: "object",
					required: true,
					additionalProperties: true,
					description: "样式声明，如 { \"color\": \"#fff\", \"font-size\": \"18px\", \"margin\": null }",
					properties: {}
				},
				apply: {
					type: "boolean",
					description: "true 立即落盘，false 只预览入队。省略则用会话默认。"
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true,
					required: ["ok", "summary"],
					properties: {
						ok: { type: "boolean" },
						file: { type: "string" },
						line: { type: "integer" },
						summary: { type: "string" }
					}
				},
				render: (_args, value) => [{ type: "text", text: value.summary }]
			},
			async execute(args) {
				const result = await session.apply({
					element: {
						file: args.file,
						line: args.line,
						tag: args.tag,
						texts: args.texts,
						classes: args.classes
					},
					declarations: args.declarations,
					apply: args.apply
				});
				return {
					ok: result.ok !== false,
					file: result.op?.file,
					line: result.op?.line,
					summary: describeResult(result)
				};
			},
			presentCall: (args) => ({
				card: "generic",
				title: `改样式 ${args.tag ?? ""}`,
				kind: "other",
				rawInput: args.declarations
			})
		}),

		defineTool({
			name: "canvas_undo",
			description: "撤销最近一次画布改动（按快照还原被改的文件）。只撤销画布自己做的改动，不影响你其他未提交的编辑。",
			parameters: {
				count: { type: "integer", description: "撤销次数，默认 1" }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true,
					required: ["ok", "summary"],
					properties: { ok: { type: "boolean" }, summary: { type: "string" } }
				},
				render: (_args, value) => [{ type: "text", text: value.summary }]
			},
			async execute(args) {
				const count = Math.max(1, Math.min(Number(args.count ?? 1), 20));
				const done = [];
				for (let i = 0; i < count; i += 1) {
					const result = await session.undo();
					if (result.ok === false) {
						if (done.length === 0) return { ok: false, summary: `撤销失败：${result.error}` };
						break;
					}
					done.push(result.op.summary);
				}
				return { ok: true, summary: `已撤销 ${done.length} 次：${done.join("；")}` };
			},
			presentCall: () => ({ card: "generic", title: "撤销画布改动", kind: "other" })
		}),

		defineTool({
			name: "canvas_redo",
			description: "重做最近一次被撤销的画布改动。",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: true,
					required: ["ok", "summary"],
					properties: { ok: { type: "boolean" }, summary: { type: "string" } }
				},
				render: (_args, value) => [{ type: "text", text: value.summary }]
			},
			async execute() {
				const result = await session.redo();
				return result.ok === false ? { ok: false, summary: `重做失败：${result.error}` } : { ok: true, summary: `已重做：${result.op.summary}` };
			},
			presentCall: () => ({ card: "generic", title: "重做画布改动", kind: "other" })
		}),

		defineTool({
			name: "canvas_pending",
			description: "处理待确认的改动：action=apply 落盘（可只落一条），action=discard 丢弃。仅当会话处于「先预览」模式时才有内容。",
			parameters: {
				action: { type: "string", required: true, enum: ["apply", "discard"], description: "apply 落盘 / discard 丢弃" },
				id: { type: "string", description: "只处理这一条操作（省略则处理全部）" }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true,
					required: ["ok", "summary"],
					properties: { ok: { type: "boolean" }, summary: { type: "string" } }
				},
				render: (_args, value) => [{ type: "text", text: value.summary }]
			},
			async execute(args) {
				if (args.action === "discard") {
					const result = session.discardPending(args.id);
					return { ok: true, summary: `已丢弃 ${result.discarded} 条待确认改动` };
				}
				const result = await session.applyPending(args.id);
				if (result.ok === false) return { ok: false, summary: `落盘失败：${result.error}` };
				const lines = result.results.map((item) => `  - ${item.ok === false ? `失败：${item.error}` : item.op.summary}`);
				return { ok: true, summary: `已落盘 ${result.results.length} 条：\n${lines.join("\n")}` };
			},
			presentCall: (args) => ({ card: "generic", title: `画布待确认：${args.action}`, kind: "other" })
		})
	];

	// 统一包一层 track，而不是逐个改 6 个 execute：
	// 少改 6 处就少 6 个出错机会，而且以后新增工具会自动被跟踪。
	return tools.map((tool) => ({ ...tool, execute: track(tool.execute) }));
}
