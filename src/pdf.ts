// A PDF's text as pages of lines, read from the content stream's drawing operators instead of pdfjs's
// text layer: the text layer silently drops text outside the page box, and we need to see all of it
// to flag it. Pure JavaScript, no network, no rendering.
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { SeenlineError } from "./error.ts";
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

// A small file can decompress to gigabytes of streams and drawing operators, and pdfjs reads a page
// in one go, so a PDF is read in a worker thread under a memory limit (its heap, and the process's
// growth, which counts decoded stream buffers too) and a deadline: past either it fails closed with
// that cause, and the process (an MCP server) stays up and responsive. Real files of the test corpora
// stay far below both.
const MEMORY_MB = 2048;
const DEADLINE_S = 120;
const fail = (why: string) => new SeenlineError("invalid", `could not read this file: ${why}`);
const OVER_MEMORY = `the PDF needs more memory to read than the limit (${MEMORY_MB / 2} MB heap, ${MEMORY_MB} MB in all)`;
// A worker that cannot start is this process's problem, never the document's.
const broken = (why: string) =>
	new SeenlineError("unavailable", `the PDF reader could not start: ${why}`);

/** Reads every page and what the file carries outside its pages; throws `invalid` for a file that is not a readable PDF. */
export function readPdf(bytes: Uint8Array): Promise<PdfDoc> {
	return new Promise((done, reject) => {
		let worker: Worker;
		try {
			// Started from a string that imports this file: the worker inherits the process's flags, and a
			// worker started from a file refuses to run under `--input-type` (`node --input-type=module -e`).
			worker = new Worker(`import(${JSON.stringify(import.meta.url)})`, {
				eval: true,
				workerData: { seenlinePdf: bytes },
				resourceLimits: { maxOldGenerationSizeMb: MEMORY_MB / 2 },
				stdout: true,
				stderr: true,
			});
		} catch (error) {
			return reject(broken((error as Error).message)); // as under --permission without --allow-worker
		}
		worker.stdout.resume();
		worker.stderr.resume();
		const [start, base] = [Date.now(), process.memoryUsage.rss()];
		let started = false; // the worker has loaded its code and pdfjs: a failure from here on is the file's
		const stop = (why: string) => {
			reject(fail(why));
			void worker.terminate();
		};
		const watch = setInterval(() => {
			if (process.memoryUsage.rss() - base > MEMORY_MB * 2 ** 20) stop(OVER_MEMORY);
			if (Date.now() - start > DEADLINE_S * 1000)
				stop(`the PDF took longer than ${DEADLINE_S} seconds to read`);
		}, 50);
		worker.on("message", (m: { started?: true; doc?: PdfDoc; error?: string }) => {
			started = true;
			if (m.started) return;
			clearInterval(watch);
			void worker.terminate();
			m.doc ? done(m.doc) : reject(new SeenlineError("invalid", m.error as string));
		});
		worker.once("error", (error: Error & { code?: string }) => {
			if (error.code === "ERR_WORKER_OUT_OF_MEMORY") stop(OVER_MEMORY);
			else if (!started) {
				reject(broken(error.message));
				void worker.terminate();
			} else stop("damaged PDF");
		});
		worker.once("exit", () => {
			clearInterval(watch);
			reject(started ? fail("damaged PDF") : broken("it exited"));
		});
	});
}

async function parse(bytes: Uint8Array): Promise<PdfDoc> {
	let opened: Awaited<ReturnType<typeof openPdf>>;
	try {
		opened = await openPdf(bytes);
	} catch (error) {
		const locked = (error as Error).name === "PasswordException";
		throw new SeenlineError(
			"invalid",
			`could not read this file: ${locked ? "the PDF is password protected" : "not a readable PDF"}`,
		);
	}
	const { pdfjs, task, doc } = opened;
	if (doc.numPages > MAX_PAGES) {
		throw new SeenlineError("invalid", `could not read this file: more than ${MAX_PAGES} pages`);
	}
	try {
		const layers = await doc.getOptionalContentConfig();
		const visible = (layer: unknown) => layers.isVisible(layer as { type: string; id: string });
		const pages: PdfPage[] = [];
		for (let n = 1; n <= doc.numPages; n++) {
			const page = await doc.getPage(n);
			const ops = await page.getOperatorList();
			const fonts = (id: string) =>
				page.commonObjs.has(id) ? page.commonObjs.get(id)?.fontMatrix : undefined;
			const { items, pictured } = walk(pdfjs.OPS, ops, page.view as Matrix, visible, fonts);
			const shown = items.some((it) => it.why.every((w) => w === "unreadable font"));
			pages.push({ ...arrange(n, items), scan: !shown || pictured >= SCAN_PICTURED });
		}
		return { pages, extras: await extras(doc) };
	} catch (error) {
		if (error instanceof SeenlineError) throw error;
		// The walker's text budget (pdf-walk.ts) is a limit, not damage: name it.
		const runs = (error as Error | null)?.message === "too much text";
		throw fail(runs ? "a page has more than 100,000 text runs" : "damaged PDF");
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
				// A run's own trailing or leading space is a word space too.
				const gap =
					prev && Math.abs(it.y - prev.y) < 0.5 * it.size && it.x - prev.end > 0.15 * it.size;
				const space = prev && (gap || /\s$/.test(prev.text) || /^\s/.test(it.text));
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

// In the worker: read the file, post the result or the cause.
if (!isMainThread && parentPort && workerData?.seenlinePdf) {
	const port = parentPort;
	await import("pdfjs-dist/legacy/build/pdf.mjs");
	port.postMessage({ started: true });
	await parse(workerData.seenlinePdf).then(
		(doc) => port.postMessage({ doc }),
		(error: Error) =>
			port.postMessage({
				error:
					error instanceof SeenlineError ? error.message : "could not read this file: damaged PDF",
			}),
	);
}
