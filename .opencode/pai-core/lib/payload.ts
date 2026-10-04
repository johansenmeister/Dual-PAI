/**
 * PAI Core — lesing av upålitelige payloads
 *
 * Alt som kommer fra en motor, fra disk eller fra et eksternt API er
 * `unknown` til det er sjekket. Hjelperne her er narrowingen: de tar en
 * verdi uten løfter og gir tilbake en med, og de kaster aldri.
 *
 * Hvorfor `unknown` og ikke `any`: `any` slår av typesjekken på hvert
 * brukssted, og formene som ankommer er for det meste UMÅLTE —
 * `@opencode-ai`-typene tok feil tre ganger på ett døgn, og v2 er en total
 * omskriving av plugin-flaten. `unknown` tvinger valget fram der verdien
 * leses, og `tsc`-gaten i `bun test` feiler hvis det glemmes.
 *
 * Mønsteret kom fra v1s `dispatch/message-text.ts` (slettet med v1), der det lukket M-12.
 *
 * Importerer ingen motor.
 *
 * @module pai-core/lib/payload
 */

/**
 * `unknown` → oppslagbart objekt, uten å påstå noe om feltene.
 *
 * Castet er trygt fordi alle verdier er `unknown`: den lover ingenting den
 * ikke kan holde. Alt som ikke er et objekt blir `{}`, så oppslag gir
 * `undefined` framfor å kaste — som er nøyaktig det `message?.content`
 * gjorde før, bare uten at typen forsvant.
 */
export function somObjekt(verdi: unknown): Record<string, unknown> {
	return typeof verdi === "object" && verdi !== null ? (verdi as Record<string, unknown>) : {};
}

/**
 * Tom streng for alt som ikke ER en streng.
 *
 * `any`-versjonen av dette mønsteret gjorde `a || b || ""`, som slapp
 * gjennom en hvilken som helst truthy verdi og lot den stringifiseres
 * senere. Med `unknown` må valget tas eksplisitt, og tom streng er det
 * trygge: `[object Object]` i en fil er verre enn ingenting.
 */
export function somTekst(verdi: unknown): string {
	return typeof verdi === "string" ? verdi : "";
}

/** Tom liste for alt som ikke ER en liste. Elementene forblir `unknown`. */
export function somListe(verdi: unknown): unknown[] {
	return Array.isArray(verdi) ? verdi : [];
}
