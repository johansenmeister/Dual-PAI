/**
 * K5 i `pai doctor`: handlere som står på null der inndataen fantes
 *
 * Arbeidsøktene har `EFFEKTER.jsonl` (`pai-core/lib/effekter.ts`): én linje per
 * effekt dispatch-laget så. Her leses de siste fullførte øktene som HAR fila (de
 * eldre kan ikke si noe), og for hver regel telles øktene der inndataen finnes på
 * disk og øktene der effekten ble merket. Inndata i minst `TERSKEL` økter og
 * effekt i ingen er en handler som kjører og ikke gjør noe: M-34 (ISC-grenen i
 * læringsfangsten), M-32 (PRD-synken under OpenCode).
 *
 * Inndatareglene er med vilje BREDERE enn handlernes egne betingelser. Leser
 * doctor inndataen som handleren gjør, ser den ikke feilen handleren har: M-34
 * var nettopp at læringsfangsten ventet `DONE` der motorene skriver `completed`.
 *
 * Regel 1: bare fullførte økter med markørfila telles, og en delvis effekt
 * (noen økter) er ikke et funn. Da er det bare «aldri» som roper.
 *
 * @module PAI/Tools/effekt-helse
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const EFFEKTFIL = "EFFEKTER.jsonl";
export const ANTALL_ØKTER = 20;
export const TERSKEL = 3;

export interface EffektRegel {
	handler: string;
	/** Hva inndataen er, til meldingen. */
	inndata: string;
	harInndata: (øktkatalog: string) => boolean;
	harEffekt: (effekter: readonly string[]) => boolean;
}

function les(sti: string): string {
	try {
		return readFileSync(sti, "utf-8");
	} catch {
		return "";
	}
}

/** PRD-ene i en øktkatalog: `PRD.md` og `PRD-<dato>-<slug>.md`, som malen ber om. */
export function prdFiler(øktkatalog: string): string[] {
	try {
		return readdirSync(øktkatalog).filter((f) => /^PRD(-[^/]*)?\.md$/.test(f));
	} catch {
		return [];
	}
}

export const REGLER: readonly EffektRegel[] = [
	{
		handler: "learning-capture (ISC branch)",
		inndata: "ISC.json with met criteria",
		harInndata: (d) => {
			try {
				const isc = JSON.parse(les(join(d, "ISC.json"))) as { criteria?: { status?: unknown }[] };
				return (isc.criteria ?? []).some((c) => /complet|done|verif|pass/i.test(String(c?.status ?? "")));
			} catch {
				return false;
			}
		},
		harEffekt: (e) => e.some((x) => x.startsWith("learnings:")),
	},
	{
		handler: "algorithm-tracker (phase tracking from the PRD)",
		inndata: "a PRD with ISC lines in the session directory",
		harInndata: (d) => prdFiler(d).some((f) => /^- \[[ xX]\] ISC-/m.test(les(join(d, f)))),
		harEffekt: (e) => e.includes("prd-tracked"),
	},
	{
		handler: "prd-sync",
		inndata: "a PRD in the session directory",
		harInndata: (d) => prdFiler(d).length > 0,
		harEffekt: (e) => e.includes("prd-synced"),
	},
];

/** Effektene i en øktkatalog, eller null når fila ikke finnes (økten er fra før K5). */
export function lesEffekter(øktkatalog: string): string[] | null {
	const sti = join(øktkatalog, EFFEKTFIL);
	if (!existsSync(sti)) return null;
	return les(sti)
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				return String((JSON.parse(l) as { effekt?: unknown }).effekt ?? "");
			} catch {
				return "";
			}
		})
		.filter(Boolean);
}

/** De siste fullførte øktene med markørfila, nyeste først. Katalognavnene begynner med tidsstempelet. */
export function sisteØkter(workRot: string, antall = ANTALL_ØKTER): { katalog: string; effekter: string[] }[] {
	const ut: { katalog: string; effekter: string[] }[] = [];
	let måneder: string[];
	try {
		måneder = readdirSync(workRot)
			.filter((m) => /^\d{4}-\d{2}$/.test(m))
			.sort()
			.reverse();
	} catch {
		return ut;
	}
	for (const m of måneder) {
		const økter = readdirSync(join(workRot, m)).sort().reverse();
		for (const ø of økter) {
			const katalog = join(workRot, m, ø);
			try {
				if (!statSync(katalog).isDirectory()) continue;
			} catch {
				continue;
			}
			if (!/^status:\s*COMPLETED\b/m.test(les(join(katalog, "META.yaml")))) continue;
			const effekter = lesEffekter(katalog);
			if (effekter === null) continue;
			ut.push({ katalog, effekter });
			if (ut.length >= antall) return ut;
		}
	}
	return ut;
}

export function effektHelse(
	workRot: string,
	regler: readonly EffektRegel[] = REGLER,
	antall = ANTALL_ØKTER,
	terskel = TERSKEL
): { problemer: string[]; varsler: string[]; økter: number } {
	const økter = sisteØkter(workRot, antall);
	const problemer: string[] = [];
	for (const r of regler) {
		const medInndata = økter.filter((ø) => r.harInndata(ø.katalog));
		const medEffekt = medInndata.filter((ø) => r.harEffekt(ø.effekter));
		if (medInndata.length >= terskel && medEffekt.length === 0) {
			problemer.push(
				`${r.handler}: ${r.inndata} in ${medInndata.length} of the last ${økter.length} sessions, effect in none (K5). The handler runs and does nothing`
			);
		}
	}
	return { problemer, varsler: [], økter: økter.length };
}
