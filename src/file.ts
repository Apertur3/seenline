// Shared local-file boundary for the CLI and MCP; the library still accepts bytes.
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { MAX_INPUT, TOO_LARGE } from "./documents.ts";
import { convert, PlainviewError } from "./index.ts";
import type { ConvertOptions } from "./types.ts";

/** What the CLI or MCP server passes on: text recognition for scans (`--ocr`) and for comparison (`--verify`), the hidden mode, and whether conversion may write temporary files. */
export type Readers = Pick<ConvertOptions, "ocr" | "verify" | "hidden" | "noTempFiles">;

// File system failures in fixed words: never the path or the system's own message.
const FS: Record<string, string> = {
	ENOENT: "no such file",
	ENOTDIR: "no such file",
	EACCES: "permission denied",
	EPERM: "permission denied",
	EISDIR: "not a regular file",
	ELOOP: "too many symbolic links, or the file changed while it was opened",
};
const fsError = (error: unknown) => FS[(error as { code?: string } | null)?.code ?? ""];
const failed = (why: string) => new PlainviewError("invalid", `could not read this file: ${why}`);

/**
 * Converts the regular file at `path`, read once and at most MAX_INPUT bytes. Opening never waits
 * on a pipe; a pipe, device or folder is refused. With `roots` (real paths), the file's real path
 * must lie inside one of them.
 */
export async function convertFile(path: string, readers: Readers = {}, roots?: string[]) {
	const file = roots ? await inside(path, roots) : path;
	return convert(await readBounded(file, !!roots), {
		name: basename(path),
		path: file,
		...readers,
	});
}

async function inside(path: string, roots: string[]): Promise<string> {
	const real = await realpath(path).catch(() => null);
	const under = (p: string) =>
		roots.some((root) => {
			const rel = relative(root, p);
			return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
		});
	if (!under(real ?? resolve(path))) throw failed("outside the folders this server may read");
	// A path that does not resolve is never opened, and one fixed message says so: a link inside a
	// root to a missing or unreadable file elsewhere tells nothing about that file.
	if (!real) throw failed("no such file, or a link that cannot be followed");
	return real;
}

async function readBounded(path: string, noFollow: boolean): Promise<Uint8Array> {
	const flags =
		constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (noFollow ? (constants.O_NOFOLLOW ?? 0) : 0);
	const handle = await open(path, flags).catch((error) => {
		throw failed(fsError(error) ?? "could not open it");
	});
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw failed("not a regular file");
		if (info.size > MAX_INPUT) throw new PlainviewError("invalid", TOO_LARGE);
		const bytes = Buffer.alloc(info.size);
		let at = 0;
		for (let n = 1; at < bytes.length && n > 0; at += n)
			({ bytesRead: n } = await handle.read(bytes, at, bytes.length - at, at));
		return bytes.subarray(0, at);
	} catch (error) {
		throw error instanceof PlainviewError ? error : failed(fsError(error) ?? "read error");
	} finally {
		await handle.close();
	}
}

export function errorMessage(error: unknown): string {
	return fsError(error) ?? (error instanceof Error ? error.message : "unknown error");
}

export function formatError(error: unknown): string {
	const code = error instanceof PlainviewError ? error.code : "invalid";
	return `${code}: ${errorMessage(error)}`;
}
