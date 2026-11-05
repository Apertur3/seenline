// textutil is an OS converter, never a model. Its lossy visibility conversion needs conservative flags.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SeenlineError } from "./error.ts";
import { HIDDEN_BLOCK } from "./hidden.ts";
import { convertOffice, OFFICE_FAILURE } from "./office.ts";

const exec = promisify(execFile);
const DOC_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

export async function legacyOfficeToText(bytes: Uint8Array, name: string): Promise<string> {
	let dir: string | undefined;
	try {
		const ext = name.toLowerCase().endsWith(".rtf") ? "rtf" : "doc";
		if (process.platform !== "darwin" || bytes.length > 50 * 1024 * 1024)
			throw new Error("unsupported");
		const header = Buffer.from(bytes.subarray(0, 8));
		if (ext === "doc" ? !header.equals(DOC_MAGIC) : !header.toString("ascii").startsWith("{\\rtf"))
			throw new Error("format");
		dir = await mkdtemp(join(tmpdir(), "seenline-office-"));
		const input = join(dir, `input.${ext}`),
			output = join(dir, "converted.docx");
		await writeFile(input, bytes, { flag: "wx", mode: 0o600 });
		await exec(
			"/usr/bin/textutil",
			["-convert", "docx", "-format", ext, "-noload", "-nostore", "-output", output, "--", input],
			{ timeout: 30_000, maxBuffer: 64 * 1024 },
		);
		if ((await stat(output)).size > 50 * 1024 * 1024) throw new Error("converted size");
		const converted = convertOffice(await readFile(output), ".docx").markdown;
		// textutil strips vanish and layout semantics. All converted text requires review, including lost hiding.
		const result = [
			`Converted from .${ext} on macOS. Headings and tables may be flattened; original text visibility could not be verified.`,
			HIDDEN_BLOCK,
			"Legacy conversion: all text flagged for review because hidden formatting may have been removed.",
			converted,
		].join("\n");
		if (Buffer.byteLength(result) > 5 * 1024 * 1024) throw new Error("text size");
		return result;
	} catch {
		throw new SeenlineError("invalid", OFFICE_FAILURE);
	} finally {
		if (dir) await rm(dir, { recursive: true, force: true });
	}
}
