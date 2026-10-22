// Reader tests check what a reader lists and the text it lists, so they read the hidden block in text
// mode, as the goldens from the pinned reference do. Tests of the default mode import src/index.ts.
import { convert as convertAs } from "../src/index.ts";
import type { ConvertOptions } from "../src/types.ts";

export { PlainviewError } from "../src/index.ts";
export const convert = (input: Uint8Array, opts: ConvertOptions) =>
	convertAs(input, { hidden: "text", ...opts });
