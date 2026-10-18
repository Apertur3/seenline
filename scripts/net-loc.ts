// Net line change of hand-written code since a base ref (default: main), for the lane report. Usage: node scripts/net-loc.ts [base]
import { execFileSync } from "node:child_process";

const base = process.argv[2] ?? "main";
const out = execFileSync(
	"git",
	["diff", "--numstat", base, "--", "src", "scripts", "test", "docs", "README.md"],
	{
		encoding: "utf8",
	},
);
let added = 0;
let removed = 0;
for (const row of out.split("\n").filter(Boolean)) {
	const [a, d, file] = row.split("\t") as [string, string, string];
	if (/^test\/(golden|fixtures)\//.test(file) || a === "-") continue;
	added += Number(a);
	removed += Number(d);
}
console.log(
	`Net lines vs ${base}: +${added} -${removed} = ${added - removed >= 0 ? "+" : ""}${added - removed}`,
);
