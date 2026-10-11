/**
 * 覆盖层 / 画布外壳发来的 WebSocket 消息处理。
 *
 * ## 为什么单独成模块
 *
 * 这段逻辑原先埋在 `index.js` 的 `apply` 闭包里，于是**只有跑起整个插件才能测**——
 * 浏览器验证里就出现了「看不到画布发出的 declare 到底有没有被处理」的空档。
 * 抽出来之后，测试可以拿真正的 `CanvasSession` 配一个假 peer，
 * 直接验证「点选 → 定位 → 改样式 → 落盘」整条链路。
 *
 * ## 协议（画布外壳与单页覆盖层共用同一套）
 *
 * | 客户端 → 宿主 | 宿主 → 客户端 |
 * |---|---|
 * | `hello` | `state` |
 * | `select` + hint | `located` + location |
 * | `declare` + hint + declarations | `applied` + ok/message/pending |
 * | `undo` / `redo` | `applied` |
 * | `applyPending` / `discardPending` | `applied` |
 *
 * 「定位但不猜」是这里的核心约定：置信度不足时把候选一起回给界面，
 * 由人决定，而不是替用户挑一个。
 */

/**
 * 造一个消息处理器。
 *
 * @param options - {
 *   session: CanvasSession,
 *   onSelection: (selection) => void   // 记下当前选中（供 Agent 工具读取）
 * }。
 * @returns { handle(peer, raw) }。
 */
import { newTrace } from "./log.js";

