// Pure readers share one output contract; OCR is supplied by the caller.
import { NotRead, SeenlineError } from "./error.ts";
import { HIDDEN_BLOCK, written } from "./hidden.ts";
import { imageMeta } from "./image-meta.ts";
import { legacyOfficeToText } from "./legacy-office.ts";
import { convertMail } from "./mail.ts";
import { convertOffice, OFFICE_FILE } from "./office.ts";
import { unseen } from "./parse-hidden.ts";
import { type PdfPage, readPdf } from "./pdf.ts";
import { subtitlesToText } from "./subtitles.ts";
import type { ConvertOptions, DocumentText, OcrResult } from "./types.ts";
import { compare } from "./verify.ts";

const MIN_TEXT = 10;
/** The largest input read, in bytes: the largest file of the test corpora is under a fifth of it. */
export const MAX_INPUT = 100 << 20;
export const TOO_LARGE = `could not read this file: larger than the ${MAX_INPUT >> 20} MB input limit`;
const TEMP_FILES =
	"could not read this file: legacy Office conversion requires temporary file writes";
/** Said under the anchor of a page with (almost) no text layer when no text recognition read it. */
export const NO_TEXT_LAYER = "(no readable text layer on this page; it may be a scan or an image)";
const safe = (l: string) => written(l, "page");
const page = (n: number, lines: string[]) => [`[p. ${n}]`, ...lines.map(safe)];
const nonEmpty = (text: string) => text.split("\n").filter((l) => l.trim());

type Reader = (pages?: number[]) => Promise<OcrResult>;

export async function documentToText(
	bytes: Uint8Array,
	opts: ConvertOptions,
	ocr: Reader,
	verify?: Reader,
): Promise<DocumentText> {
	const { name } = opts;
	if (bytes.length > MAX_INPUT) throw new SeenlineError("invalid", TOO_LARGE);
	if (/\.(html?|eml|msg)$/i.test(name)) return { markdown: convertMail(bytes, name), pages: 1 };
	if (/\.(doc|rtf)$/i.test(name)) {
		if (opts.noTempFiles) throw new SeenlineError("unavailable", TEMP_FILES);
		return { markdown: await legacyOfficeToText(bytes, name), pages: 1 };
	}
	if (OFFICE_FILE.test(name)) return convertOffice(bytes, name, opts.maxRows);
	if (/\.(vtt|srt)$/i.test(name)) {
		const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return { markdown: subtitlesToText(raw), pages: 1 };
	}
	if (!/\.(pdf|png|jpe?g|heic|bmp|gif|webp)$/i.test(name))
		throw new SeenlineError("invalid", "could not read this file: unsupported format");
	const result = /\.pdf$/i.test(name)
		? await fromPdf(bytes, ocr, verify)
		: { ...(await fromImage(bytes, ocr)), checked: [] };
	const { body, hidden, pages, readers, checked } = result;
	// A comparison's counts are not document text, so the body never suppresses them.
	const listed = [...unseen(body, hidden), ...checked];
	const lines = listed.length > 0 ? [...body, HIDDEN_BLOCK, ...listed] : body;
	if (lines.every((l) => l.trim() === "" || l === NO_TEXT_LAYER || /^\[p\. \d+\]$/.test(l)))
		throw new SeenlineError("invalid", "could not read this file: no text found in it");
	return { markdown: `${lines.join("\n")}\n`, pages, ...(readers && { readers }) };
}

async function fromImage(bytes: Uint8Array, ocr: () => Promise<OcrResult>) {
	const read = await ocr();
	const body = read.pages.flatMap(nonEmpty).map(safe);
	// OCR extras count as recognised content; image metadata alone does not.
	if (!body.length && !read.extras.some((extra) => extra.trim()))
		throw new SeenlineError("invalid", "could not read this file: no text found in it");
	return {
		body,
		hidden: [...read.extras, ...imageMeta(bytes)],
		pages: read.pages.length,
		readers: read.reader ? read.pages.map(() => read.reader as string) : undefined,
	};
}

async function fromPdf(bytes: Uint8Array, ocr: Reader, verify?: Reader) {
	const { pages, extras } = await readPdf(bytes);
	const letters = (p: PdfPage) => p.lines.join("").replace(/[^\p{L}\p{N}]/gu, "").length;
	// A short text layer on a page that is not mostly a picture is the page's text, not a scan's.
	const weak = pages.map((p) => p.scan && letters(p) < MIN_TEXT);
	const all = weak.every(Boolean);
	// Without recognised text, a weak page keeps its few lines and says it was not read;
	// a recogniser that names its own failure (a missing program, a timeout) fails the file.
	const read: OcrResult | null = weak.some(Boolean)
		? await ocr(pages.filter((_, i) => weak[i]).map((p) => p.number)).catch((error) => {
				if (all || (error instanceof SeenlineError && !(error instanceof NotRead))) throw error;
				return null;
			})
		: { pages: [], extras: [] };
	// A page recognition returned no text for keeps the marker: it was not read, not found empty.
	const body = pages.flatMap((p, i) => {
		const recognised = read ? nonEmpty(read.pages[i] ?? "") : [];
		return page(
			p.number,
			!weak[i] ? p.lines : recognised.length ? recognised : [NO_TEXT_LAYER, ...p.lines],
		);
	});
	const hidden = pages.flatMap((p) =>
		p.hidden.map(
			(h) => `p. ${p.number}, ${h.why.join(" and ")} text: ${h.text.replace(/\s+/g, " ")}`,
		),
	);
	const checked = verify
		? await compare(
				pages.filter((p, i) => !weak[i] && p.lines.length),
				verify,
			)
		: [];
	return {
		body,
		hidden: [...hidden, ...extras, ...(read?.extras ?? [])],
		checked,
		pages: pages.length,
		readers: read?.reader
			? pages.map((_, i) => (weak[i] ? (read.reader as string) : "pdfjs"))
			: undefined,
	};
}
