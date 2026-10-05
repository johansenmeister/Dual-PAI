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

	// Remote code execution
	/curl.*\|\s*(ba)?sh/,
	/wget.*\|\s*(ba)?sh/,

	// Credential theft. `cat` as a word, not a substring: without `\b` the
	// rules fired on "certificate", "applications" and
	// "ClientCertificateCredential" whenever `.env` came later on the line, and
	// blocked legitimate Graph commands (M-39).
	/\bcat\b.*\.ssh\/id_/,
	/\bcat\b.*\.aws\/credentials/,
	/\bcat\b.*\.env/,

	// === WP-B: Additional modern attack vectors ===
	// Obfuscated RCE via base64 decode
	/eval\s*\$\(\s*(echo|printf|cat)\s+.*\|\s*base64\s+-d/,
	/\$\(curl\s+.*\)\s*\|\s*(ba)?sh/, // command substitution + pipe

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
] as const;
