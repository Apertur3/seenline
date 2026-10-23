// A real source mutation, loaded in a child only: production files never change on disk.
import { registerHooks } from "node:module";

registerHooks({
	load(url, context, nextLoad) {
		const result = nextLoad(url, context);
		if (!url.endsWith("/src/mail.ts")) return result;
		const source = String(result.source);
		const mutated = source.replace(
			/import\s*\{\s*HIDDEN_BLOCK\s*,?([^}]*)\}\s*from\s*(["'][^"']+["']);?/,
			'import {$1} from $2; const HIDDEN_BLOCK = "[Mutation: hidden text presented as ordinary text]";',
		);
		if (mutated === source) throw new Error("Mail hidden-header mutation did not apply");
		return { ...result, source: mutated };
	},
});
