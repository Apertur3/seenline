export interface OcrResult {
	pages: string[];
	extras: string[];
	reader?: string;
}

export interface ConvertOptions {
	name: string;
	path?: string;
	/** For a PDF, `pages` lists the 1-based pages to read; return text at index page - 1. `bytes` is always the input being converted: read it rather than the path, which can change after parsing. */
	ocr?: (path: string, pages?: number[], bytes?: Uint8Array) => Promise<OcrResult>;
	/** For a PDF, reads the rendered pages that have a text layer (called as `ocr`) and lists a page whose text layer has words the page image shows differently as `text differs from page image`; any failure fails the file. */
	verify?: (path: string, pages?: number[], bytes?: Uint8Array) => Promise<OcrResult>;
	maxRows?: number;
	/** How the Markdown's hidden block shows hidden text (default describe); `hidden` in the result always keeps it. */
	hidden?: "text" | "framed" | "describe";
	/** Refuse what needs a temporary file (legacy .doc and .rtf; text recognition without `path`) instead of writing one. */
	noTempFiles?: boolean;
}

export interface DocumentText {
	markdown: string;
	pages: number;
	readers?: string[];
}

export interface HiddenText {
	anchor: string;
	reasons: string[];
	text: string;
	/** Set when the text reads like an instruction to an AI (override, exfil, role, verdict, addresses-ai): a triage signal from fixed rules, not a verdict. */
	suspect?: string;
}

export interface ConvertResult extends DocumentText {
	hidden: HiddenText[];
	flags: string[];
}
