export interface OcrResult {
	pages: string[];
	extras: string[];
	reader?: string;
}

export interface ConvertOptions {
	name: string;
	path?: string;
	/** For a PDF, `pages` lists the 1-based pages to read; return text at index page - 1. */
	ocr?: (path: string, pages?: number[]) => Promise<OcrResult>;
	maxRows?: number;
	/** How the Markdown's hidden block shows hidden text (default describe); `hidden` in the result always keeps it. */
	hidden?: "text" | "framed" | "describe";
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
