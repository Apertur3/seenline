// Optional set E step: token counts from a provider's count endpoint, for the native PDF upload and for
// each tool's Markdown. Not part of the default run (it makes network calls and bills nothing but needs a key).
// The key is read from the macOS Keychain at run time and never written anywhere:
//   security add-generic-password -U -a seenline-bench -s seenline-bench-provider -w
// BENCH_COUNT_URL is the count endpoint (Messages count_tokens shape); BENCH_COUNT_MODEL the model id.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Entry } from "./corpus.ts";
import { CANDIDATES } from "./report.ts";

async function count(url: string, key: string, model: string, block: object): Promise<number> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"x-api-key": key,
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
		},
		body: JSON.stringify({ model, messages: [{ role: "user", content: [block] }] }),
		signal: AbortSignal.timeout(60_000),
	});
	if (!response.ok) throw new Error(`count endpoint: HTTP ${response.status}`);
	return ((await response.json()) as { input_tokens: number }).input_tokens;
}

export async function providerTokens(cache: string, entries: Entry[]): Promise<void> {
	const url = process.env.BENCH_COUNT_URL;
	const model = process.env.BENCH_COUNT_MODEL;
	if (!url || !model) throw new Error("set BENCH_COUNT_URL and BENCH_COUNT_MODEL");
	const key = execFileSync(
		"security",
		["find-generic-password", "-a", "seenline-bench", "-s", "seenline-bench-provider", "-w"],
		{ encoding: "utf8" },
	).trim();
	const out: Record<string, Record<string, number>> = {};
	for (const e of entries.filter((e) => e.file.endsWith(".pdf"))) {
		const data = readFileSync(e.path).toString("base64");
		const row: Record<string, number> = {
			native: await count(url, key, model, {
				type: "document",
				source: { type: "base64", media_type: "application/pdf", data },
			}),
		};
		for (const candidate of Object.keys(CANDIDATES)) {
			const file = join(cache, candidate, `${e.file}.json`);
			if (!existsSync(file)) continue;
			const run = JSON.parse(readFileSync(file, "utf8"));
			if (run.status === "ok" && run.text)
				row[candidate] = await count(url, key, model, { type: "text", text: run.text });
		}
		out[e.file] = row;
	}
	writeFileSync(join(cache, "provider-tokens.json"), JSON.stringify(out, null, 2));
}
