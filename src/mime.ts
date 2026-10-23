// MIME is byte-oriented until each leaf has its own transfer encoding and charset.
export interface MimePart {
	headers: Map<string, string>;
	type: string;
	params: Record<string, string>;
	bytes: Buffer;
	children: MimePart[];
}
export function decodeCharset(bytes: Uint8Array, charset = "utf-8"): string {
	const label = charset.toLowerCase();
	if (
		!["utf-8", "utf8", "us-ascii", "ascii", "iso-8859-1", "latin1", "windows-1252"].includes(label)
	)
		throw new Error("unsupported charset");
	if (["us-ascii", "ascii"].includes(label) && bytes.some((b) => b > 127))
		throw new Error("non-ASCII bytes");
	return new TextDecoder(label === "latin1" ? "windows-1252" : label, { fatal: true }).decode(
		bytes,
	);
}
export function transfer(raw: string, encoding: string): Buffer {
	if (encoding === "base64") {
		const value = raw.replace(/\s/g, "");
		if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
			throw new Error("invalid base64");
		return Buffer.from(value, "base64");
	}
	if (encoding === "quoted-printable") {
		const joined = raw.replace(/=\r?\n/g, "");
		if (/=(?![\da-f]{2})/i.test(joined)) throw new Error("invalid quoted-printable");
		return Buffer.from(
			joined.replace(/=([\da-f]{2})/gi, (_, h: string) =>
				String.fromCharCode(Number.parseInt(h, 16)),
			),
			"latin1",
		);
	}
	if (!["", "7bit", "8bit", "binary"].includes(encoding))
		throw new Error("unsupported transfer encoding");
	return Buffer.from(raw, "latin1");
}
export function headerText(s: string): string {
	if (/[\x80-\xff]/.test(s)) s = decodeCharset(Buffer.from(s, "latin1"));
	return s
		.replace(
			/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,
			(_, charset: string, kind: string, value: string) =>
				decodeCharset(
					transfer(
						kind.toLowerCase() === "q" ? value.replace(/_/g, " ") : value,
						kind.toLowerCase() === "q" ? "quoted-printable" : "base64",
					),
					charset,
				),
		)
		.replace(/[\r\n\t]+/g, " ");
}
export function mimeParams(raw: string): { value: string; params: Record<string, string> } {
	const value = raw.split(";")[0]?.trim().toLowerCase() ?? "";
	const params: Record<string, string> = Object.create(null);
	let at = raw.indexOf(";");
	const re = /;\s*([\w*-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))\s*/gy;
	// A trailing ";" after the last parameter is common and carries nothing.
	while (at >= 0 && at < raw.length && raw.slice(at).replace(/^;/, "").trim()) {
		re.lastIndex = at;
		const m = re.exec(raw);
		if (!m) throw new Error("MIME parameter");
		const key = (m[1] as string).toLowerCase();
		if (Object.hasOwn(params, key)) throw new Error("duplicate MIME parameter");
		params[key] = (m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1");
		at = re.lastIndex;
	}
	return { value, params };
}
function splitHeaders(raw: string, part: boolean) {
	// A MIME part that starts with a blank line has no headers (RFC 2046 5.1.1); a message must have them.
	if (part && /^\r?\n/.test(raw))
		return { headers: new Map<string, string>(), body: raw.replace(/^\r?\n/, "") };
	const separator = /\r?\n\r?\n/.exec(raw);
	if (!separator || separator.index > 64 * 1024) throw new Error("MIME headers");
	const headers = new Map<string, string>();
	const lines = raw
		.slice(0, separator.index)
		.replace(/\r?\n[ \t]+/g, " ")
		.split(/\r?\n/);
	if (lines.length > 200) throw new Error("MIME header count");
	for (const line of lines) {
		const m = /^([!-9;-~]+):[ \t]*(.*)$/.exec(line);
		if (!m) throw new Error("MIME header");
		const key = (m[1] as string).toLowerCase();
		// Repeated Received fields are ordinary. Ambiguous content and identity headers are not.
		if (headers.has(key) && /^(?:content-|from$|to$|cc$|date$|subject$|mime-version$)/.test(key))
			throw new Error("duplicate MIME header");
		headers.set(key, headers.has(key) ? `${headers.get(key)}; ${m[2]}` : (m[2] as string));
	}
	return { headers, body: raw.slice(separator.index + separator[0].length) };
}
export function readMime(bytes: Uint8Array): MimePart {
	if (bytes.length > 50 * 1024 * 1024) throw new Error("MIME size");
	let count = 0;
	const parse = (raw: string, depth: number): MimePart => {
		if (++count > 200 || depth > 20) throw new Error("MIME parts budget");
		const { headers, body } = splitHeaders(raw, depth > 0);
		const { value: type, params } = mimeParams(
			headers.get("content-type") ?? "text/plain; charset=us-ascii",
		);
		const part: MimePart = { headers, type, params, bytes: Buffer.alloc(0), children: [] };
		const encoding = (headers.get("content-transfer-encoding") ?? "").trim().toLowerCase();
		if (!type.startsWith("multipart/")) {
			part.bytes = transfer(body, encoding);
			return part;
		}
		if (!["", "7bit", "8bit", "binary"].includes(encoding)) throw new Error("encoded multipart");
		const boundary = params.boundary;
		if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary))
			throw new Error("MIME boundary");
		let current: string[] | null = null;
		for (const line of body.split(/\r?\n/)) {
			// Trailing blanks trimmed from the start of their run only, so a long blank run costs one scan.
			const bare = line.replace(/(?<![ \t])[ \t]+$/, "");
			if (bare === `--${boundary}` || bare === `--${boundary}--`) {
				if (current) part.children.push(parse(current.join("\r\n"), depth + 1));
				current = null;
				if (line.trimEnd() === `--${boundary}--`) break;
				current = [];
			} else if (current) current.push(line);
		}
		// A truncated message without its closing boundary: mail readers show the last part to the end.
		if (current) part.children.push(parse(current.join("\r\n"), depth + 1));
		if (!part.children.length) throw new Error("unclosed MIME multipart");
		return part;
	};
	// An mbox export starts with a "From sender weekday date" envelope line before the headers; keep
	// it as a header the scan sees. Any other first line without a colon still fails.
	const raw = Buffer.from(bytes)
		.toString("latin1")
		.replace(
			/^From (\S+ +(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [^\r\n]*)(?=\r?\n[!-9;-~]+:)/,
			"Mbox-From: $1",
		);
	return parse(raw, 0);
}
