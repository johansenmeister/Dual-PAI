/**
 * Claude-adapter — hvilken prosess eier økten?
 *
 * Reaperen i `pai-core/dispatch/session.ts` er korrekthetsgarantien i hele
 * teardown-kjeden, og den hviler på ett spørsmål: lever prosessen som eide
 * arbeidsøkten? Under OpenCode er svaret `process.pid`, fordi pluginen bor i
 * motorprosessen hele økten. Under Claude Code er det feil svar — hver hook
 * er sin egen kortlivede prosess.
 *
 * Slekten er MÅLT 2026-09-21 mot Claude Code 2.1.278:
 *
 *   dybde=1  pid=40131  comm=bash    ← hook-skriptet
 *   dybde=2  pid=40130  comm=sh      ← /bin/sh -c "${CLAUDE_PLUGIN_ROOT}/..."
 *   dybde=3  pid=40105  comm=claude  ← MOTORPROSESSEN
 *   dybde=4  pid=40103  comm=timeout
 *   dybde=5  pid=40096  comm=bash
 *   dybde=6  pid=39485  comm=claude  ← en HELT ANNEN claude-økt
 *
 * Dybde 6 er grunnen til at vi tar den FØRSTE treffet oppover og stopper der.
 * Leter vi videre, eller tar vi det siste, kan en nøstet økt ende opp med å
 * registrere en annen økts prosess som sin eier.
 *
 * @module claude-plugin/owner
 */

import { readFileSync } from "node:fs";

/** Hvor mange ledd oppover vi leter. Målt avstand er 2; taket er slark. */
const MAX_DYBDE = 8;

/** `comm` i /proc er avkortet til 15 tegn. «claude» er godt innenfor. */
const MOTOR_COMM = "claude";

interface ProsessInfo {
	pid: number;
	comm: string;
	ppid: number;
	/** Felt 22 i /proc/<pid>/stat. Vakt mot PID-gjenbruk. */
	start: string | undefined;
}

/**
 * Les én linje fra `/proc/<pid>/stat`.
 *
 * Parsingen starter etter SISTE `)`, ikke ved første mellomrom:
 * prosessnavnet står i parenteser og kan selv inneholde både mellomrom og
 * parenteser. Samme grunn som i `pai-core/lib/paths.ts:readProcessStart`.
 *
 * Returnerer null utenfor Linux, eller når prosessen er borte.
 */
function lesProsess(pid: number): ProsessInfo | null {
	let stat: string;
	try {
		stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
	} catch {
		return null;
	}

	const startParentes = stat.indexOf("(");
	const sluttParentes = stat.lastIndexOf(")");
	if (startParentes === -1 || sluttParentes <= startParentes) return null;

	const comm = stat.slice(startParentes + 1, sluttParentes);
	const felter = stat.slice(sluttParentes + 2).split(" ");
	// Etter `)` er indeks 0 felt 3 (state). ppid er felt 4 → indeks 1,
	// starttime er felt 22 → indeks 19.
	const ppid = Number.parseInt(felter[1] ?? "", 10);
	if (!Number.isInteger(ppid)) return null;

	return { pid, comm, ppid, start: felter[19] };
}

/**
 * Finn motorprosessen ved å gå oppover i slekten fra oss selv.
 *
 * @returns PID og `starttime` til nærmeste forfar som er en claude-prosess,
 *   eller `null` når ingen finnes. `null` er et gyldig svar, ikke en feil:
 *   kaller-siden skriver da ingen pid, og reaperen faller tilbake på
 *   alderssjekken. Se bootstrap.ts.
 */
export function finnMotorprosess(fra: number = process.pid): { pid: number; start?: string } | null {
	let pid = fra;

	for (let dybde = 0; dybde < MAX_DYBDE; dybde++) {
		const info = lesProsess(pid);
		if (!info) return null;

		// Ikke oss selv: hook-prosessen kan i prinsippet hete claude om noen
		// kjører dispatcheren gjennom en wrapper med det navnet, og da ville
		// vi registrert en prosess som dør om et øyeblikk.
		if (dybde > 0 && info.comm === MOTOR_COMM) {
			return { pid: info.pid, start: info.start };
		}

		// pid 1 er init, 0 finnes ikke. Er vi der, er det ingen motor over oss.
		if (info.ppid <= 1) return null;
		pid = info.ppid;
	}

	return null;
}
