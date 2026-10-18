// Size gates: hand-written files stay under 400 lines (hard ceiling 800), and a unit may grow at most 10% per release.
// Exemptions live in size-ledger.json with a reason; generated files carry "@generated" in their first lines.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const FILE_BUDGET = 400;
const HARD_CEILING = 800;
const GROWTH = 0.1;
const UNITS = ["src", "scripts", "test"];
const ledger = JSON.parse(readFileSync("size-ledger.json", "utf8")) as {
	releases: { version: string; lines: Record<string, number> }[];
	exemptions: { version?: string; unit?: string; file?: string; reason: string }[];
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
const totals: Record<string, number> = Object.fromEntries(UNITS.map((u) => [u, 0]));
for (const f of files) {
	const text = readFileSync(f, "utf8");
	if (text.split("\n", 5).some((l) => l.includes("@generated"))) continue;
	const n = lines(f);
	const unit = f.split("/")[0] as string;
	totals[unit] = (totals[unit] ?? 0) + n;
	const exempt = ledger.exemptions.some((e) => e.file === f);
	if (n > HARD_CEILING) problems.push(`${f}: ${n} lines, over the hard ceiling of ${HARD_CEILING}`);
	else if (n > FILE_BUDGET && !exempt)
		problems.push(`${f}: ${n} lines, over ${FILE_BUDGET} without an exemption`);
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
	console.log(JSON.stringify(ledger, null, "\t"));
	process.exit(0);
}
console.log(
	`Size: ${UNITS.map((u) => `${u} ${totals[u]}`).join(", ")} lines (last release ${last?.version ?? "none"}).`,
);
if (problems.length > 0) {
	console.error(problems.join("\n"));
	process.exit(1);
}
