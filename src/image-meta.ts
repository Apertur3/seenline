// The text an image carries outside its pixels: PNG text chunks, JPEG comments, the EXIF text tags and
// XMP. A reader of the picture never sees it, so it goes to the flagged block,
// one line each. Anything that is not a well-formed PNG or JPEG yields nothing.
import { inflateSync } from "node:zlib";

const MAX_LINE = 2000;
const flat = (s: string) => {
	const t = s.replace(/[\s\0]+/g, " ").trim();
	return t.length > MAX_LINE ? `${t.slice(0, MAX_LINE)} [cut at ${MAX_LINE} characters]` : t;
};
const XMP_TEXT =
	/<(dc:(?:title|description|subject|creator)|exif:UserComment)\b[^>]*>([\s\S]*?)<\/\1>/g;
// Tags that are free text a person wrote (0x010e, 0x9286, 0x9c9c, 0x9c9f, 0x9c9b); camera make, model and software are not.
const EXIF_TEXT: Record<number, string> = {
	270: "ImageDescription",
	37510: "UserComment",
	40092: "XPComment",
	40095: "XPSubject",
	40091: "XPTitle",
};
// A compressed chunk is bounded: a few KB of zeros must not become a gigabyte.
const inflate = (b: Buffer) => inflateSync(b, { maxOutputLength: 1 << 20 });
const SKIP_PNG = new Set(["Software", "Creation Time", "Source"]);

export function imageMeta(bytes: Uint8Array): string[] {
	const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
	try {
		if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
			return png(b);
		if (b[0] === 0xff && b[1] === 0xd8) return jpeg(b);
	} catch {}
	return [];
}

function png(b: Buffer): string[] {
	const out: string[] = [];
	for (let at = 8; at + 8 <= b.length; ) {
		const len = b.readUInt32BE(at);
		const type = b.toString("latin1", at + 4, at + 8);
		const data = b.subarray(at + 8, at + 8 + len);
		const zero = data.indexOf(0);
		const key = data.toString("latin1", 0, Math.max(zero, 0));
		let text = "";
		try {
			if (type === "tEXt") text = data.toString("latin1", zero + 1);
			if (type === "zTXt") text = inflate(data.subarray(zero + 2)).toString("latin1");
			if (type === "iTXt") {
				// key, flag, method, language tag, translated key, then the text
				const lang = data.indexOf(0, zero + 3);
				const body = data.subarray(data.indexOf(0, lang + 1) + 1);
				text = (data[zero + 1] ? inflate(body) : body).toString("utf8");
			}
		} catch {
			text = "could not be read (too large or damaged)"; // flagged, never silent
		}
		// Software and the like are tool names; only a long value is treated as text someone wrote.
		const tool = SKIP_PNG.has(key) && flat(text).length <= 100;
		if (flat(text) && !tool) out.push(`image metadata ${key}: ${flat(text)}`);
		at += 12 + len;
	}
	return out;
}

function jpeg(b: Buffer): string[] {
	const out: string[] = [];
	for (let at = 2; at + 4 <= b.length && b[at] === 0xff; ) {
		const marker = b[at + 1] ?? 0;
		if (marker === 0xda) break; // the image data starts
		const len = b.readUInt16BE(at + 2);
		const seg = b.subarray(at + 4, at + 2 + len);
		if (marker === 0xfe && flat(seg.toString("utf8")))
			out.push(`image metadata Comment: ${flat(seg.toString("utf8"))}`);
		if (marker === 0xe1 && seg.subarray(0, 6).toString("latin1") === "Exif\0\0")
			out.push(...exif(seg.subarray(6)));
		if (marker === 0xe1 && seg.toString("latin1", 0, 28) === "http://ns.adobe.com/xap/1.0/")
			out.push(...xmp(seg.toString("utf8")));
		at += 2 + len;
	}
	return out;
}

function xmp(raw: string): string[] {
	const out: string[] = [];
	for (const [, tag, inner] of raw.matchAll(XMP_TEXT)) {
		const text = flat((inner ?? "").replace(/<[^>]*>/g, " "));
		if (text) out.push(`image metadata ${tag}: ${text}`);
	}
	return out;
}

// TIFF structure inside the EXIF segment: IFD0, and the EXIF IFD it points to.
function exif(t: Buffer): string[] {
	const le = t.toString("latin1", 0, 2) === "II";
	const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
	const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
	const out: string[] = [];
	const ifd = (start: number, depth: number) => {
		for (let i = 0, n = u16(start); i < n; i++) {
			const e = start + 2 + i * 12;
			const tag = u16(e);
			const size = u32(e + 4) * ([0, 1, 1, 2, 4, 8, 1, 1][u16(e + 2)] ?? 1);
			const data = t.subarray(
				size > 4 ? u32(e + 8) : e + 8,
				(size > 4 ? u32(e + 8) : e + 8) + size,
			);
			if (tag === 0x8769 && depth === 0) ifd(u32(e + 8), 1);
			const name = EXIF_TEXT[tag];
			if (!name) continue;
			// XP tags are UTF-16, UserComment starts with an 8-byte character code, the rest is ASCII.
			const text =
				tag >= 0x9c9b ? data.toString("utf16le") : data.toString("latin1", tag === 0x9286 ? 8 : 0);
			if (flat(text)) out.push(`image metadata ${name}: ${flat(text)}`);
		}
	};
	ifd(u32(4), 0);
	return out;
}
