// Plainview through convert(), the same call the CLI and the MCP server make. No OCR callback is
// supplied, so scans and images fail closed; that is recorded, not hidden.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { convert } from "../src/index.ts";
import { version } from "../src/version.ts";
import type { Entry } from "./corpus.ts";
import { median } from "./stats.ts";

export const REPS = 3;

/** Hardware stated generically: class of machine, not a name. */
export const hardware = () => ({
	os: `${platform()} ${release().split(".")[0]}`,
	arch: arch(),
	cores: cpus().length,
	memoryGiB: Math.round(totalmem() / 2 ** 30),
});

export async function ours(cache: string, entries: Entry[], reps = REPS): Promise<void> {
	const dir = join(cache, "plainview");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "environment.json"),
		JSON.stringify({
			candidate: "plainview",
			version,
			date: new Date().toISOString().slice(0, 10),
			node: process.version,
			...hardware(),
			configuration: "convert() from src, no OCR callback",
		}),
	);
	for (const entry of entries) {
		const bytes = readFileSync(entry.path);
		const times: number[] = [];
		let text = "";
		let status = "ok";
		let error = "";
		let signal: string[] = [];
		for (let i = 0; i < reps; i++) {
			const started = performance.now();
			status = "ok";
			error = "";
			try {
				const result = await convert(bytes, { name: entry.file, path: entry.path });
				text = result.markdown;
				signal = [...result.flags, ...(result.hidden.length ? ["hidden-block"] : [])];
			} catch (e) {
				status = "error";
				error = e instanceof Error ? e.message : String(e);
			}
			times.push((performance.now() - started) / 1000);
		}
		writeFileSync(
			join(dir, `${entry.file}.json`),
			JSON.stringify({ text, status, error, signal, seconds: median(times), sha256: entry.sha256 }),
		);
	}
}
