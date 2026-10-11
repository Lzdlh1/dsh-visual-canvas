/**
 * dsh-visual-canvas —— DSH 可视化前端编辑插件（宿主半边）。
 *
 * ## 它在整条链路里的位置
 *
 * ```
 * 浏览器（你的应用，任意技术栈）
 *   └─ 注入的覆盖层：点选 / 拖拽 / 缩放 / 改样式
 *         │ WebSocket（注册在 DSH 自己的服务器上，不额外开端口）
 * ┌───────▼──────── DSH 宿主（本插件）─────────────┐
 * │ ① 代理层：把你的 dev server 挂到 <prefix> 之下  │
 * │ ② 定位层：元素线索 → 源文件:行:标签             │
 * │ ③ 写回层：最小补丁 + 配平校验 + 冲突检测        │
 * │ ④ 工具层：canvas_* 工具给 Agent 用              │
 * └─────────────────────────────────────────────────┘
 * ```
 *
 * ## 为什么挂在 DSH 自己的服务器上
 *
 * `ctx.webServer.register` 与 `registerUpgrade` 让我们**复用** DSH 的 HTTP 服务器：
 * 不用另起端口、不用管证书、并且天然继承同一条回环信任链（loopback + Host + same-origin）。
 */

import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { BoardSession } from "./board.js";
import { createLibraryApi } from "./library-api.js";
import { createHandlers } from "./handler.js";
import { CanvasSession } from "./ops.js";
import { createLogger } from "./log.js";
import { createPeerHandler } from "./peer.js";
import { PromptBridge } from "./prompt.js";
import { startStandaloneServer } from "./standalone.js";
import { normalizeMounts } from "./static-mounts.js";
import { createCanvasTools } from "./tools.js";
import {
	DEFAULT_PREFIX,
	ENDPOINTS,
	endpointPath,
	inject,
	loopbackOnly,
	name,
	normalizePrefix,
	readJsonBody,
	writeJson
} from "./util.js";
import { Peer } from "./ws.js";

const here = dirname(fileURLToPath(import.meta.url));
const overlayDir = join(here, "overlay");
const shellDir = join(here, "canvas");

/**
 * 独立端口的默认值。
 *
 * 为什么需要独立端口：DSH 的侧边栏嵌入浏览器**拒绝打开与 DSH 自身同源的地址**
 * （`parseBrowserAddress` 里的 `application-origin` 判定），而 DSH 界面与画布原本同源。
 * 同源判定含端口，换个端口即换个 origin。详见 standalone.js。
 */
const DEFAULT_STANDALONE_PORT = 19390;

/**
 * 解析插件配置。
 *
 * `projectRoot` 没有合理默认值：猜错了就会去改别人的文件。所以留空时
 * 保留空串，由 {@link apply} 明确报错——比静默用一个错的项目根安全得多。
 *
 * @param config - 原始配置。
 * @returns 归一化配置。
 */
export function resolveConfig(config) {
	const raw = config ?? {};
	const prefix = normalizePrefix(raw.prefix ?? DEFAULT_PREFIX);
	const port = Number(raw.standalonePort ?? DEFAULT_STANDALONE_PORT);
	return {
		enabled: raw.enabled !== false,
		prefix,
		target: typeof raw.target === "string" && raw.target !== "" ? raw.target : "http://127.0.0.1:5173",
		projectRoot: typeof raw.projectRoot === "string" ? raw.projectRoot.trim() : "",
		autoApply: raw.autoApply !== false,
		gitCheckpoints: raw.gitCheckpoints !== false,
		snapshotRoot: typeof raw.snapshotRoot === "string" && raw.snapshotRoot !== "" ? raw.snapshotRoot : null,
		// 独立端口：侧边栏（嵌入浏览器）唯一能打开的入口，见 standalone.js 的说明。
		standalone: raw.standalone !== false,
		standalonePort: Number.isInteger(port) && port >= 0 && port <= 65535 ? port : DEFAULT_STANDALONE_PORT,
		/**
		 * 静态挂载：把本地目录/文件直接挂到画布端口下，**不必另起 dev server**。
		 *
		 * 动机很实际：为看一个纯静态页面（插件自带的设计原型、导出产物）专门起一个进程，
		 * 意味着「DSH 一重启就得记得把它拉起来」。挂载之后这些页面由画布自己
		 * （同一个端口、同一个进程）提供，打开就能看到，没有额外生命周期要管。
		 *
		 * 写法：`[{ path: "/ui", dir: "demo" }]` 或 `[{ path: "/ui", file: "x.html" }]`。
		 * 安全边界见 static-mounts.js（只读、不可越出挂载目录）。
		 */
		staticMounts: normalizeMounts(raw.staticMounts, typeof raw.projectRoot === "string" ? raw.projectRoot.trim() : "")
	};
}

