/**
 * Hvor modellen skal skrive PRD-en (M-47), og at refleksjonen mangler (#315)
 *
 * Malen ber modellen skrive PRD-en i arbeidsøktens katalog, men ingenting
 * fortalte den hvilken katalog det var. Den laget sine egne under
 * `MEMORY/WORK/`, og der fant verken teardown eller kompakteringen dem. Linja
 * går med `user.message` (Claude, `UserPromptSubmit`) og `context.build` (v2,
 * bygget på nytt hver tur), og er kort nok til å ligge godt under hook-taket.
 *
 * Samme kanal bærer påminnelsen om refleksjonen. LEARN-sjekken i
 * `isc-validator` ser bare svar med LEARN-fasen, og i `warn` når den bare
 * loggen. En økt som starter i FULL og fortsetter i ITERATION, avsluttet
 * derfor uten refleksjon og uten at noen sa fra (jobb #4). En PRD betyr at
 * økten kjørte Algoritmen, og da skal det finnes en refleksjon skrevet etter
 * at økten startet. Mangler den, sier neste tur fra, til den er skrevet.
 *
 * Bare med `PAI_ENABLED=1`, som resten av konteksten.
 *
 * @module dispatch/arbeidsokt
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getCurrentWorkPath, getLearningDir, getPaiHome } from "../lib/paths";

/** LEARN kjører fra Standard og opp; `WriteReflection` avviser de to under. */
const UNDER_LEARN = new Set(["instant", "fast"]);

/** Tidsfeltet i kanonisk form og i de to eldre formene `MineReflections` leser. */
function tidspunkt(linje: string): number {
	try {
		const rad = JSON.parse(linje) as Record<string, unknown>;
		const verdi = rad.timestamp ?? rad.ts ?? rad.date;
		return typeof verdi === "string" ? Date.parse(verdi) : Number.NaN;
	} catch {
		return Number.NaN;
	}
}

/**
 * Sann når økten har en PRD fra Standard og opp, og ingen refleksjon er
 * skrevet etter at den startet. Tvil gir usann: uten `started_at` er det
 * ingenting å måle mot, og en påminnelse som slår feil, lærer modellen å
 * overse den.
 *
 * Tiden er hele koblingen mellom økt og refleksjon. En annen økts refleksjon
 * i samme tidsrom teller derfor med; det er prisen for ikke å kreve et felt
 * de eldre radene ikke har.
 */
export function manglerRefleksjon(katalog: string): boolean {
	if (!fs.existsSync(path.join(katalog, "PRD.md"))) return false;

	let meta: string;
	try {
		meta = fs.readFileSync(path.join(katalog, "META.yaml"), "utf-8");
	} catch {
		return false;
	}
	const innsats = meta.match(/^effort_level:\s*(\S+)/m)?.[1]?.toLowerCase();
	if (innsats && UNDER_LEARN.has(innsats)) return false;
	const startet = Date.parse(meta.match(/^started_at:\s*(\S+)/m)?.[1] ?? "");
	if (Number.isNaN(startet)) return false;

	const fil = path.join(getLearningDir(), "REFLECTIONS", "algorithm-reflections.jsonl");
	let innhold = "";
	try {
		innhold = fs.readFileSync(fil, "utf-8");
	} catch {
		return true;
	}
	return !innhold.split("\n").some((linje) => tidspunkt(linje) >= startet);
}

export async function arbeidsøktKontekst(sessionId: string): Promise<string | null> {
	if (process.env.PAI_ENABLED !== "1" || !sessionId) return null;
	const katalog = await getCurrentWorkPath(sessionId).catch(() => null);
	if (!katalog) return null;
	const linjer = [
		`PAI work session directory: ${katalog}`,
		`Write this task's PRD as ${katalog}/PRD.md (format: PAI/PRDFORMAT.md); the hooks read it from there.`,
	];
	if (manglerRefleksjon(katalog)) {
		// `PAI_DIR` foran: verktøyet faller ellers tilbake på `~/.opencode`, og
		// modellens skall har ikke `PAI_HOME`, som hooken leser treet fra.
		const hjem = getPaiHome();
		const verktøy = path.join(hjem, "PAI", "Tools", "WriteReflection.ts");
		linjer.push(
			`This session has a PRD but no LEARN reflection yet. When the work is done, write it, in ITERATION format too: PAI_DIR=${hjem} bun ${verktøy} --task "…" --effort <level> --sentiment <1-10> --q1 "…" --q2 "…" --q3 "…"`,
		);
	}
	return linjer.join("\n");
}
