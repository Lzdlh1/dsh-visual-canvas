/**
 * 结构化日志 —— 只为**快速定位问题**而存在。
 *
 * ## 为什么要有它（2026-10-07 的教训）
 *
 * 同一个问题（"拖动后弹回原位"）连续排查了**六轮**都没定位。根子不是代码难，
 * 而是**看不到运行现场**：
 *
 *   - 定位器最终挑中了哪一行？—— 不知道
 *   - 写回为什么被拒？—— 只看到界面上一句"已撤回预览"
 *   - 消息到底发出去没有？—— 只能靠加打印再让用户复现
 *
 * 全靠读代码猜，猜错了三轮（键盘事件 → pin → Alt 语义 → 甚至改错了对象）。
 * 最后是**让用户截图状态栏** + **写脚本逐行打印打分**，才一次看清四个真因。
 * **如果当时有日志，第一轮就能看到候选列表。**
 *
 * ## 设计约束（按 `logging-scaffold` 技能）
 *
 * - **结构化**：JSON Lines，一行一条；能 grep 能 jq，追加写不破坏旧内容
 * - **先于业务**：日志是基础设施，加新功能时顺手记，而不是出事了才补
 * - **强制脱敏**：字段黑名单 + 长随机串正则兜底；密钥 / token 永不落盘
 * - **不引入依赖**：手写 JSONL 就够（规则里明确不擅自加依赖）
 * - **只读**：日志**绝不参与业务判断**，写失败也只是静默降级
 *
 * ## 三个关键设计
 *
 * 1. **`trace`**：一次用户操作（点选 → 拖动 → 写回）共用同一个 id。
 *    编辑层在**外壳**、定位写回在**宿主**，跨进程排查时最难的就是"这两条日志
 *    是不是同一次操作" —— 有了 trace 就能直接串起来。
 * 2. **环形缓冲**：内存里留最近若干条，用户一出问题就能**一次性导出**，
 *    不必去翻可能有几十 MB 的日志文件。
 * 3. **分级**：默认 `info`；排障时用环境变量开到 `debug` / `trace`，不用改代码。
 *
 * ## 用法
 *
 * ```js
 * import { createLogger } from "./log.js";
 * const log = createLogger({ dir: "/path/to/.dsh-canvas/logs", service: "canvas-host" });
 * log.info("locate", { trace, file, line, confidence, candidates: 5 });
 * log.error("apply-failed", { trace, kind, reason });
 * ```
 *
 * @module log
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 需要遮蔽的字段名（小写比较，包含即命中）。
 *
 * 按技能给的黑名单；这里再补几个本项目会遇到的（凭据类路径）。
 */
const SENSITIVE_KEYS = new Set([
	"password", "passwd", "secret", "token", "apikey", "api_key", "api-key",
	"authorization", "auth", "cookie", "set-cookie", "credential", "credentials",
	"privatekey", "private_key", "session", "sessionid", "creditcard", "credit_card",
	"idcard", "id_card", "phone", "email", "ssn"
]);

/**
 * 长随机串兜底：字段名看不出来、但值明显像密钥的。
 *
 * 技能里点名的几种前缀 + 通用高熵串。
 */
const SECRET_PATTERNS = [
	/\bsk-[A-Za-z0-9_-]{16,}/gu,
	/\bghp_[A-Za-z0-9]{20,}/gu,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/gu,
	/\bAKIA[0-9A-Z]{12,}/gu,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}/gu,
	// JWT：三段式 `header.payload.signature`。
	// 段长差异很大（header 常见的就 20 字符左右，payload 可能更短），
	// **门槛放到 8** 才兜得住 —— 第一版写 `{20,}`，测试里一个真实的短 JWT
	// 直接漏过去了。兜底要的是"宁可多遮蔽"，不是"精确匹配"。
	/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/gu,
	/\bBearer\s+[A-Za-z0-9._-]{20,}/gu
];

/** 遮蔽后的占位符。 */
const REDACTED = "[REDACTED]";

/** 值的最大长度：日志是给人看的，超长值只会淹没关键信息。 */
const MAX_VALUE_LENGTH = 400;

/** 内存里保留多少条（供一键导出）。 */
const BUFFER_SIZE = 400;

/**
 * 把一个值转成**能安全落盘**的短值。
 *
 * @param value - 任意值。
 * @param depth - 当前深度（防深层嵌套炸栈）。
 * @param seen - 当前**递归路径上**的对象（检测真正的环）。
 *   用"进出栈"而不是"全局记住"：同一个对象出现在兄弟位置是正常的 DAG，
 *   只有指向**自己的祖先**才是环。
 * @returns 可 JSON 序列化的值。
 */
