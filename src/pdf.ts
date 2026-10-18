// A PDF's text as pages of lines, read from the content stream's drawing operators instead of pdfjs's
// text layer: the text layer silently drops text outside the page box, and we need to see all of it
// to flag it. Pure JavaScript, no network, no rendering.
import { fileURLToPath } from "node:url";
import { PlainviewError } from "./error.ts";
import { extras } from "./pdf-extras.ts";
import { type Item, type Matrix, walk } from "./pdf-walk.ts";

export interface PdfDoc {
	pages: PdfPage[];
	/** Lines of text from outside the pages: properties, annotations, form fields, attachments, scripts. */
	extras: string[];
}

export interface PdfPage {
	number: number;
	/** Text a reader of the page sees, one string per line, in content-stream order. */
	lines: string[];
	/** Text a reader does not see, each with the reasons: white, tiny, invisible, off-page, covered, hidden layer. */
	hidden: { text: string; why: string[] }[];
}

const MAX_PAGES = 300;

async function openPdf(bytes: Uint8Array) {
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const dir = fileURLToPath(new URL("./", import.meta.resolve("pdfjs-dist/package.json")));
	const task = pdfjs.getDocument({
		data: new Uint8Array(bytes), // a plain copy: pdfjs refuses a Buffer and takes ownership of what it gets
		verbosity: 0,
		useSystemFonts: false,
		standardFontDataUrl: `${dir}standard_fonts/`,
		cMapUrl: `${dir}cmaps/`,
		cMapPacked: true,
	});
	return { pdfjs, task, doc: await task.promise };
}

/** Reads every page and what the file carries outside its pages; throws `invalid` for a file that is not a readable PDF. */
export async function readPdf(bytes: Uint8Array): Promise<PdfDoc> {
	let opened: Awaited<ReturnType<typeof openPdf>>;
	try {
		opened = await openPdf(bytes);
	} catch (error) {
		const locked = (error as Error).name === "PasswordException";
		throw new PlainviewError(
			"invalid",
			`could not read this file: ${locked ? "the PDF is password protected" : "not a readable PDF"}`,
		);
	}
	const { pdfjs, task, doc } = opened;
	if (doc.numPages > MAX_PAGES) {
		throw new PlainviewError("invalid", `could not read this file: more than ${MAX_PAGES} pages`);
	}
	try {
		const layers = await doc.getOptionalContentConfig();
		const visible = (layer: unknown) => layers.isVisible(layer as { type: string; id: string });
		const pages: PdfPage[] = [];
		for (let n = 1; n <= doc.numPages; n++) {
			const page = await doc.getPage(n);
			const ops = await page.getOperatorList();
			pages.push(arrange(n, walk(pdfjs.OPS, ops, page.view as Matrix, visible)));
		}
		return { pages, extras: await extras(doc) };
	} catch {
		throw new PlainviewError("invalid", "could not read this file: damaged PDF");
	} finally {
		await task.destroy();
	}
}

// Groups visible items into lines in stream order (a new line when the baseline moves or the text
// jumps back, as at a column change), and a wide gap on a line into " | " (table cells).
function arrange(number: number, found: Item[]): PdfPage {
	const page: PdfPage = { number, lines: [], hidden: [] };
	let prev: Item | undefined;
	for (const it of found) {
		if (it.why.length > 0) {
			page.hidden.push({ text: it.text.trim(), why: it.why });
			continue;
		}
		const sameLine =
			prev &&
			Math.abs(it.y - prev.y) < 0.5 * Math.max(it.size, prev.size) &&
			it.x > prev.end - it.size;
		if (!prev || !sameLine) page.lines.push(it.text);
		else {
			const gap = it.x - prev.end;
			// A run's own trailing or leading space already is the gap; only a bare gap needs one.
			const glue = gap > 1.2 * it.size ? " | " : gap > 0.15 * it.size ? " " : "";
			page.lines[page.lines.length - 1] += glue + it.text;
		}
		prev = it;
	}
	// Ligature glyphs (fi, fl, ffi) are one character in the file; readers and searches want letters.
	page.lines = page.lines
		.map((l) => l.replace(/[ﬀ-ﬆ]/g, (c) => c.normalize("NFKC")))
		.map((l) => l.replace(/\s+/g, " ").trim())
		.filter(Boolean);
	return page;
}
