import { isAbsolute, relative, sep } from "node:path";

/** A file, or a 1-based inclusive line range of it, to mention in the prompt. */
export interface FileRef {
	path: string;
	from?: number;
	to?: number;
}

/** `path` relative to `cwd` when it is inside it, else absolute. */
export function displayPath(path: string, cwd: string): string {
	const rel = relative(cwd, path);
	const outside = rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
	return outside ? path : rel;
}

/** `@path`, or `@path#L12` / `@path#L12-20` for a line range (the agent resolves these with its read tool). Paths outside `cwd` stay absolute. */
export function reference(ref: FileRef, cwd: string): string {
	const path = displayPath(ref.path, cwd);
	if (ref.from === undefined) return `@${path}`;
	return ref.to === undefined || ref.to === ref.from ? `@${path}#L${ref.from}` : `@${path}#L${ref.from}-${ref.to}`;
}
