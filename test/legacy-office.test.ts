import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { convert } from "./text-mode.ts";

const documentToText = async (path: string, name: string, bytes: Uint8Array) =>
	(await convert(bytes, { name, path })).markdown;

import { HIDDEN_BLOCK, scan } from "../src/hidden.ts";

const fixtures = new URL("./fixtures/documents/", import.meta.url);
const mac = process.platform === "darwin";

async function inScratch(run: (directory: string) => Promise<void>) {
	const directory = await mkdtemp(join(tmpdir(), "legacy-acceptance-"));
	const previous = process.env.TMPDIR;
	process.env.TMPDIR = directory;
	try {
		await run(directory);
	} finally {
		if (previous === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previous;
		await rm(directory, { recursive: true, force: true });
	}
}

for (const extension of ["doc", "rtf"]) {
	test(`legacy .${extension} converts through macOS textutil and cleans scratch files`, {
		skip: !mac,
	}, async () => {
		const name = `office-legacy.${extension}`;
		const file = new URL(name, fixtures);
		const bytes = await readFile(file);
		await inScratch(async (directory) => {
			const output = await documentToText(fileURLToPath(file), name, bytes);
			for (const fact of [
				"Harbor legacy report",
				"Budget is 42000 EUR",
				"Delivery",
				"Launch on 8 November",
				"Visible legacy paragraph",
			])
				assert.ok(output.includes(fact), `missing fact: ${fact}`);
			const visible = output.split(HIDDEN_BLOCK)[0] ?? "";
			assert.match(
				visible,
				/visibility|layout|formatting/i,
				"warns that original visibility could not be verified",
			);
			const cells = ["Team", "Seats", "Otter", "12"].map((text) => output.indexOf(text));
			assert.ok(
				cells.every((at, i) => at >= 0 && (i === 0 || at > (cells[i - 1] ?? -1))),
				"flattened table cells stay in reading order",
			);
			const lines = output.split("\n");
			const flagged = scan(lines).hidden;
			for (const canary of ["LEGACY_VANISH", "LEGACY_WHITE", "LEGACY_TINY"]) {
				const at = lines.findIndex((line) => line.includes(canary));
				assert.ok(at >= 0 && flagged.has(at + 1), `originally hidden text is flagged: ${canary}`);
			}
			assert.deepEqual(await readdir(directory), [], "conversion leaves no temporary files");
		});
	});

	test(`damaged .${extension} fails closed and cleans scratch files`, { skip: !mac }, async () => {
		await inScratch(async (directory) => {
			const file = join(directory, `damaged.${extension}`);
			const bytes = Buffer.from([0xff, 0x00, 0x9a, 0x17]);
			await writeFile(file, bytes);
			await assert.rejects(
				documentToText(file, `damaged.${extension}`, bytes),
				/could not read this file/,
			);
			assert.deepEqual(await readdir(directory), [`damaged.${extension}`]);
			assert.deepEqual(
				await readFile(file),
				bytes,
				"failed conversion leaves the inbox original untouched",
			);
		});
	});

	test(`legacy .${extension} has a clear refusal away from macOS`, { skip: mac }, async () => {
		const name = `office-legacy.${extension}`;
		const file = new URL(name, fixtures);
		await assert.rejects(
			documentToText(fileURLToPath(file), name, await readFile(file)),
			/could not read this file/,
		);
	});
}

test("Windows and Linux refuse legacy Word without invoking a converter", async () => {
	const original = Object.getOwnPropertyDescriptor(process, "platform");
	assert.ok(original);
	try {
		for (const platform of ["win32", "linux"]) {
			Object.defineProperty(process, "platform", { ...original, value: platform });
			for (const extension of ["doc", "rtf"]) {
				const name = `office-legacy.${extension}`;
				await assert.rejects(
					documentToText("unused", name, await readFile(new URL(name, fixtures))),
					/could not read this file: save it as \.docx, \.pptx or \.xlsx/,
				);
			}
		}
	} finally {
		Object.defineProperty(process, "platform", original);
	}
});

test("textutil conversion failure removes its temporary input and output", {
	skip: !mac,
}, async () => {
	await inScratch(async (directory) => {
		const bytes = Buffer.concat([
			Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
			Buffer.alloc(2048),
		]);
		await assert.rejects(documentToText("unused", "broken.doc", bytes), /could not read this file/);
		assert.deepEqual(await readdir(directory), []);
	});
});
