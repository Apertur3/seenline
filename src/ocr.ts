// Opt-in OCR for the CLI and MCP server: a local tesseract, and pdftoppm (poppler) for PDF pages.
// Arguments are arrays (no shell) and carry no path: the bytes that were parsed go in on stdin, so a
// file changed on disk after parsing is never the one read. Each process has a timeout and an output
// cap, and each file one deadline for all its pages.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PlainviewError } from "./error.ts";
import type { OcrResult } from "./types.ts";

const MAX_OUTPUT = 32 << 20;
const INSTALL: Record<string, string> = {
	tesseract:
		"text recognition needs tesseract (install it, for example brew install tesseract or apt install tesseract-ocr)",
	pdftoppm:
		"text recognition of PDF pages needs pdftoppm (install poppler, for example brew install poppler or apt install poppler-utils)",
};
// Tesseract treats input that is not an image as a list of file names and reads those, so only known
// image signatures go in; a BMP also needs a size field within the file (0 from a stream writer)
// and a known DIB header size.
const isImage = (bytes: Uint8Array) => {
	const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const head = b.subarray(0, 12).toString("latin1");
	if (head.startsWith("BM"))
		return (
			b.length >= 26 &&
			b.readUInt32LE(2) <= b.length &&
			[12, 16, 40, 52, 56, 64, 108, 124].includes(b.readUInt32LE(14))
		);
	return (
		["\x89PNG\r\n\x1a\n", "\xff\xd8\xff", "GIF87a", "GIF89a"].some((s) => head.startsWith(s)) ||
		(head.startsWith("RIFF") && head.slice(8) === "WEBP")
	);
};

// One program run: input on stdin, output on stdout, killed at `timeout` or the file's `deadline`.
function run(cmd: string, args: string[], input: Uint8Array, limit: Limit) {
	return new Promise<Buffer>((done, reject) => {
		const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"] });
		const chunks: Buffer[] = [];
		let size = 0;
		const fail = (message: string, code: "invalid" | "unavailable" = "invalid") => {
			clearTimeout(timer);
			child.kill("SIGKILL");
			reject(new PlainviewError(code, `could not read this file: ${message}`));
		};
		const left = limit.deadline - Date.now();
		const late =
			left < limit.timeout
				? "text recognition is over the time limit for this file"
				: `text recognition timed out (${cmd})`;
		const timer = setTimeout(() => fail(late), Math.max(0, Math.min(limit.timeout, left)));
		child.on("error", (error: NodeJS.ErrnoException) =>
			error.code === "ENOENT"
				? fail(INSTALL[cmd] as string, "unavailable")
				: fail(`text recognition failed (${cmd})`),
		);
		child.stdout?.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_OUTPUT) fail("text recognition output is over the size limit");
			else chunks.push(chunk);
		});
		child.on("close", (code) => {
			if (code === 0) {
				clearTimeout(timer);
				done(Buffer.concat(chunks));
			} else
				fail(
					`text recognition failed (${cmd} exited with an error${cmd === "tesseract" ? `; is the language data for ${limit.lang} installed?` : ""})`,
				);
		});
		child.stdin?.on("error", () => {});
		child.stdin?.end(input);
	});
}
type Limit = { timeout: number; deadline: number; lang: string };

/** `timeout` caps each program run; a file's runs together end at `base` plus `perPage` for each page. */
export function tesseract(lang: string, timeout = 60_000, base = 120_000, perPage = 10_000) {
	const text = async (image: Uint8Array, limit: Limit) =>
		(await run("tesseract", ["stdin", "stdout", "-l", lang], image, limit))
			.toString("utf8")
			.replace(/\f/g, "");

	return async (path: string, pages?: number[], bytes?: Uint8Array): Promise<OcrResult> => {
		const data = bytes ?? (await readFile(resolve(path)));
		const limit = { timeout, lang, deadline: Date.now() + base + perPage * (pages?.length ?? 1) };
		if (!pages) {
			if (!isImage(data))
				throw new PlainviewError(
					"unavailable",
					"could not read this file: text recognition reads PNG, JPEG, GIF, BMP and WebP images only",
				);
			return { pages: [await text(data, limit)], extras: [], reader: "tesseract" };
		}
		const out: string[] = Array(Math.max(0, ...pages)).fill("");
		for (const n of pages) {
			const png = await run(
				"pdftoppm",
				["-png", "-gray", "-scale-to", "3500", "-f", `${n}`, "-l", `${n}`, "-"],
				data,
				limit,
			);
			if (!isImage(png))
				throw new PlainviewError(
					"invalid",
					"could not read this file: text recognition failed (pdftoppm returned no image)",
				);
			out[n - 1] = await text(png, limit);
		}
		return { pages: out, extras: [], reader: "tesseract" };
	};
}
