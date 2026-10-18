import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("Office hidden-content gate kills a missing hidden-header mutation", () => {
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	const result = spawnSync(
		process.execPath,
		[
			"--import",
			fileURLToPath(new URL("./office-mutation.ts", import.meta.url)),
			"--test",
			fileURLToPath(new URL("./office-boundary.test.ts", import.meta.url)),
		],
		{ encoding: "utf8", timeout: 30_000, env },
	);
	assert.ifError(result.error);
	const output = result.stdout + result.stderr;
	assert.doesNotMatch(output, /mutation did not apply|SyntaxError|ERR_MODULE_NOT_FOUND/);
	assert.notEqual(result.status, 0, "the gate survived unflagged Office hidden content");
	assert.match(output, /source\.flags\?\.includes\("markup-hidden"\)/);
});
