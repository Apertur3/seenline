// Office conversion is deterministic and local. The linked AI understands this text later.
import { failure } from "./error.ts";
import { HIDDEN_BLOCK, written } from "./hidden.ts";
import { MAX_ROWS, sheets } from "./office-sheets.ts";
import { slides } from "./office-slides.ts";
import { word } from "./office-word.ts";
import { flat, local, packageXml, text, type Xml } from "./office-xml.ts";
import { listedValue, unseen } from "./parse-hidden.ts";

export const OFFICE_FILE = /\.(docx?|pptx?|xlsx?|csv|tsv)$/i;
export const OFFICE_FAILURE = "could not read this file: save it as .docx, .pptx or .xlsx";
const safe = (s: string) => written(s);

export function convertOffice(
	bytes: Uint8Array,
	extension: string,
	maxRows = MAX_ROWS,
): { markdown: string; pages: number } {
	try {
		const ext = extension.toLowerCase().replace(/^.*\./, "");
		if (["doc", "ppt", "xls"].includes(ext)) throw new Error("legacy format");
		if (bytes.length > 50 * 1024 * 1024) throw new Error("file size");
		if (ext === "csv" || ext === "tsv") return { markdown: csv(bytes, ext, maxRows), pages: 1 };
		const parts = packageXml(bytes);
		const out =
			ext === "docx"
				? word(parts)
				: ext === "pptx"
					? slides(parts)
					: ext === "xlsx"
						? sheets(parts, maxRows)
						: null;
		if (!out) throw new Error("format");
		for (const [name, node] of parts) {
			const value = /(?:comments\d*|comment\d*)\.xml$/i.test(name)
				? text(node)
				: /^(docProps|customXml)\//.test(name) && !GENERATED.test(name)
					? partText(node, name)
					: "";
			if (flat(value)) out.hidden.push(`${name}: ${flat(value)}`);
		}
		// Slide and sheet readers mark their own text lines; a Word body has no anchors of its own.
		const lines = out.body.filter(Boolean).map(ext === "docx" ? safe : String);
		const listed = unseen(lines, out.hidden.map(safe));
		if (listed.length) lines.push(HIDDEN_BLOCK, ...listed);
		if (!lines.length) throw new Error("no text");
		const result = `${lines.join("\n")}\n`;
		if (Buffer.byteLength(result) > 5 * 1024 * 1024) throw new Error("text size");
		return { markdown: result, pages: out.pages ?? 1 };
	} catch (error) {
		throw failure(error, OFFICE_FAILURE);
	}
}

function csv(bytes: Uint8Array, ext: string, maxRows: number): string {
	const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	if (source.includes("\0")) throw new Error("binary CSV");
	const delimiter = ext === "tsv" ? "\t" : detect(source);
	const rows: string[][] = [];
	let row: string[] = [],
		cell = "",
		quoted = false,
		closed = false;
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		if (quoted) {
			if (c === '"' && source[i + 1] === '"') {
				cell += '"';
				i++;
			} else if (c === '"') {
				quoted = false;
				closed = true;
			} else cell += c;
		} else if (c === '"' && cell === "" && !closed) quoted = true;
		else if (c === delimiter) {
			row.push(cell);
			cell = "";
			closed = false;
		} else if (c === "\n" || c === "\r") {
			if (c === "\r" && source[i + 1] === "\n") i++;
			rows.push([...row, cell]);
			row = [];
			cell = "";
			closed = false;
			if (rows.length > maxRows) break;
		} else {
			if (closed || c === '"') throw new Error("CSV quoting");
			cell += c;
		}
	}
	if (quoted) throw new Error("CSV quote");
	if (cell || row.length) rows.push([...row, cell]);
	if (!rows.length) throw new Error("empty CSV");
	const lines = rows
		.slice(0, maxRows)
		.flatMap((r, i) => [`[row ${i + 1}]`, safe(r.map(flat).join(" | "))]);
	if (rows.length > maxRows) lines.push(`[truncated: first ${maxRows} rows only]`);
	const result = `${lines.join("\n")}\n`;
	if (Buffer.byteLength(result) > 5 * 1024 * 1024) throw new Error("text size");
	return result;
}

function detect(source: string): string {
	const counts = new Map([
		[",", 0],
		[";", 0],
		["\t", 0],
		["|", 0],
	]);
	let quoted = false;
	for (const c of source.slice(0, 65536)) {
		if (c === '"') quoted = !quoted;
		if (!quoted && (c === "\n" || c === "\r")) break;
		if (!quoted && counts.has(c)) counts.set(c, (counts.get(c) ?? 0) + 1);
	}
	return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ",";
}

// Package parts a program writes for itself: relationships, data-store ids, and the SharePoint
// form, content-type and event definitions a library stamps on every file. Statistics and the
// generated title list in app.xml likewise; only its free-text fields are read.
const GENERATED = /^customXml\/(?:_rels\/|itemProps)/;
const DEFINITIONS = ["FormTemplates", "contentTypeSchema", "Receivers"];
const APP_FIELDS = ["Company", "Manager"];
// Namespace declarations, nil markers and the citation style Word records on a bibliography.
const SETTINGS = /^(?:xmlns|xsi:|SelectedStyle$|StyleName$)/;

/** A property or custom XML part's values worth listing; custom XML attributes as `name: value`. */
function partText(n: Xml, part: string, depth = 0): string {
	const name = local(n) ?? "";
	if (depth === 0 && DEFINITIONS.includes(name)) return "";
	if (depth === 1 && part === "docProps/app.xml" && !APP_FIELDS.includes(name)) return "";
	if (name === "language") return "";
	const attrs = part.startsWith("customXml/")
		? Object.entries(n.attrs).filter(([k, v]) => !SETTINGS.test(k) && listedValue(k, v))
		: [];
	return [
		...attrs.map(([k, v]) => `${k}: ${v}`),
		...n.children.map((c) =>
			typeof c !== "string" ? partText(c, part, depth + 1) : listedValue(name, c) ? c : "",
		),
	]
		.filter((s) => s.trim())
		.join(" ");
}
