// fflate deliberately omits ZIP integrity checks; office documents must fail closed on corruption.
import { unzipSync } from "fflate";

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, i) => {
	let n = i;
	for (let j = 0; j < 8; j++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
	return n >>> 0;
});
function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const b of bytes) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ b) & 255] as number);
	return (crc ^ 0xffffffff) >>> 0;
}

export function officeZip(bytes: Uint8Array): Record<string, Uint8Array> {
	const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
	let end = b.length - 22;
	while (end >= Math.max(0, b.length - 65557) && b.readUInt32LE(end) !== 0x06054b50) end--;
	if (
		end < 0 ||
		b.readUInt32LE(end) !== 0x06054b50 ||
		end + 22 > b.length ||
		end + 22 + b.readUInt16LE(end + 20) !== b.length
	)
		throw new Error("ZIP end");
	if (b.readUInt16LE(end + 4) || b.readUInt16LE(end + 6)) throw new Error("multipart ZIP");
	const count = b.readUInt16LE(end + 10);
	if (count > 5000 || count !== b.readUInt16LE(end + 8)) throw new Error("ZIP count");
	let at = b.readUInt32LE(end + 16),
		total = 0;
	const checks = new Map<string, { crc: number; size: number }>();
	for (let i = 0; i < count; i++) {
		if (b.readUInt32LE(at) !== 0x02014b50 || b.readUInt16LE(at + 8) & 1)
			throw new Error("ZIP entry");
		const size = b.readUInt32LE(at + 24),
			length = b.readUInt16LE(at + 28);
		const name = new TextDecoder("utf-8", { fatal: true }).decode(
			b.subarray(at + 46, at + 46 + length),
		);
		if (checks.has(name) || name.includes("..") || name.startsWith("/"))
			throw new Error("ZIP path");
		total += size;
		if (size > 32 * 1024 * 1024 || total > 64 * 1024 * 1024) throw new Error("ZIP size");
		checks.set(name, { crc: b.readUInt32LE(at + 16), size });
		at += 46 + length + b.readUInt16LE(at + 30) + b.readUInt16LE(at + 32);
	}
	if (at !== end || at - b.readUInt32LE(end + 16) !== b.readUInt32LE(end + 12))
		throw new Error("ZIP directory");
	const files = unzipSync(bytes, { filter: (f) => /\.(xml|rels)$/i.test(f.name) });
	for (const [name, data] of Object.entries(files)) {
		const check = checks.get(name);
		if (!check || check.size !== data.length || check.crc !== crc32(data))
			throw new Error("ZIP integrity");
	}
	return files;
}
