// Size gates: files over 400 lines warn (hard ceiling 1000) and ratchet (an over-budget file may only shrink, a new one must comply);
// functions over 100 lines warn; a unit may grow at most 10% per release. Over-budget files and exemptions live in
// size-ledger.json; generated files carry "@generated" in their first lines.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const FILE_BUDGET = 400;
const HARD_CEILING = 1000;
const FUNCTION_BUDGET = 100;
const GROWTH = 0.1;
// ponytail: indentation heuristic (the code is tab-formatted by biome); upgrade to a real parser if it misfires.
const HEADER =
	/^(\t*)(?:(?:export |async |static |public |private )*function\b|(?:async )?[\w$]+\(.*\)(?:: [^{]+)? \{$|.*=> \{$)/;
const CONTROL = /^\t*(?:if|for|while|switch|catch|else|try|do)\b/;
const UNITS = ["src", "scripts", "test"];
const ledger = JSON.parse(readFileSync("size-ledger.json", "utf8")) as {
	releases: { version: string; lines: Record<string, number> }[];
	overBudget: Record<string, number>;
	exemptions: { version: string; unit: string; reason: string }[];
};
const version = JSON.parse(readFileSync("package.json", "utf8")).version as string;
const files = execFileSync(
	"git",
	["ls-files", "--cached", "--others", "--exclude-standard", ...UNITS],
	{
		encoding: "utf8",
	},
)
	.split("\n")
	.filter((f) => /\.(ts|mjs|js|py)$/.test(f) && !/^test\/(golden|fixtures)\//.test(f));

const lines = (f: string) => readFileSync(f, "utf8").split("\n").length - 1;
const problems: string[] = [];
const warnings: string[] = [];
const over: Record<string, number> = {};
const totals: Record<string, number> = Object.fromEntries(UNITS.map((u) => [u, 0]));
for (const f of files) {
	const text = readFileSync(f, "utf8");
	if (text.split("\n", 5).some((l) => l.includes("@generated"))) continue;
	const n = lines(f);
	const unit = f.split("/")[0] as string;
	totals[unit] = (totals[unit] ?? 0) + n;
	if (n > HARD_CEILING) problems.push(`${f}: ${n} lines, over the hard ceiling of ${HARD_CEILING}`);
	else if (n > FILE_BUDGET) {
		over[f] = n;
		const allowed = ledger.overBudget[f];
		if (allowed === undefined)
			problems.push(`${f}: ${n} lines, a new file must stay within ${FILE_BUDGET}`);
		else if (n > allowed)
			problems.push(
				`${f}: grew from ${allowed} to ${n} lines; an over-budget file may only shrink`,
			);
		else warnings.push(`${f}: ${n} lines (budget ${FILE_BUDGET})`);
	}
	if (f.endsWith(".ts")) warnings.push(...longFunctions(f, text));
}
function longFunctions(f: string, text: string): string[] {
	const rows = text.split("\n");
	const found: string[] = [];
	for (const [i, row] of rows.entries()) {
		const m = HEADER.exec(row);
		if (!m || CONTROL.test(row) || !row.endsWith("{")) continue;
		const close = rows.findIndex(
			(r, j) => j > i && r.startsWith(`${m[1]}}`) && !r.startsWith(`${m[1]}\t`),
		);
		if (close - i + 1 > FUNCTION_BUDGET)
			found.push(`${f}:${i + 1}: function of ${close - i + 1} lines (budget ${FUNCTION_BUDGET})`);
	}
	return found;
}
const last = ledger.releases.at(-1);
for (const unit of UNITS) {
	const before = last?.lines[unit];
	if (before === undefined || (totals[unit] ?? 0) <= before * (1 + GROWTH)) continue;
	const exempt = ledger.exemptions.some((e) => e.unit === unit && e.version === version);
	if (!exempt)
		problems.push(
			`${unit}: ${totals[unit]} lines vs ${before} at ${last?.version} (more than ${GROWTH * 100}% growth, no exemption for ${version})`,
		);
}
if (process.argv.includes("--record")) {
	ledger.releases.push({ version, lines: totals });
	ledger.overBudget = over;
	console.log(JSON.stringify(ledger, null, "\t"));
	process.exit(0);
}
console.log(
	`Size: ${UNITS.map((u) => `${u} ${totals[u]}`).join(", ")} lines (last release ${last?.version ?? "none"}).`,
);
if (warnings.length > 0) console.warn(`warnings:\n${warnings.join("\n")}`);
if (problems.length > 0) {
	console.error(problems.join("\n"));
	process.exit(1);
}
