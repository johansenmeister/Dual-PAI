#!/usr/bin/env bun
/**
 * Secrets in the added lines of a diff, for the guard in `sync-end.sh` (#370).
 *
 * The autosync pushed a `THREAD.md` with a Gitea PAT in a remote URL
 * (`https://<user>:<token>@host/…`, work issue #11): the guard only knew key
 * files and private-key blocks. This reads `git diff -U0` on stdin and runs
 * every added line through `maskSecrets` from `pai-core/lib/secrets.ts`, the
 * same patterns and known `.env` values that mask tool output for the model,
 * so the two cannot drift.
 *
 * One line per file with a hit on stdout: `<path>\t<labels>`, the shapes and
 * variable names that matched, never the value. The caller words the message.
 * Exit 0 either way; the caller decides.
 *
 * @module Tools/SecretScan
 */

import { type KnownSecret, knownSecrets, maskSecrets } from "../.opencode/pai-core/lib/secrets";

/** `<path>\t<labels>` per file whose added lines hold a secret. */
export function scanDiff(diff: string, known: KnownSecret[] = knownSecrets()): string[] {
	const found = new Map<string, Set<string>>();
	let file = "";
	let header = false;
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) {
			header = true;
			continue;
		}
		// `+++ ` is the file name only in the header, before the first `@@`;
		// later it is an added line that starts with `++`.
		if (header && line.startsWith("+++ ")) {
			// Git puts a tab after a path that contains a space.
			file = line.slice(6).replace(/\t$/, "");
			continue;
		}
		if (line.startsWith("@@")) {
			header = false;
			continue;
		}
		if (header || !line.startsWith("+")) continue;
		const { hits } = maskSecrets(line.slice(1), known);
		if (!hits.length) continue;
		const labels = found.get(file) ?? new Set<string>();
		for (const h of hits) labels.add(h.label);
		found.set(file, labels);
	}
	return [...found].map(([path, labels]) => `${path}\t${[...labels].join(", ")}`);
}

if (import.meta.main) {
	const diff = await Bun.stdin.text();
	for (const line of scanDiff(diff)) console.log(line);
}
