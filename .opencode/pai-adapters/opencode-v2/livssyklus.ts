/**
 * v2-adapteren — sesjonens livssyklus (fase 4)
 *
 * v2 sier ikke fra når en hovedøkt starter, og ingen hendelse betyr «økten er
 * over» (MÅLT, fase 0):
 *
 *   start   `session.created` kom KUN for subagenters barneøkter, aldri for
 *           hovedøkten. Første `session.prompt` per `sessionID` er kilden.
 *   slutt   `session.execution.succeeded` er turslutt, og `session.deleted`
 *           er sletting fra historikken. Ingen av dem er teardown (H-17).
 *           Det som finnes, er pluginens cleanup-funksjon: i `--standalone`
 *           kjørte den ved normal slutt, SIGINT og SIGKILL av CLI-en (M4).
 *
 * MEN CLEANUP ER IKKE BARE NEDSTENGING. v2 laster pluginen på nytt i samme
 * prosess når innholdet i en fil den importerer endres, også i `pai-core`
 * (MÅLT 2026-09-25: ~2 s etter endringen, samme pid, og ikke ved et rent
 * `touch`). Da kalles cleanup for den
 * gamle instansen midt i økten, UTEN `location.shutdown` på bussen. Ved ekte
 * nedstenging kom `location.shutdown` før cleanup (38 ms før, målt). Teardown
 * ved omlasting ville fullført en levende økt, og neste prompt ville fått en
 * ny arbeidskatalog — H-17 på nytt, utløst av en `git pull`.
 *
 * Derfor kjører cleanup teardown BARE når nedstengingen er meldt. Uten
 * signalet står øktene, og det er den fail-safe retningen: dør prosessen
 * likevel, har tilstandsfila en død eier, og reaperen tar den ved neste
 * oppstart. Sent, men ikke tapt.
 *
 * Eieren er `process.pid`, altså den private serveren (B5). Drepes selve
 * serveren, kjører ingen cleanup, og da er reaperen korrekthetsgarantien —
 * som i v1.
 *
 * Holdt fri for motor-API, så den kan testes med funksjoner alene. Indeksen
 * eier dispatch og bussen; denne eier bare hvilke økter som er startet.
 *
 * @module pai-adapters/opencode-v2/livssyklus
 */

import { fileLog, fileLogError } from "../../pai-core/lib/file-logger";

/**
 * Hvor lenge cleanup får bruke på teardown før den gir opp.
 *
 * v2 awaiter cleanup-funksjonen før serveren stenger (MÅLT 2026-09-25: uten
 * `await` på teardown sto øktene ACTIVE etter normal slutt, SIGINT og SIGKILL
 * av CLI-en). En teardown som henger, ville altså hengt nedstengingen, og
 * brukeren ville sittet med en CLI som ikke avslutter.
 */
export const SLUTT_FRIST_MS = 10_000;

/**
 * Hvor lenge cleanup venter på `location.shutdown` når den ikke er sett ennå.
 *
 * Ved nedstenging kom hendelsen 38 ms før cleanup (MÅLT), men bussen leveres
 * asynkront. Ved omlasting kommer den aldri, så dette er prisen per omlasting.
 */
export const NEDSTENGING_VENT_MS = 500;

export interface Livssyklusvalg {
	/** Reaperen, startet ved plugin-last. Første prompt venter på den. */
	rydding: Promise<unknown>;
	/** Send `session.start` for økten. */
	start: (sessionId: string) => Promise<unknown>;
	/** Send `session.end` for økten. */
	slutt: (sessionId: string) => Promise<unknown>;
	fristMs?: number;
	nedstengingVentMs?: number;
}

export class Livssyklus {
	/** Hovedøkter startet i denne instansen, med sitt `session.start`. */
	private readonly startet = new Map<string, Promise<unknown>>();

	private meldStengt: () => void = () => {};
	private readonly stengt = new Promise<void>((løs) => {
		this.meldStengt = løs;
	});

	constructor(private readonly valg: Livssyklusvalg) {}

