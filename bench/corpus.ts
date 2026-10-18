// The corpus: the repo's own synthetic fixtures (always present), the pinned public files and the
// Split-View canaries (present once `prepare` has run). Answer keys are data files or the fixture keys.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DOCUMENT_CASES, NOT_EXTRACTED, OFFICE_CASES } from "../scripts/document-cases.ts";
import { DOCS, HIDDEN_MARKERS } from "../scripts/facts.ts";
import { mailKey } from "../scripts/mail-key.ts";
import { officeKey } from "../scripts/office-key.ts";
import type { Key } from "./score.ts";

export interface Entry extends Key {
	file: string;
	path: string;
	group: "public" | "synthetic" | "splitview";
	/** Plan set: A public documents, B Split-View canaries, C the repo's own injection and fidelity set. */
	set: "A" | "B" | "C";
	source: string;
	license: string;
	licenseUrl: string;
	sha256: string;
	/** Split-View gap id, for set B. */
	gap?: string;
	family?: string;
}

export const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const here = (...p: string[]) => join(import.meta.dirname, ...p);
export const data = <T>(name: string): T => JSON.parse(readFileSync(here("data", name), "utf8"));

export interface PublicFile extends Key {
	file: string;
	url: string;
	sha256: string;
	license: string;
	licenseUrl: string;
	transform: string | null;
}
export interface SplitView {
	source: string;
	record: string;
	url: string;
	file: string;
	sha256: string;
	license: string;
	pdfs: string;
	note: string;
	gaps: { id: string; family: string; visible: string; payload: string }[];
}
export const PUBLIC = data<PublicFile[]>("public.json");
export const SPLITVIEW = data<SplitView>("splitview.json");

interface Control {
	file: string;
	dir?: string;
	/** Literal document text, for cases that have no fixture file; {tag} becomes the tag-character payload. */
	html?: string;
	tag?: string;
	/** Variation-selector payload: "bmp" spells it in U+FE00-FE0F nibbles, "supp" in U+E0100-E01EF bytes. */
	vs?: { mode: "bmp" | "supp"; text: string };
	facts?: string[];
	hidden?: string[];
}

const FIXTURES = here("../test/fixtures");
const empty = { facts: [], rows: [], order: [], anchors: [], hidden: [] };
// Tag characters spell ASCII at U+E0000 + the code point: the payload as the file holds it.
const tagged = (s: string) =>
	[...s].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");

const nibble = (n: number) => String.fromCodePoint(0xfe00 + n);
const smuggled = (mode: "bmp" | "supp", s: string) =>
	[...s]
		.map((c) => {
			const b = c.charCodeAt(0);
			return mode === "bmp" ? nibble(b >> 4) + nibble(b & 15) : String.fromCodePoint(0xe0100 + b);
		})
		.join("");

function add(entries: Entry[], file: string, path: string, key: Key): Entry {
	const entry: Entry = {
		...key,
		file,
		path,
		group: "synthetic",
		set: "C",
		source: `test/fixtures/${path.slice(FIXTURES.length + 1)}`,
		license: "synthetic fixture of this repository",
		licenseUrl: "LICENSE",
		sha256: digest(readFileSync(path)),
	};
	entries.push(entry);
	return entry;
}

/** The repo's handwritten answer keys and fixtures; nothing is generated or downloaded here. */
function synthetic(entries: Entry[], cache: string): void {
	const docs = join(FIXTURES, "documents");
	for (const doc of DOCS) {
		add(entries, doc.file, join(docs, doc.file), {
			facts: doc.facts.map((f) => f.a),
			rows: doc.rows ?? [],
			order: doc.order ?? [],
			anchors: doc.facts.filter((f) => f.page).map((f) => ({ label: `[p. ${f.page}]`, fact: f.a })),
			hidden: doc.file === "hidden-text.pdf" ? HIDDEN_MARKERS : [],
		});
	}
	for (const key of officeKey) {
		const anchors = key.anchors.map((label) => ({ label, fact: "" }));
		add(entries, key.file, join(docs, key.file), { ...key, order: [], anchors });
	}
	for (const key of mailKey) {
		const anchors = [...key.structure, ...key.headers].map((label) => ({ label, fact: "" }));
		add(entries, key.file, join(docs, key.file), { ...key, rows: [], order: [], anchors });
	}
	const injection = join(FIXTURES, "injection");
	for (const c of [...DOCUMENT_CASES, ...OFFICE_CASES, ...NOT_EXTRACTED]) {
		const entry =
			entries.find((e) => e.file === c.file) ??
			add(entries, c.file, join(injection, c.file), { ...empty });
		// A case that must be flagged is a hidden payload; any other is ordinary visible text.
		if (!("flags" in c) || (Array.isArray(c.flags) && c.flags.length))
			entry.hidden = [...entry.hidden, c.canary];
		else entry.facts = [...entry.facts, c.canary];
	}
	for (const c of data<Control[]>("control.json")) {
		let path = join(FIXTURES, c.dir ?? "", c.file);
		if (c.html !== undefined) {
			// Unicode cases live in the data file; they are written out so every tool reads a real file.
			path = join(cache, "synthetic", c.file);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(
				path,
				c.html
					.replace("{tag}", tagged(c.tag ?? ""))
					.replace("{vs}", smuggled(c.vs?.mode ?? "bmp", c.vs?.text ?? "")),
			);
		}
		const hidden = [
			...(c.hidden ?? []),
			...(c.tag ? [tagged(c.tag)] : []),
			...(c.vs ? [smuggled(c.vs.mode, c.vs.text)] : []),
		];
		const entry = add(entries, c.file, path, { ...empty, facts: c.facts ?? [], hidden });
		if (c.html !== undefined) entry.source = "bench/data/control.json";
	}
}

/** Entries whose file is not in the cache are left out: a corpus is what has been prepared. */
export function corpus(cache: string): Entry[] {
	const entries: Entry[] = [];
	synthetic(entries, cache);
	for (const item of PUBLIC) {
		const path = join(cache, "corpus", item.file);
		if (!existsSync(path)) continue;
		entries.push({
			...item,
			path,
			group: "public",
			set: "A",
			source: item.url,
			sha256: digest(readFileSync(path)),
		});
	}
	for (const gap of SPLITVIEW.gaps) {
		const file = `${gap.id}_canary.pdf`;
		const path = join(cache, "splitview", SPLITVIEW.pdfs, file);
		if (!existsSync(path)) continue;
		entries.push({
			...empty,
			facts: [gap.visible],
			hidden: [gap.payload],
			file,
			path,
			group: "splitview",
			set: "B",
			source: SPLITVIEW.record,
			license: SPLITVIEW.license,
			licenseUrl: SPLITVIEW.record,
			sha256: digest(readFileSync(path)),
			gap: gap.id,
			family: gap.family,
		});
	}
	return entries;
}
