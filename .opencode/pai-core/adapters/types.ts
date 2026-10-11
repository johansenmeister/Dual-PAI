/**
 * PAI-OpenCode Shared Types
 *
 * Common TypeScript interfaces for plugin handlers and adapters.
 *
 * @module types
 */

/**
 * Security validation result
 *
 * Returned by security-validator.ts to indicate what action to take
 */
export interface SecurityResult {
	/** Action to take: block (deny), confirm (ask), or allow */
	action: "block" | "confirm" | "allow";
	/** Reason for the action (for logging) */
	reason: string;
	/** Optional detailed message for user */
	message?: string;
}

/**
 * Verktøykallet vakten vurderer, i kjernens form (`tool.before`)
 */
export interface ToolInput {
	/** Tool name (Bash, Read, Write, etc.) */
	tool: string;
	/** Tool arguments */
	args: Record<string, unknown>;
	/** Session ID */
	sessionId?: string;
}

/**
 * Tillatelsessjekken vakten vurderer, i kjernens form
 */
export interface PermissionInput {
	/** Tool name */
	tool: string;
	/** Tool arguments */
	args: Record<string, unknown>;
	/** Permission type being requested */
	permission?: string;
}

// An option with or without its argument: `-u root`, `-t`, `-o BatchMode=yes`.
const OPTIONS = String.raw`(?:-\S+\s+(?:[^\s-]\S*\s+)?)*`;

/**
 * A pattern for `verb` where a command starts: first on the line, after a
 * separator (`;`, `&`, `|`, `(`, newline, backtick, `$(`), after a prefix that
 * runs the next word (`sudo`, `xargs`, `do` …), as the remote command of
 * `ssh [options] <host>`, or inside `sh -c '…'`. A quote directly before the
 * verb counts only after `ssh <host>` or `sh -c`, so `echo "reboot needed"`
 * passes.
 */
function atCommand(verb: string): RegExp {
	const start = [
		"^",
		String.raw`[;&|(\n\x60]`,
		String.raw`\$\(`,
		String.raw`\b(?:sudo|doas|exec|nohup|xargs|do|then|else)\s+${OPTIONS}`,
		String.raw`\bssh\s+${OPTIONS}[^\s-]\S*\s+["']?`,
		String.raw`\b(?:ba|z|da)?sh\s+-c\s+["']`,
	].join("|");
	return new RegExp(String.raw`(?:${start})\s*(?:${verb})(?=$|[\s;&|)"'\x60])`);
}

/**
 * Dangerous command patterns for security validation
 *
 * These patterns will trigger a BLOCK action
 */