function sanitize(value, depth = 0, seen = new Set()) {
	if (value === null || value === undefined) return value;
	if (typeof value === "string") {
		let text = value;
		for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, REDACTED);
		return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}…` : text;
	}
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "function") return "[function]";
	if (value instanceof Error) {
		return { name: value.name, message: value.message, stack: String(value.stack ?? "").split("\n").slice(0, 4).join("\n") };
	}
	if (depth >= 4) return "[deep]";
	if (Array.isArray(value)) {
		// 数组不参与环检测（自己套自己在日志场景里几乎不会是排查重点），只限深度
		return value.slice(0, 30).map((item) => sanitize(item, depth + 1, seen));
	}
	if (typeof value === "object") {
		// **真正的环**：这个对象已经在当前这条递归路径上了。
		//
		// 只靠 `depth >= 4` 是不够的 —— 那要展开四层才发现问题，
		// 前三层会原样写进日志（既浪费体积，又可能把巨大的对象整个拷进去）。
		if (seen.has(value)) return "[circular]";
		seen.add(value);
		const out = {};
		for (const [key, item] of Object.entries(value)) {
			// 字段名命中黑名单 → 整条遮蔽（不记值，连长度都不记）
			if (SENSITIVE_KEYS.has(key.toLowerCase())) {
				out[key] = REDACTED;
				continue;
			}
			out[key] = sanitize(item, depth + 1, seen);
		}
		seen.delete(value);
		return out;
	}
	return String(value);
}

/**
 * 建一个 logger。
 *
 * @param options - { dir, service, level, bufferSize, console }。
 *   - `dir`：日志目录；给了才落盘（测试里可以不给，只走内存缓冲）。
 *   - `service`：服务名，用来区分来源（`canvas-host` / `canvas-shell`）。
 *   - `level`：`error` | `warn` | `info` | `debug` | `trace`，默认读环境变量
 *     `DSH_CANVAS_LOG_LEVEL`，再退回 `info`。
 *   - `console`：是否同时打到 stderr（开发时方便，默认关）。
 * @returns logger 对象。
 */
export function createLogger(options = {}) {
	const service = String(options.service ?? "canvas");
	const levels = ["error", "warn", "info", "debug", "trace"];
	const wanted = String(options.level ?? process.env.DSH_CANVAS_LOG_LEVEL ?? "info").toLowerCase();
	const threshold = Math.max(0, levels.indexOf(wanted));
	const bufferSize = Number.isInteger(options.bufferSize) ? options.bufferSize : BUFFER_SIZE;
	const toConsole = options.console === true;
	const dir = typeof options.dir === "string" && options.dir !== "" ? options.dir : null;

	/** 内存环形缓冲：出问题时一次性导出，不用翻文件。 */
	const buffer = [];
	let file = null;

	if (dir !== null) {
		try {
			mkdirSync(dir, { recursive: true });
			// 按天分文件：一个文件不会无限长大，翻起来也快
			const day = new Date().toISOString().slice(0, 10);
			file = join(dir, `canvas-${day}.jsonl`);
		} catch {
			// 建目录失败就只走内存缓冲 —— **日志不该影响业务**
			file = null;
		}
	}

	/**
	 * 写一条。
	 * @param level - 级别。
	 * @param event - 机器可读的事件名（建议 `动作-结果`，如 `locate-miss`）。
	 * @param data - 附加上下文。
	 * @returns 写进去的那条记录（测试用）。
	 */
	function write(level, event, data) {
		if (levels.indexOf(level) > threshold) return null;
		const record = {
			ts: new Date().toISOString(),
			level,
			service,
			event: String(event ?? "?"),
			...sanitize(data ?? {})
		};

		buffer.push(record);
		if (buffer.length > bufferSize) buffer.shift();

		// 落盘**失败也不抛**：日志是辅助设施，不能把业务带崩
		if (file !== null) {
			try {
				appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
			} catch { /* 静默降级到内存缓冲 */ }
		}
		if (toConsole) {
			try {
				process.stderr.write(`${JSON.stringify(record)}\n`);
			} catch { /* 忽略 */ }
		}
		return record;
	}

	const logger = {
		service,
		/** 日志文件路径（没落盘时为 null）。 */
		file,
		error: (event, data) => write("error", event, data),
		warn: (event, data) => write("warn", event, data),
		info: (event, data) => write("info", event, data),
		debug: (event, data) => write("debug", event, data),
		trace: (event, data) => write("trace", event, data),
		/** 当前级别（排障时先确认这个，别以为"没日志=没发生"）。 */
		level: levels[threshold],
		/** 最近若干条（供一键导出 / 测试断言）。 */
		recent: (count = bufferSize) => buffer.slice(-count),
		/** 清空内存缓冲（落盘的不动）。 */
		clear: () => { buffer.length = 0; }
	};
	return logger;
}

/**
 * 生成一个短 trace id（**实现在 `canvas/trace.js`**）。
 *
 * ⚠️ 它不能放在这个文件里：`log.js` 为了落盘 `import` 了 `node:fs`，是**宿主侧**模块。
 * 而外壳脚本（浏览器）也要生成 trace —— 让它 import 这个文件，
 * 会因为加载 `node:fs` 失败而**把整个外壳带崩**。
 *
 * 而 `trace.js` 又必须待在 `lib/canvas/`（和引用它的 `edit.js` **同目录**）：
 * 外壳文件由白名单提供（`lib/handler.js` 的 `SHELL_FILES`），
 * 上一层目录的模块浏览器请求不到（404）。
 *
 * 2026-10-07 这两个坑都实测踩过，**每一个都让画布整个不响应**。
 * 这里重新导出只为让宿主侧的老调用点不用改。
 */
export { newTrace } from "./canvas/trace.js";

export { SENSITIVE_KEYS, SECRET_PATTERNS, REDACTED };
