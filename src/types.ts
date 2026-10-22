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
}

export interface ConvertResult extends DocumentText {
	hidden: HiddenText[];
	flags: string[];
}
