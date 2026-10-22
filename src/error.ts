export class PlainviewError extends Error {
	readonly code: "invalid" | "unavailable";

	constructor(code: "invalid" | "unavailable", message: string) {
		super(message);
		this.name = "PlainviewError";
		this.code = code;
	}
}

/** OCR was not given, or failed without a reason of its own: a PDF with other text pages marks the page instead. */
export class NotRead extends PlainviewError {}

// A reader's internal failure, named by its class of cause in plain words; never document content.
const CAUSES: [RegExp, string][] = [
	[/^unsupported CSS selector$/, "unsupported CSS selector in a rule that can hide text"],
	[/CSS/, "CSS that cannot be read safely (escapes, variables, computed values or at-rules)"],
	[/^HTML attribute count$/, "an HTML element has too many attributes"],
	[/^HTML tag size$/, "an HTML tag is too long"],
	[/^HTML (?:tokens|depth)$/, "the HTML has too many tags or nests them too deeply"],
	[/^MIME (?:parts budget|header count)$/, "the email has too many parts or headers"],
	[/^(?:file|text|HTML|MIME|ZIP) size$/, "the file or its text is over the size limit"],
	[/^(?:slide|sheet) count$/, "too many slides or sheets, or none"],
	[/ZIP|^not OOXML$/, "not a complete Office package"],
	[/HTML/, "malformed HTML (a broken tag, attribute or character reference)"],
	[/charset|non-ASCII|^encoding$/, "text in an unsupported or invalid character encoding"],
	[/base64|quoted-printable|transfer encoding|encoded multipart/, "a damaged mail encoding"],
	[/MIME|multipart/, "a malformed email structure (headers, parameters or part boundaries)"],
	[/^no (?:mail )?text$/, "no text found in it"],
	[/XML|DTD|^duplicate attribute$/, "malformed or unsupported XML inside the package"],
	[/cached value/, "a spreadsheet formula has no saved value"],
	[/CSV/, "malformed CSV (quotes or binary data)"],
	[
		/^missing |relationship|missing$|cell column|style cycle/,
		"a document part is missing or invalid",
	],
];

/** The error for a failed read: its class of cause when known, else the reader's own fallback. */
export function failure(error: unknown, fallback: string): PlainviewError {
	if (error instanceof PlainviewError) return error;
	const m = (error as { code?: string; message?: string } | null) ?? {};
	const key = m.code === "ERR_ENCODING_INVALID_ENCODED_DATA" ? "encoding" : String(m.message);
	const cause = CAUSES.find(([pattern]) => pattern.test(key))?.[1];
	return new PlainviewError("invalid", cause ? `could not read this file: ${cause}` : fallback);
}
