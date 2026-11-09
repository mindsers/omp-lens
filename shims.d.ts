// omp ships as a compiled binary without type declarations. These cover exactly the parts of the
// host-supplied modules this extension imports, so `bun run typecheck` can check the rest.

declare module "@oh-my-pi/pi-tui" {
	export function matchesKey(data: string, id: string): boolean;
	export function truncateToWidth(text: string, width: number): string;
	export function visibleWidth(text: string): number;
	export function wrapTextWithAnsi(text: string, width: number): string[];
	export class Text {
		constructor(text: string, paddingX?: number, paddingY?: number);
	}
	export class Markdown {
		constructor(text: string, paddingX: number, paddingY: number, theme: unknown);
		render(width: number): string[];
	}
}

declare module "@oh-my-pi/pi-natives" {
	export function highlightCode(code: string, lang: string, colors: Record<string, string>): string;
	export function supportsLanguage(lang: string): boolean;
	export function warmHighlighter(): unknown;
}

declare module "@oh-my-pi/pi-coding-agent" {
	export function getMarkdownTheme(): unknown;
}
