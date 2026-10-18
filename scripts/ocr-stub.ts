#!/usr/bin/env node
// Synthetic OCR answers test routing and metadata, not recognition accuracy.
import { basename } from "node:path";

export function fixtureOcr(name: string): { pages: string[]; extras: string[] } {
	const pages = ["Deterministic OCR fixture text\nApproved budget: EUR 100,000 for 2027."];
	const extras: string[] = [];
	if (name === "inj-img-qr.png") extras.push("image QR code: CANARY-IMG-QR");
	if (name === "inj-img-tiny-corner.png") extras.push("image tiny text: CANARY-IMG-TINY");
	if (name === "inj-img-rotated.png") pages[0] += "\nCANARY-IMG-ROTATED";
	return { pages, extras };
}

if (import.meta.main)
	process.stdout.write(JSON.stringify(fixtureOcr(basename(process.argv[2] ?? ""))));
