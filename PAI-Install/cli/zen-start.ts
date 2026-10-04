#!/usr/bin/env bun
/**
 * zen-start.ts — velg gratismodellen det første oppsettet kjører med (#162)
 *
 * `install.sh` starter kjøreplanen i v2 med en gratis Zen-modell, så en ny
 * bruker trenger verken nøkkel eller abonnement for å komme i gang (MÅLT
 * 2026-10-04: v2 2.0.18 svarer med `opencode/<modell>-free` uten `/connect`).
 * Dette verktøyet velger modellen og skriver den inn i `opencode.json`, som
 * standard og for hver agent. Etterpå velger brukeren selv, i kjøreplanen.
 *
 * Tre ting er målt og styrer formen:
 *
 * - **Vilkårene, ikke lista, bestemmer rekkefølgen.** Identitetsintervjuet
 *   spør etter navn og tidssone. Zens personvernside (lest 2026-10-04) sier at
 *   bare LongCat 2.5 Preview Free og Space Bunny Free har nulllagring og ingen
 *   trening; de andre gratismodellene bruker dataene til å forbedre modellen,
 *   og Nemotron sier «do not submit personal or confidential data». Andre
 *   modeller brukes bare med `--allow-other`, som `install.sh` spør om først.
 * - **Den levende lista lyver.** `deepseek-v4-flash-free` sto i
 *   `zen/v1/models` og ga `provider.no-route`. Hver kandidat prøves derfor med
 *   en ekte `run` før den velges.
 * - **Modellen må settes.** Uten `model` i konfigen valgte v2 en modell som
 *   svarte 403 «not available in your country».
 *
 * Bruk:
 *   bun PAI-Install/cli/zen-start.ts                 # velg og skriv
 *   bun PAI-Install/cli/zen-start.ts --allow-other   # tillat modeller som bruker dataene
 *   bun PAI-Install/cli/zen-start.ts --model <id>    # prøv og skriv akkurat denne
 *   bun PAI-Install/cli/zen-start.ts --dry-run       # velg, men skriv ikke
 *
 * Exitkoder: 0 valgt (id-en på stdout), 1 feil, 2 ingen modell med
 * nulllagring svarte (prøv igjen med `--allow-other`).
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Gratismodellene med nulllagring og ingen trening, i prioritert rekkefølge. */
export const NULLLAGRING: readonly string[] = ["longcat-2.5-preview-free", "space-bunny-free"];

export const ZEN_MODELLER_URL = "https://opencode.ai/zen/v1/models";
export const ZEN_PERSONVERN_URL = "https://opencode.ai/docs/zen/#privacy";

const REPO = join(import.meta.dir, "..", "..");

/**
 * Kandidatene i rekkefølge: nulllagring først, i `NULLLAGRING`s rekkefølge,
 * deretter (bare med `tillatAndre`) de andre gratismodellene i lista.
 * En tom levende liste gir nulllagringsmodellene likevel: lista kan mangle
 * fordi nettet hikket, og prøven avgjør uansett.
 */
export function kandidater(levende: string[], tillatAndre: boolean): string[] {
	const gratis = levende.filter((id) => id.endsWith("-free"));
	const trygge = NULLLAGRING.filter((id) => gratis.length === 0 || gratis.includes(id));
	if (!tillatAndre) return [...trygge];
	return [...trygge, ...gratis.filter((id) => !trygge.includes(id))];
}

/** Sett `model` og hver `agent.<navn>.model` til `opencode/<id>`. Resten står. */
export function medModell(konfig: Record<string, unknown>, id: string): Record<string, unknown> {
	const modell = `opencode/${id}`;
	const ut: Record<string, unknown> = { ...konfig, model: modell };
	const agenter = konfig.agent;
	if (agenter && typeof agenter === "object") {
		const nye: Record<string, unknown> = {};
		for (const [navn, a] of Object.entries(agenter as Record<string, unknown>)) {
			nye[navn] = a && typeof a === "object" ? { ...(a as Record<string, unknown>), model: modell } : a;
		}
		ut.agent = nye;
	}
	return ut;
}

/** Svarte modellen? Utdataen fra `run --format json` har en `text`-del og ingen `error`. */
export function svarte(stdout: string): boolean {
	let tekst = false;
	for (const linje of stdout.split("\n")) {
		let h: { type?: string; part?: { text?: string } };
		try {
			h = JSON.parse(linje);
		} catch {
			continue;
		}
		if (h.type === "error") return false;
		if (h.type === "text" && (h.part?.text ?? "").trim().length > 0) tekst = true;
	}
	return tekst;
}

async function levendeListe(): Promise<string[]> {
	try {
		const svar = await fetch(ZEN_MODELLER_URL, { signal: AbortSignal.timeout(15_000) });
		const data = (await svar.json()) as { data?: { id: string }[] };
		return (data.data ?? []).map((m) => m.id);
	} catch {
		return [];
	}
}

/**
 * Én ekte `run` mot modellen, i en tom katalog så prosjektets konfig og PAI
 * ikke lastes. Alltid `--standalone` og aldri `--auto` (B6); stdin fra
 * `/dev/null`, ellers kan `run` henge (MÅLT, fase 0).
 */
async function prøv(binær: string, id: string): Promise<boolean> {
	const tom = mkdtempSync(join(tmpdir(), "pai-zen-start-"));
	try {
		const proc = Bun.spawn(
			[binær, "run", "--standalone", "--model", `opencode/${id}`, "--format", "json", "Reply with the single word: ok"],
			{ cwd: tom, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
		);
		const vakt = setTimeout(() => proc.kill("SIGKILL"), 120_000);
		const stdout = await new Response(proc.stdout as ReadableStream).text();
		await proc.exited;
		clearTimeout(vakt);
		return proc.exitCode === 0 && svarte(stdout);
	} finally {
		rmSync(tom, { recursive: true, force: true });
	}
}

async function main(): Promise<number> {
	const args = process.argv.slice(2);
	const tillatAndre = args.includes("--allow-other");
	const tørr = args.includes("--dry-run");
	const i = args.indexOf("--model");
	const valgt = i >= 0 ? args[i + 1] : undefined;
	if (i >= 0 && !valgt) {
		console.error("--model needs a model id, e.g. longcat-2.5-preview-free");
		return 1;
	}

	const binær = join(REPO, ".opencode", "node_modules", "@opencode", "cli", "bin", "opencode.exe");
	const liste = valgt ? [valgt.replace(/^opencode\//, "")] : kandidater(await levendeListe(), tillatAndre);

	for (const id of liste) {
		process.stderr.write(`  trying opencode/${id} … `);
		if (!(await prøv(binær, id))) {
			process.stderr.write("no answer\n");
			continue;
		}
		process.stderr.write("ok\n");
		if (!tørr) {
			// `.opencode/opencode.json` er en lenke til roten; skriv den ekte fila.
			const fil = realpathSync(join(REPO, "opencode.json"));
			const konfig = JSON.parse(readFileSync(fil, "utf-8"));
			writeFileSync(fil, `${JSON.stringify(medModell(konfig, id), null, 2)}\n`);
		}
		console.log(`opencode/${id}`);
		return 0;
	}

	if (valgt) return 1;
	console.error(
		tillatAndre
			? "No free Zen model answered. Check the network, then run install.sh again."
			: `No zero-retention free model answered. Other free models may use your data (${ZEN_PERSONVERN_URL}).`,
	);
	return tillatAndre ? 1 : 2;
}

if (import.meta.main) process.exit(await main());
