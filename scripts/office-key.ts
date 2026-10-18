// Synthetic answer key written before the fixtures and converter.
export const officeKey = [
	{
		file: "office-memo.docx",
		facts: [
			"Harbor report",
			"Budget is 42000 EUR",
			"First action",
			"Footnote detail",
			"Endnote detail",
		],
		rows: [
			["Team", "Seats"],
			["Otter", "12"],
		],
		anchors: ["# Harbor report", "## Delivery"],
		hidden: [
			"DOC_VANISH",
			"DOC_WHITE",
			"DOC_BACKGROUND",
			"DOC_TINY",
			"DOC_COMMENT",
			"DOC_DELETION",
			"DOC_PROPERTY",
			"DOC_CUSTOM",
		],
	},
	{
		file: "office-deck.pptx",
		facts: ["Harbor launch", "Launch on 8 November", "Presenter reminder"],
		rows: [
			["Team", "Seats"],
			["Otter", "12"],
		],
		anchors: ["[slide 1]", "[slide 2]"],
		hidden: [
			"PPT_HIDDEN_SLIDE",
			"PPT_OFFSLIDE",
			"PPT_TINY",
			"PPT_WHITE",
			"PPT_COMMENT",
			"PPT_PROPERTY",
		],
	},
	{
		file: "office-book.xlsx",
		facts: ["Harbor budget", "42000", "12"],
		rows: [
			["Team", "Seats"],
			["Otter", "12"],
		],
		anchors: ["[Sheet: Budget]", "[Sheet: Archive]", "[row 1]", "[row 2]"],
		hidden: [
			"XLS_HIDDEN_SHEET",
			"XLS_HIDDEN_ROW",
			"XLS_HIDDEN_COLUMN",
			"XLS_WHITE",
			"XLS_TINY",
			"XLS_COMMENT",
			"XLS_PROPERTY",
		],
	},
	{
		file: "office-rows.csv",
		facts: ["Otter", "12", "Harbor, east"],
		rows: [["Otter", "12", "Harbor, east"]],
		anchors: ["[row 1]", "[row 2]"],
		hidden: [],
	},
	{
		file: "office-dutch.docx",
		facts: ["Besluiten haven", "De begroting is 42000 euro.", "Oplevering op 8 november."],
		rows: [],
		anchors: ["# Besluiten haven"],
		hidden: [],
	},
] as const;
