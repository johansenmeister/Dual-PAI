/**
 * K10 i `pai doctor`: ledige sider i v2s `opencode.db`
 *
 * Etter v2s migrering var 92 % av basen på `pai` ledige sider (8,4 GB, v1s
 * hendelseslogg tømt), og `auto_vacuum` er av, så de blir liggende. `VACUUM`
 * ga 712 MB. Her leses `page_count`/`freelist_count` skrivebeskyttet (~25 ms),
 * og doctoren foreslår `VACUUM` med motoren stoppet. Retter aldri selv: en
 * `VACUUM` mens v2 skriver, er brukerens beslutning, ikke en selvreparasjon.
 *
 * Regel 1: taus under terskelen. En liten base med mye ledig plass (12 MB,
 * 44 % på testmaskinen 2026-09-29) er ikke et funn; bare begge kravene sammen
 * roper.
 *
 * @module PAI/Tools/db-helse
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Minst så mye ledig plass før doctoren sier fra. */
export const MIN_LEDIG_BYTE = 256 * 1024 * 1024;
/** Og minst så stor andel av fila. */
export const MIN_ANDEL = 0.3;

export function standardDbSti(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share"), "opencode", "opencode.db");
}

export interface DbHelse {
	/** Én linje per funn. Tom når basen er under terskelen, eller ikke finnes. */
	varsler: string[];
	/** Ledige byte, eller null når basen ikke kunne leses. */
	ledig: number | null;
	totalt: number | null;
}

/** `sqlite3` finnes ikke på alle maskinene (ikke på testmaskinen), men bun gjør. */
export function vacuumKommando(sti: string): string {
	return `bun -e 'new (require("bun:sqlite").Database)(${JSON.stringify(sti)}).run("VACUUM")'`;
}

function mb(byte: number): string {
	return `${Math.round(byte / (1024 * 1024))} MB`;
}

export function dbHelse(sti: string = standardDbSti(), minLedig = MIN_LEDIG_BYTE, minAndel = MIN_ANDEL): DbHelse {
	if (!existsSync(sti)) return { varsler: [], ledig: null, totalt: null };
	let db: Database | undefined;
	try {
		db = new Database(sti, { readonly: true });
		const pragma = (navn: string) => Number(Object.values(db?.query(`PRAGMA ${navn}`).get() ?? {})[0] ?? 0);
		const størrelse = pragma("page_size");
		const totalt = pragma("page_count") * størrelse;
		const ledig = pragma("freelist_count") * størrelse;
		const varsler =
			totalt > 0 && ledig >= minLedig && ledig / totalt >= minAndel
				? [
						`${mb(ledig)} of ${mb(totalt)} in ${sti} is free pages (auto_vacuum is off). ` +
							`Stop all OpenCode sessions, then run: ${vacuumKommando(sti)}`,
					]
				: [];
		return { varsler, ledig, totalt };
	} catch {
		// Låst eller ødelagt: K29 og motoren selv sier fra om det. I tvil, ingenting.
		return { varsler: [], ledig: null, totalt: null };
	} finally {
		db?.close();
	}
}
