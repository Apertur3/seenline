// `prepare`: the only step that touches the network. Every download is a pinned URL with a sha256,
// checked before anything is written, and lands in the cache outside the repository.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import { data, digest, PUBLIC, SPLITVIEW } from "./corpus.ts";

async function download(url: string, sha256: string, name: string): Promise<Uint8Array> {
	const response = await fetch(url, {
		signal: AbortSignal.timeout(120_000),
	});
	if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (digest(bytes) !== sha256) throw new Error(`${name}: source checksum changed`);
	return bytes;
}

function put(path: string, bytes: Uint8Array): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, bytes);
}

async function publicFiles(cache: string): Promise<void> {
	for (const item of PUBLIC) {
		const dest = join(cache, "corpus", item.file);
		if (existsSync(dest)) continue;
		let bytes = await download(item.url, item.sha256, item.file);
		if (item.transform === "shift-jis-to-utf8") {
			bytes = Buffer.from(new TextDecoder("shift-jis").decode(bytes));
		} else if (item.transform === "reportlab-generator") {
			// The pinned script (sha256 checked above) writes the PDF; it needs reportlab installed.
			const generator = join(cache, "public-injection.py");
			writeFileSync(generator, bytes);
			execFileSync(process.env.BENCH_GENERATOR_PYTHON ?? "python3", [generator], {
				cwd: cache,
				env: { ...process.env, SOURCE_DATE_EPOCH: "1704067200" },
				timeout: 30_000,
			});
			bytes = readFileSync(join(cache, "test_injected.pdf"));
		} else if (item.transform) {
			const extracted = unzipSync(bytes)[item.transform];
			if (!extracted) throw new Error(`${item.file}: missing ${item.transform}`);
			bytes = extracted;
		}
		put(dest, bytes);
	}
}

/** The artifact is CC-BY-4.0 (credit the authors); only its Corpus A and B PDFs are unpacked, never vendored. */
async function splitView(cache: string): Promise<void> {
	const dirs = [SPLITVIEW.pdfs, data<{ sets: { B: { pdfs: string } } }>("models.json").sets.B.pdfs];
	if (dirs.every((d) => existsSync(join(cache, "splitview", d)))) return;
	const zip = await download(SPLITVIEW.url, SPLITVIEW.sha256, SPLITVIEW.file);
	const files = unzipSync(zip, {
		filter: (f) => dirs.some((d) => f.name.startsWith(`${d}/`)) && f.name.endsWith(".pdf"),
	});
	for (const [name, bytes] of Object.entries(files)) put(join(cache, "splitview", name), bytes);
}

async function tika(cache: string): Promise<void> {
	const { jar } = data<{ candidates: { tika: { jar: { url: string; sha256: string } } } }>(
		"environment.json",
	).candidates.tika;
	const dest = join(cache, "tika", "tika-app.jar");
	if (!existsSync(dest)) put(dest, await download(jar.url, jar.sha256, "tika-app.jar"));
}

export async function prepare(cache: string): Promise<void> {
	await publicFiles(cache);
	await splitView(cache);
	await tika(cache);
}
