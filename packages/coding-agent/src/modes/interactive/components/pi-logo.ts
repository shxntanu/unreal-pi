import { backgroundAnsi, foregroundAnsi, isAppleTerminalSession, rgbColor } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

const CORAL = rgbColor(228, 138, 122);
const BLUE = rgbColor(79, 142, 179);
const YELLOW = rgbColor(234, 182, 93);
const RESET = "\x1b[0m";

/**
 * The Unreal Pi mark: a P with a detached, hollow U beneath it. Each pair of bitmap rows
 * is rendered as one terminal row using half-block characters.
 */
export function piLogoLines(): string[] {
	const pixels = ["ccc.", "b.c.", "bb.y", "b..y", "....", "b.b.", "bbb.", "...."];
	const colors: Record<string, typeof CORAL | undefined> = { c: CORAL, b: BLUE, y: YELLOW, ".": undefined };
	const mode = theme.getColorMode();
	const fg = (color: typeof CORAL) => foregroundAnsi(color, mode);
	const bg = (color: typeof CORAL) => backgroundAnsi(color, mode);
	const lines: string[] = [];

	for (let row = 0; row < pixels.length; row += 2) {
		let line = "";
		for (let column = 0; column < pixels[row]!.length; column++) {
			const upper = colors[pixels[row]![column]!];
			const lower = colors[pixels[row + 1]![column]!];
			if (upper && lower) {
				line += `${fg(upper)}${bg(lower)}▀${RESET}`;
			} else if (upper) {
				line += `${fg(upper)}▀${RESET}`;
			} else if (lower) {
				line += `${fg(lower)}▄${RESET}`;
			} else {
				line += " ";
			}
		}
		lines.push(line);
	}
	return lines;
}

/**
 * Whether the terminal renders the half-block logo correctly. Apple Terminal draws gaps between rows and
 * misaligns the half blocks, so it gets the text wordmark instead.
 */
export function supportsPiLogo(): boolean {
	return !isAppleTerminalSession();
}

/** Text fallback for the logo: "Pi" with the logo's coral and yellow. */
export function piWordmark(): string {
	const mode = theme.getColorMode();
	return `${foregroundAnsi(CORAL, mode)}P${RESET}${foregroundAnsi(YELLOW, mode)}i${RESET}`;
}
