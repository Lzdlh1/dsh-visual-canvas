/**
 * 最小 WebSocket 服务端实现（只做覆盖层需要的那部分）。
 *
 * 为什么不用 `ws`：本插件的原则是不引入新依赖。WebSocket 的服务端握手与帧格式
 * 是稳定的公开标准（RFC 6455），实现文本帧 + 控制帧所需的代码不到 200 行，
 * 而且完全在我们控制之下。
 *
 * 支持：
 * - 握手（含 `Sec-WebSocket-Accept` 校验）
 * - 文本 / 二进制帧
 * - 分片消息重组（continuation 帧）
 * - ping / pong / close 控制帧
 * - 掩码解码（客户端发来的帧必须带掩码）
 *
 * 不支持（覆盖层用不到）：扩展协商（permessage-deflate）、服务端分片发送。
 */

import { createHash } from "node:crypto";

/** 握手用的固定 GUID（RFC 6455）。 */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** 帧操作码。 */
const OPCODE = {
	continuation: 0x0,
	text: 0x1,
	binary: 0x2,
	close: 0x8,
	ping: 0x9,
	pong: 0xa
};

/** 单条消息的字节上限，防内存放大攻击。 */
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

/**
 * 计算握手响应里的 Sec-WebSocket-Accept。
 * @param key - 客户端发来的 Sec-WebSocket-Key。
 * @returns 应答值。
 */
export function acceptKey(key) {
	return createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
}

/**
 * 校验一个入站升级请求是不是合法的 WebSocket 握手。
 * @param req - Node 请求对象。
 * @returns { ok: boolean, reason?: string }。
 */
export function isWebSocketUpgrade(req) {
	const upgrade = String(req.headers?.upgrade ?? "").toLowerCase();
	if (upgrade !== "websocket") return { ok: false, reason: `upgrade 头不是 websocket: ${upgrade}` };
	const key = req.headers?.["sec-websocket-key"];
	if (typeof key !== "string" || key === "") return { ok: false, reason: "缺少 sec-websocket-key" };
	const version = String(req.headers?.["sec-websocket-version"] ?? "");
	if (version !== "13") return { ok: false, reason: `不支持的 sec-websocket-version: ${version}` };
	return { ok: true };
}

/**
 * 完成握手，把 socket 升级为 WebSocket。
 * @param req - Node 请求对象。
 * @param socket - TCP socket。
 * @returns 是否成功。
 */
export function completeHandshake(req, socket) {
	const check = isWebSocketUpgrade(req);
	if (!check.ok) return false;
	const accept = acceptKey(String(req.headers["sec-websocket-key"]));
	socket.write([
		"HTTP/1.1 101 Switching Protocols",
		"Upgrade: websocket",
		"Connection: Upgrade",
		`Sec-WebSocket-Accept: ${accept}`,
		"",
		""
	].join("\r\n"));
	return true;
}

/**
 * 编码一个服务端帧（不掩码，服务端发出的帧按规范不加掩码）。
 * @param opcode - 操作码。
 * @param payload - 载荷 Buffer。
 * @returns 帧 Buffer。
 */
export function encodeFrame(opcode, payload) {
	const length = payload.length;
	let header;
	if (length < 126) {
		header = Buffer.alloc(2);
		header[1] = length;
	} else if (length < 65_536) {
		header = Buffer.alloc(4);
		header[1] = 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.alloc(10);
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(length), 2);
	}
	header[0] = 0x80 | opcode; // FIN + opcode
	return Buffer.concat([header, payload]);
}

/**
 * 增量解析器：把 TCP 字节流切成 WebSocket 帧。
 *
 * 用法：new FrameParser(onMessage, onControl)，收到数据时喂 push(chunk)。
 */
export class FrameParser {
	/**
	 * @param onMessage - (payloadText: string, isBinary: boolean) => void
	 * @param onControl - (opcode: number, payload: Buffer) => void
	 */
	constructor(onMessage, onControl) {
		this.buffer = Buffer.alloc(0);
		this.fragments = [];
		this.fragmentOpcode = null;
		this.onMessage = onMessage;
		this.onControl = onControl;
	}

	/**
	 * 喂入一段数据。
	 * @param chunk - 收到的字节。
	 */
	push(chunk) {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		// 一个 TCP 段里可能有多帧，循环吃到不够一帧为止。
		while (this.readOne()) {
			// 继续
		}
	}

