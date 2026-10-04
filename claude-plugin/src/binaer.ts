/**
 * Claude-adapter — den kompilerte hook-binæren
 *
 * `bin/pai-hook` er en KONTRAKT, ikke en fil: hooks.json peker kun på det
 * navnet. Bak det ligger enten shell-oppstarteren som kjører `bun
 * bin/pai-hook.ts`, eller — når den er bygget — en `bun build --compile
 * --bytecode`-binær på `bin/pai-hook.bin`.
 *
 * MÅLT 2026-09-22, 20 kall per sti:
 *
 * | Variant | Hurtigutgang | Full sti |
 * |---|---|---|
 * | `sh` + `bun` | 74 ms | 89 ms |
 * | `--compile` alene | 74 ms | 90 ms |
 * | `--compile --bytecode` | **30 ms** | **36 ms** |
 *
 * `--compile` ALENE GIR NULL. Planen anslo 10–20 ms fra den; det tallet var
 * feil. Hele gevinsten ligger i `--bytecode`, som slipper å parse 53 moduler
 * på nytt ved hver eneste hook-prosess.
 *
 * PRISEN er at en kompilert binær kan bli stale: redigerer du
 * sikkerhetsvakten uten å bygge på nytt, kjører den gamle koden videre, og
 * det skjer stumt. Denne fila er vakten mot det. Sjekken ligger bevisst IKKE
 * i den varme stien — en `find -newer` koster 11 ms av de 44 vi vant, altså
 * en fjerdedel. Den kjøres ved `SessionStart` (som allerede koster 424 ms,
 * der 11 ms drukner) og av launcheren før oppstart.
 *
 * @module claude-plugin/binaer
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** Filnavnet den kompilerte binæren har. Gitignorert; bygges av `pai claude sync`. */
export const BINÆRNAVN = "pai-hook.bin";

/**
 * Katalogene som utgjør hookens kildekode, relativt til repo-roten.
 *
 * Endres denne lista, må `Tools/BuildClaudeHook.ts` fortsatt treffe det samme
 * settet — ellers blir en kilde usynlig for ferskhetssjekken, og da er vakten
 * verre enn ingen vakt: den sier «fersk» om noe som ikke er det.
 * `tests/hook-binary.test.ts` låser at hver katalog finnes.
 */
export const KILDEKATALOGER: readonly string[][] = [
	["claude-plugin", "bin"],
	["claude-plugin", "src"],
	[".opencode", "pai-core"],
];

/** Hvor den kompilerte binæren ligger, gitt plugin-roten. */
export function binærSti(pluginRot: string): string {
	return join(pluginRot, "bin", BINÆRNAVN);
}

/**
 * Nyeste mtime blant alle `.ts`-filer i kildekatalogene, i millisekunder.
 *
 * Returnerer 0 når ingenting finnes — da kan ingenting være stale, og en
 * ferskhetssjekk som feiler skal ikke kunne blokkere noe.
 */
export function nyesteKildeendring(repoRot: string): number {
	let nyest = 0;

	const gå = (katalog: string): void => {
		let innhold: string[];
		try {
			innhold = readdirSync(katalog);
		} catch {
			// En katalog vi ikke får lest er ikke et bevis på at noe er stale.
			return;
		}
		for (const navn of innhold) {
			const sti = join(katalog, navn);
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(sti);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				gå(sti);
			} else if (navn.endsWith(".ts") && st.mtimeMs > nyest) {
				nyest = st.mtimeMs;
			}
		}
	};

	for (const deler of KILDEKATALOGER) {
		const katalog = join(repoRot, ...deler);
		if (existsSync(katalog)) gå(katalog);
	}

	return nyest;
}

export interface Ferskhet {
	/** Er binæren bygget i det hele tatt? */
	finnes: boolean;
	/** Er den nyere enn all kildekode? Alltid `true` når den ikke finnes — da kjører vi kilden. */
	fersk: boolean;
	/** mtime for binæren, 0 når den ikke finnes. */
	bygget: number;
	/** Nyeste kilde-mtime. */
	nyesteKilde: number;
}

/**
 * Er den kompilerte binæren fersk?
 *
 * **`finnes: false` gir `fersk: true`, og det er med vilje.** Uten binær
 * kjører shell-oppstarteren kilden direkte, og da er ingenting stale. Å
 * rapportere «ikke fersk» der ville gitt en advarsel om et problem som ikke
 * finnes — og en advarsel som alltid står, er en advarsel ingen leser.
 */
export function sjekkFerskhet(repoRot: string, pluginRot?: string): Ferskhet {
	const rot = pluginRot ?? join(repoRot, "claude-plugin");
	const bin = binærSti(rot);

	if (!existsSync(bin)) {
		return { finnes: false, fersk: true, bygget: 0, nyesteKilde: 0 };
	}

	let bygget = 0;
	try {
		bygget = statSync(bin).mtimeMs;
	} catch {
		return { finnes: false, fersk: true, bygget: 0, nyesteKilde: 0 };
	}

	const nyesteKilde = nyesteKildeendring(repoRot);
	return { finnes: true, fersk: nyesteKilde <= bygget, bygget, nyesteKilde };
}

/**
 * Finn repo-roten ut fra plugin-roten.
 *
 * `claude-plugin/` ligger ved siden av `.opencode/` i samme repo, så roten er
 * ett hakk opp. Skilt ut som funksjon fordi BÅDE hooken og launcheren trenger
 * den, og de kommer fra hver sin kant.
 */
export function repoRotFraPlugin(pluginRot: string): string {
	return dirname(pluginRot);
}
