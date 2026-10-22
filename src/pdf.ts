// A PDF's text as pages of lines, read from the content stream's drawing operators instead of pdfjs's
// text layer: the text layer silently drops text outside the page box, and we need to see all of it
// to flag it. Pure JavaScript, no network, no rendering.
import { fileURLToPath } from "node:url";
import { PlainviewError } from "./error.ts";
import { extras } from "./pdf-extras.ts";
import { lines, readingOrder } from "./pdf-order.ts";
import { type Item, type Matrix, walk } from "./pdf-walk.ts";

export interface PdfDoc {
	pages: PdfPage[];
	/** Lines of text from outside the pages: properties, annotations, form fields, attachments, scripts. */
	extras: string[];
}

export interface PdfPage {
	number: number;
	/** Text a reader of the page sees, one string per line, in reading order (pdf-order.ts). */
	lines: string[];
	/** Text a reader does not see, each with the reasons: white, tiny, invisible, off-page, covered, clipped, squeezed, hidden layer, unreadable font; and the stored text of a page whose stored order is not its reading order (reading order). */
	hidden: { text: string; why: string[] }[];
	/** The page shows no text (drawn, even if not decodable), or pictures cover at least half of it: a scan when its text is short. */
	scan: boolean;
}

const SCAN_PICTURED = 0.5;

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
			const { items, pictured } = walk(pdfjs.OPS, ops, page.view as Matrix, visible);
			const shown = items.some((it) => it.why.every((w) => w === "unreadable font"));
			pages.push({ ...arrange(n, items), scan: !shown || pictured >= SCAN_PICTURED });
		}
		return { pages, extras: await extras(doc) };
	} catch {
		throw new PlainviewError("invalid", "could not read this file: damaged PDF");
	} finally {
		await task.destroy();
	}
}

// Visible runs in reading order (pdf-order.ts), grouped into lines: a new line when the baseline moves or
// the text jumps back, as at a column change, and a wide gap on a line as " | " (table cells).
// Hidden runs of one or two characters each, four or more in a row and mostly letters (a glyph per text
// object), are one entry: the text they spell, a space where a gap on a baseline is a word space, with
// the reasons of all of them. Apart, repeated letters would be dropped as repeats and single letters as
// words the body shows. Shorter or mostly other runs (a figure's tick labels) stay one entry each.
function arrange(number: number, found: Item[]): Omit<PdfPage, "scan"> {
	const groups: Item[][] = [];
	const short = (it?: Item) => !!it && [...it.text.trim()].length <= 2;
	for (const it of found.filter((x) => x.why.length > 0)) {
		const last = groups.at(-1);
		if (last && short(it) && short(last.at(-1))) last.push(it);
		else groups.push([it]);
	}
	const hidden = groups.flatMap((g) => {
		const text = g
			.map((it, i) => {
				const prev = g[i - 1];
				const space =
					prev && Math.abs(it.y - prev.y) < 0.5 * it.size && it.x - prev.end > 0.15 * it.size;
				return (space ? " " : "") + it.text.trim();
			})
			.join("");
		const spelt = g.length >= 4 && 2 * (text.match(/\p{L}/gu)?.length ?? 0) > [...text].length;
		if (spelt) return [{ text, why: [...new Set(g.flatMap((it) => it.why))] }];
		return g.map((it) => ({ text: it.text.trim(), why: it.why }));
	});
	const { order, moved } = readingOrder(found.filter((it) => it.why.length === 0));
	// The stored order goes in the block: it is what an extractor that follows the file reads.
	if (moved.length > 0) hidden.push({ text: text(moved, " ").join(" "), why: ["reading order"] });
	return { number, lines: text(order, " | "), hidden };
}

function text(runs: Item[], cell: string): string[] {
	const glue = (prev: Item, it: Item) => {
		const gap = it.x - prev.end;
		// A run's own trailing or leading space already is the gap; only a bare gap needs one.
		return gap > 1.2 * it.size ? cell : gap > 0.15 * it.size ? " " : "";
	};
	const joined = lines(runs).map((line) =>
		line.map((it, i) => (i === 0 ? it.text : glue(line[i - 1] as Item, it) + it.text)).join(""),
	);
	// Ligature glyphs (fi, fl, ffi) are one character in the file; readers and searches want letters.
	return joined
		.map((l) => l.replace(/[ﬀ-ﬆ]/g, (c) => c.normalize("NFKC")))
		.map((l) => l.replace(/\s+/g, " ").trim())
		.filter(Boolean);
}