	/**
	 * 尝试解析一帧。
	 * @returns 是否消费了一帧（false 表示数据不够）。
	 */
	readOne() {
		const buffer = this.buffer;
		if (buffer.length < 2) return false;
		const fin = (buffer[0] & 0x80) !== 0;
		const opcode = buffer[0] & 0x0f;
		const masked = (buffer[1] & 0x80) !== 0;
		let length = buffer[1] & 0x7f;
		let offset = 2;

		if (length === 126) {
			if (buffer.length < offset + 2) return false;
			length = buffer.readUInt16BE(offset);
			offset += 2;
		} else if (length === 127) {
			if (buffer.length < offset + 8) return false;
			const big = buffer.readBigUInt64BE(offset);
			if (big > BigInt(MAX_MESSAGE_BYTES)) throw new Error("帧超过上限");
			length = Number(big);
			offset += 8;
		}

		let maskKey = null;
		if (masked) {
			if (buffer.length < offset + 4) return false;
			maskKey = buffer.subarray(offset, offset + 4);
			offset += 4;
		}

		if (buffer.length < offset + length) return false;
		let payload = buffer.subarray(offset, offset + length);
		if (maskKey !== null) {
			const copy = Buffer.from(payload);
			for (let i = 0; i < copy.length; i += 1) copy[i] ^= maskKey[i % 4];
			payload = copy;
		}
		this.buffer = buffer.subarray(offset + length);

		// 控制帧：可以插在分片消息中间。
		if (opcode === OPCODE.close || opcode === OPCODE.ping || opcode === OPCODE.pong) {
			this.onControl(opcode, payload);
			return true;
		}

		if (opcode === OPCODE.continuation) {
			this.fragments.push(payload);
			if (!fin) return true;
			const full = Buffer.concat(this.fragments);
			const op = this.fragmentOpcode;
			this.fragments = [];
			this.fragmentOpcode = null;
			this.emit(full, op);
			return true;
		}

		if (!fin) {
			this.fragmentOpcode = opcode;
			this.fragments = [payload];
			return true;
		}

		this.emit(payload, opcode);
		return true;
	}

	/**
	 * 交付一条完整消息。
	 * @param payload - 完整载荷。
	 * @param opcode - 起始帧的操作码。
	 */
	emit(payload, opcode) {
		if (payload.length > MAX_MESSAGE_BYTES) throw new Error("消息超过上限");
		this.onMessage(payload.toString("utf8"), opcode === OPCODE.binary);
	}
}

/**
 * 一个已连接的覆盖层客户端。
 */
export class Peer {
	/**
	 * @param socket - TCP socket。
	 * @param meta - { remoteAddress }。
	 */
	constructor(socket, meta = {}) {
		this.socket = socket;
		this.meta = meta;
		this.closed = false;
		this.parser = new FrameParser(
			(text, isBinary) => this.onMessage?.(text, isBinary),
			(opcode, payload) => this.onControl(opcode, payload)
		);
		socket.on("data", (chunk) => {
			try {
				this.parser.push(chunk);
			} catch (error) {
				this.close(1009, String(error?.message ?? error));
			}
		});
		socket.on("close", () => {
			this.closed = true;
			this.onClose?.();
		});
		socket.on("error", () => {
			this.closed = true;
			this.onClose?.();
		});
	}

	/**
	 * 处理控制帧。
	 * @param opcode - 操作码。
	 * @param payload - 载荷。
	 */
	onControl(opcode, payload) {
		if (opcode === OPCODE.ping) {
			this.sendFrame(OPCODE.pong, payload);
			return;
		}
		if (opcode === OPCODE.close) {
			this.close(1000, "");
		}
	}

	/**
	 * 发一帧。
	 * @param opcode - 操作码。
	 * @param payload - 载荷。
	 */
	sendFrame(opcode, payload) {
		if (this.closed) return;
		try {
			this.socket.write(encodeFrame(opcode, payload));
		} catch {
			this.closed = true;
		}
	}

	/**
	 * 发一条文本消息。
	 * @param text - 文本。
	 */
	send(text) {
		this.sendFrame(OPCODE.text, Buffer.from(String(text), "utf8"));
	}

	/**
	 * 发一条 JSON 消息。
	 * @param payload - 可序列化对象。
	 */
	sendJson(payload) {
		this.send(JSON.stringify(payload));
	}

	/**
	 * 关闭连接。
	 * @param code - 关闭码。
	 * @param reason - 原因文本。
	 */
	close(code = 1000, reason = "") {
		if (this.closed) return;
		this.closed = true;
		const reasonBytes = Buffer.from(String(reason), "utf8").subarray(0, 123);
		const payload = Buffer.alloc(2 + reasonBytes.length);
		payload.writeUInt16BE(code, 0);
		reasonBytes.copy(payload, 2);
		try {
			this.socket.write(encodeFrame(OPCODE.close, payload));
		} catch {
			// 忽略
		}
		this.socket.end();
	}
}
