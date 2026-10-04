/**
 * Nøklene i `.opencode/.env`: satt eller mangler, aldri verdiene (#162 fase 1)
 *
 * `.env.example` er lista: hver `# ## Gruppe`-linje starter en gruppe, og hver
 * `NAVN=` under den er en nøkkel. En nøkkel er satt når `.env` har den med en
 * verdi som ikke er tom. Verdiene leses bare for å avgjøre det, og forlater
 * aldri denne modulen: resultatet har navn og boolske verdier, ingenting annet.
 *
 * To innganger: `pai keys` viser hele lista (for brukeren som fyller ut fila,
 * og for kjøreplanen), og `pai doctor` viser bare det som er galt. Alle nøklene
 * er valgfrie, så en manglende nøkkel er ikke et avvik. Avvikene er en `.env`
 * andre kan lese (et problem), nøkler som ikke står i malen, og en
 * `~/.config/PAI/.env` som ingen verktøy leser lenger (varsler).
 *
 * @module PAI/Tools/nokkel-helse
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Nøkkelgruppe {
	navn: string;
	nøkler: { navn: string; satt: boolean }[];
}

export interface NøkkelHelse {
	/** Stien til `.env`, og om den finnes. */
	env: string;
	envFinnes: boolean;
	/** Gruppene fra malen, i malens rekkefølge. Tom når malen mangler. */
	grupper: Nøkkelgruppe[];
	/** Navn med verdi i `.env` som ikke står i malen. */
	ukjente: string[];
	/** Det som må rettes. */
	problemer: string[];
	/** Det brukeren bør vite. */
	varsler: string[];
}

const NAVN = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** Gruppene og nøklene i `.env.example`. Nøkler før første gruppe havner i «Other». */
export function lesMal(tekst: string): { navn: string; nøkler: string[] }[] {
	const grupper: { navn: string; nøkler: string[] }[] = [];
	for (const linje of tekst.split("\n")) {
		const gruppe = linje.match(/^#\s*##\s+(.+?)\s*$/);
		if (gruppe) {
			grupper.push({ navn: gruppe[1], nøkler: [] });
			continue;
		}
		const m = linje.match(NAVN);
		if (!m) continue;
		if (grupper.length === 0) grupper.push({ navn: "Other", nøkler: [] });
		grupper[grupper.length - 1].nøkler.push(m[1]);
	}
	return grupper.filter((g) => g.nøkler.length > 0);
}

/** Navnene i en `.env` som har en verdi. Tom og `""` teller som ikke satt. */
export function satteNøkler(tekst: string): Set<string> {
	const satt = new Set<string>();
	for (const linje of tekst.split("\n")) {
		const m = linje.trim().match(NAVN);
		if (!m) continue;
		const verdi = m[2].trim().replace(/^(["'])(.*)\1$/, "$2").trim();
		if (verdi !== "") satt.add(m[1]);
		else satt.delete(m[1]);
	}
	return satt;
}

/** Sjekken. `dir` er `.opencode`-treet, `home` er hjemmekatalogen (for `~/.config/PAI`). */
export function nøkkelHelse(dir: string, home: string): NøkkelHelse {
	const env = join(dir, ".env");
	const mal = join(dir, ".env.example");
	const h: NøkkelHelse = { env, envFinnes: existsSync(env), grupper: [], ukjente: [], problemer: [], varsler: [] };

	const satt = h.envFinnes ? satteNøkler(readFileSync(env, "utf-8")) : new Set<string>();
	if (h.envFinnes) {
		const modus = statSync(env).mode & 0o777;
		if (modus & 0o077) h.problemer.push(`${env} is readable by others (${modus.toString(8)}): chmod 600 ${env}`);
	}

	if (existsSync(mal)) {
		h.grupper = lesMal(readFileSync(mal, "utf-8")).map((g) => ({
			navn: g.navn,
			nøkler: g.nøkler.map((n) => ({ navn: n, satt: satt.has(n) })),
		}));
		const kjente = new Set(h.grupper.flatMap((g) => g.nøkler.map((n) => n.navn)));
		h.ukjente = [...satt].filter((n) => !kjente.has(n)).sort();
		if (h.ukjente.length > 0)
			h.varsler.push(`${h.ukjente.length} key(s) in .env are not in .env.example: ${h.ukjente.join(", ")}`);
	} else {
		h.varsler.push(`did not find ${mal}: cannot tell which keys are missing`);
	}

	const gammel = join(home, ".config", "PAI", ".env");
	if (existsSync(gammel))
		h.varsler.push(`${gammel} exists, but no tool reads it any more: move the keys to ${env}`);

	return h;
}
