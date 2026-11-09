/**
 * Make untrusted text (file contents, file names, grep hits, diffs) safe to draw in the terminal. Control
 * characters other than tab and newline become visible Unicode control pictures, so a file cannot slip escape
 * sequences through (rewriting the clipboard with OSC 52, retitling the window, faking output). C1 controls,
 * which some terminals also act on, become U+FFFD. CRLF line ends are normalised first. Run this before adding
 * any colour of our own.
 */
export function safeText(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ch => {
		const code = ch.charCodeAt(0);
		if (code < 0x20) return String.fromCharCode(0x2400 + code); // ␛ for ESC, ␇ for BEL, ␍ for CR…
		return code === 0x7f ? "␡" : "�";
	});
}
