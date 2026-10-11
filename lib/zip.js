/**
 * 最小 ZIP 读取器。
 *
 * ## 为什么不装依赖
 *
 * 插件到现在零依赖，这是个刻意的约束：用户装插件不该顺带拖进一棵依赖树。
 * 而 Node 没有内置 zip。整包解压库动辄几百 KB，为一个"读几个 JSON 和 HTML"
 * 的需求不值得。
 *
 * 好在 deflate 压缩 Node 有（`node:zlib` 的 `inflateRawSync`），
 * 剩下的只是解析 ZIP 的目录结构——那部分格式很简单，几十行足够。
 *
 * ## 只读，不写
 *
 * 这个实现**只解压**。插件不需要造 zip，所以不实现压缩、不实现 ZIP64、
 * 不支持加密。遇到这些情况明确报错，而不是悄悄给出坏数据。
 *
 * ## 为什么读中央目录而不是顺序扫本地头
 *
 * ZIP 允许在文件流里塞"已删除"的本地头（本地头可以没有对应数据）。
 * 只有**中央目录**是权威索引。顺着本地头扫会把已删文件也读出来，
 * 或者因为数据描述符（streaming 写法）读到错误的长度。
 */

import { inflateRawSync } from "node:zlib";

/** 中央目录项的固定部分长度。 */
const CENTRAL_HEADER_SIZE = 46;
/** 本地文件头长度。 */
const LOCAL_HEADER_SIZE = 30;

/**
 * 从尾部找到中央目录的结束记录（EOCD）。
 *
 * EOCD 在文件末尾，但后面可能跟最多 65535 字节的注释，所以要往回扫。
 *
 * @param buffer - 整个 zip 的字节。
 * @returns EOCD 的偏移，找不到返回 -1。
 */
function findEndOfCentralDirectory(buffer) {
	const minOffset = Math.max(0, buffer.length - 65557); // 22 字节 EOCD + 最多 65535 注释
	for (let i = buffer.length - 22; i >= minOffset; i -= 1) {
		// EOCD 签名 0x06054b50
		if (buffer[i] === 0x50 && buffer[i + 1] === 0x4b && buffer[i + 2] === 0x05 && buffer[i + 3] === 0x06) return i;
	}
	return -1;
}

/**
 * 读一个 zip 里的所有条目。
 *
 * @param buffer - zip 文件的字节（Buffer 或 Uint8Array）。
 * @returns { entries } —— 每项 { name, data }，data 是 Buffer。
 *   遇到不支持的情况返回 { error }。
 */
export function readZipEntries(buffer) {
	const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
	if (bytes.length < 22) return { error: "不是一个 zip：文件太小" };

	const eocd = findEndOfCentralDirectory(bytes);
	if (eocd < 0) return { error: "不是一个 zip：找不到中央目录结束记录" };

	const total = bytes.readUInt16LE(eocd + 10);
	const directoryOffset = bytes.readUInt32LE(eocd + 16);
	// 0xFFFF / 0xFFFFFFFF 是 ZIP64 的哨兵值。这里不做 ZIP64——
	// 明确报错比读出一堆错位的数据好。
	if (total === 0xffff || directoryOffset === 0xffffffff) {
		return { error: "这是 ZIP64 格式，暂不支持（把包拆小或改用普通 zip）" };
	}

	const entries = [];
	let offset = directoryOffset;
	for (let i = 0; i < total; i += 1) {
		if (offset + CENTRAL_HEADER_SIZE > bytes.length) return { error: "中央目录不完整" };
		// 签名 0x02014b50
		if (bytes.readUInt32LE(offset) !== 0x02014b50) return { error: `第 ${i} 个中央目录项签名不对` };

		const flags = bytes.readUInt16LE(offset + 8);
		const method = bytes.readUInt16LE(offset + 10);
		const compressedSize = bytes.readUInt32LE(offset + 20);
		const nameLength = bytes.readUInt16LE(offset + 28);
		const extraLength = bytes.readUInt16LE(offset + 30);
		const commentLength = bytes.readUInt16LE(offset + 32);
		const localOffset = bytes.readUInt32LE(offset + 42);
		const name = bytes.toString("utf8", offset + CENTRAL_HEADER_SIZE, offset + CENTRAL_HEADER_SIZE + nameLength);

		offset += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;

		if ((flags & 0x1) !== 0) return { error: `「${name}」是加密的，暂不支持` };
		// 目录条目没有数据，跳过（但保留名字，调用方可能要建目录）
		if (name.endsWith("/")) {
			entries.push({ name, data: Buffer.alloc(0), directory: true });
			continue;
		}
		if (localOffset + LOCAL_HEADER_SIZE > bytes.length) return { error: `「${name}」的本地头越界` };

		// 本地头里的 name/extra 长度可能与中央目录不同，必须按本地头自己的来算数据起点
		const localNameLength = bytes.readUInt16LE(localOffset + 26);
		const localExtraLength = bytes.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + LOCAL_HEADER_SIZE + localNameLength + localExtraLength;
		// 压缩长度以 0 写在本地头是"用数据描述符"的流式写法，长度只在中央目录里可靠
		const dataEnd = dataStart + compressedSize;
		if (dataEnd > bytes.length) return { error: `「${name}」的数据越界` };

		const raw = bytes.subarray(dataStart, dataEnd);
		let data;
		if (method === 0) {
			data = Buffer.from(raw); // stored
		} else if (method === 8) {
			try {
				data = inflateRawSync(raw);
			} catch (error) {
				return { error: `「${name}」解压失败：${String(error?.message ?? error)}` };
			}
		} else {
			return { error: `「${name}」用了不支持的压缩方式（method=${method}）` };
		}
		entries.push({ name, data });
	}

	return { entries };
}

/**
 * 判断一段字节是不是 zip。
 *
 * @param buffer - 字节。
 * @returns 是否像 zip。
 */
export function looksLikeZip(buffer) {
	const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
	if (bytes.length < 4) return false;
	// "PK\x03\x04"（普通）或 "PK\x05\x06"（空包）
	return bytes[0] === 0x50 && bytes[1] === 0x4b
		&& ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06));
}