export const DANGEROUS_PATTERNS = [
	// Destructive file operations
	/rm\s+-rf\s+\//, // rm -rf / (any root-level deletion blocked)
	/rm\s+-rf\s+~\//, // rm -rf ~/ (home)
	/rm\s+-rf\s+\*/, // rm -rf * (wildcard)
	/rm\s+-rf\s+\.\./, // rm -rf .. (parent traversal - any path starting with ..)
	/mkfs\./,
	/dd\s+if=.*of=\/dev\//,

	// System compromise
	/chmod\s+777\s+\//,
	/chown\s+-R\s+.*\s+\//,

	// Reverse shells
	/bash\s+-i\s+>&/,
	/nc\s+-e\s+\/bin\/(ba)?sh/,
	/python.*socket.*connect/,

	// Remote code execution. `sh` as a word: without `\b` a pipe to
	// `sha256sum` or `shasum` after a download blocked the checksum check
	// (job #3).
	/curl.*\|\s*(ba)?sh\b/,
	/wget.*\|\s*(ba)?sh\b/,

	// Credential theft. `cat` as a word, not a substring: without `\b` the
	// rules fired on "certificate", "applications" and
	// "ClientCertificateCredential" whenever `.env` came later on the line, and
	// blocked legitimate Graph commands (M-39). The public key (`id_*.pub`) is
	// shared on purpose, so a path ending in `.pub` passes; a glob or anything
	// after `.pub` still blocks (#294). The path must be an argument to the
	// same `cat`: a `;`, `|`, `&` or newline ends the match, so `cat /sys/…;
	// . ~/.opencode/.env` passes (job #3).
	/\bcat\b[^;|&\n]*\.ssh\/id_(?![^\s;|&"')]*\.pub(?![^\s;|&"')]))/,
	/\bcat\b[^;|&\n]*\.aws\/credentials/,
	/\bcat\b[^;|&\n]*\.env/,

	// === WP-B: Additional modern attack vectors ===
	// Obfuscated RCE via base64 decode
	/eval\s*\$\(\s*(echo|printf|cat)\s+.*\|\s*base64\s+-d/,
	/\$\(curl\s+.*\)\s*\|\s*(ba)?sh\b/, // command substitution + pipe

	// Environment variable exfiltration
	/printenv\s*.*\|\s*(curl|wget|nc)/, // env dump + exfiltration
	/env\s*\|?\s*grep\s+.*KEY.*\|\s*(curl|wget)/, // API key theft via grep

	// Python/Node RCE one-liners
	/python[23]?\s+-c\s+["'].*__import__.*os.*system/, // python -c "import os; os.system()"
	/node\s+-e\s+["'].*require.*child_process/, // node -e "require('child_process')"

	// SSH key theft / identity compromise
	/cat\s+~\/\.ssh\/known_hosts/,
	/ssh-keyscan/,
] as const;

/**
 * Warning command patterns for security validation
 *
 * These patterns will trigger a CONFIRM action
 */
export const WARNING_PATTERNS = [
	// Git operations that could be destructive
	/git\s+push\s+--force/,
	/git\s+reset\s+--hard/,

	// Package installs
	/npm\s+install\s+-g/,
	/pip\s+install/,

	// Docker operations
	/docker\s+rm/,
	/docker\s+rmi/,

	// Destructive API calls (#222). PAI holds tokens for Gitea, Proxmox and
	// Portainer that can delete, and to the patterns above such a call is an
	// ordinary `curl`. The method flag, not the tool: curl's `-X DELETE`,
	// `-XDELETE`, `-sX DELETE` and `--request DELETE`, wget's `--method=DELETE`
	// and `gh api --method DELETE` all take this form. The method ends at a
	// quote or a space, so `tar -X delete-list.txt` passes.
	/(?:^|\s)(?:-[A-Za-z]*X\s*|--(?:request|method)(?:\s+|=))["']?(?:DELETE|delete)(?=["'\s]|$)/,
	// `pve <METHOD> <path>` from guide/gitea/pve.sh
	/\bpve\s+["']?(?:DELETE|delete)(?=["'\s]|$)/,
	// A hard stop or reset of a Proxmox guest, through the helper or the API
	// itself. `shutdown` and `reboot` are graceful and pass.
	/\bpve\s+["']?POST["']?\s+["']?\S*\/status\/(?:stop|reset)\b/,
	/\/api2\/json\/\S*\/status\/(?:stop|reset)\b/,

	// Destructive server commands, run locally or over SSH (#411). PAI has root
	// over SSH to hosts, and the same stop that asks through the API above went
	// through as `ssh <host> 'qm stop …'`. The verb must be where a command
	// starts (see `atCommand`), so `grep reboot`, `RebootTier.md` and the
	// Semaphore template `reboot-tier` pass.
	atCommand("reboot|poweroff|halt|shutdown"),
	atCommand(String.raw`init\s+[06]`),
	atCommand(String.raw`systemctl\s+(?:reboot|poweroff|halt|kexec)`),
	// A graceful `qm shutdown` passes, as `status/shutdown` does through the API.
	atCommand(String.raw`(?:qm|pct)\s+(?:stop|reset|destroy)`),
	atCommand(String.raw`pvesh\s+delete`),
	atCommand(String.raw`pvesh\s+(?:create|set)\s+\S*/status/(?:stop|reset)`),
	atCommand(String.raw`z(?:fs|pool)\s+destroy`),
	// pf: -d disables the firewall, -F flushes rules or tables.
	atCommand(String.raw`pfctl(?:\s+[^\s;&|]+)*?\s+-[A-Za-z]*[dF][A-Za-z]*`),
	atCommand(String.raw`configctl(?:\s+[^\s;&|]+)*?\s+(?:reboot|halt|poweroff)`),
	// Removes bans, bouncers or machines: the firewall stops blocking.
	atCommand(String.raw`cscli\s+\S+\s+delete`),
	// OPNsense and pfSense keep their whole configuration under /conf.
	atCommand(String.raw`rm(?:\s+-\S+)*\s+["']?/conf(?:/[^\s;&|"']*)?`),

	// A script fed to a shell on the other side (#411): the guard cannot see
	// what runs there, so it cannot judge it. A heredoc to `ssh … sh` is
	// visible and is matched by the patterns above instead.
	/\|\s*ssh\b[^;&|\n]*\s["']?(?:\S*\/)?(?:ba|z|da|k)?sh["']?(?=\s|$)/,
	/\bssh\b[^;&|\n]*\s(?:\S*\/)?(?:ba|z|da|k)?sh(?:\s+-s)?\s*<(?!<)/,
] as const;
