/**
 * PAI Core — delt kjøretidstilstand for hendelsesbehandling
 *
 * Dedupe-vinduet og meldingsbufferne. Begge lå i modulvariabler fram til
 * batch 5, og det holdt bare så lenge én prosess så hele økten. Det gjør
 * den ikke: Claude Code kjører **én prosess per hook-event**, og OpenCode
 * kan starte på nytt midt i en økt. Prosessminne er derfor ikke en
 * optimalisering her — det er et feilsvar.
 *
 * Nøkkelen er `sessionKey`, ikke rå sessionId, fordi de to motorene deler
 * MEMORY-tre. `sessionKeyFor()` garanterer at samme rå ID under to motorer
 * aldri gir samme filnavn.
 *
 * Importerer ingen motor.
 *
 * @module pai-core/dispatch/state
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileLogError } from "../lib/file-logger";
import { ensureDir, getStateDir } from "../lib/paths";

/** Hvor lenge en melding regnes som nylig behandlet. */
const MESSAGE_DEDUPE_TTL_MS = 5000;

/** Tak på hvor mange meldinger relationship-memory får se. Som før. */
const MAX_USER_MESSAGES = 50;
const MAX_ASSISTANT_MESSAGES = 20;

/**
 * Hvor lenge transiente øktfiler får ligge før de regnes som forlatt.
 *
 * Dedupe og buffere er caching, ikke arbeidshistorikk. Dør en prosess uten
 * å rydde, skal filene forsvinne av seg selv framfor å samle seg i STATE/.
 */
const STALE_MS = 24 * 60 * 60 * 1000;

function dedupeFile(sessionKey: string): string {
	return path.join(getStateDir(), `dedupe-${sessionKey}.json`);
}

function bufferFile(sessionKey: string): string {
	return path.join(getStateDir(), `msgbuf-${sessionKey}.jsonl`);
}

/**
 * Skriv en fil atomisk.
 *
 * Leseren er en annen prosess enn skriveren. Et halvskrevet JSON-dokument
 * ville gitt en parse-feil som handleren svelger — og dermed stille tapt
 * dedupe-vinduet.
 */
async function writeAtomic(målfil: string, innhold: string): Promise<void> {
	const temp = `${målfil}.tmp.${process.pid}`;
	await fs.promises.writeFile(temp, innhold);
	await fs.promises.rename(temp, målfil);
}

/**
 * Er meldingen nylig behandlet?
 *
 * OpenCode har to kilder til samme brukermelding, og uten denne sjekken får
 * man dobbel arbeidsøkt, dobbel rating og dobbelt THREAD-innslag. Claude
 * Codes `UserPromptSubmit` fyrer én gang, så der er dette et no-op som
 * koster ett filoppslag.
 *
 * H-08: nøkkelen inneholder sessionKey. Uten den kunne to samtidige økter
 * som sendte samme tekst innen TTL-vinduet dedupe hverandres meldinger —
 * den andre økten mistet arbeidsøkt, rating og THREAD-innslag i stillhet.
 *
 * FAIL-OPEN: kan vi ikke lese tilstanden, svarer vi «ikke sett før». Å
 * gjette på duplikat ville forkastet en ekte brukermelding, som er den
 * dyreste feilen dette systemet kan gjøre.
 */
