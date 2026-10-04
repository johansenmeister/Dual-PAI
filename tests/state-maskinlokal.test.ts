/**
 * Kontrakt-test: `MEMORY/STATE/` er maskinlokal, og git ser den ikke (K17)
 *
 * `sync-end.sh` gjør `git add -A`, så alt under `STATE/` som ikke er
 * gitignorert, blir committet og trukket inn på de andre maskinene. Regelen
 * var en blokkliste, én linje per fil, og den mistet skriverne etter hvert
 * som de kom til. MÅLT 2026-10-01: `0f1f8ef` (sync fra pc-en) committet
 * `prd-registry.json`, som har absolutte stier, og `pai-pull` stoppet på de
 * andre maskinene med «untracked working tree files would be overwritten».
 * `subagent-registry-*.json` (også absolutte stier) var committet fra tre
 * maskiner, og åtte skrivere til hadde ingen regel. Historikken har dessuten
 * `algorithm-state.json` 44 ganger og `security-audit.jsonl` 42 ganger, fra
 * før reglene deres kom.
 *
 * Regelen er nå en tillatelsesliste i `.gitignore`: alt under `STATE/` er
 * ignorert, bortsett fra katalogene og deres `.gitkeep`. Testen holder den
 * slik fra tre sider:
 *
 *   1. Hver kildefil som bygger en sti under `STATE/`, står i tabellen under,
 *      og hvert mønster i tabellen finnes fortsatt i kilden.
 *   2. Hvert navn skriverne lager, og et navn ingen skriver lager ennå, er
 *      ignorert, med mindre det står i `BEVISST_SPORET`.
 *   3. Git sporer ingenting under `STATE/` utover `.gitkeep` og `BEVISST_SPORET`.
 *
 * @module tests/state-maskinlokal
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const STATE = ".opencode/MEMORY/STATE";

/**
 * Filer under `STATE/` som SKAL synkes. Tom: ingenting der er ment å følge
 * med til en annen maskin. En oppføring her krever et unntak (`!`) i
 * `.gitignore` og en begrunnelse ved siden av.
 */
const BEVISST_SPORET: Record<string, string> = {};

/**
 * Hva hver skriver lager under `STATE/`. `spor` er literalen slik den står i
 * kilden, og testen krever at den fortsatt gjør det; `navn` er et eksempel
 * på fila, relativt til `STATE/`. Temp-filene fra atomisk skriving står med,
 * fordi en krasj mellom skriving og `rename` etterlater dem.
 */