	/** `location.shutdown` er sett: neste cleanup er en ekte nedstenging. */
	nedstenging(): void {
		this.meldStengt();
	}

	/**
	 * Kalles for hver prompt fra en hovedøkt. Første gang per økt sendes
	 * `session.start`.
	 *
	 * Returnerer når REAPEREN er ferdig, ikke når `session.start` er det. Det
	 * første er en rekkefølge brukermeldingen trenger: gjenopptas en økt der
	 * serveren ble drept, ligger dens gamle tilstandsfil der med en død eier.
	 * Uten ventingen ville reaperen fullført økten mens `user.message` skrev i
	 * den.
	 *
	 * `session.start` venter derimot ingen på. Den gjør en versjonssjekk mot
	 * GitHub med fem sekunders tidsavbrudd, og det skal ikke ligge foran
	 * brukerens første modellkall. Cleanup venter på den i stedet.
	 *
	 * Etter en omlasting sendes `session.start` på nytt for en økt den gamle
	 * instansen startet. Det er ufarlig: arbeidsøkten leses fra disk, så
	 * meldingen havner i samme katalog.
	 */
	async prompt(sessionId: string): Promise<void> {
		await this.valg.rydding;
		// Sjekk og sett uten `await` imellom, så to samtidige prompts i samme
		// økt ikke begge starter den.
		if (!sessionId || this.startet.has(sessionId)) return;
		fileLog(`[v2] session.start for ${sessionId} (første prompt, pid ${process.pid})`, "info");
		this.startet.set(
			sessionId,
			this.valg.start(sessionId).catch((error) => {
				fileLogError(`[v2] session.start feilet for ${sessionId}`, error);
			})
		);
	}

	/**
	 * Pluginens cleanup: ved nedstenging `session.end` for hver økt denne
	 * instansen har startet, én om gangen, innenfor `SLUTT_FRIST_MS`.
	 *
	 * Øktene tas ut FØR noe awaites, så et nytt kall ikke avslutter dem to
	 * ganger. Et `session.start` som fortsatt kjører, får bli ferdig først:
	 * ellers kunne startens rydding og teardown gått i hverandre.
	 *
	 * Reaperen awaites også, selv uten økter. Den kjører full teardown for
	 * foreldreløse økter, og en server som stenger midt i den, etterlater en
	 * halvveis fullført økt. Og i en test ville en reaper som overlevde fila,
	 * lest `STATE/` etter at `PAI_HOME` var satt tilbake — det EKTE treet.
	 */
	async slutt(): Promise<void> {
		const økter = [...this.startet.entries()];
		this.startet.clear();
		const frist = this.valg.fristMs ?? SLUTT_FRIST_MS;

		const arbeid = (async () => {
			await this.valg.rydding;
			for (const [, start] of økter) await start;
			if (økter.length === 0) return true;

			const stenger = await Promise.race([
				this.stengt.then(() => true),
				new Promise<false>((løs) => setTimeout(() => løs(false), this.valg.nedstengingVentMs ?? NEDSTENGING_VENT_MS)),
			]);
			if (!stenger) {
				fileLog(
					`[v2] cleanup uten location.shutdown — omlasting, ikke nedstenging. ` +
						`${økter.length} økt(er) lever videre; reaperen tar dem hvis prosessen dør`,
					"info"
				);
				return true;
			}

			for (const [sessionId] of økter) {
				await this.valg.slutt(sessionId).catch((error) => {
					fileLogError(`[v2] session.end feilet for ${sessionId}`, error);
				});
			}
			return true;
		})();

		let tidtaker: ReturnType<typeof setTimeout> | undefined;
		const fristUt = new Promise<false>((løs) => {
			tidtaker = setTimeout(() => løs(false), frist);
		});
		const ferdig = await Promise.race([arbeid, fristUt]);
		clearTimeout(tidtaker);
		if (!ferdig) {
			fileLog(
				`[v2] teardown rakk ikke fram innen ${frist} ms — reaperen tar resten ved neste oppstart`,
				"warn"
			);
		}
	}
}
