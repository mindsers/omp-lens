// Minimal structural types for the omp host objects this extension touches.
// omp ships as a compiled binary without .d.ts files, so these mirror the
// documented surface (docs: extensions.md, tui.md) and nothing more. Checked against omp 18.17.0.

export interface Theme {
	fg(token: string, text: string): string;
	bg(token: string, text: string): string;
	/** Raw ANSI foreground sequence for a theme token, e.g. "syntaxKeyword". */
	getFgAnsi(token: string): string;
}

export interface Tui {
	requestRender(force?: boolean): void;
}

export interface Component {
	render(width: number): readonly string[];
	invalidate(): void;
	handleInput(data: string): void;
}

export interface OverlayOptions {
	width?: string | number;
	anchor?: string;
	margin?: { top?: number; bottom?: number };
}

export interface ExtensionUi {
	notify(message: string, level?: "info" | "warning" | "error"): void;
	custom<T>(
		factory: (tui: Tui, theme: Theme, keybindings: unknown, done: (result: T) => void) => Component,
		options?: { overlay?: boolean; overlayOptions?: OverlayOptions },
	): Promise<T>;
	pasteToEditor(text: string): void;
	supportsEditor?: boolean;
}

export interface CommandContext {
	mode: string;
	cwd: string;
	ui: ExtensionUi;
	isIdle(): boolean;
}

export interface CustomMessage {
	customType: string;
	content: string;
	display: boolean;
}

export interface SessionEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/** The context event handlers receive. `sessionModes` exists only in the main interactive session, never in subagents. */
export interface EventContext {
	cwd: string;
	mode: string;
	sessionModes?: object;
	sessionManager: { getBranch(): SessionEntry[] };
}

export interface ArgumentCompletion {
	label: string;
	value: string;
	description?: string;
}

export interface ExtensionApi {
	registerCommand(
		name: string,
		spec: {
			description: string;
			handler: (args: string, ctx: CommandContext) => Promise<void>;
			/** Suggestions for the text typed after the command name; null for none. */
			getArgumentCompletions?: (prefix: string) => ArgumentCompletion[] | null;
		},
	): void;
	registerMessageRenderer(
		customType: string,
		render: (message: { content: unknown }, options: { expanded: boolean }, theme: Theme) => object,
	): void;
	sendMessage(
		message: CustomMessage,
		options?: { deliverAs?: "steer" | "followUp" | "nextTurn" | "aside"; triggerTurn?: boolean },
	): unknown;
	/**
	 * Handlers are awaited, up to omp's handler timeout (30 s by default). `before_agent_start` runs before a
	 * prompt's agent loop begins.
	 */
	on(event: "session_start" | "before_agent_start" | "agent_start" | "agent_end", handler: (event: unknown, ctx: EventContext) => void | Promise<void>): void;
	/** Persist `data` in the session under `customType`; it comes back through `sessionManager.getBranch()` on resume. */
	appendEntry(customType: string, data: unknown): unknown;
}
