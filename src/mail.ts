// Local mail/web conversion shares the document hidden-content boundary.
import { failure, PlainviewError } from "./error.ts";
import { HIDDEN_BLOCK } from "./hidden.ts";
import { type MailText, readHtml } from "./html.ts";
import { decodeCharset, headerText, type MimePart, mimeParams, readMime } from "./mime.ts";
import { unseen } from "./parse-hidden.ts";

const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const safe = (s: string) => (s === HIDDEN_BLOCK ? `${s} (written in the file)` : s);
function quoted(raw: string): string[] {
	let older = false;
	return raw
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => {
			if (
				/^(?:On .+wrote:|Op .+schreef .+:|-{2,}\s*(?:Original Message|Oorspronkelijk bericht|Forwarded message))/i.test(
					line,
				)
			)
				older = true;
			return older && line && !/^\s*>/.test(line) ? `> ${line}` : line;
		});
}
function addLeaf(part: MimePart, plain: string[], html: MailText[], out: MailText): void {
	const disposition = mimeParams(part.headers.get("content-disposition") ?? "inline");
	const filename =
		disposition.params.filename ?? disposition.params["filename*"] ?? part.params.name;
	if (
		disposition.value === "attachment" ||
		filename ||
		!["text/plain", "text/html"].includes(part.type)
	) {
		out.body.push(
			`Attachment: ${flat(headerText(filename ?? "(unnamed)"))}; ${part.type}; ${part.bytes.length} bytes (not converted)`,
		);
		return;
	}
	const text = decodeCharset(part.bytes, part.params.charset ?? "us-ascii");
	if (part.type === "text/plain") plain.push(text);
	else html.push(readHtml(text));
}
function email(bytes: Uint8Array): MailText {
	const root = readMime(bytes),
		out: MailText = { body: [], hidden: [] };
	for (const name of ["From", "To", "Cc", "Date", "Subject"]) {
		const raw = root.headers.get(name.toLowerCase());
		if (raw !== undefined) out.body.push(`${name}: ${headerText(raw)}`);
	}
	const plain: string[] = [],
		html: MailText[] = [],
		attachments: MailText = { body: [], hidden: [] };
	const walk = (part: MimePart) => {
		for (const [name, raw] of part.headers) {
			const text = headerText(raw);
			if (
				!["from", "to", "cc", "date", "subject"].includes(name) &&
				/(?:\bai\b|assistant|llm|prompt|chatgpt|instruct|ignore|negeer|systeem)/i.test(
					`${name}: ${text}`,
				)
			)
				out.hidden.push(`Mail header ${name}: ${flat(text)}`);
		}
		if (part.children.length) {
			if (mimeParams(part.headers.get("content-disposition") ?? "inline").value === "attachment")
				throw new Error("multipart attachment unsupported");
			for (const child of part.children) walk(child);
		} else addLeaf(part, plain, html, attachments);
	};
	walk(root);
	if (plain.length) out.body.push(...plain.flatMap(quoted));
	else if (html.length) out.body.push(...(html[0]?.body ?? []));
	for (const [i, parsed] of html.entries()) {
		out.hidden.push(...parsed.hidden);
		// Even a small extra instruction in an alternative is material; preserve every differing alternative.
		if (
			(plain.length || i > 0) &&
			flat(parsed.body.join(" ")) !==
				flat(plain.length ? plain.join(" ") : (html[0]?.body.join(" ") ?? ""))
		)
			out.hidden.push(`Mail alternate HTML: ${flat(parsed.body.join(" "))}`);
	}
	out.body.push(...attachments.body);
	if (!plain.length && !html.length && !attachments.body.length) throw new Error("no mail text");
	return out;
}
export function convertMail(bytes: Uint8Array, name: string): string {
	if (/\.msg$/i.test(name))
		throw new PlainviewError(
			"invalid",
			"could not read this file: export or save Outlook mail as .eml",
		);
	try {
		if (bytes.length > 50 * 1024 * 1024) throw new Error("file size");
		const out = /\.eml$/i.test(name) ? email(bytes) : readHtml(decodeCharset(bytes));
		const body = out.body.map(safe);
		const listed = unseen(body, out.hidden);
		const result = [...body, ...(listed.length ? [HIDDEN_BLOCK, ...listed] : [])].join("\n").trim();
		if (!result || Buffer.byteLength(result) > 5 * 1024 * 1024)
			throw new Error(result ? "text size" : "no text");
		return `${result}\n`;
	} catch (error) {
		throw failure(
			error,
			"could not read this file: damaged, unsupported or over-budget HTML/email; save as UTF-8 HTML or .eml",
		);
	}
}
