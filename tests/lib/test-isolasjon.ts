/**
 * Testisolasjon for hele suiten — hjelperne bak `tests/preload.ts` (K1)
 *
 * Tester har skrevet i det EKTE MEMORY-treet minst fem ganger, og hver gang
 * var det én fil som glemte å isolere seg. Den siste var ikke engang en
 * glemsel: en `user.message` starter implicit-sentiment uten `await`, og
 * svaret fra et EKTE modellkall kom etter at fila hadde gjenopprettet
 * `PAI_HOME`. Og alle `bun test` skrev 35 falske linjer i den ekte
 * `STATE/security-audit.jsonl`, blant dem «blocked: write
 * ~/.ssh/authorized_keys» — målt 2026-09-26 med øyeblikksbildet under.
 *
 * Derfor er isolasjonen suitens, ikke hver fils: preloaden setter `PAI_HOME`
 * til en temp-katalog før noen test laster, stubber `inference()`, og
 * sammenligner de ekte trærne før og etter.
 *
 * @module tests/lib/test-isolasjon
 */

import { type Dirent, existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Feilteksten stubben svarer med — testene asserter på den. */
export const INFERENCE_STUBB = "inference() er stubbet i bun test (tests/preload.ts)";

/** sti → "størrelse:mtimeMs" for hver fil under røttene. */
export type Øyeblikksbilde = Map<string, string>;

/**
 * Alle MEMORY-trær `getPaiHome()` kan havne i: `$PAI_HOME`, `cwd/.opencode`
 * og `~/.opencode`, slått sammen etter realpath. På maskinene er
 * `~/.opencode` en symlink inn i repoet, så det blir som regel ett tre.
 *
 * Speiler oppløsningen i `pai-core/lib/paths.ts` i stedet for å importere
 * den: preloaden laster før testene, og produktmoduler den importerer, blir
 * cachet med preloadens miljø.
 */
export function ekteMemoryRøtter(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string[] {
	const kandidater = [env.PAI_HOME, join(cwd, ".opencode"), join(homedir(), ".opencode")];
	const røtter = new Set<string>();
	for (const kandidat of kandidater) {
		if (!kandidat) continue;
		const memory = join(kandidat, "MEMORY");
		if (existsSync(memory)) røtter.add(realpathSync(memory));
	}
	return [...røtter];
}

/**
 * Størrelse og endringstid per fil. Ikke antall filer: `persistLearning` har
 * sekundoppløsning i filnavnet, og en ny skriving i samme sekund overskriver
 * den forrige, så antallet står stille mens innholdet endres (fase 5).
 */
export function taØyeblikksbilde(røtter: string[]): Øyeblikksbilde {
	const bilde: Øyeblikksbilde = new Map();
	const gå = (katalog: string) => {
		let oppføringer: Dirent[];
		try {
			oppføringer = readdirSync(katalog, { withFileTypes: true });
		} catch {
			return;
		}
		for (const oppføring of oppføringer) {
			const sti = join(katalog, oppføring.name);
			if (oppføring.isDirectory()) {
				gå(sti);
				continue;
			}
			try {
				const s = lstatSync(sti);
				bilde.set(sti, `${s.size}:${s.mtimeMs}`);
			} catch {
				// Slettet mellom readdir og lstat — neste bilde viser det.
			}
		}
	};
	for (const rot of røtter) gå(rot);
	return bilde;
}

/** Hva som er nytt, endret og slettet mellom to bilder, sortert. */
export function endringer(før: Øyeblikksbilde, etter: Øyeblikksbilde): string[] {
	const funn: string[] = [];
	for (const [sti, verdi] of etter) {
		const tidligere = før.get(sti);
		if (tidligere === undefined) funn.push(`ny:      ${sti}`);
		else if (tidligere !== verdi) funn.push(`endret:  ${sti}`);
	}
	for (const sti of før.keys()) {
		if (!etter.has(sti)) funn.push(`slettet: ${sti}`);
	}
	return funn.sort();
}
