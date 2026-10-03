export type ShellOperationPayload = {
	version: 1;
	command: string;
	cwd: string;
	env?: Record<string, string>;
	timeoutMs?: number;
	purpose?: string;
	/** Persist the selected shell so queued work does not change execution environment. */
	shell?: { executable: string; args: string[]; commandTransport?: "argv" | "stdin" };
};

export interface OperationOutputOptions {
	stream?: "stdout" | "stderr" | "both";
	tailLines?: number;
	/** Literal substring, not a regular expression. Search only the bounded suffix. */
	contains?: string;
}

export interface OperationOutputExcerpt {
	stream: "stdout" | "stderr";
	path: string;
	text: string;
	bytes: number;
	scannedBytes: number;
	truncated: boolean;
	missing: boolean;
}
