// Opt-in benchmark; nothing here runs in CI except the offline tests.
//   npm run bench                    manifest, ours, report: no network, no Python
//   npm run bench -- verify          ours with --verify on the PDFs, once each (needs tesseract, pdftoppm)
//   npm run bench -- prepare         download the pinned corpora (the only networked step)
//   sh bench/run-adapters.sh <cache> run the competitor adapters in isolated uv environments
//   npm run bench -- modes           sets B and C under each --hidden mode, printed (into plainview-<mode>)
//   npm run bench -- speed|anchors   sets F and D into the cache (speed packs and installs; --prefer-offline)
//   npm run bench -- provider-tokens optional provider token counts (key read from the Keychain)
// PLAINVIEW_BENCH_CACHE must be an absolute scratch directory outside the repository.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { corpus } from "./corpus.ts";
import { modes, ours } from "./ours.ts";
import { prepare } from "./prepare.ts";
import { markdown, rows, tsv } from "./report.ts";

const root = resolve(import.meta.dirname, "..");
const cache = process.env.PLAINVIEW_BENCH_CACHE ?? "";
if (!cache || !isAbsolute(cache) || resolve(cache).startsWith(root))
	throw new Error(
		"Set PLAINVIEW_BENCH_CACHE to an absolute scratch directory outside the repository",
	);

/** The inputs every tool reads, copied side by side, and the manifest the adapters take them from. */
function manifest(): void {
	const entries = corpus(cache);
	mkdirSync(join(cache, "input"), { recursive: true });
	for (const e of entries) writeFileSync(join(cache, "input", e.file), readFileSync(e.path));
	const list = entries.map(({ path: _, ...e }) => e);
	writeFileSync(join(cache, "manifest.json"), JSON.stringify(list, null, 2));
}

function report(): void {
	const rs = rows(cache);
	writeFileSync(join(root, "bench/results.tsv"), tsv(rs));
	writeFileSync(join(root, "docs/BENCHMARK.md"), markdown(rs, cache));
}

const command = process.argv[2] ?? "all";
mkdirSync(cache, { recursive: true });
if (command === "prepare") {
	await prepare(cache);
	manifest();
} else if (command === "provider-tokens") {
	await (await import("./provider-tokens.ts")).providerTokens(cache, corpus(cache));
} else if (command === "speed") await (await import("./speed.ts")).speed(cache);
else if (command === "anchors") await (await import("./anchors.ts")).anchors(cache);
else if (command === "all") {
	manifest();
	await ours(cache, corpus(cache));
	report();
} else if (command === "manifest") manifest();
else if (command === "ours") await ours(cache, corpus(cache));
else if (command === "modes") process.stdout.write(await modes(cache, corpus(cache)));
else if (command === "verify") {
	const { tesseract } = await import("../src/ocr.ts");
	const pdfs = corpus(cache).filter((e) => /\.pdf$/i.test(e.file));
	await ours(cache, pdfs, 1, "describe", tesseract("eng"));
} else if (command === "report") report();
else
	throw new Error(
		"usage: run.ts [prepare | manifest | ours | modes | verify | report | speed | anchors | provider-tokens]",
	);
