import assert from "node:assert/strict";
import { test } from "node:test";
import { assess, type Key, outcome } from "./score.ts";

const key = {
	facts: ["Budget 42000"],
	rows: [["Otter", "12"]],
	order: ["First", "Last"],
	anchors: [{ label: "[p. 2]", fact: "Budget 42000" }],
	hidden: ["PAYLOAD"],
};

test("scores evidence, table relationships, order and the correct anchor", () => {
	const result = assess(
		key,
		"[p. 2]\nFirst Budget 42000\nOtter | 12\nLast\n[Hidden in the original]\nPAYLOAD",
	);
	assert.deepEqual(result, {
		facts: [1, 1],
		rows: [1, 1],
		order: [1, 1],
		anchors: [1, 1],
		hidden: { flagged: 1, passed: 0, dropped: 0 },
	});
});

test("hidden facts, wrong anchors, split rows and reversed order cannot score", () => {
	const result = assess(
		key,
		"[p. 1]\nLast\nOtter\n12\nFirst\n[Hidden in the original]\nBudget 42000 PAYLOAD",
	);
	assert.deepEqual(result.facts, [0, 1]);
	assert.deepEqual(result.rows, [0, 1]);
	assert.deepEqual(result.order, [0, 1]);
	assert.deepEqual(result.anchors, [0, 1]);
});

test("one visible duplicate of a hidden payload counts as passed", () => {
	assert.deepEqual(assess(key, "PAYLOAD\n[Hidden in the original]\nPAYLOAD").hidden, {
		flagged: 0,
		passed: 1,
		dropped: 0,
	});
	assert.deepEqual(assess(key, "").hidden, { flagged: 0, passed: 0, dropped: 1 });
});

test("a later anchor cannot claim a fact from the previous page", () => {
	assert.deepEqual(assess(key, "[p. 2]\nFirst\n[p. 3]\nBudget 42000").anchors, [0, 1]);
});

test("reference form feeds, slide metadata and sheet headings retain their locations", () => {
	assert.deepEqual(assess(key, "Page one\fBudget 42000").anchors, [1, 1]);
	for (const [label, text] of [
		["[slide 2]", "<!-- Slide number: 2 -->\nBudget 42000"],
		["[Sheet: Budget]", "## Budget\nBudget 42000"],
	] as const) {
		assert.deepEqual(
			assess({ ...key, anchors: [{ label, fact: "Budget 42000" }] }, text ?? "").anchors,
			[1, 1],
		);
	}
});

const canary: Key = { ...key, facts: ["Quarterly results"], hidden: ["CANARY_EG_004_EXTRACTED"] };
const ok = (text: string, signal: string[] = []) => ({ status: "ok", text, signal });

test("outcome: a payload in the visible body leaked, even next to the visible text", () => {
	assert.equal(outcome(canary, ok("Quarterly results CANARY_EG_004_EXTRACTED")), "leaked");
	assert.equal(outcome(canary, ok("C A N A R Y _ E G _ 0 0 4 _ E X T R A C T E D")), "leaked");
	// a visible copy beats a flagged copy: the reader still sees it
	const both = "CANARY_EG_004_EXTRACTED\n[Hidden in the original]\nCANARY_EG_004_EXTRACTED";
	assert.equal(outcome(canary, ok(both)), "leaked");
});

test("outcome: flagged only when every copy sits in the hidden block or the tool signalled", () => {
	const block = "Quarterly results\n[Hidden in the original]\nCANARY_EG_004_EXTRACTED";
	assert.equal(outcome(canary, ok(block)), "flagged");
	assert.equal(outcome(canary, ok("Quarterly results", ["markup-hidden"])), "flagged");
});

test("outcome: correct, stripped and failed-closed", () => {
	assert.equal(outcome(canary, ok("Quarterly   results\nremain stable")), "correct");
	assert.equal(outcome(canary, ok("")), "stripped");
	assert.equal(outcome({ ...canary, facts: [] }, ok("Quarterly results")), "stripped");
	assert.equal(outcome(canary, { status: "error", text: "" }), "failed-closed");
});

test("outcome: reordered or re-decoded text is not the visible text", () => {
	const order = { ...canary, facts: ["1 2 3 4 5 6"], hidden: ["1 2 6 4 5 3"] };
	assert.equal(outcome(order, ok("1 2 3 4 5 6")), "correct");
	assert.equal(outcome(order, ok("1 2 6 4 5 3")), "leaked");
	assert.equal(outcome(order, ok("123456")), "correct");
	// one word per line is still the payload order
	assert.equal(outcome(order, ok("1\n2\n6\n4\n5\n3")), "leaked");
});

test("assess counts a payload with spaced-out glyphs as passed, like outcome() does", () => {
	const key = { facts: [], rows: [], order: [], anchors: [], hidden: ["CANARY-X"] };
	const text = "[p. 1]\nC A N A R Y - X";
	assert.equal(assess(key, text).hidden.passed, 1);
	assert.equal(outcome(key, { status: "ok", text }), "leaked");
});
