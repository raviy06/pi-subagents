function shellQuote(value: string, platform: NodeJS.Platform): string {
	// PowerShell expands double-quoted arguments. Use literal strings and double each
	// recognized single-quote delimiter, including the typographic variants.
	if (platform === "win32") return `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, (quote) => quote + quote)}'`;
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function isBareExecutable(value: string): boolean {
	return /^[\w./@:-]+$/.test(value);
}

// Windows does not imply PowerShell: a Herdr pane may run Git Bash or another POSIX shell, which cannot parse the call operator.
export type ShellFlavor = "auto" | "posix";

export function formatShellCommand(exe: string, args: readonly string[], platform: NodeJS.Platform = process.platform, flavor: ShellFlavor = "auto"): string {
	const posix = flavor === "posix" || (flavor === "auto" && platform !== "win32");
	const quotePlatform: NodeJS.Platform = posix ? "linux" : platform;
	const quotedArgs = args.map((arg) => shellQuote(arg, quotePlatform));
	if (!posix) return `& ${[shellQuote(exe, quotePlatform), ...quotedArgs].join(" ")}`;
	// Nushell treats a leading quoted token as a string, so use a bare invoker for paths that need quoting.
	const invocation = isBareExecutable(exe) ? exe : `sh -c 'exec "$0" "$@"' ${shellQuote(exe, quotePlatform)}`;
	return [invocation, ...quotedArgs].join(" ");
}
