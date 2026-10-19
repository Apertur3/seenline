// Minimal hand-built PDFs for the synthetic fixtures (Helvetica as /F1, content streams given as text).
import { Buffer } from "node:buffer";

export type Part = string | Buffer;
const buf = (p: Part) => (typeof p === "string" ? Buffer.from(p, "latin1") : p);
export const stream = (dict: string, data: Part) => {
	const body = buf(data);
	return Buffer.concat([
		buf(`<< ${dict} /Length ${body.length} >>\nstream\n`),
		body,
		buf("\nendstream"),
	]);
};

export interface Spec {
	content: string;
	catalog?: string;
	page?: string;
	resources?: string;
	/** Objects 6, 7, ...: referenced by the strings above as "6 0 R" and so on. */
	extra?: Part[];
	info?: string;
	/** Content streams of pages 2, 3, ...: plain pages after the extra objects. */
	more?: string[];
}
export function pdf(s: Spec): Buffer {
	const more = s.more ?? [];
	const next = 6 + (s.extra?.length ?? 0);
	const kids = ["3 0 R", ...more.map((_, i) => `${next + 2 * i} 0 R`)];
	const objs: Part[] = [
		`<< /Type /Catalog /Pages 2 0 R ${s.catalog ?? ""} >>`,
		`<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`,
		`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> ${s.resources ?? ""} >> ${s.page ?? ""} >>`,
		stream("", s.content),
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		...(s.extra ?? []),
		...more.flatMap((content, i) => [
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${next + 2 * i + 1} 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
			stream("", content),
		]),
	];
	const parts: Buffer[] = [buf("%PDF-1.7\n")];
	const at: number[] = [];
	let size = parts[0]?.length ?? 0;
	objs.forEach((o, i) => {
		const b = Buffer.concat([buf(`${i + 1} 0 obj\n`), buf(o), buf("\nendobj\n")]);
		at.push(size);
		size += b.length;
		parts.push(b);
	});
	const info = s.info ? `/Info ${objs.length + 1} 0 R ` : "";
	if (s.info) {
		const b = Buffer.concat([buf(`${objs.length + 1} 0 obj\n${s.info}\nendobj\n`)]);
		at.push(size);
		size += b.length;
		parts.push(b);
	}
	const table = at.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("");
	parts.push(
		buf(
			`xref\n0 ${at.length + 1}\n0000000000 65535 f \n${table}trailer\n<< /Size ${at.length + 1} /Root 1 0 R ${info}>>\nstartxref\n${size}\n%%EOF\n`,
		),
	);
	return Buffer.concat(parts);
}

export const T = (x: number, y: number, size: number, text: string, pre = "") =>
	`BT ${pre} /F1 ${size} Tf ${x} ${y} Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET\n`;
