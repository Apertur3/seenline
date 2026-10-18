export interface OcrResult {
	pages: string[];
	extras: string[];
	reader?: string;
}

export interface ConvertOptions {
	name: string;
	path?: string;
	ocr?: (path: string) => Promise<OcrResult>;
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
