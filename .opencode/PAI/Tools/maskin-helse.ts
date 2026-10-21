/**
 * `pai doctor`'s section for the machine setup (#472): this machine against
 * `PAI/USER/MASKINER.yaml`, from the same steps as `pai maskin --sjekk`.
 *
 * Silent when there is no profile (rule 1: the profile is opt-in until the
 * installation has one), and when every step is ok. Report only (rule 2): the
 * line says what to run, and nothing is run.
 *
 * @module PAI/Tools/maskin-helse
 */

import { type CheckResult, check, problems, stepLine } from "./maskin";

export interface MachineHealth {
	problemer: string[];
	varsler: string[];
	/** The line `pai doctor` prints when there is nothing to say. */
	ok: string;
}

export function maskinHelse(opencodeDir: string, home: string, result?: CheckResult): MachineHealth {
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
