/**
 * Skrivebeskyttede stier (K57)
 *
 * PAI-økter på jobb skrev to ganger i BookStack-speilet (`~/repos/example-work-docs/`),
 * som er output fra synken og ikke en arbeidsflate. Neste `pull --rebase
 * --autostash` kolliderte ved stash-pop, og speilet fikk konfliktmarkører
 * (2026-09-17: 101 filer, 2026-09-30: én). Sikkerhetsvakten nekter derfor
 * `write`/`edit` under stiene her, og `pai doctor` sjekker at repoene er rene.
 *
 * Lista ligger i en sporet fil under `PAI/USER/`, ikke i `settings.json`: den
 * er gitignorert og ville måttet settes for hånd på hver jobbmaskin, mens
 * `PAI/USER/` følger med bundelen og er der forskjellen mellom jobb og hjemme
 * bor (brukerens valg 2026-09-30). Hjemme finnes fila ikke, og vakten er taus.
 *
 * ```json
 * { "stier": ["~/repos/example-work-docs"], "kilde": "BookStack: update_page i bookstack-MCP" }
 * ```
 *
 * `kilde` er valgfri og står i meldingen til modellen, så kjernen ikke trenger
 * å kjenne BookStack. Manglende fil, ugyldig JSON eller en relativ sti gir
 * ingen blokkering og aldri et kast: vakten er fail-open.
 *
 * @module skrivebeskyttet
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { getHomePaiDir } from "./paths";

/** Relativt til PAI-treet (`~/.opencode`). */
export const SKRIVEBESKYTTET_FIL = join("PAI", "USER", "SKRIVEBESKYTTET.json");

export interface Skrivebeskyttet {
	/** Absolutte, normaliserte stier. Tom når fila mangler eller er ugyldig. */
	stier: string[];
	/** Hvor endringen skal gjøres i stedet, eller null. */
	kilde: string | null;
}

/** `~` og `~/…` ekspanderes; resten normaliseres med `path.resolve`. */
export function ekspander(sti: string, hjem: string = homedir()): string {
	if (sti === "~") return resolve(hjem);
	if (sti.startsWith("~/")) return resolve(hjem, sti.slice(2));
	return resolve(sti);
}

export function lesSkrivebeskyttet(paiDir: string = getHomePaiDir()): Skrivebeskyttet {
	const ingen: Skrivebeskyttet = { stier: [], kilde: null };
	const fil = join(paiDir, SKRIVEBESKYTTET_FIL);
	if (!existsSync(fil)) return ingen;
	try {
		const data: unknown = JSON.parse(readFileSync(fil, "utf-8"));
		if (typeof data !== "object" || data === null) return ingen;
		const { stier, kilde } = data as Record<string, unknown>;
		return {
			stier: Array.isArray(stier)
				? stier
						.filter((s): s is string => typeof s === "string")
						.map((s) => s.trim())
						// En relativ sti ville løst seg mot prosessens cwd og betydd noe nytt i hver økt.
						.filter((s) => s === "~" || s.startsWith("~/") || isAbsolute(s))
						.map((s) => ekspander(s))
				: [],
			kilde: typeof kilde === "string" && kilde.trim() !== "" ? kilde.trim() : null,
		};
	} catch {
		return ingen;
	}
}

/**
 * Stien selv, og den samme gjennom symlenkene i nærmeste forelder som finnes.
 * `~/.opencode` er en symlenke inn i repoet på alle maskinene; speilet kan
 * nås på samme måte, og en fil som ikke finnes ennå, har ingen realpath.
 */
function varianter(sti: string): string[] {
	let katalog = sti;
	let rest = "";
	while (!existsSync(katalog)) {
		const forelder = dirname(katalog);
		if (forelder === katalog) return [sti];
		rest = rest ? join(basename(katalog), rest) : basename(katalog);
		katalog = forelder;
	}
	try {
		const ekte = rest ? join(realpathSync(katalog), rest) : realpathSync(katalog);
		return ekte === sti ? [sti] : [sti, ekte];
	} catch {
		return [sti];
	}
}

/**
 * Den skrivebeskyttede roten `filePath` ligger under, eller null.
 *
 * Prefikset sammenlignes med avsluttende skilletegn, så `example-work-docs-foo/`
 * ikke treffer `example-work-docs`, og `path.resolve` fanger `foo/../`.
 */
export function skrivebeskyttetRot(filePath: string, stier: readonly string[]): string | null {
	if (stier.length === 0) return null;
	const mål = varianter(resolve(filePath));
	for (const rot of stier) {
		for (const r of varianter(rot)) {
			const prefiks = r.endsWith(sep) ? r : r + sep;
			if (mål.some((m) => m === r || m.startsWith(prefiks))) return rot;
		}
	}
	return null;
}