export async function wasMessageRecentlyProcessed(
	sessionKey: string,
	content: string
): Promise<boolean> {
	const hash = `${content.length}:${content.substring(0, 100)}`;
	const now = Date.now();
	const fil = dedupeFile(sessionKey);

	let sett: Record<string, number> = {};
	try {
		sett = JSON.parse(await fs.promises.readFile(fil, "utf-8"));
	} catch {
		// Finnes ikke ennå, eller er ulesbar. Begge betyr «ingen historikk».
	}

	const sist = sett[hash];
	if (typeof sist === "number" && now - sist < MESSAGE_DEDUPE_TTL_MS) {
		return true;
	}

	sett[hash] = now;
	// Rydd gamle oppføringer, ellers vokser fila gjennom hele økten.
	for (const [nøkkel, tid] of Object.entries(sett)) {
		if (now - tid > MESSAGE_DEDUPE_TTL_MS * 2) delete sett[nøkkel];
	}

	try {
		await ensureDir(getStateDir());
		await writeAtomic(fil, JSON.stringify(sett));
	} catch (error) {
		// Kan vi ikke skrive, mister vi dedupe — ikke meldingen.
		fileLogError("[Dedupe] Kunne ikke skrive dedupe-tilstand", error);
	}

	return false;
}

/**
 * Legg en melding i øktens buffer.
 *
 * Append-only JSONL, ikke les-endre-skriv. To prosesser som skriver samtidig
 * ville ellers overskrevet hverandre; med append taper ingen av dem.
 * Taket håndheves ved LESING, siden en trimming her ville krevd nettopp den
 * les-endre-skriv-syklusen formatet er valgt for å unngå.
 */
export async function appendMessage(
	sessionKey: string,
	role: "user" | "assistant",
	text: string
): Promise<void> {
	try {
		await ensureDir(getStateDir());
		const linje = `${JSON.stringify({ role, text })}\n`;
		await fs.promises.appendFile(bufferFile(sessionKey), linje);
	} catch (error) {
		fileLogError("[MsgBuf] Kunne ikke skrive meldingsbuffer", error);
	}
}

/**
 * Les øktens meldinger, nyeste sist, med takene håndhevet.
 */
export async function readMessages(
	sessionKey: string
): Promise<{ user: string[]; assistant: string[] }> {
	const user: string[] = [];
	const assistant: string[] = [];

	let innhold: string;
	try {
		innhold = await fs.promises.readFile(bufferFile(sessionKey), "utf-8");
	} catch {
		return { user, assistant };
	}

	for (const linje of innhold.split("\n")) {
		if (!linje.trim()) continue;
		try {
			const post = JSON.parse(linje) as { role?: string; text?: string };
			if (typeof post.text !== "string") continue;
			if (post.role === "user") user.push(post.text);
			else if (post.role === "assistant") assistant.push(post.text);
		} catch {
			// En avkortet siste linje er forventet hvis prosessen døde midt i
			// en append. Resten av fila er fortsatt gyldig.
		}
	}

	return {
		user: user.slice(-MAX_USER_MESSAGES),
		assistant: assistant.slice(-MAX_ASSISTANT_MESSAGES),
	};
}

/** Fjern øktens transiente filer. Kalles ved teardown. */
export async function clearMessages(sessionKey: string): Promise<void> {
	for (const fil of [bufferFile(sessionKey), dedupeFile(sessionKey)]) {
		try {
			await fs.promises.unlink(fil);
		} catch {
			// Fantes ikke. Det er sluttilstanden vi ville ha.
		}
	}
}

/**
 * Rydd transiente øktfiler ingen ryddet etter.
 *
 * Dedupe og buffere er caching. Dør en prosess uten teardown, blir filene
 * liggende, og uten dette samler STATE/ dem opp i det uendelige.
 */
export async function pruneStaleState(): Promise<number> {
	let fjernet = 0;
	try {
		const dir = getStateDir();
		const now = Date.now();
		for (const navn of await fs.promises.readdir(dir)) {
			if (!navn.startsWith("dedupe-") && !navn.startsWith("msgbuf-")) continue;
			const full = path.join(dir, navn);
			try {
				const stat = await fs.promises.stat(full);
				if (now - stat.mtimeMs > STALE_MS) {
					await fs.promises.unlink(full);
					fjernet++;
				}
			} catch {
				// Fila forsvant under oss, eller kan ikke leses. La den være.
			}
		}
	} catch {
		// STATE/ finnes ikke ennå.
	}
	return fjernet;
}
