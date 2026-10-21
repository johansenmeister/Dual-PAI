/**
 * `pai doctor`'s section for the machine setup (#472): this machine against
 * `PAI/USER/MASKINER.yaml`, from the same steps as `pai maskin --sjekk`.
 *
 * Silent when there is no profile (rule 1: the profile is opt-in until the
 * installation has one), and when every step is ok. Report only (rule 2): the
 * line says what to run, and nothing is run.
 *
 * The `pai` command on PATH (#476) is checked with or without a profile: a
 * warning, since the shell function still works where the profile is read.
 *
 * @module PAI/Tools/maskin-helse
 */

import { dirname } from "node:path";
import { type CheckResult, check, problems, stepLine } from "./maskin";
import { paiCommandPath, paiCommandState } from "./pai-command";

export interface MachineHealth {
	problemer: string[];
	varsler: string[];
	/** The line `pai doctor` prints when there is nothing to say. */
	ok: string;
}

/** `opencodeDir` is the real path of the tree, so its parent is the repo the command should run. */
export function paiCommandWarnings(opencodeDir: string, home: string): string[] {
	const path = paiCommandPath(home);
	const repo = dirname(opencodeDir);
	const fix = `bun ${repo}/PAI-Install/cli/shell-setup.ts`;
	switch (paiCommandState(home, repo)) {
		case "ok":
			return [];
		case "missing":
			return [`${path} is missing, so shells that do not read your shell profile (agents' tools, cron, systemd) have no pai: ${fix}`];
		case "other":
			return [`${path} runs another PAI or is outdated: ${fix}`];
		case "foreign":
			return [`${path} is not PAI's, so shells that do not read your shell profile run that instead of PAI`];
	}
}

export function maskinHelse(opencodeDir: string, home: string, result?: CheckResult): MachineHealth {
	const h = profileHealth(opencodeDir, home, result);
	return { ...h, varsler: [...paiCommandWarnings(opencodeDir, home), ...h.varsler] };
}

function profileHealth(opencodeDir: string, home: string, result?: CheckResult): MachineHealth {
	const r = result ?? check(opencodeDir, home);
	switch (r.kind) {
		case "no-profile":
			return { problemer: [], varsler: [], ok: "no machine profile (PAI/USER/MASKINER.yaml)" };
		case "bad-profile":
			return { problemer: r.errors.map((e) => `${r.path}: ${e}`), varsler: [], ok: "" };
		case "unknown":
			return {
				problemer: [],
				varsler: [`${r.name} is not among the machines in ${r.path} (roles: ${r.roles.join(", ")})`],
				ok: "",
			};
		case "checked":
			return {
				problemer: problems(r.steps).map((s) => stepLine(s, false)),
				varsler: r.steps.filter((s) => s.status === "warning").map((s) => stepLine(s, false)),
				ok: `${r.host} is as the profile says (${r.role}, ${r.steps.length} steps)`,
			};
	}
}