// biome-ignore-start lint/suspicious/noTemplateCurlyInString: `spor` er kildeteksten til malstrengene, ikke en malstreng
const SKRIVERE: Record<string, { spor: string; navn: string }[]> = {
	".opencode/pai-core/lib/paths.ts": [
		{ spor: "`current-work-${sessionId}.json`", navn: "current-work-ses_x.json" },
		{ spor: "`algorithm-state-${sessionId}.json`", navn: "algorithm-state-ses_x.json" },
		{ spor: "`${målfil}.tmp.${process.pid}`", navn: "current-work-ses_x.json.tmp.123" },
	],
	".opencode/pai-core/handlers/algorithm-tracker.ts": [
		{ spor: "`${målfil}.tmp.${process.pid}`", navn: "algorithm-state-ses_x.json.tmp.123" },
	],
	".opencode/pai-core/dispatch/state.ts": [
		{ spor: "`dedupe-${sessionKey}.json`", navn: "dedupe-claude_x.json" },
		{ spor: "`msgbuf-${sessionKey}.jsonl`", navn: "msgbuf-claude_x.jsonl" },
		{ spor: "`${målfil}.tmp.${process.pid}`", navn: "dedupe-claude_x.json.tmp.123" },
	],
	".opencode/pai-core/lib/session-pointer.ts": [
		{ spor: '"sessions", "by-ppid"', navn: "sessions/by-ppid/123.json" },
		{ spor: "`${mål}.${process.pid}.tmp`", navn: "sessions/by-ppid/123.json.456.tmp" },
	],
	".opencode/pai-core/handlers/prd-sync.ts": [
		{ spor: '"prd-registry.json"', navn: "prd-registry.json" },
		{ spor: "`${registryPath}.tmp.${process.pid}`", navn: "prd-registry.json.tmp.123" },
	],
	".opencode/pai-core/handlers/last-response-cache.ts": [
		{ spor: '"last-response.txt"', navn: "last-response.txt" },
		{ spor: "`last-response-${safe}.txt`", navn: "last-response-ses_x.txt" },
	],
	".opencode/pai-core/handlers/question-tracking.ts": [{ spor: '"questions.jsonl"', navn: "questions.jsonl" }],
	".opencode/pai-core/handlers/session-registry.ts": [
		{ spor: "`subagent-registry-${sessionId}.json`", navn: "subagent-registry-ses_x.json" },
		{ spor: "`${filePath}.lock`", navn: "subagent-registry-ses_x.json.lock" },
		{ spor: "`${filePath}.tmp.${process.pid}.${Date.now()}`", navn: "subagent-registry-ses_x.json.tmp.1.2" },
	],
	".opencode/pai-core/handlers/security-validator.ts": [
		{ spor: '"security-audit.jsonl"', navn: "security-audit.jsonl" },
	],
	".opencode/pai-core/handlers/tab-state.ts": [{ spor: '"tab-title.json"', navn: "tab-title.json" }],
	".opencode/PAI/Tools/algorithm.ts": [
		{ spor: '"STATE", "algorithms"', navn: "algorithms/ses_x.json" },
		{ spor: '"STATE", "session-names.json"', navn: "session-names.json" },
	],
	".opencode/PAI/Tools/SessionProgress.ts": [
		{ spor: "`${project}-progress.json`", navn: "progress/prosjekt-progress.json" },
	],
	".opencode/PAI/Tools/AlgorithmPhaseReport.ts": [
		{ spor: '"algorithm-phase.json"', navn: "algorithm-phase.json" },
	],
};
// biome-ignore-end lint/suspicious/noTemplateCurlyInString: slutten på tabellen

/** Kildefiler som bare LESER under `STATE/`, eller bare sjekker at katalogen finnes. */
const LESERE = new Set([
	".opencode/pai-core/dispatch/session.ts",
	".opencode/pai-core/handlers/session-cleanup.ts",
	".opencode/pai-core/handlers/compaction-intelligence.ts",
	".opencode/pai-core/handlers/integrity-check.ts",
]);

/**
 * Navn ingen skriver lager i dag. De prøver at regelen dekker en skriver som
 * kommer SENERE, i roten og i en ny katalog. Det var det blokklista ikke
 * gjorde.
 */
const UKJENTE = ["ny-skriver-k17.json", "ny-katalog-k17/fil.json"];

/** Kodekatalogene som kjører i drift. `Tools/` er utelatt: røyktestene leser et temp-tre. */
const KODEROTER = [
	".opencode/pai-core",
	".opencode/pai-adapters",
	".opencode/PAI/Tools",
	".opencode/skills",
	".opencode/tools",
	"claude-plugin",
];

