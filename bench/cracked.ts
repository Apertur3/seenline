// CrackedPDFs (arXiv:2607.19396, MIT): detection and false-positive run. The PDFs are adversarial
// and are only ever parsed by convert(); they live in the cache, never in the repository.
//   node bench/cracked.ts prepare | run [test|train|all] | report [test|train|all]   (PLAINVIEW_BENCH_CACHE as in run.ts)
// Detected = a hidden entry or a scanner flag, the same test --fail-on-hidden applies.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { convert } from "../src/index.ts";
import { parseHidden } from "../src/parse-hidden.ts";
import { data, digest } from "./corpus.ts";

interface Cracked {
	files: { name: string; url: string; sha256: string }[];
}
interface Meta {
	pdf_id: string;
	pdf_role: string;
	file_path: string;
	pair_id: string;
	attack_family: string;
	rendering_regime: string;
	spatial_regime: string;
	structural_regime: string;
	message_type: string;
}
interface Row {
	id: string;
	status: "ok" | "error" | "timeout";
	error: string;
	detected: boolean;
	hidden: number;
	hiddenChars: number;
	flags: string[];
	reasons: string[];
	/** A hidden entry reads like an instruction to an AI once the dataset's marker tokens are removed. */
	suspect: string[];
	ms: number;
}

const CRACKED = data<Cracked>("cracked.json");
const TIMEOUT_MS = 60_000;
// The dataset's own artefacts (its errata): marker tokens and "benign" self-labels, removed before
// the suspect rules run so they cannot score on them.
const MARKERS =
	/\[?(DATASET_SAMPLE_ID|MESSAGE_TYPE)=[^\]\s]*\]?|<?\/?(SYSTEM_POLICY_DO_NOT_REMOVE|DOCUMENT_LAYOUT_NOTE)>?|benign[^.]*\.|no prompt directive/gi;

export async function prepareCracked(cache: string): Promise<void> {
	const dir = join(cache, "cracked");
	mkdirSync(dir, { recursive: true });
	for (const f of CRACKED.files) {
		const dest = join(dir, f.name.replace("/", "-"));
		if (!existsSync(dest)) {
			const res = await fetch(f.url, { redirect: "follow" });
			if (!res.ok) throw new Error(`${f.name}: HTTP ${res.status}`);
			const bytes = new Uint8Array(await res.arrayBuffer());
			if (digest(bytes) !== f.sha256) throw new Error(`${f.name}: source checksum changed`);
			writeFileSync(dest, bytes);
		}
		if (
			f.name.endsWith(".tar.gz") &&
			!existsSync(join(dir, f.name.split("/")[1]?.split(".")[0] ?? ""))
		)
			execFileSync("tar", ["xzf", dest, "-C", dir]);
	}
}