/**
 * 注册插件。
 *
 * @param ctx - 宿主插件上下文（携带 webServer 与 tools）。
 * @param config - 插件配置。
 */
/**
 * 诊断落盘：把「加载/激活」过程中的状态与错误**追加**到 $DSH_HOME 下的一个 JSONL 文件。
 *
 * 为什么需要它：桌面应用的宿主日志不容易拿到，而「激活失败」时最需要的恰恰是那条错误。
 *
 * 为什么是追加式 JSONL 而不是覆盖式 JSON：
 * 本地测试也会调用 `apply`，覆盖式写法会把真实宿主那条冲掉（我踩过一次）；
 * 追加式 + 每行带 `pid` 与 `origin`，就能清楚区分「宿主加载」与「测试运行」。
 *
 * @param origin - 来源标记（"host" | "test"）。
 * @param patch - 要记录的字段。
 */
function writeActivationDiag(origin, patch) {
	try {
		const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
		const path = join(home, "visual-canvas-activation.jsonl");
		const line = JSON.stringify({
			origin,
			pid: process.pid,
			at: new Date().toISOString(),
			...patch
		});
		appendFileSync(path, `${line}\n`, "utf8");
	} catch {
		// 诊断写不进去也不能影响主流程。
	}
}

/** 模块加载即可验证：这一行出现说明模块被成功 import 了。 */
writeActivationDiag("host", { phase: "module-loaded" });

/**
 * 请求审计：记最近若干条进诊断文件（避免刷爆，做去重与限流）。
 *
 * 为什么需要：排查「某个宿主环境加载不出来」时，必须知道**它到底发了什么请求头**。
 * 我先前靠读代码猜请求形态，猜错过好几轮（cross-site 判定、webview/iframe 之分），
 * 所以这里改成让证据自己说话。
 *
 * @param entry - 审计字段。
 */
const auditSeen = new Map();
function logRequestAudit(entry) {
	try {
		// 同一「形态」只记一次（用关键头做指纹），避免 iframe 里几十个资源请求刷屏。
		const fingerprint = `${entry.allowed}|${entry.secFetchSite}|${entry.secFetchMode}|${entry.secFetchDest}|${entry.origin ?? ""}|${entry.host}`;
		const count = (auditSeen.get(fingerprint) ?? 0) + 1;
		auditSeen.set(fingerprint, count);
		if (count > 1) return;
		writeActivationDiag("host", { phase: "request", ...entry });
	} catch {
		// 审计失败不影响代理
	}
}

