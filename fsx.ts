import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface Entry {
	name: string;
	path: string;
	isDirectory: boolean;
	size: number;
	/** Modification time; with `size` it tells a cached preview that the file changed on disk. */
	mtimeMs: number;
	/** Set on text-search results: the matching line. Such entries are named `path:line`. */
	hit?: { line: number; text: string };
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
	return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

/** Directories first, then files, each sorted case-insensitively. `..` leads unless at the root. */
export async function listDirectory(dir: string, showHidden: boolean): Promise<Entry[]> {
	const names = (await readdir(dir)).filter(name => showHidden || !name.startsWith("."));
	const stats = await Promise.all(
		names.map(async name => {
			const path = join(dir, name);
			try {
				const info = await stat(path);
				return { name, path, isDirectory: info.isDirectory(), size: info.size, mtimeMs: info.mtimeMs } satisfies Entry;
			} catch {
				return null; // broken symlink, permission denied
			}
		}),
	);
	const byName = (a: Entry, b: Entry) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
	const entries = stats.filter((e): e is Entry => e !== null);
	const dirs = entries.filter(e => e.isDirectory).sort(byName);
	const files = entries.filter(e => !e.isDirectory).sort(byName);
	const parent = dirname(dir);
	const up: Entry[] = parent === dir ? [] : [{ name: "..", path: parent, isDirectory: true, size: 0, mtimeMs: 0 }];
	return [...up, ...dirs, ...files];
}