const metas = (dir: string): Meta[] =>
	readFileSync(join(dir, "data-metadata.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));

function selection(dir: string, which: string): Meta[] {
	const all = metas(dir);
	if (which === "all") return all;
	const test = new Set<string>(
		JSON.parse(readFileSync(join(dir, "data-splits.json"), "utf8"))[`${which}_ids`],
	);
	return all.filter((m) => test.has(m.pdf_id));
}

export async function runCracked(cache: string, which = "test"): Promise<void> {
	const dir = join(cache, "cracked");
	const out: string[] = [];
	for (const m of selection(dir, which)) {
		const path = join(dir, m.file_path);
		const t0 = performance.now();
		const row: Row = {
			id: m.pdf_id,
			status: "ok",
			error: "",
			detected: false,
			hidden: 0,
			hiddenChars: 0,
			flags: [],
			reasons: [],
			suspect: [],
			ms: 0,
		};
		try {
			const bytes = new Uint8Array(readFileSync(path));
			const r = await Promise.race([
				convert(bytes, { name: m.file_path, path }),
				new Promise<never>((_, rej) =>
					setTimeout(() => rej(new Error("timeout")), TIMEOUT_MS).unref(),
				),
			]);
			row.hidden = r.hidden.length;
			row.hiddenChars = r.hidden.reduce((n, h) => n + h.text.length, 0);
			row.flags = r.flags;
			row.reasons = [...new Set(r.hidden.flatMap((h) => h.reasons))];
			row.detected = r.hidden.length > 0 || r.flags.length > 0;
			const lines = r.hidden.map(
				(h) => `${h.anchor}, ${h.reasons.join(" and ")} text: ${h.text.replace(MARKERS, " ")}`,
			);
			row.suspect = [...new Set(parseHidden(lines).flatMap((h) => h.suspect ?? []))];
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			Object.assign(row, {
				status: msg === "timeout" ? "timeout" : "error",
				error: msg.slice(0, 200),
			});
		}
		row.ms = Math.round(performance.now() - t0);
		out.push(JSON.stringify(row));
	}
	writeFileSync(join(dir, `results-${which}.jsonl`), `${out.join("\n")}\n`);
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "n/a");

/** Plain-text report: confusion, per-role rates, breakdowns, length-tied subset. Errors count as not detected. */
export function reportCracked(cache: string, which = "test"): string {
	const dir = join(cache, "cracked");
	const rows = new Map<string, Row>();
	for (const l of readFileSync(join(dir, `results-${which}.jsonl`), "utf8")
		.trim()
		.split("\n")) {
		const r: Row = JSON.parse(l);
		rows.set(r.id, r);
	}
	const sel = selection(dir, which);
	const by = new Map(sel.map((m) => [m.pdf_id, m]));
	const lines: string[] = [];
	const det = (m: Meta) => rows.get(m.pdf_id)?.detected ?? false;
	const role = (r: string) => sel.filter((m) => m.pdf_role === r);
	const rate = (ms: Meta[]) =>
		`${ms.filter(det).length}/${ms.length} ${pct(ms.filter(det).length, ms.length)}`;
	const inj = role("injected_attack");
	const conf = role("benign_confounder");
	const orig = role("benign_original");
	const f1 = (tp: number, fp: number, fn: number) =>
		((2 * tp) / (2 * tp + fp + fn || 1)).toFixed(3);
	const tp = inj.filter(det).length;
	const fpC = conf.filter(det).length;
	const fpO = orig.filter(det).length;
	lines.push(
		`files ${sel.length}: injected ${inj.length}, confounder ${conf.length}, original ${orig.length}`,
	);
	lines.push(
		`recall injected ${rate(inj)}`,
		`FP confounder ${rate(conf)}`,
		`FP original ${rate(orig)}`,
	);
	lines.push(`F1 (negatives = confounder+original) ${f1(tp, fpC + fpO, inj.length - tp)}`);
	lines.push(`F1 (negatives = confounder only) ${f1(tp, fpC, inj.length - tp)}`);
	const bad = [...rows.values()].filter((r) => r.status !== "ok");
	lines.push(`not ok: ${bad.length}`);
	const causes: Record<string, number> = {};
	for (const r of bad)
		causes[`${by.get(r.id)?.pdf_role}: ${r.status} ${r.error}`] =
			(causes[`${by.get(r.id)?.pdf_role}: ${r.status} ${r.error}`] ?? 0) + 1;
	for (const [k, v] of Object.entries(causes)) lines.push(`  ${v}  ${k}`);
	for (const key of [
		"attack_family",
		"rendering_regime",
		"spatial_regime",
		"structural_regime",
		"message_type",
	] as const) {
		lines.push(`\nrecall by ${key}`);
		for (const v of [...new Set(inj.map((m) => m[key]))].sort())
			lines.push(`  ${v}\t${rate(inj.filter((m) => m[key] === v))}`);
	}
	// Length proxies (the metadata has no payload length): "bytes" = what a file adds over its benign original;
	// "hidden" = characters in Plainview's own hidden block. Tied = confounder within 10% of the injected one.
	const size = (m: Meta) => statSync(join(dir, m.file_path)).size;
	const pairs = new Map<string, Record<string, Meta>>();
	for (const m of metas(dir)) pairs.set(m.pair_id, { ...pairs.get(m.pair_id), [m.pdf_role]: m });
	const len: Record<string, (m: Meta, p: Record<string, Meta>) => number> = {
		bytes: (m, p) => size(m) - size(p.benign_original as Meta),
		hidden: (m) => rows.get(m.pdf_id)?.hiddenChars ?? 0,
	};
	for (const [name, f] of Object.entries(len)) {
		const tied = new Set<string>();
		for (const m of inj) {
			const p = pairs.get(m.pair_id);
			if (!p?.benign_original || !p.benign_confounder) continue;
			const di = f(m, p);
			if (di > 0 && Math.abs(f(p.benign_confounder, p) - di) <= 0.1 * di) tied.add(m.pair_id);
		}
		const ti = inj.filter((m) => tied.has(m.pair_id));
		const tc = conf.filter((m) => tied.has(m.pair_id));
		lines.push(`\nlength-tied pairs by ${name}: ${tied.size} of ${inj.length}`);
		lines.push(`  recall injected ${rate(ti)}`, `  FP confounder ${rate(tc)}`);
		lines.push(
			`  F1 (confounder negatives) ${f1(ti.filter(det).length, tc.filter(det).length, ti.length - ti.filter(det).length)}`,
		);
	}
	const tagged = (m: Meta) => (rows.get(m.pdf_id)?.suspect.length ?? 0) > 0;
	const trate = (ms: Meta[]) =>
		`${ms.filter(tagged).length}/${ms.length} ${pct(ms.filter(tagged).length, ms.length)}`;
	lines.push(
		`\nsuspect tag (markers removed): injected ${trate(inj)}, confounder ${trate(conf)}, original ${trate(orig)}`,
	);
	for (const key of ["message_type", "attack_family"] as const)
		for (const v of [...new Set(inj.map((m) => m[key]))].sort())
			lines.push(`  ${key} ${v}\t${trate(inj.filter((m) => m[key] === v))}`);
	lines.push("\nmissed injected by family");
	for (const m of inj.filter((x) => !det(x))) lines.push(`  ${m.attack_family}\t${m.pdf_id}`);
	lines.push("\nfalse positives on confounders: reasons/flags");
	const why: Record<string, number> = {};
	for (const m of conf.filter(det)) {
		const r = rows.get(m.pdf_id);
		const k = [...(r?.reasons ?? []), ...(r?.flags ?? [])].join(" + ");
		why[k] = (why[k] ?? 0) + 1;
	}
	for (const [k, v] of Object.entries(why).sort((a, b) => b[1] - a[1])) lines.push(`  ${v}  ${k}`);
	return lines.join("\n");
}

if (import.meta.main) {
	const cache = process.env.PLAINVIEW_BENCH_CACHE ?? "";
	const [cmd, which] = process.argv.slice(2);
	if (cmd === "prepare") await prepareCracked(cache);
	else if (cmd === "run") await runCracked(cache, which);
	else console.log(reportCracked(cache, which));
}
