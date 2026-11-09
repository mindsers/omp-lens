const MINIFIED_MAX_LINES = 5;
const MINIFIED_MIN_CHARS = 100;

/**
 * A JSON file of a few long lines is unreadable as is; return it indented. Undefined when it is not
 * minified-looking or not valid JSON. The result is a view, not the file's own lines.
 */
export function prettyJson(text: string, lines: number): string | undefined {
	if (lines > MINIFIED_MAX_LINES || text.length < MINIFIED_MIN_CHARS) return undefined;
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return undefined;
	}
}
