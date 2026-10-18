// Regenerate exclusively from the read-only reference at bca4fe5, never from src/.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const reference = (await readdir(new URL("../.ref/", import.meta.url))).filter((name) =>
	name.endsWith("-bca4fe5"),
);
if (reference.length !== 1) throw new Error("expected exactly one pinned bca4fe5 export in .ref/");
const base = new URL(`../.ref/${reference[0]}/`, import.meta.url);
const { documentToText } = await import(new URL("src/inbox/documents.ts", base).href);
const { subtitlesToText } = await import(new URL("src/inbox/subtitles.ts", base).href);
const { scan, visible } = await import(new URL("src/vault/hidden.ts", base).href);
const ocrVariable = `${reference[0]?.slice(0, -"-bca4fe5".length).toUpperCase()}_OCR_BIN`;
const previous = process.env[ocrVariable];
process.env[ocrVariable] = fileURLToPath(new URL("./ocr-stub.ts", import.meta.url));
let count = 0;
await mkdir(new URL("../test/golden/scanner/", import.meta.url), { recursive: true });
await mkdir(new URL("../test/golden/invalid/", import.meta.url), { recursive: true });
try {
	for (const group of ["documents", "injection", "subtitles"]) {
		const fixtures = new URL(`../test/fixtures/${group}/`, import.meta.url);
		const output = new URL(`../test/golden/${group}/`, import.meta.url);
		await mkdir(output, { recursive: true });
		for (const name of (await readdir(fixtures)).sort()) {
			if (name.startsWith("a4-")) continue; // Raw Unicode/markup samples exercise the scanner separately.
			const file = new URL(name, fixtures);
			const bytes = await readFile(file);
			const markdown: string = /\.(srt|vtt)$/.test(name)
				? subtitlesToText(bytes.toString("utf8"))
				: await documentToText(fileURLToPath(file), name, bytes);
			await writeFile(new URL(`${name}.md`, output), markdown);
			count++;
		}
	}
	for (const name of (
		await readdir(new URL("../test/fixtures/injection/", import.meta.url))
	).filter((name) => name.startsWith("a4-"))) {
		const raw = await readFile(
			new URL(`../test/fixtures/injection/${name}`, import.meta.url),
			"utf8",
		);
		const lines = raw.replace(/\n$/, "").split("\n");
		const result = scan(lines);
		const expected = {
			flags: result.flags.filter((flag: string) => flag !== "speaker"),
			hidden: [...result.hidden],
			visible: lines.map((line) => visible(line)),
		};
		await writeFile(
			new URL(`../test/golden/scanner/${name}.json`, import.meta.url),
			`${JSON.stringify(expected, null, 2)}\n`,
		);
	}
	const name = "password.pdf";
	const file = new URL(`../test/fixtures/invalid/${name}`, import.meta.url);
	try {
		await documentToText(fileURLToPath(file), name, await readFile(file));
		throw new Error("protected fixture unexpectedly converted");
	} catch (error) {
		const failure = error as { code?: string; message: string };
		if (!failure.code) throw error;
		await writeFile(
			new URL(`../test/golden/invalid/${name}.json`, import.meta.url),
			`${JSON.stringify({ code: failure.code, message: failure.message }, null, 2)}\n`,
		);
	}
} finally {
	if (previous === undefined) delete process.env[ocrVariable];
	else process.env[ocrVariable] = previous;
}
console.log(
	`Generated ${count} document goldens, 3 scanner goldens and 1 refusal golden at bca4fe5`,
);