export function apply(ctx, config) {
	// 探针：把「看到了什么服务」记下来，用于区分「缺依赖」与「代码抛错」。
	const probe = {};
	for (const key of ["webServer", "tools", "logger", "fs", "storage", "baseDir"]) {
		try {
			probe[key] = ctx[key] === undefined ? "缺" : "有";
		} catch (error) {
			probe[key] = `访问抛错: ${String(error?.message ?? error).slice(0, 60)}`;
		}
	}
	writeActivationDiag("host", {
		phase: "apply-enter",
		step: "enter",
		probe,
		config: {
			keys: config === null || config === undefined ? null : Object.keys(config),
			target: config?.target ?? null,
			projectRoot: config?.projectRoot ?? null,
			prefix: config?.prefix ?? null
		}
	});

	try {
		applyInner(ctx, config);
		writeActivationDiag("host", { phase: "ok", step: "done", probe });
	} catch (error) {
		writeActivationDiag("host", {
			phase: "failed",
			step: "apply",
			probe,
			error: {
				name: error?.constructor?.name ?? "Error",
				message: String(error?.message ?? error),
				stack: String(error?.stack ?? "").split("\n").slice(0, 8)
			}
		});
		ctx.logger?.warn?.(`[visual-canvas] 激活失败（细节见诊断文件）：${String(error?.message ?? error)}`);
		// **故意不重新抛出**：插件激活失败只应让这一行不激活，绝不能拖垮整个宿主。
		// 我先前在这里 `throw error`，结果工具 schema 写错时整个应用起不来（host 进程直接退出）。
		// 错误已经落盘到诊断文件，排查靠它，不靠崩应用。
	}
}

/**
 * 真正的挂载逻辑（被 apply 用 try/catch 包住，便于把错误落盘）。
 *
 * @param ctx - 宿主插件上下文。
 * @param config - 插件配置。
 */
