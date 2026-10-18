// Set E, local part: o200k token counts. The ranks ship inside the tokenizer package, so counting needs
// no network. Provider counts are a separate, optional step (provider-tokens.ts).
import { Tiktoken } from "js-tiktoken/lite";
import o200k from "js-tiktoken/ranks/o200k_base";

const encoder = new Tiktoken(o200k);
export const tokens = (text: string): number => encoder.encode(text, [], []).length;
