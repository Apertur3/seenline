// The default hidden mode, describe: byte parity with the expected files in test/fixtures/describe
// (written by this repository, not the pinned reference), and no listed hidden text in the Markdown.
//   UPDATE_DESCRIBE=1 node --test test/describe.test.ts   rewrites the expected files; read the diff.
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { test } from "node:test";
import { convert } from "../src/index.ts";

const expected = new URL("./fixtures/describe/", import.meta.url);

for (const group of await readdir(expected))
	for (const file of await readdir(new URL(`${group}/`, expected))) {
		const name = file.replace(/\.md$/, "");
		const legacy = /\.(doc|rtf)$/i.test(name);
		test(`describe parity: ${group}/${name}`, {
			skip: legacy && platform() !== "darwin",
		}, async () => {
			const bytes = await readFile(new URL(`./fixtures/${group}/${name}`, import.meta.url));
			const { markdown, hidden } = await convert(bytes, { name });
			const at = new URL(`${group}/${file}`, expected);
			if (process.env.UPDATE_DESCRIBE) await writeFile(at, markdown);
			assert.equal(markdown, await readFile(at, "utf8"));
			// The described entries: the block, or for a legacy conversion (whose converted text stays
			// readable) the converted file's own block. Short texts could match a count by chance.
			const described = markdown.split("[Hidden in the original]\n").at(-1) ?? "";
			for (const { text } of hidden)
				if (text.length >= 8 && !/^HTML (script|style) present/.test(text))
					assert.ok(!described.includes(text), `${name}: ${text}`);
		});
	}