function applyInner(ctx, config) {
	const resolved = resolveConfig(config);

	if (resolved.projectRoot === "") {
		// 没有项目根就没法定位源码。这里**明确不激活**并留下原因，
		// 而不是拿进程工作目录猜一个——猜错会去改不相干的仓库。
		ctx.logger?.warn?.(
			"[visual-canvas] 未配置 projectRoot，插件不激活。"
			+ "请在 profile 的 cordis.patch.yml 里给这一行补上 projectRoot: \"<你的前端项目绝对路径>\"。"
		);
		return;
	}

	// $DSH_HOME：快照、本机视图状态都放这里（不进用户的项目）。
	const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	const snapshotRoot = resolved.snapshotRoot ?? join(dshHome, "visual-canvas", "snapshots");

	/**
	 * 自己的结构化日志（JSON Lines）。
	 *
	 * ## 为什么不直接用 `ctx.logger`
	 *
	 * 1. **要能检索**：JSONL 可以直接 grep / jq，出问题时按 `trace` 一筛就能
	 *    把"外壳发消息 → 宿主定位 → 写回结果"串成一条链；`ctx.logger` 的输出
	 *    是给终端看的，翻起来慢。
	 * 2. **要能一键导出**：日志落在 `snapshotRoot` 同级的 `logs/` 下，用户出问题
	 *    直接把当天的文件发过来即可，不必去翻 DSH 的日志目录。
	 * 3. **要能开关**：`DSH_CANVAS_LOG_LEVEL=debug` 就能看到定位与消息的细节，
	 *    不用改代码、不用重装。
	 *
	 * ## 它绝不参与业务
	 *
	 * 写盘失败只静默降级到内存缓冲（见 `log.js`）—— 日志是辅助设施，
	 * 不能因为它把画布带崩。
	 */
	const log = createLogger({
		dir: join(dirname(snapshotRoot), "logs"),
		service: "canvas-host"
		// 级别只认环境变量 `DSH_CANVAS_LOG_LEVEL`（error/warn/info/debug/trace）。
		// 不走插件配置：那个 `raw` 只在 resolveConfig 里存在，这里是另一层作用域
		//（第一版写成 `raw.logLevel`，插件直接激活失败：`raw is not defined`）。
	});

	// 会话：一个插件实例一个会话（对应一个项目根）。
	const session = new CanvasSession({
		root: resolved.projectRoot,
		snapshotRoot,
		autoApply: resolved.autoApply,
		gitCheckpoints: resolved.gitCheckpoints,
		logger: log
	});

	// 画板会话与指令桥都建在**两个 effect 之外**：路由那一块要用它们处理请求，
	// 工具那一块要用它们回答「画布上有什么」并记录会话归属。
	const board = new BoardSession({ root: resolved.projectRoot, dshHome, prefix: resolved.prefix, logger: ctx.logger });

	// 画布 → Agent 的指令桥。
	//
	// 用 `ctx.get("sessionController")` 而**不是**硬 inject：这个服务只影响
	// 「画布能不能把指令发给 Agent」这一项能力，万一某天不可用，
	// 画布本身（浏览、拖拽、改布局）不该跟着一起挂掉。
	// 服务契约里也明确给了可选访问形式（requiresUndefinedCheck: true）。
	const bridge = new PromptBridge({
		getSessionController: () => {
			try {
				return ctx.get("sessionController");
			} catch {
				return undefined;
			}
		},
		// 注释卡片发图片要用它。同样按可选服务取 ——
		// 拿不到时注释仍然能发纯文字，只是发不了图（见 prompt.js 里的处理）。
		getAttachments: () => {
			try {
				return ctx.get("attachments");
			} catch {
				return undefined;
			}
		},
		projectRoot: resolved.projectRoot,
		prefix: resolved.prefix,
		logger: ctx.logger
	});

	/** 当前连着的覆盖层（同一时刻通常只有一个浏览器标签）。 */
	const peers = new Set();
	/** 覆盖层报上来的当前选中元素（供 Agent 工具读取）。 */
	let selection = null;

	/**
	 * 给所有覆盖层广播一条消息。
	 * @param payload - 消息体。
	 */
	const broadcast = (payload) => {
		for (const peer of peers) peer.sendJson(payload);
	};

	/** 把会话状态推给面板。 */
	const pushState = () => {
		const status = session.status();
		broadcast({
			type: "state",
			pending: status.pending.length,
			canUndo: status.historyDepth > 0,
			canRedo: status.redoDepth > 0
		});
	};

	/**
	 * 处理一条覆盖层消息。
	 *
	 * ## ⚠️ 这里**只做转发**，不再自己实现分发
	 *
	 * 实测踩过：这段曾经是消息分发的**第二份实现**——一份在 `lib/peer.js` 的
	 * `createPeerHandler` 里（那份是后来为了能单独测试抽出来的），
	 * 一份在这里。两份**并行存在、只有这一份在跑**。
	 *
	 * 后果非常隐蔽：改了 `peer.js`（给 mutate 加回执、加异常兜底）**完全不生效**，
	 * 因为那份代码根本没被调用；`peer.js` 从 import 到没被用过一次，是纯死代码。
	 *
	 * 症状是「界面发出去的请求永远收不到回执」——
	 * 排查了好几轮才定位到"改的是另一份实现"。而真相只要看一眼
	 * `message.type === "..."` 的分支列表就看得出来：里面**没有 `mutate`**。
	 *
	 * **现在唯一的分发实现是 `lib/peer.js`。** 要加消息类型请改那里，
	 * 它有配套的 `test/peer-entry-harness.mjs`，改完立刻能验。
	 *
	 * @param peer - 来源连接。
	 * @param raw - 原始文本。
	 */
	const onPeerMessage = createPeerHandler({
		session,
		logger: log,
		// `peer.js` 不认识「当前选中」这个概念，它只负责定位——
		// 选中状态是插件自己的事（Agent 工具要读），由这个回调带回来。
		onSelection: (next) => {
			selection = next;
		}
	});

	// ---- 路由与升级
	//
	// 处理逻辑全部在 lib/handler.js：两个入口（DSH 端口与独立端口）共用同一套，
	// 避免像早先那样「独立端口少了状态接口」之类的规则漂移。
	ctx.effect(() => {
		const disposers = [];

		/**
		 * 接管一条覆盖层连接。handler 已做完握手与访问控制，这里只挂行为。
		 *
		 * @param peer - 已建立的覆盖层连接。
		 */
		const attachPeer = (peer) => {
			peer.onMessage = (text) => {
				void onPeerMessage(peer, text).catch((error) => {
					ctx.logger?.warn?.(`[visual-canvas] 处理消息失败：${String(error?.message ?? error)}`);
				});
			};
			peer.onClose = () => {
				peers.delete(peer);
				selection = null;
			};
			peers.add(peer);
			peer.sendJson({ type: "state", pending: session.pending.length, canUndo: false, canRedo: false });
		};

		// 画板会话（board）与指令桥（bridge）建在 effect 之外，两个 effect 共用，
		// 这里不再重复创建——否则工具那边会用到一个不同的实例，视图状态就对不上了。

		/**
		 * 状态载荷：两个入口共用（`/…/__canvas__/status`）。
		 *
		 * 定义在独立端口启动之前，靠闭包读 `standalone`，所以顺序没问题。
		 *
		 * @returns 状态对象。
		 */
		const statusPayload = () => ({
			...session.status(),
			target: resolved.target,
			prefix: resolved.prefix,
			clients: peers.size,
			selection: selection === null ? null : selection.label,
			workspaces: (board.snapshot().workspaces ?? []).length,
			// 画布的可访问地址：独立端口是对侧边栏唯一可用的那个（见 standalone.js）。
			urls: {
				dshServer: `${resolved.prefix}/`,
				standalone: standalone === null ? null : standalone.url
			}
		});

		const handlers = createHandlers({
			target: resolved.target,
			prefix: resolved.prefix,
			enabled: resolved.enabled,
			overlayDir,
			shellDir,
			// 静态挂载：命中就直接从磁盘应答，不转发给 target（那边的 dev server 常常没在跑）
			mounts: resolved.staticMounts,
			// 设计库：**全局资产，放 $DSH_HOME 下，不进任何项目**。
			// 一套设计规范是跨项目复用的东西，跟着项目走会导致每个新项目都要重新导入一遍。
			library: createLibraryApi({
				root: join(dshHome, "visual-canvas", "libraries"),
				logger: ctx.logger
			}),
			board,
			prompt: bridge,
			status: statusPayload,
			logger: ctx.logger,
			onPeer: (peer) => attachPeer(peer)
		});

		// 前缀路由：画布外壳、插件资源、画板 API、代理，全部由 handler 分发。
		disposers.push(ctx.webServer.register({
			kind: "prefix",
			path: resolved.prefix,
			handler: async (req, res) => {
				const allowed = loopbackOnly(req);
				// 请求审计：把「谁在请求、带了什么头、放行还是拒绝」记进诊断文件。
				// 这是排查「某个宿主环境（如 DSH 侧边栏 iframe）加载不出来」时唯一可靠的手段——
				// 光看代码猜请求头会一直猜错（我已经猜错过好几轮）。
				logRequestAudit({
					method: req.method,
					url: req.url,
					allowed,
					host: req.headers?.host,
					origin: req.headers?.origin,
					secFetchSite: req.headers?.["sec-fetch-site"],
					secFetchMode: req.headers?.["sec-fetch-mode"],
					secFetchDest: req.headers?.["sec-fetch-dest"],
					userAgent: String(req.headers?.["user-agent"] ?? "").slice(0, 60),
					referer: req.headers?.referer
				});
				await handlers.handleRequest(req, res);
			}
		}));

		// 升级：覆盖层 WebSocket（精确）与 HMR 转发（前缀）。
		disposers.push(ctx.webServer.registerUpgrade({
			path: endpointPath(resolved.prefix, ENDPOINTS.ws),
			handler: (req, socket, head) => handlers.handleUpgradeRequest(req, socket, head)
		}));
		disposers.push(ctx.webServer.registerUpgrade({
			kind: "prefix",
			path: `${resolved.prefix}/__hmr__`,
			handler: (req, socket, head) => handlers.handleUpgradeRequest(req, socket, head)
		}));

		// 状态接口：单独注册一条精确路由，这样即使前缀路由出问题也能探活。
		disposers.push(ctx.webServer.register({
			kind: "exact",
			path: `${resolved.prefix}/__canvas__/status`,
			handler: async (req, res) => {
				if (!loopbackOnly(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method === "POST") {
					const body = await readJsonBody(req);
					if (body.error !== undefined) {
						writeJson(res, 400, { error: body.error });
						return;
					}
					writeJson(res, 200, { ok: true, received: body.value });
					return;
				}
				writeJson(res, 200, statusPayload());
			}
		}));

		// 独立端口的入口：**侧边栏唯一能用的地址**。
		// DSH 的嵌入浏览器拒绝打开与自身同源的地址，所以画布必须有另一个 origin。
		// 启动是异步的，这里用 then 填充 standalone，不阻塞插件激活。
		let standalone = null;
		if (resolved.standalone !== false) {
			startStandaloneServer({
				port: resolved.standalonePort,
				handlers,
				urlPath: `${resolved.prefix}/`
			}).then((server) => {
				standalone = server;
				ctx.logger?.info?.(
					`[visual-canvas] 画布地址：${server.url}（侧边栏/浏览器都用这个；`
					+ `DSH 端口下的 ${resolved.prefix}/ 同源，嵌入浏览器会拒绝打开）`
				);
			}).catch((error) => {
				ctx.logger?.warn?.(
					`[visual-canvas] 独立端口 ${resolved.standalonePort} 启动失败：${String(error?.message ?? error)}。`
					+ "侧边栏将无法打开画布（DSH 拒绝嵌入自身同源地址）；可改用普通浏览器，或换一个 standalonePort。"
				);
			});
		}

		return () => {
			for (const peer of [...peers]) peer.close(1001, "插件卸载");
			peers.clear();
			if (standalone !== null) void standalone.close();
			for (const dispose of disposers) {
				try {
					dispose();
				} catch {
					// 卸载期的清理失败不该影响其他行。
				}
			}
		};
	}, "visual-canvas: routes");

	// ---- 工具注册
	ctx.effect(() => {
		const tools = createCanvasTools({
			session,
			getSelection: () => selection,
			// 学到「哪个会话在用画布」——这是指令通道唯一可靠的会话来源。
			onSessionSeen: (sessionId) => {
				bridge.noteSession(sessionId);
			},
			// 画板上下文：让 canvas_status 能告诉 Agent 画布上有哪些画板。
			getBoardContext: () => {
				const snapshot = board.snapshot();
				return { workspaces: snapshot.workspaces, selectedId: board.activeId };
			},
			// 指令通道状态：让 canvas_status 能把「绑没绑上」直接报出来。
			// 「AI 指令不可用」有三种完全不同的成因，而界面上长得一模一样 ——
			// 报出来才不用靠猜。
			getPromptStatus: () => bridge.status(),
			logger: ctx.logger
		});
		const disposers = tools.map((tool) => ctx.tools.register(tool));
		return () => {
			for (const dispose of disposers) {
				try {
					dispose();
				} catch {
					// 同上
				}
			}
		};
	}, "visual-canvas: tools");

	ctx.logger?.info?.(
		`[visual-canvas] 已挂载：${resolved.prefix}/ → ${resolved.target}（项目根 ${resolved.projectRoot}，`
		+ `${resolved.autoApply ? "直接落盘" : "先预览"}）`
	);
	void pushState;
}

export { inject, name };

/**
 * 测试入口：暴露纯函数与配置解析，供离线单测直接驱动。
 * 生产路径只使用 apply / inject / name。
 */
export const __internals = {
	resolveConfig
};
