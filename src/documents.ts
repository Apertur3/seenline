// Pure readers share one output contract; OCR is supplied by the caller.
import { NotRead, PlainviewError } from "./error.ts";
import { HIDDEN_BLOCK } from "./hidden.ts";
import { imageMeta } from "./image-meta.ts";
import { legacyOfficeToText } from "./legacy-office.ts";
import { convertMail } from "./mail.ts";
import { convertOffice, OFFICE_FILE } from "./office.ts";
import { unseen } from "./parse-hidden.ts";
import { type PdfPage, readPdf } from "./pdf.ts";
import { subtitlesToText } from "./subtitles.ts";
import type { ConvertOptions, DocumentText, OcrResult } from "./types.ts";

const MIN_TEXT = 10;
/** Said under the anchor of a page with (almost) no text layer when no text recognition read it. */
export const NO_TEXT_LAYER = "(no readable text layer on this page; it may be a scan or an image)";
const safe = (l: string) => (l === HIDDEN_BLOCK ? `${l} (written in the page)` : l);
const page = (n: number, lines: string[]) => [`[p. ${n}]`, ...lines.map(safe)];
const nonEmpty = (text: string) => text.split("\n").filter((l) => l.trim());

export async function documentToText(
	bytes: Uint8Array,
	opts: ConvertOptions,
	ocr: (pages?: number[]) => Promise<OcrResult>,
): Promise<DocumentText> {
	const { name } = opts;
	if (/\.(html?|eml|msg)$/i.test(name)) return { markdown: convertMail(bytes, name), pages: 1 };
	if (/\.(doc|rtf)$/i.test(name))
		return { markdown: await legacyOfficeToText(bytes, name), pages: 1 };
	if (OFFICE_FILE.test(name)) return convertOffice(bytes, name, opts.maxRows);
	if (/\.(vtt|srt)$/i.test(name)) {
		const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return { markdown: subtitlesToText(raw), pages: 1 };
	}
	if (!/\.(pdf|png|jpe?g|heic|bmp|gif|webp)$/i.test(name))
		throw new PlainviewError("invalid", "could not read this file: unsupported format");
	const result = /\.pdf$/i.test(name) ? await fromPdf(bytes, ocr) : await fromImage(bytes, ocr);
	const { body, hidden, pages, readers } = result;
	const listed = unseen(body, hidden);
	const lines = listed.length > 0 ? [...body, HIDDEN_BLOCK, ...listed] : body;
	if (lines.every((l) => l.trim() === "" || l === NO_TEXT_LAYER || /^\[p\. \d+\]$/.test(l)))
		throw new PlainviewError("invalid", "could not read this file: no text found in it");
	return { markdown: `${lines.join("\n")}\n`, pages, ...(readers && { readers }) };
}

async function fromImage(bytes: Uint8Array, ocr: () => Promise<OcrResult>) {
	const read = await ocr();
	return {
		body: read.pages.flatMap(nonEmpty).map(safe),
		hidden: [...read.extras, ...imageMeta(bytes)],
		pages: read.pages.length,
		readers: read.reader ? read.pages.map(() => read.reader as string) : undefined,
	};
}

async function fromPdf(bytes: Uint8Array, ocr: (pages: number[]) => Promise<OcrResult>) {
	const { pages, extras } = await readPdf(bytes);
	const letters = (p: PdfPage) => p.lines.join("").replace(/[^\p{L}\p{N}]/gu, "").length;
	const weak = pages.map((p) => letters(p) < MIN_TEXT);
	const all = weak.every(Boolean);
	// Without recognised text, a weak page keeps its few lines and says it was not read;
	// a recogniser that names its own failure (a missing program, a timeout) fails the file.
	const read: OcrResult | null = weak.some(Boolean)
		? await ocr(pages.filter((_, i) => weak[i]).map((p) => p.number)).catch((error) => {
				if (all || (error instanceof PlainviewError && !(error instanceof NotRead))) throw error;
				return null;
			})
		: { pages: [], extras: [] };
	const body = pages.flatMap((p, i) =>
		page(
			p.number,
			!weak[i] ? p.lines : read ? nonEmpty(read.pages[i] ?? "") : [NO_TEXT_LAYER, ...p.lines],
		),
	);
	const hidden = pages.flatMap((p) =>
		p.hidden.map(
			(h) => `p. ${p.number}, ${h.why.join(" and ")} text: ${h.text.replace(/\s+/g, " ")}`,
		),
	);
	return {
		body,
		hidden: [...hidden, ...extras, ...(read?.extras ?? [])],
		pages: pages.length,
		readers: read?.reader
			? pages.map((_, i) => (weak[i] ? (read.reader as string) : "pdfjs"))
			: undefined,
	};
}
