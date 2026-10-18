// The text a PDF carries outside its pages: document properties, annotations and form fields,
// attachments and scripts. None of it is in the page a reader sees, so it goes to the flagged block
// one line each, never dropped.
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

const MAX_LINE = 2000;
const flat = (s: string) => {
	const t = s.replace(/[\s\0]+/g, " ").trim();
	return t.length > MAX_LINE ? `${t.slice(0, MAX_LINE)} [cut at ${MAX_LINE} characters]` : t;
};
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const XMP_TEXT =
	/<(dc:(?:title|description|subject|creator)|pdf:Keywords)\b[^>]*>([\s\S]*?)<\/\1>/g;
const PROPERTIES = ["Title", "Subject", "Keywords", "Author"];

export async function extras(doc: PDFDocumentProxy): Promise<string[]> {
	const out: string[] = [];
	// A part that cannot be read is said so in the block, never skipped without a trace.
	const tried = <T>(label: string, run: () => Promise<T>, none: T) =>
		run().catch(() => {
			out.push(`${label}: could not be read`);
			return none;
		});
	const meta = await tried("metadata", () => doc.getMetadata(), null);
	const info = (meta?.info ?? {}) as Record<string, unknown>;
	for (const key of PROPERTIES) {
		if (typeof info[key] === "string" && flat(info[key]))
			out.push(`metadata ${key}: ${flat(info[key])}`);
	}
	const xmp = (meta?.metadata as { getRaw?: () => string } | null)?.getRaw?.() ?? "";
	for (const [, tag, inner] of xmp.matchAll(XMP_TEXT)) {
		const text = flat((inner ?? "").replace(/<[^>]*>/g, " "));
		if (text) out.push(`metadata ${tag}: ${text}`);
	}
	for (const [name, list] of (await tried("javascript", () => doc.getJSActions(), null)) ?? []) {
		for (const code of list) out.push(`javascript ${name}: ${flat(code)}`);
	}
	for (const name of (await tried("attachments", () => doc.getAttachments(), null))?.keys() ?? []) {
		const bytes = await tried(`attachment ${name}`, () => doc.getAttachmentContent(name), null);
		out.push(`attachment ${name}: ${bytes ? asText(bytes) : "content unreadable"}`);
	}
	for (let n = 1; n <= doc.numPages; n++) {
		const page = await doc.getPage(n);
		for (const a of (await tried(
			`p. ${n}, annotations`,
			() => page.getAnnotations(),
			[],
		)) as Record<string, unknown>[]) {
			const note = (a.contentsObj as { str?: string } | undefined)?.str;
			const field = a.fieldValue;
			if (note && flat(note)) out.push(`p. ${n}, annotation: ${flat(note)}`);
			if (typeof field === "string" && flat(field))
				out.push(`p. ${n}, form field ${a.fieldName ?? ""}: ${flat(field)}`);
		}
	}
	return out;
}

// An attachment that is text is quoted; anything else is named by its size, so nothing is silent.
function asText(bytes: Uint8Array): string {
	try {
		return flat(UTF8.decode(bytes));
	} catch {
		return `${bytes.length} bytes, not text`;
	}
}
