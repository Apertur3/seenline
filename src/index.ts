import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { documentToText } from "./documents.ts";
import { PlainviewError } from "./error.ts";
import { HIDDEN_BLOCK, scan } from "./hidden.ts";
import { parseHidden } from "./parse-hidden.ts";
import type { ConvertOptions, ConvertResult, OcrResult } from "./types.ts";

export { PlainviewError } from "./error.ts";
export type { ConvertOptions, ConvertResult, HiddenText, OcrResult } from "./types.ts";

/** Convert locally; optional OCR receives the supplied path or a private temporary copy. */
export async function convert(input: Uint8Array, opts: ConvertOptions): Promise<ConvertResult> {
	if (input.length === 0)
		throw new PlainviewError("invalid", "could not read this file: empty input");
	if (opts.maxRows !== undefined && (!Number.isSafeInteger(opts.maxRows) || opts.maxRows < 1))
		throw new PlainviewError("invalid", "maxRows must be a positive safe integer");
	let scratch: string | undefined;
	const ocr = async (): Promise<OcrResult> => {
		if (!opts.ocr)
			throw new PlainviewError(
				"unavailable",
				"could not read this file: no text recognition available",
			);
		let path = opts.path;
		if (path === undefined) {
			scratch = await mkdtemp(join(tmpdir(), "plainview-ocr-"));
			path = join(scratch, `input${extname(opts.name)}`);
			await writeFile(path, input, { flag: "wx", mode: 0o600 });
		}
		try {
			const read = await opts.ocr(path);
			if (
				!strings(read.pages) ||
				!strings(read.extras) ||
				(read.reader !== undefined && typeof read.reader !== "string")
			)
				throw new Error("shape");
			return read;
		} catch {
			throw new PlainviewError("invalid", "could not read this file: text recognition failed");
		}
	};
	try {
		const result = await documentToText(input, opts, ocr);
		const lines = result.markdown.replace(/\n$/, "").split("\n");
		const block = lines.indexOf(HIDDEN_BLOCK);
		return {
			...result,
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
