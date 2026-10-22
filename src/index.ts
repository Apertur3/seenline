import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { documentToText } from "./documents.ts";
import { NotRead, PlainviewError } from "./error.ts";
import { HIDDEN_BLOCK, scan } from "./hidden.ts";
import { HIDDEN_MODES, parseHidden, showHidden } from "./parse-hidden.ts";
import type { ConvertOptions, ConvertResult, OcrResult } from "./types.ts";

export { PlainviewError } from "./error.ts";
export type { ConvertOptions, ConvertResult, HiddenText, OcrResult } from "./types.ts";

/** Convert locally; optional OCR receives the supplied path or a private temporary copy, and for a PDF the page numbers to read. */
export async function convert(input: Uint8Array, opts: ConvertOptions): Promise<ConvertResult> {
	if (input.length === 0)
		throw new PlainviewError("invalid", "could not read this file: empty input");
	if (opts.maxRows !== undefined && (!Number.isSafeInteger(opts.maxRows) || opts.maxRows < 1))
		throw new PlainviewError("invalid", "maxRows must be a positive safe integer");
	if (opts.hidden !== undefined && !HIDDEN_MODES.includes(opts.hidden))
		throw new PlainviewError("invalid", "hidden must be text, framed or describe");
	let scratch: string | undefined;
	const ocr = async (pages?: number[]): Promise<OcrResult> => {
		if (!opts.ocr)
			throw new NotRead("unavailable", "could not read this file: no text recognition available");
		let path = opts.path;
		if (path === undefined) {
			scratch = await mkdtemp(join(tmpdir(), "plainview-ocr-"));
			path = join(scratch, `input${extname(opts.name)}`);
			await writeFile(path, input, { flag: "wx", mode: 0o600 });
		}
		try {
			const read = await opts.ocr(path, pages);
			if (
				!strings(read.pages) ||
				!strings(read.extras) ||
				(read.reader !== undefined && typeof read.reader !== "string")
			)
				throw new Error("shape");
			return read;
		} catch (error) {
			if (error instanceof PlainviewError) throw error;
			throw new NotRead("invalid", "could not read this file: text recognition failed");
		}
	};
	try {
		const result = await documentToText(input, opts, ocr);
		const lines = result.markdown.replace(/\n$/, "").split("\n");
		const block = lines.indexOf(HIDDEN_BLOCK);
		const head = lines.slice(0, block + 1);
		const end = result.markdown.endsWith("\n") ? "\n" : "";
		const mode = opts.hidden ?? "describe";
		// A legacy .doc or .rtf keeps all its converted text under the block, unverified rather than hidden.
		const shown = showHidden(lines.slice(block + 1), mode, /\.(doc|rtf)$/i.test(opts.name));
		return {
			...result,
			markdown:
				block < 0 || mode === "text" ? result.markdown : [...head, ...shown].join("\n") + end,
			hidden: block < 0 ? [] : parseHidden(lines.slice(block + 1)),
			flags: scan(lines).flags,
		};
	} catch (error) {
		if (error instanceof PlainviewError) throw error;
		throw new PlainviewError("invalid", "could not read this file: invalid input");
	} finally {
		if (scratch) await rm(scratch, { recursive: true, force: true });
	}
}

function strings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((x) => typeof x === "string");
}
