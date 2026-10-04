/**
 * PAI Core — parsing av PAI-responsformatet
 *
 * Algoritmen krever at hvert svar avsluttes med en talelinje:
 *
 *     🗣️ <DA-navnet>: én setning som oppsummerer hva som ble gjort
 *
 * Linja het «voice completion» og bodde i `voice-notification.ts`, fordi den
 * første konsumenten var TTS. Da voice ble fjernet, viste det seg at den
 * hadde to konsumenter til: terminalfanens tittel og observability-flagget
 * `has_voice_line`. Parsingen er altså en egenskap ved RESPONSFORMATET, ikke
 * ved talesyntese, og hører hjemme her.
 *
 * Importerer ingen motor.
 *
 * @module pai-core/lib/response-format
 */

/**
 * Hent ut talelinja fra et assistentsvar.
 *
 * Unicode-bevisst i navnedelen med vilje: DA-navnet er brukerkonfigurerbart
 * (`identity.ts`), og et navn med aksent eller ikke-ASCII-tegn skal ikke
 * gjøre linja usynlig.
 *
 * @returns Selve setningen uten prefiks, eller null når svaret ikke har en.
 */
export function extractSpokenLine(text: string): string | null {
	if (!text) return null;

	// Mønster: 🗣️ Navn: melding
	const match = text.match(/🗣️\s*[\p{L}\p{M}\w\s\-.']+:\s*(.+?)(?:\n|$)/u);
	return match ? match[1].trim() : null;
}