export function createPeerHandler(options) {
	const session = options.session;
	const onSelection = options.onSelection ?? (() => {});
	// 日志跟会话共用一份（没单独给就用 session 的）
	const log = options.logger ?? session.logger;

	/** 当前状态快照，每条回执都带上，省得界面再问一次。 */
	const state = () => ({
		pending: session.pending.length,
		canUndo: session.history.length > 0,
		canRedo: session.future.length > 0
	});

	/**
	 * 处理一条消息。
	 *
	 * @param peer - 连接（需有 sendJson）。
	 * @param raw - 原始文本。
	 * @returns Promise<void>。
	 */
	return async function handle(peer, raw) {
		let message;
		try {
			message = JSON.parse(raw);
		} catch {
			peer.sendJson({ type: "applied", ok: false, message: "消息不是合法 JSON" });
			return;
		}

		// **外层兜底：任何一条分支抛异常，都要把异常回给界面。**
		//
		// 为什么不逐个分支加 try/catch：分支有 declare / select / mutate /
		// undo / redo / applyPending / discardPending 好几条，**逐个加一定会漏**，
		// 而漏掉的那条就表现为「请求发出去了、界面永远停在等待」——最难查的一类故障。
		//
		// 实测代价：`session.mutate` 在运行的宿主里抛了异常，回执发不出去，
		// 界面停在「正在写入…」，**排查花了好几轮**才发现"原来是抛异常了"。
		//
		// 不吞异常：栈顶几行原样回给界面——那是排查这类问题**唯一**能看到宿主内部的地方。
		// **trace 是跨进程排查的关键。**
		//
		// 编辑层在**外壳**、定位写回在**宿主**，两侧各有日志。出问题时最想知道的是
		// "这两条日志是不是同一次操作" —— 外壳发消息时带上 trace，宿主原样记进每条，
		// 直接按 trace 一筛就能把一次操作完整串起来。
		// 没带就自己生成一个，保证宿主这边的日志至少内部可串。
		const trace = typeof message?.trace === "string" && message.trace !== "" ? message.trace : newTrace();
		const started = Date.now();
		log?.debug?.("peer-recv", { trace, type: message?.type, kind: message?.kind, boardPath: message?.boardPath });

		try {
			await dispatch(peer, message, trace);
			log?.debug?.("peer-done", {
				trace, type: message?.type, kind: message?.kind, ms: Date.now() - started
			});
		} catch (error) {
			// 这条尤其重要：界面通常只显示"宿主处理时抛异常"，看不到落在哪个分支
			log?.error?.("peer-throw", {
				trace, type: message?.type, kind: message?.kind, ms: Date.now() - started, error
			});
			peer.sendJson({
				type: message?.type === "mutate" ? "mutated" : "applied",
				kind: message?.kind,
				ok: false,
				error: true,
				message: `宿主处理「${String(message?.type ?? "?")}」时抛异常：${String(error?.message ?? error)}`,
				detail: String(error?.stack ?? "").split("\n").slice(0, 6).join("\n"),
				...state()
			});
		}
	};

	/**
	 * 按类型分发一条消息（原 handle 的主体）。
	 *
	 * @param peer - 连接。
	 * @param message - 已解析的消息。
	 * @param trace - 链路 id（由 `handle` 生成，透传给 session，两侧日志靠它对齐）。
	 * @returns Promise<void>。
	 */
	async function dispatch(peer, message, trace) {
		if (message.type === "hello") {
			peer.sendJson({ type: "state", ...state() });
			return;
		}

		/**
	 * 外壳侧日志转发。
	 *
	 * 编辑层跑在**外壳**、定位与写回跑在**宿主**，两边各有各的现场。
	 * 第一版排查最难的就是这一点：界面说"没反应"，宿主说"没收到"，
	 * 谁也证明不了自己。让外壳把关键节点发过来、由宿主**统一落盘**，
	 * 一份日志里就能按 `trace` 把一次操作完整串起来。
	 *
	 * **不回执**：日志很密集，每条都回执会变成消息风暴。
	 * 它也不参与业务，丢了就丢了（真丢了说明连接本身断了，那是另一个问题）。
	 */
	if (message.type === "log") {
		const levels = ["error", "warn", "info", "debug", "trace"];
		const level = levels.includes(message.level) ? message.level : "info";
		log?.[level]?.(`shell:${String(message.event ?? "?")}`, {
			trace,
			...(message.data ?? {})
		});
		return;
	}

	if (message.type === "select") {
			const hint = message.hint ?? {};
			const located = session.locate(hint, { trace });
			onSelection({
				hint,
				location: located,
				label: `${hint.tag ?? "元素"}${located.file === null ? "（未定位）" : ` · ${located.file}:${located.line}`}`
			});
			peer.sendJson({ type: "located", location: located });
			return;
		}

		if (message.type === "declare") {
			const result = await session.apply({
				trace,
				element: message.hint ?? {},
				declarations: message.declarations ?? {},
				// 用户在候选列表里钉住的位置：带上它就不再重新搜索，直接用那个位置。
				pin: message.pin,
				// 画板的应用路径（如 /plugin-ui）。宿主靠它把「这块画板对应哪个文件」学下来，
				// 下次同路径下的元素就优先那个文件——而不是每次重新按分数猜
				//（分数分不出「原型里的 span」和「真实外壳里的 span」，文案一模一样）。
				boardPath: message.boardPath
			});
			const located = result.op?.located ?? result.located;
			peer.sendJson({
				type: "applied",
				ok: result.ok !== false,
				// 定位不唯一时宿主会**自动挑一个**，并把「我挑了谁、还有哪些候选」一并给出。
				// 这段说明必须原样送到界面——否则用户只看到「失败」，
				// 不知道工具其实已经选好了、还能换（实测就是这么卡住的）。
				message: result.ok === false ? result.error : (located?.reason ?? undefined),
				autoPicked: located?.autoPicked,
				candidates: located?.candidates,
				op: result.op,
				...state()
			});
			return;
		}

		// ---- 结构改动：复制 / 删除 / 插入 / 移动
		//
		// 与 declare 分开是因为改的是**结构**而不是属性：宿主对这类改动更保守
		//（定位不唯一时直接拒绝，不做猜测），所以回执的措辞也更硬。
		if (message.type === "mutate") {
			// **必须 try/catch，否则宿主侧一抛异常就永远不回执。**
			//
			// 实测踩过：`session.mutate` 在运行的宿主里抛了异常，而这里的
			// `await` 之后才 `sendJson` —— 异常往上冒，回执发不出去。
			// 界面那边看到的是「正在写入…」永远停住，**没有任何线索**，
			// 排查花了很久才定位到"原来是抛异常了"。
			//
			// 一个不回执的请求比一个失败的回执糟得多：前者让界面和宿主
			// 对同一件事的认知永久分叉。**宁可把异常原文回给界面。**
			let result;
			try {
				result = await session.mutate({
					trace,
					kind: message.kind,
					element: message.hint ?? {},
					payload: message.payload ?? {},
					pin: message.pin,
					boardPath: message.boardPath
				});
			} catch (error) {
				peer.sendJson({
					type: "mutated",
					kind: message.kind,
					ok: false,
					error: true,
					// 带上异常的消息和栈顶几行——这比一句"失败"有用得多，
					// 而且这是排查这类问题唯一能看到宿主内部的地方。
					message: `宿主处理时抛异常：${String(error?.message ?? error)}`,
					detail: String(error?.stack ?? "").split("\n").slice(0, 5).join("\n"),
					...state()
				});
				return;
			}
			const located = result.op?.located ?? result.located;
			peer.sendJson({
				type: "mutated",
				kind: message.kind,
				ok: result.ok !== false,
				// 失败时原样带上宿主的原因：结构改动失败的原因往往很具体
				//（"定位不唯一，结构改动不做猜测：最像的是 X，另有 N 个候选"），
				// 用通用文案盖掉会让用户完全不知道该做什么。
				message: result.ok === false ? result.error : result.op?.summary,
				candidates: located?.candidates,
				op: result.op,
				...state()
			});
			return;
		}

		if (message.type === "undo" || message.type === "redo") {
			const result = message.type === "undo" ? await session.undo() : await session.redo();
			peer.sendJson({
				type: "applied",
				ok: result.ok !== false,
				message: result.ok === false
					? result.error
					: `已${message.type === "undo" ? "撤销" : "重做"}：${result.op.summary}`,
				...state()
			});
			return;
		}

		if (message.type === "applyPending" || message.type === "discardPending") {
			const result = message.type === "applyPending"
				? await session.applyPending(message.id)
				: session.discardPending(message.id);
			peer.sendJson({
				type: "applied",
				ok: result.ok !== false,
				message: result.ok === false
					? result.error
					: (message.type === "applyPending" ? "待确认改动已落盘" : `已丢弃 ${result.discarded} 条`),
				...state()
			});
			return;
		}

		peer.sendJson({ type: "applied", ok: false, message: `未知消息类型：${String(message.type)}` });
	};
}
