/**
 * Data i en skallkommando (#322, jobb #6)
 *
 * Sikkerhetsvaktas mønstre ble matchet mot hele kommandoteksten, også det som
 * bare er tekst. En økt på jobb som skrev «cat av .env blokkert» inn i en PRD
 * med en heredoc, og en refleksjon med «(cat .env, rm -rf)» i `--q3`, ble
 * stoppet som om den leste `.env`, og måtte omformulere for å slippe gjennom
 * (2026-10-06). `utenData` gir kommandoen med de delene tømt som skallet
 * garantert ikke kjører, og vakta matcher mot den.
 *
 * Bare to former regnes som data, og bare når det er sikkert:
 *
 * - **Kroppen til en heredoc med sitert skilletegn** (`<<'EOF'`, `<<"EOF"`,
 *   `<<\EOF`) som går til `cat` eller `tee` uten rør. Sitert skilletegn betyr
 *   ingen utvidelse, så `$(…)` i kroppen er bokstavelig. `cat <<EOF`, `bash
 *   <<'EOF'` og `cat <<'EOF' | sh` matches som før.
 * - **Siterte argumenter til et verktøy som bare lagrer teksten**
 *   (`TEKSTVERKTØY`). Enkle anførselstegn alltid; doble bare uten `$(` eller
 *   backtick. Går verktøyets utdata i et rør, er argumentene ikke data lenger.
 *
 * Alt annet står urørt. `ssh vert 'cat …/.env'` er en kommando i anførselstegn,
 * ikke data, og blokkeres fortsatt.
 *
 * @module skalldata
 */

/**
 * PAI-verktøy der argumentene bare skrives til en logg. Et verktøy som kjører,
 * sender eller tolker argumentene sine, hører ikke hjemme her.
 */
const TEKSTVERKTØY =
	/^\s*(?:\w+=\S*\s+)*bun\s+(?:run\s+)?\S*\b(?:WriteReflection|RecordMitigation)\.ts["']?(?=\s|$)/;

/** `cat`/`tee` med en heredoc med sitert skilletegn, og ingen rør etter. */
const HEREDOC_TIL_FIL =
	/(?:^|[;&(])\s*(?:cat|tee(?:\s+-a)?)\b[^|;&\n<]*<<(-?)\s*(?:'([\w.-]+)'|"([\w.-]+)"|\\([\w.-]+))[^|;&\n<]*$/;

function utenHeredocKropp(kommando: string): string {
	const linjer = kommando.split("\n");
	const ut: string[] = [];
	for (let i = 0; i < linjer.length; i++) {
		ut.push(linjer[i]);
		const m = HEREDOC_TIL_FIL.exec(linjer[i]);
		if (!m) continue;
		const ord = m[2] ?? m[3] ?? m[4];
		const tabber = m[1] === "-";
		const slutt = linjer.findIndex(
			(l, j) => j > i && (tabber ? l.replace(/^\t+/, "") : l) === ord
		);
		// Uten avslutning vet vi ikke hvor kroppen slutter: la alt stå.
		if (slutt < 0) continue;
		ut.push(linjer[slutt]);
		i = slutt;
	}
	return ut.join("\n");
}

/** Indeksen til det avsluttende anførselstegnet, eller -1. */
function sitatSlutt(tekst: string, start: number): number {
	const tegn = tekst[start];
	for (let i = start + 1; i < tekst.length; i++) {
		if (tegn === '"' && tekst[i] === "\\") i++;
		else if (tekst[i] === tegn) return i;
	}
	return -1;
}

/**
 * Kommandoen med datadelene tømt: heredoc-kroppen fjernet, siterte argumenter
 * til et tekstverktøy erstattet med tomme anførselstegn.
 */
export function utenData(kommando: string): string {
	const tekst = utenHeredocKropp(kommando);
	let ut = "";
	// Segmentet er kommandoen siden forrige skilletegn, rått og tømt.
	let rå = "";
	let tømt = "";
	for (let i = 0; i < tekst.length; i++) {
		const c = tekst[i];
		if (c === "\\") {
			rå += tekst.slice(i, i + 2);
			tømt += tekst.slice(i, i + 2);
			i++;
			continue;
		}
		if (c === "'" || c === '"') {
			const slutt = sitatSlutt(tekst, i);
			if (slutt < 0) {
				rå += tekst.slice(i);
				tømt += tekst.slice(i);
				break;
			}
			const sitat = tekst.slice(i, slutt + 1);
			const data = TEKSTVERKTØY.test(tømt) && (c === "'" || !/\$\(|`/.test(sitat));
			rå += sitat;
			tømt += data ? c + c : sitat;
			i = slutt;
			continue;
		}
		if (";|&\n(".includes(c)) {
			// Et rør (ikke `||`) gir utdata videre: da gjelder den rå teksten.
			const rør = c === "|" && tekst[i + 1] !== "|" && tekst[i - 1] !== "|";
			ut += (rør ? rå : tømt) + c;
			rå = "";
			tømt = "";
			continue;
		}
		rå += c;
		tømt += c;
	}
	return ut + tømt;
}
