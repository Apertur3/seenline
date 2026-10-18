export class PlainviewError extends Error {
	readonly code: "invalid" | "unavailable";

	constructor(code: "invalid" | "unavailable", message: string) {
		super(message);
		this.name = "PlainviewError";
		this.code = code;
	}
}
