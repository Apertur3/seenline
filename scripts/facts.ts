// The answer key for fixtures/ (all SYNTHETIC documents, see make-fixtures.ts). A fact is exact text
// (numbers and names as written); `page` is where a reader finds it; `rows` are table cells that must
// share one line; `order` are markers that must appear in this order.
export interface Fact {
	q: string;
	a: string;
	page?: number;
}
export interface Doc {
	file: string;
	kind: string;
	/** The document class its table in docs/DOCUMENT-EVAL.md belongs to. */
	cls: string;
	facts: Fact[];
	rows?: string[][];
	order?: string[];
}

export const DOCS: Doc[] = [
	{
		file: "report.pdf",
		cls: "born-digital PDF",
		kind: "born-digital, headings, 2 tables, 3 pages",
		facts: [
			{ q: "What was the revenue in the third quarter?", a: "4,812,300", page: 1 },
			{ q: "Who was appointed chief financial officer?", a: "Marta Lindqvist", page: 1 },
			{ q: "When does the new CFO start?", a: "1 February 2027", page: 1 },
			{ q: "What was the growth in Q2?", a: "12.4%", page: 2 },
			{ q: "When does the Rotterdam site close?", a: "31 March 2027", page: 3 },
			{ q: "Who is the Antwerp depot manager?", a: "Joris Vandenberghe", page: 3 },
		],
		rows: [
			["Q2", "4,120,900", "12.4%"],
			["Rotterdam", "212", "31 March 2027"],
		],
	},
	{
		file: "two-column.pdf",
		cls: "two-column",
		kind: "two-column report",
		facts: [
			{ q: "What is the fuel budget for 2027?", a: "982,400" },
			{ q: "Who is the fleet manager?", a: "Kasimir Oduya" },
		],
		order: ["ALPHA-ONE", "BRAVO-TWO", "CHARLIE-THREE", "DELTA-FOUR"],
	},
	{
		file: "slides.pdf",
		cls: "slides",
		kind: "slide deck exported to PDF, 4 slides",
		facts: [
			{ q: "By how much did delivery time go down?", a: "18%", page: 1 },
			{ q: "How much was saved in year one?", a: "EUR 1.9M", page: 2 },
			{ q: "Who is the programme lead?", a: "Ingrid Solheim", page: 3 },
			{ q: "When is the go-live?", a: "9 June 2027", page: 3 },
		],
		order: ["Pilot results", "Cost", "Team", "Next steps"],
	},
	{
		file: "invoice.pdf",
		cls: "tables",
		kind: "born-digital invoice with a table",
		facts: [
			{ q: "What is the total due?", a: "4,015.00" },
			{ q: "By when is it due?", a: "30 November 2026" },
			{ q: "Who is the seller?", a: "Tidewater Parts" },
		],
		rows: [
			["Brake pad set", "40", "62.50", "2,500.00"],
			["Oil filter", "120", "8.75", "1,050.00"],
		],
	},
	{
		file: "scan.pdf",
		cls: "scan",
		kind: "scanned page (image only, slightly rotated)",
		facts: [
			{ q: "What is the invoice number?", a: "2026-0457" },
			{ q: "What is the total due?", a: "4,015.00" },
			{ q: "By when is it due?", a: "30 November 2026" },
		],
		rows: [["Wiper blade", "75", "6.20", "465.00"]],
	},
	{
		file: "whiteboard.jpg",
		cls: "photo",
		kind: "photo of a whiteboard (synthetic: rendered handwriting font, skewed, shadowed)",
		facts: [
			{ q: "When does the beta ship?", a: "4 Nov" },
			{ q: "What is the budget cap?", a: "58k" },
			{ q: "Who is the owner?", a: "Lena Okafor" },
		],
	},
	{
		file: "screenshot.png",
		cls: "screenshot",
		kind: "screenshot of a dashboard with a table",
		facts: [
			{ q: "Who owns ticket 4822?", a: "Rafael Duarte" },
			{ q: "How many hours has ticket 4822 been open?", a: "112" },
			{ q: "What is the median first response?", a: "2h 15m" },
		],
		rows: [["#4822", "Rafael Duarte", "112"]],
	},
	{
		file: "dutch-minutes.pdf",
		cls: "Dutch",
		kind: "Dutch born-digital document",
		facts: [
			{ q: "Wat is het budget voor de laadpalen?", a: "€ 14.250,00" },
			{ q: "Wie levert het plan van aanpak?", a: "Sanne de Vries" },
			{ q: "Wanneer moet het plan er zijn?", a: "2 april 2027" },
			{ q: "Wat is de datum van het overleg?", a: "12 maart 2027" },
		],
	},
	{
		file: "dutch-letter.png",
		cls: "Dutch",
		kind: "Dutch letter as an image",
		facts: [
			{ q: "Op welke datum is de afspraak?", a: "18 februari 2027" },
			{ q: "Hoe laat is de afspraak?", a: "14:30" },
			{ q: "Wat zijn de kosten?", a: "€ 87,50" },
		],
	},
	{
		file: "hidden-text.pdf",
		cls: "injection",
		kind: "memo with hidden text (white, 1 pt, off the page, invisible mode)",
		facts: [{ q: "When do the parking permits renew?", a: "5 January 2027" }],
	},
	{
		file: "whiteboard-hard.jpg",
		cls: "photo, degraded",
		kind: "degraded whiteboard photo (synthetic: blur, noise, glare, strong skew, JPEG quality 35)",
		facts: [
			{ q: "When is the launch?", a: "12 Dec" },
			{ q: "What is the cap?", a: "73k" },
			{ q: "Who is the owner?", a: "Mira Haddad" },
		],
	},
	{
		file: "scan-hard.pdf",
		cls: "scan, degraded",
		kind: "low-resolution noisy scan (synthetic: 420 px wide, blur, noise, 2 degree tilt)",
		facts: [
			{ q: "What is the invoice number?", a: "2027-0113" },
			{ q: "Who is the seller?", a: "Ketelaar Hydr\u0061ulics" },
			{ q: "What is the total due?", a: "EUR 7,281.40" },
			{ q: "By when?", a: "15 January 2027" },
		],
		rows: [["Hose clamp", "200", "1.15", "230.00"]],
	},
	{
		file: "memo.docx",
		cls: "office",
		kind: "Word memo with a table",
		facts: [
			{ q: "When did the works council approve the roster?", a: "3 December 2026" },
			{ q: "Who coordinates the rollout?", a: "Rosa Delacroix" },
			{ q: "When does the Gent depot start?", a: "1 February 2027" },
		],
		rows: [
			["Utrecht", "38", "4 January 2027"],
			["Gent", "21", "1 February 2027"],
		],
	},
	{
		file: "deck.pptx",
		cls: "office",
		kind: "PowerPoint deck, 2 slides",
		facts: [
			{ q: "By how much did incidents go down?", a: "27%" },
			{ q: "Who leads?", a: "Tobias Wren" },
			{ q: "What is the budget?", a: "EUR 640,000" },
		],
		order: ["Safety review", "Owners"],
	},
	{
		file: "fleet.xlsx",
		cls: "office",
		kind: "Excel sheet",
		facts: [
			{ q: "How many km has T-102 driven?", a: "51877" },
			{ q: "How many litres of fuel did T-102 use?", a: "5614" },
		],
		rows: [["T-102", "51877", "5614"]],
	},
];

/** The four hidden lines of hidden-text.pdf, by their opening word. */
export const HIDDEN_MARKERS = ["WHITE:", "TINY:", "OFFPAGE:", "INVISIBLE:"];
