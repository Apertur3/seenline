// Opt-in OCR for the CLI and MCP server: a local tesseract, and pdftoppm (poppler) for PDF pages.
// Arguments are arrays (no shell); user paths never reach an argument list except a PDF's absolute
// path, which cannot start with a dash. Each process has a timeout and an output cap.
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
// Tesseract treats input that is not an image as a list of file names and reads those, so only known image signatures go in.
const isImage = (head: string) =>
	["\x89PNG\r\n\x1a\n", "\xff\xd8\xff", "GIF87a", "GIF89a", "BM"].some((s) => head.startsWith(s)) ||
	(head.startsWith("RIFF") && head.endsWith("WEBP"));

export function tesseract(lang: string, timeout = 60_000) {
	const run = (cmd: string, args: string[], input: Uint8Array | null) =>
		new Promise<Buffer>((done, reject) => {
			const child = spawn(cmd, args, { stdio: [input ? "pipe" : "ignore", "pipe", "ignore"] });
			const chunks: Buffer[] = [];
			let size = 0;
			const fail = (message: string, code: "invalid" | "unavailable" = "invalid") => {
				clearTimeout(timer);
				child.kill("SIGKILL");
				reject(new PlainviewError(code, `could not read this file: ${message}`));
			};
			const timer = setTimeout(() => fail(`text recognition timed out (${cmd})`), timeout);
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
				} else fail(`text recognition failed (${cmd} exited with an error)`);
			});
			child.stdin?.on("error", () => {});
			child.stdin?.end(input);
		});
	const text = async (image: Uint8Array) =>
		(await run("tesseract", ["stdin", "stdout", "-l", lang], image))
			.toString("utf8")
			.replace(/\f/g, "");

	return async (path: string, pages?: number[]): Promise<OcrResult> => {
		const file = resolve(path);
		if (!pages) {
			const bytes = await readFile(file);
			if (!isImage(bytes.subarray(0, 12).toString("latin1")))
				throw new PlainviewError(
					"unavailable",
					"could not read this file: text recognition reads PNG, JPEG, GIF, BMP and WebP images only",
				);
			return { pages: [await text(bytes)], extras: [], reader: "tesseract" };
		}
		const out: string[] = Array(Math.max(0, ...pages)).fill("");
		for (const n of pages) {
			const png = await run(
				"pdftoppm",
				["-png", "-gray", "-scale-to", "3500", "-f", `${n}`, "-l", `${n}`, file],
				null,
			);
			out[n - 1] = await text(png);
		}
		return { pages: out, extras: [], reader: "tesseract" };
	};
}
