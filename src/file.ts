// Shared local-file boundary for the CLI and MCP; the library still accepts bytes.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { convert, PlainviewError } from "./index.ts";
import type { ConvertOptions } from "./types.ts";

/** What the CLI or MCP server passes on: text recognition for scans (`--ocr`) and for comparison (`--verify`), and the hidden mode. */
export type Readers = Pick<ConvertOptions, "ocr" | "verify" | "hidden">;

export async function convertFile(path: string, readers: Readers = {}) {
	let bytes: Buffer;
	try {
		bytes = await readFile(path);
	} catch (error) {
		throw new PlainviewError("invalid", `could not read this file: ${errorMessage(error)}`);
	}
	return convert(bytes, { name: basename(path), path, ...readers });
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "unknown error";
}

export function formatError(error: unknown): string {
	const code = error instanceof PlainviewError ? error.code : "invalid";
	return `${code}: ${errorMessage(error)}`;
}
