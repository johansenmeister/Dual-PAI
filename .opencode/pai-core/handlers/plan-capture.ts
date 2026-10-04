/**
 * Plan Capture Handler
 *
 * Gjør `.opencode/Plans/` ekte. Katalogen har sagt «plans are created
 * automatically in plan mode» siden forken, og ingen kodesti skrev dit.
 *
 * BEGGE MOTORENE SKRIVER PLANEN SOM EN FIL, med sitt vanlige skriveverktøy:
 *
 *   Claude Code   `Write` til `~/.claude/plans/<slug>.md`, med
 *                 `permission_mode: "plan"` i payloaden (MÅLT 2026-09-26 mot
 *                 2.1.283). `PostToolUse` fyrer som for enhver `Write`.
 *                 `ExitPlanMode` finnes IKKE i `-p`-modus, så fangsten kan
 *                 ikke henge på den.
 *   OpenCode v2   `write` til en fil i `$HOME/.opencode/plan/`. Filnavnet
 *                 velger modellen: `plan.md` i fase 0, `hello-plan.md` i
 *                 `V2Smoke` (MÅLT). Plan-agentens egen kode tillater `edit`
 *                 på `plan/*` og nekter alt annet (UTLEDET fra kilden i
 *                 binæren, 2.0.16). Det finnes ikke noe `plan_exit` i v2.
 *                 MERK: påminnelsen plan-agenten får, sier «do not create or
 *                 update plan files unless the user explicitly asks you to».
 *                 Under v2 havner en plan altså bare i fil når brukeren ber om
 *                 det; ellers står den i samtalen, og da er det ingenting å
 *                 fange.
 *
 * Derfor er fangsten én regel i `tool.after`: en skriving eller redigering av
 * en kjent planfil gir et øyeblikksbilde i `Plans/`. Fila leses fra disk, fordi
 * en `edit` bare bærer den endrede biten.
 *
 * FELLA fra planen: `~/.opencode` er en symlink inn i repoet, så v2s
 * planfiler havner i `.opencode/plan/` og ville blitt committet av
 * `sync-end.sh`s `git add -A`. Den er gitignorert; `Plans/` er stedet som
 * synkes.
 *
 * @module plan-capture
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileLog, fileLogError } from "../lib/file-logger";
import { getPaiHome } from "../lib/paths";
import { getLocalTimestamp } from "../lib/time";

/** Hvor planen kommer fra. Utledet av STIEN, ikke av motornavnet. */
type Planfil = { kilde: "claude" | "opencode"; slug: string };

/**
 * Er stien en planfil motoren skriver i plan-modus?
 *
 * Mønstrene er stiens hale, ikke en absolutt sti under `$HOME`: under
 * `V2Smoke` er `HOME` en temp-katalog, og for v2 kan modellen oppgi stien
 * både via symlinken og uten.
 */
export function somPlanfil(sti: string): Planfil | undefined {
	const s = sti.replace(/\\/g, "/");
	const opencode = s.match(/\/\.opencode\/plan\/([^/]+)\.md$/);
	if (opencode) return { kilde: "opencode", slug: opencode[1] };
	const claude = s.match(/\/\.claude\/plans\/([^/]+)\.md$/);
	if (claude) return { kilde: "claude", slug: claude[1] };
	return undefined;
}

export function getPlansDir(): string {
	return path.join(getPaiHome(), "Plans");
}

/**
 * Filnavnet i `Plans/`. Samme plan gir samme navn, så hver redigering
 * erstatter øyeblikksbildet framfor å legge til et nytt.
 *
 * Claudes slug er unik per plan fra før (`lag-en-kort-plan-vectorized-lake`).
 * v2s filnavn velger modellen, og `plan.md` går igjen på tvers av økter, så
 * økten står i navnet.
 */
export function planFilnavn(fil: Planfil, sessionId: string): string {
	if (fil.kilde === "claude") return `claude-${fil.slug}.md`;
	const økt = (sessionId || "ukjent").replace(/[^A-Za-z0-9_-]/g, "");
	return `opencode-${fil.slug}-${økt}.md`;
}

/** Kroppen etter vår frontmatter, for å se om planen faktisk er endret. */
function kropp(innhold: string): string {
	const m = innhold.match(/^---\n[\s\S]*?\n---\n\n?/);
	return m ? innhold.slice(m[0].length) : innhold;
}

/**
 * Ta et øyeblikksbilde av planen. `undefined` når stien ikke er en planfil.
 *
 * Skriver ikke når planteksten er uendret: `Plans/` synkes via git, og en
 * ny `fanget`-tid ved hver identiske skriving ville gitt en commit per
 * verktøykall.
 */
export async function capturePlan(
	sti: string,
	opts: { sessionId: string; harness: string }
): Promise<{ captured: boolean; filepath?: string } | undefined> {
	const fil = somPlanfil(sti);
	if (!fil) return undefined;
	try {
		let plan: string;
		try {
			plan = await fs.promises.readFile(sti, "utf-8");
		} catch {
			fileLog(`[PlanCapture] Planfila ${sti} kunne ikke leses`, "warn");
			return { captured: false };
		}
		if (!plan.trim()) return { captured: false };

		const dir = getPlansDir();
		await fs.promises.mkdir(dir, { recursive: true });
		const mål = path.join(dir, planFilnavn(fil, opts.sessionId));

		try {
			if (kropp(await fs.promises.readFile(mål, "utf-8")) === plan) {
				return { captured: false, filepath: mål };
			}
		} catch {
			// Ingen tidligere versjon.
		}

		const innhold = [
			"---",
			`kilde: ${sti}`,
			`sesjon: ${opts.sessionId || "ukjent"}`,
			`harness: ${opts.harness}`,
			`fanget: ${getLocalTimestamp()}`,
			"---",
			"",
			plan,
		].join("\n");
		const temp = `${mål}.tmp.${process.pid}`;
		await fs.promises.writeFile(temp, innhold);
		await fs.promises.rename(temp, mål);
		fileLog(`[PlanCapture] Plan fanget: ${path.basename(mål)}`, "info");
		return { captured: true, filepath: mål };
	} catch (error) {
		fileLogError("[PlanCapture] Fangst feilet (non-blocking)", error);
		return { captured: false };
	}
}