/** En sti under `STATE/` bygges enten med `getStateDir()` eller med literalen `"STATE"`. */
const BRUKER_STATE = /getStateDir\(|["'`]STATE["'`]/;

function kildefiler(rot: string): string[] {
	let oppføringer: { name: string; isDirectory(): boolean; isFile(): boolean; parentPath: string }[];
	try {
		oppføringer = readdirSync(join(REPO, rot), { recursive: true, withFileTypes: true });
	} catch {
		return [];
	}
	// `realpathSync`: `.opencode/skills/PAI` er en symlenke til `../PAI`, og
	// den rekursive lesingen følger den. Filen skal telle én gang, under sitt
	// eget navn.
	return oppføringer
		.filter((o) => o.isFile() && /\.(ts|js|mjs)$/.test(o.name) && !o.parentPath.includes("node_modules"))
		.map((o) => realpathSync(join(o.parentPath, o.name)).replace(`${realpathSync(REPO)}/`, ""));
}

/** `null` når treet ikke er et git-repo, som `speil-maskinuavhengig.test.ts`. */
async function git(args: string[], stdin?: string): Promise<{ kode: number; ut: string } | null> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: REPO,
		stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
		stdout: "pipe",
		stderr: "ignore",
	});
	const ut = await new Response(proc.stdout).text();
	const kode = await proc.exited;
	if (kode === 128) return null;
	return { kode, ut };
}

describe("MEMORY/STATE/ er maskinlokal (K17)", () => {
	test("hver kildefil som bygger en sti under STATE/, står i tabellen", () => {
		const funnet = [...new Set(KODEROTER.flatMap(kildefiler))]
			.filter((f) => BRUKER_STATE.test(readFileSync(join(REPO, f), "utf-8")))
			.sort();
		const kjent = [...Object.keys(SKRIVERE), ...LESERE].sort();

		// En ny fil her er en ny skriver: legg navnene den lager i SKRIVERE,
		// eller filen i LESERE hvis den bare leser.
		expect(funnet.filter((f) => !kjent.includes(f))).toEqual([]);
		// Og motsatt: en oppføring for en fil som ikke lenger rører STATE/.
		expect(kjent.filter((f) => !funnet.includes(f))).toEqual([]);
	});

	test("hvert mønster i tabellen står fortsatt i kilden", () => {
		const borte = Object.entries(SKRIVERE).flatMap(([fil, mønstre]) => {
			const kilde = readFileSync(join(REPO, fil), "utf-8");
			return mønstre.filter((m) => !kilde.includes(m.spor)).map((m) => `${fil}: ${m.spor}`);
		});
		expect(borte).toEqual([]);
	});

	test("alt skriverne lager, og det ingen lager ennå, er gitignorert", async () => {
		const navn = [...Object.values(SKRIVERE).flatMap((m) => m.map((x) => x.navn)), ...UKJENTE];
		const stier = navn.map((n) => `${STATE}/${n}`);

		// `--no-index`: spør regelen, ikke indeksen. Uten flagget svarer git
		// «ikke ignorert» for en fil som allerede er sporet.
		const svar = await git(["check-ignore", "--no-index", "--stdin"], `${stier.join("\n")}\n`);
		if (svar === null) return;
		const ignorert = new Set(svar.ut.split("\n").filter(Boolean));

		const sporbare = stier.filter((s) => !ignorert.has(s) && !(s.slice(STATE.length + 1) in BEVISST_SPORET));
		expect(sporbare).toEqual([]);
	});

	test(".gitkeep er ikke ignorert, så katalogene finnes i en fersk klone", async () => {
		const stier = [`${STATE}/.gitkeep`, `${STATE}/progress/.gitkeep`, `${STATE}/integrity/.gitkeep`];
		const svar = await git(["check-ignore", "--no-index", "--stdin"], `${stier.join("\n")}\n`);
		if (svar === null) return;
		expect(svar.ut.split("\n").filter(Boolean)).toEqual([]);
	});

	test("git sporer bare .gitkeep under STATE/", async () => {
		const svar = await git(["ls-files", "--", STATE]);
		if (svar === null) return;
		const sporet = svar.ut
			.split("\n")
			.filter(Boolean)
			.filter((s) => !s.endsWith("/.gitkeep") && !(s.slice(STATE.length + 1) in BEVISST_SPORET));
		// En fil her er committet fra en maskin (`sync-end.sh` gjør `git add -A`)
		// før regelen dekket den. `git rm --cached <fil>` tar den ut av indeksen
		// og lar den ligge på disk.
		expect(sporet).toEqual([]);
	});
});
