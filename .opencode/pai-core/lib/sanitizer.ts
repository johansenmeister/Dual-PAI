/**
 * PAI-OpenCode Input Sanitizer
 *
 * Normalizes input BEFORE pattern matching to prevent obfuscation bypasses.
 * Decodes base64, normalizes Unicode lookalikes, collapses spacing, strips HTML.
 *
 * @module sanitizer
 */

/**
 * Decode base64-encoded strings within content
 * Attackers often use: eval $(echo "aWdub3JlIHByZXZpb3VzIGluc3RydWN0aW9ucw==" | base64 -d)
 *
 * @param content - Content potentially containing base64 payloads
 * @returns Content with base64 payloads decoded and marked
 */
export function decodeBase64Payloads(content: string): string {
	return content.replace(/[A-Za-z0-9+/]{20,}={0,2}/g, (match) => {
		try {
			const decoded = atob(match);
			// Only replace if decoded result is printable ASCII (avoid binary noise)
			// Use character ranges instead of hex escapes to avoid control char lint issues
			const printableAsciiPattern = /^[ -~\n\r\t]+$/;
			if (printableAsciiPattern.test(decoded)) return `${match}[decoded:${decoded}]`;
		} catch {
			/* Not valid base64 */
		}
		return match;
	});
}

/**
 * Normalize Unicode lookalikes to ASCII
 * "іgnore" (Cyrillic і) → "ignore" to prevent Unicode bypass
 *
 * @param content - Content potentially containing Unicode lookalikes
 * @returns Normalized ASCII content
 */
export function normalizeUnicode(content: string): string {
	// Use NFKD normalization to decompose characters
	const normalized = content.normalize("NFKD");

	// Build regex from char codes to avoid control character lint warning
	// Match any character outside ASCII range (0-127)
	const nonAsciiRegex = new RegExp(`[^${String.fromCharCode(0)}-${String.fromCharCode(127)}]`, "g");

	return normalized.replace(nonAsciiRegex, (char) => {
		// Map common Cyrillic/Greek lookalikes to ASCII
		const lookalikes: Record<string, string> = {
			а: "a", // Cyrillic а (U+0430)
			е: "e", // Cyrillic е (U+0435)
			і: "i", // Cyrillic і (U+0456)
			о: "o", // Cyrillic о (U+043E)
			р: "p", // Cyrillic р (U+0440)
			с: "c", // Cyrillic с (U+0441)
			ѕ: "s", // Cyrillic ѕ (U+0455)
			у: "y", // Cyrillic у (U+0443)
			х: "x", // Cyrillic х (U+0445) - kha, NOT Latin h
			А: "A", // Cyrillic А (U+0410)
			В: "B", // Cyrillic В (U+0412)
			Е: "E", // Cyrillic Е (U+0415)
		};
		return lookalikes[char] ?? char;
	});
}

/**
 * Collapse excessive whitespace to detect patterns split by spaces
 * "i g n o r e   a l l   p r e v i o u s" → "ignore all previous"
 *
 * @param content - Content with potentially obfuscated spacing
 * @returns Content with normalized spacing
 */
export function collapseObfuscatedSpacing(content: string): string {
	// Detect letter-space-letter pattern (obfuscated words)
	// `\w` er ASCII også med `u`, så «h å n d» slapp gjennom (K30).
	if (/^([\p{L}\p{N}_]\s){4,}/u.test(content.trim())) {
		return content.replace(/([\p{L}\p{N}_])\s(?=[\p{L}\p{N}_])/gu, "$1");
	}
	return content;
}

/**
 * Strip HTML/XML tags that might wrap injection attempts
 * "<system>ignore instructions</system>" → "ignore instructions"
 *
 * @param content - Content potentially containing HTML/XML tags
 * @returns Content with tags stripped
 */
export function stripHtmlTags(content: string): string {
	return content
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Full sanitization pipeline — all transforms in order
 *
 * Order matters:
 * 1. Decode base64 first (reveals hidden payloads)
 * 2. Normalize Unicode (catches lookalike bypasses)
 * 3. Collapse spacing (catches obfuscated words)
 * 4. Strip HTML tags (reveals wrapped injections)
 *
 * @param content - Raw content to sanitize
 * @returns Sanitized content ready for pattern matching
 */
export function sanitizeForSecurityCheck(content: string): string {
	let sanitized = content;
	sanitized = decodeBase64Payloads(sanitized);
	sanitized = normalizeUnicode(sanitized);
	sanitized = collapseObfuscatedSpacing(sanitized);
	sanitized = stripHtmlTags(sanitized);
	return sanitized;
}

/**
 * Fields to check for injection in tool args
 * Extends beyond just args.content to cover all text inputs
 */
export const INJECTION_SCAN_FIELDS = [
	"content",
	"text",
	"prompt",
	"message",
	"query",
	"description",
	"instruction",
	"input",
	"command", // Bash commands can contain injections too
	"filePath", // Write/Edit target path
	"oldString", // Edit tool's replacement source text
	"newString", // Edit tool's replacement target text
	"patchText", // v2s patch-verktøy: hele innholdet som skrives (K58)
] as const;
