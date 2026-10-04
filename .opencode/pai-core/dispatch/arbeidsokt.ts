/**
 * Hvor modellen skal skrive PRD-en (M-47)
 *
 * Malen ber modellen skrive PRD-en i arbeidsøktens katalog, men ingenting
 * fortalte den hvilken katalog det var. Den laget sine egne under
 * `MEMORY/WORK/`, og der fant verken teardown eller kompakteringen dem. Linja
 * går med `user.message` (Claude, `UserPromptSubmit`) og `context.build` (v2,
 * bygget på nytt hver tur), og er kort nok til å ligge godt under hook-taket.
 *
 * Bare med `PAI_ENABLED=1`, som resten av konteksten.
 *
 * @module dispatch/arbeidsokt
 */

import { getCurrentWorkPath } from "../lib/paths";

export async function arbeidsøktKontekst(sessionId: string): Promise<string | null> {
	if (process.env.PAI_ENABLED !== "1" || !sessionId) return null;
	const katalog = await getCurrentWorkPath(sessionId).catch(() => null);
	if (!katalog) return null;
	return `PAI work session directory: ${katalog}\nWrite this task's PRD as ${katalog}/PRD.md (format: PAI/PRDFORMAT.md); the hooks read it from there.`;
}
