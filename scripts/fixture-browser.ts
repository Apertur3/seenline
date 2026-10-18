// Optional offline fixture tool. Keep browser automation out of runtime dependencies.
import { createRequire } from "node:module";

interface Page {
	setContent(html: string): Promise<void>;
	setViewportSize(size: { width: number; height: number }): Promise<void>;
	pdf(options?: { printBackground?: boolean; preferCSSPageSize?: boolean }): Promise<Buffer>;
	screenshot(options?: { path?: string; type?: "png" | "jpeg"; quality?: number }): Promise<Buffer>;
}
interface Browser {
	newContext(options: { deviceScaleFactor: number }): Promise<{ newPage(): Promise<Page> }>;
	close(): Promise<void>;
}
export const chromium = {
	async launch(): Promise<Browser> {
		const tool = createRequire(import.meta.url)("playwright") as {
			chromium: { launch(): Promise<Browser> };
		};
		return tool.chromium.launch();
	},
};
