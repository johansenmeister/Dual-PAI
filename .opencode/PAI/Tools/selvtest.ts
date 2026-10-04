/**
 * Selvtesten for OpenCode v2 — det launcheren sjekker før motoren starter
 *
 * Laget mellom utviklingsvaktene (`bun test`, `V2Smoke`) og en doctor på
 * forespørsel: harnesset merker SELV at noe må gjøres, og sier fra med én
 * linje og kommandoen som retter det. Mønsteret er stale-vakten for Claudes
 * hook-binær (`claude-plugin/src/binaer.ts`), og de samme fire reglene gjelder
 * (handoverens «Rammen»):
 *
 *   1. Taus når alt er i orden. En sjekk som roper feil, er verre enn ingen
 *      (M-23/M-24), så hver sjekk er testet i begge retninger.
 *   2. Reparerer ingenting. Den rapporterer kommandoen.
 *   3. Erstatter ikke røyktesten, men sier fra når den må kjøres (K4).
 *   4. Billig: ingen prosesser startes i det vanlige tilfellet. `opencode.exe
 *      --version` koster 300 ms (MÅLT 2026-09-26), så den installerte
 *      versjonen leses fra pakkens `package.json`, ikke fra binæren.
 *
 * Fire sjekker, alle fra funn i v2-prosjektet og jobb-overgangen:
 *
 *   K9   binæren er en plassholder, ikke en kjørbar binær (fase 7). STOPPER.
 *   K11  en v1-binær finnes på maskinen, og starter den, lager den K9 (fase 7).
 *   K4   installert ≠ pinnet, eller `V2Smoke` er ikke kjørt grønt mot den
 *        pinnede versjonen. v2 validerer ikke hooknavn, så en bump uten
 *        røyktest er stum (B3, krav 1).
 *   K27  rester i en `plugins/`-katalog v2 laster fra, typisk v1s
 *        `pai-unified.ts` etter en overgang (jobb-fase 4).
 *   K13  adapteren er endret siden `V2Smoke` var grønn. Kvitteringen har en
 *        hash av adapterfilene, ikke bare versjonen.
 *
 * K40 (launcheren bygger fra et annet tre enn sitt eget) gjelder begge
 * motorene, og kalles av launcheren selv (`sjekkTreet`).
 *
 * K6 (en agent som ikke kan spawnes som subagent) krever motorens egen
 * agentliste og står i adapteren (`pai-adapters/opencode-v2/selvtest.ts`).
 *
 * For Claude Code (`selvtestClaude`): C1, installert er den pinnede versjonen og
 * selvoppdateringen er av, og C2, `ClaudeSmoke` er kjørt grønt mot pinningen
 * og mot pluginens kode slik den er nå (K36).
 *
 * @module PAI/Tools/selvtest
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

/** v2-binæren, pinnet i `.opencode/package.json` (B3). Samme sti som launcheren bruker. */
function binærSti(opencodeDir: string): string {
	return join(opencodeDir, "node_modules", "@opencode", "cli", "bin", "opencode.exe");
}

// ============================================================================
// K9 — binæren er en ekte binær
// ============================================================================

/**
 * De første bytene til en kjørbar binær: ELF (Linux), Mach-O i begge
 * byterekkefølger og som fat-binær (macOS), og PE (Windows).
 *
 * Plassholderen `bun install` legger igjen uten `postinstall` er 229 byte
 * tekst (MÅLT, fase 7). `existsSync` sier at den finnes, og `spawn` dør med
 * `ENOEXEC` og en stacktrace.
 */
const MAGI: readonly (readonly number[])[] = [
	[0x7f, 0x45, 0x4c, 0x46],
	[0xfe, 0xed, 0xfa, 0xce],
	[0xfe, 0xed, 0xfa, 0xcf],
	[0xce, 0xfa, 0xed, 0xfe],
	[0xcf, 0xfa, 0xed, 0xfe],
	[0xca, 0xfe, 0xba, 0xbe],
	[0x4d, 0x5a],
];

/** Starter fila med magien til en kjørbar binær? Leser fire byte, følger symlenker. */
export function erKjørbarBinær(sti: string): boolean {
	let fd: number | undefined;
	try {
		fd = openSync(sti, "r");
		// Ingen lengdesjekk: bufferen er nullfylt, og ingen magi har en
		// 0-byte, så en fil kortere enn magien kan ikke treffe.
		const buf = Buffer.alloc(4);
		readSync(fd, buf, 0, 4, 0);
		return MAGI.some((m) => m.every((b, i) => buf[i] === b));
	} catch {
		return false;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/**
 * Kan binæren startes? `null` når den kan, ellers meldingen launcheren
 * avslutter med.
 *
 * Reparasjonen er den MÅLTE: en vanlig `bun install` retter ikke
 * plassholderen, `rm -rf node_modules/@opencode/cli && bun install` gjør det.
 */
export function sjekkBinær(opencodeDir: string): string | null {
	const bin = binærSti(opencodeDir);
	const reparer = `Run: cd ${opencodeDir} && rm -rf node_modules/@opencode/cli && bun install`;
	if (!existsSync(bin)) return `The v2 binary is missing: ${bin}\n${reparer}`;
	if (!erKjørbarBinær(bin)) {
		return `The v2 binary is not executable (a placeholder from an install without postinstall?): ${bin}\n${reparer}`;
	}
	return null;
}

// ============================================================================
// K4 — installert er pinnet, og røyktesten er kjørt mot den
// ============================================================================

/**
 * Kvitteringen `V2Smoke` skriver når ALT er grønt. Sporet i git, fordi den
 * gjelder den pinnede versjonen i repoet og ikke maskinen: én grønn røyktest
 * dekker alle maskinene som puller bumpen, og en bump som committes uten ny
 * kvittering, står igjen som en avvikende versjon.
 */
export interface Kvittering {
	versjon: string;
	dato: string;
	hooks: number;
	sjekker: number;
	/** `adapterHash` av koden røyktesten kjørte mot (K13, K36). */
	adapter?: string;
	/**
	 * Merknadene fra de grønne sjekkene (K55), som en ny nøkkel i et verktøykall
	 * (K54). Står bare når det finnes noen, så en kjøring uten gir ingen diff.
	 * Selvtesten leser dem ikke: de er for den som ser på diffen ved en bump.
	 */
	merknader?: string[];
}

export function kvitteringSti(opencodeDir: string): string {
	return join(opencodeDir, "v2smoke-kvittering.json");
}

function lesJson(sti: string): Record<string, unknown> | null {
	try {
		const v: unknown = JSON.parse(readFileSync(sti, "utf-8"));
		return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** Pinnet `@opencode/cli` i `.opencode/package.json`, eller null. */
export function pinnetVersjon(opencodeDir: string): string | null {
	const deps = lesJson(join(opencodeDir, "package.json"))?.dependencies;
	const v = deps !== null && typeof deps === "object" ? (deps as Record<string, unknown>)["@opencode/cli"] : undefined;
	return typeof v === "string" ? v : null;
}

/** Installert `@opencode/cli`, fra pakkens `package.json`. Null når den mangler. */
export function installertVersjon(opencodeDir: string): string | null {
	const v = lesJson(join(opencodeDir, "node_modules", "@opencode", "cli", "package.json"))?.version;
	return typeof v === "string" ? v : null;
}

function lesKvitteringFra(sti: string): Kvittering | null {
	const k = lesJson(sti);
	if (!k || typeof k.versjon !== "string") return null;
	return {
		versjon: k.versjon,
		dato: typeof k.dato === "string" ? k.dato : "?",
		hooks: typeof k.hooks === "number" ? k.hooks : 0,
		sjekker: typeof k.sjekker === "number" ? k.sjekker : 0,
		...(typeof k.adapter === "string" ? { adapter: k.adapter } : {}),
		...(Array.isArray(k.merknader) && k.merknader.every((m) => typeof m === "string")
			? { merknader: k.merknader as string[] }
			: {}),
	};
}

export function lesKvittering(opencodeDir: string): Kvittering | null {
	return lesKvitteringFra(kvitteringSti(opencodeDir));
}

/** Skrives av `V2Smoke`, og bare når hver hook fyrte og hver sjekk holdt. */
export function skrivKvittering(opencodeDir: string, k: Kvittering): void {
	writeFileSync(kvitteringSti(opencodeDir), `${JSON.stringify(k, null, "\t")}\n`);
}

/**
 * Stemmer installert, pinnet og kvitteringen? Én linje per avvik.
 *
 * Installert mot pinnet først: etter en `git pull` av en bump er det den som
 * er feil, og kvitteringen stemmer allerede med den nye pinningen.
 */
export function sjekkPinning(opencodeDir: string, repoRot: string): string[] {
	const pinnet = pinnetVersjon(opencodeDir);
	if (!pinnet) return [];
	const varsler: string[] = [];

	const installert = installertVersjon(opencodeDir);
	if (installert && installert !== pinnet) {
		varsler.push(`v2 installed ${installert}, pinned ${pinnet}. Run: cd ${opencodeDir} && bun install`);
	}

	const k = lesKvittering(opencodeDir);
	const kjør = `Run: cd ${repoRot} && bun Tools/V2Smoke.ts`;
	if (k?.versjon !== pinnet) {
		varsler.push(
			`V2Smoke has not passed against v2 ${pinnet} (receipt: ${k ? `${k.versjon}, ${k.dato}` : "none"}). ` +
				`A hook that does not fire goes unnoticed. ${kjør}`
		);
	} else if (adapterEndret(k, adapterHash(opencodeDir, v2AdapterFiler(opencodeDir)))) {
		varsler.push(
			`V2Smoke has not passed against the adapter as it is now (pai-adapters/opencode-v2, ${adapterKilde(k)}). ` +
				`A hook binding that does not fire goes unnoticed. ${kjør}`
		);
	}
	return varsler;
}

// ============================================================================
// K13 og K36 — kvitteringen gjelder adapterkoden også
// ============================================================================

/**
 * Alle filer under `dir`, eller ingen når den mangler. Rekursivt, fordi
 * `claude-plugin/src/adapter/` er en underkatalog.
 */
function filerUnder(dir: string, ta: (navn: string) => boolean = () => true): string[] {
	try {
		return readdirSync(dir, { recursive: true, withFileTypes: true })
			.filter((d) => d.isFile() && ta(d.name))
			.map((d) => join(d.parentPath, d.name));
	} catch {
		return [];
	}
}

/**
 * Filene `V2Smoke` beviser (K13): hele v2-adapteren. Ikke `pai-core`: den
 * endres for ofte, og kontrakttestene i `bun test` dekker den.
 */
export function v2AdapterFiler(opencodeDir: string): string[] {
	return filerUnder(join(opencodeDir, "pai-adapters", "opencode-v2"));
}

/**
 * Filene `ClaudeSmoke` beviser (K36): pluginens egen kode og konfigen motoren
 * leser. Ikke det generatoren skriver (`skills/`, `agents/`, kartene): de
 * endres med hver skill, og `claude-mirror.test.ts` vokter dem. Ikke
 * `bin/pai-hook.bin` heller: den er bygget, gitignorert og 80 MB.
 */
export function claudeAdapterFiler(repoRot: string): string[] {
	const plugin = join(repoRot, "claude-plugin");
	return [
		...filerUnder(join(plugin, "src"), (n) => n.endsWith(".ts")),
		...filerUnder(join(plugin, "bin"), (n) => !n.endsWith(".bin")),
		...filerUnder(join(plugin, "mcp"), (n) => n.endsWith(".ts")),
		...[join(plugin, "hooks", "hooks.json"), join(plugin, ".mcp.json"), join(plugin, ".claude-plugin", "plugin.json")].filter(
			(f) => existsSync(f)
		),
	];
}

/**
 * sha256 over stien (relativ til `rot`, så den er lik på alle maskiner) og
 * innholdet til hver fil, sortert. Null når det ikke finnes noe å hashe eller
 * en fil ikke kan leses: da kan ingenting avgjøres, og selvtesten tier.
 */
export function adapterHash(rot: string, filer: string[]): string | null {
	if (filer.length === 0) return null;
	const h = createHash("sha256");
	try {
		for (const [rel, fil] of filer.map((f) => [relative(rot, f), f] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
			h.update(rel);
			h.update("\0");
			h.update(readFileSync(fil));
			h.update("\0");
		}
	} catch {
		return null;
	}
	return h.digest("hex");
}

/**
 * Er koden endret siden kvitteringen? En kvittering uten hash er fra før K13
 * og dekker ikke adapteren, så den teller som endret. Ukjent hash på disken:
 * nei (regel 1).
 */
function adapterEndret(k: Kvittering, nå: string | null): boolean {
	return nå !== null && k.adapter !== nå;
}

function adapterKilde(k: Kvittering): string {
	return k.adapter ? `receipt ${k.dato}` : `the receipt from ${k.dato} has no adapter hash`;
}

// ============================================================================
// C2 — Claude Code: røyktesten er kjørt mot installert versjon
// ============================================================================

/**
 * Kvitteringen `Tools/ClaudeSmoke.ts` skriver når ALT er grønt. Samme form og
 * samme regler som v2s (K4): sporet i git, og gjelder versjonen som ble testet.
 * K-10 viste hvorfor den trengs: Claude Code oppdaterer seg selv, og en ny
 * versjon kuttet PAI-konteksten uten at noe ble rødt.
 */
export function claudeKvitteringSti(opencodeDir: string): string {
	return join(opencodeDir, "claude-smoke-kvittering.json");
}

export function lesClaudeKvittering(opencodeDir: string): Kvittering | null {
	return lesKvitteringFra(claudeKvitteringSti(opencodeDir));
}

/** Skrives av `ClaudeSmoke`, og bare når hver hook fyrte og hver sjekk holdt. */
export function skrivClaudeKvittering(opencodeDir: string, k: Kvittering): void {
	writeFileSync(claudeKvitteringSti(opencodeDir), `${JSON.stringify(k, null, "\t")}\n`);
}

/** Hvordan `claude` kom på maskinen. Avgjør kommandoen som installerer en annen versjon. */
export type ClaudeForm = "installer" | "npm" | "apt" | "ukjent";

export interface InstallertClaude {
	versjon: string;
	form: ClaudeForm;
}

/**
 * Installert Claude Code, uten å starte noe når stien sier det: den offisielle
 * installeren lenker `claude` til `…/claude/versions/<versjon>` (MÅLT på
 * testmaskinen), og npm-pakken har versjonen i sin `package.json`. apt-pakken
 * `claude-code` er én binær i `/usr/bin/claude` (MÅLT i `.deb`-en 2026-09-27).
 * Bare en sti uten versjon koster en `claude --version` (25 ms, MÅLT
 * 2026-09-27). Null når `claude` ikke finnes eller ikke svarer.
 *
 * Samme rekkefølge som launcherens `resolveClaudeExecutable`: installerens
 * `~/.local/bin/claude` foran PATH, ellers sjekkes en annen binær enn den som
 * startes når både apt og installeren finnes. `HOME` fra `env`, så en test
 * aldri treffer brukerens egen.
 */
export function installertClaude(
	env: NodeJS.ProcessEnv = process.env,
	aptSti = "/usr/bin/claude"
): InstallertClaude | null {
	const lokal = env.HOME ? join(env.HOME, ".local", "bin", "claude") : null;
	const sti = lokal && existsSync(lokal) ? lokal : Bun.which("claude", { PATH: env.PATH ?? "" });
	if (!sti) return null;
	let ekte: string;
	try {
		ekte = realpathSync(sti);
	} catch {
		return null;
	}
	const fraSti = /\/versions\/(\d+\.\d+\.\d+)$/.exec(ekte)?.[1];
	if (fraSti) return { versjon: fraSti, form: "installer" };
	const npm = /^(.*\/@anthropic-ai\/claude-code)\//.exec(ekte)?.[1];
	if (npm) {
		const v = lesJson(join(npm, "package.json"))?.version;
		if (typeof v === "string") return { versjon: v, form: "npm" };
	}
	try {
		const r = Bun.spawnSync([ekte, "--version"], { stdin: "ignore", timeout: 2000 });
		const v = /(\d+\.\d+\.\d+)/.exec(r.stdout.toString())?.[1];
		return v ? { versjon: v, form: ekte === aptSti ? "apt" : "ukjent" } : null;
	} catch {
		return null;
	}
}

export function installertClaudeVersjon(env: NodeJS.ProcessEnv = process.env): string | null {
	return installertClaude(env)?.versjon ?? null;
}

/**
 * Pinnet Claude Code (C1): `pai.claudeCode` i `.opencode/package.json`, ved
 * siden av `@opencode/cli`. Ikke en avhengighet: `bun install` skal ikke hente
 * en binær på 240 MB, og installeren eier `~/.local/share/claude/versions/`.
 */
export function pinnetClaudeVersjon(opencodeDir: string): string | null {
	const pai = lesJson(join(opencodeDir, "package.json"))?.pai;
	const v = pai !== null && typeof pai === "object" ? (pai as Record<string, unknown>).claudeCode : undefined;
	return typeof v === "string" ? v : null;
}

/**
 * Kommandoen som installerer en bestemt versjon. MÅLT for installeren
 * (2026-09-27): `claude install <versjon>` henter den, flytter symlenken og
 * går også NED, også med `DISABLE_AUTOUPDATER=1`. apt-varianten er lest ut av
 * pakkekilden (hver versjon ligger der som `<versjon>-1`), ikke kjørt.
 */
export function claudeInstallKommando(form: ClaudeForm, versjon: string): string {
	if (form === "npm") return `npm install -g @anthropic-ai/claude-code@${versjon}`;
	if (form === "apt") {
		return `sudo apt install --allow-downgrades --allow-change-held-packages claude-code=${versjon}-1 && sudo apt-mark hold claude-code`;
	}
	return `claude install ${versjon}`;
}

/**
 * Er `ClaudeSmoke` kjørt grønt mot `versjon`? Taus når versjonen ikke lar seg
 * avgjøre: i tvil sier den ingenting (regel 1).
 */
export function sjekkClaudeRøyktest(opencodeDir: string, repoRot: string, versjon: string | null): string[] {
	if (!versjon) return [];
	const k = lesClaudeKvittering(opencodeDir);
	const kjør = `Run: cd ${repoRot} && bun Tools/ClaudeSmoke.ts`;
	if (k?.versjon !== versjon) {
		return [
			`ClaudeSmoke has not passed against Claude Code ${versjon} (receipt: ${k ? `${k.versjon}, ${k.dato}` : "none"}). ` +
				`A change in the engine goes unnoticed (K-10). ${kjør}`,
		];
	}
	if (adapterEndret(k, adapterHash(repoRot, claudeAdapterFiler(repoRot)))) {
		return [
			`ClaudeSmoke has not passed against the plugin as it is now (claude-plugin, ${adapterKilde(k)}). ` +
				`A hook binding that does not fire goes unnoticed. ${kjør}`,
		];
	}
	return [];
}

/**
 * C1, samme rekkefølge som K4: installert mot pinnet først, fordi det er den
 * som er feil etter en `git pull` av en bump, og kvitteringen gjelder da
 * allerede den nye pinningen. Uten pinning sammenlignes kvitteringen med
 * installert versjon, som før C1.
 */
export function sjekkClaudePinning(opencodeDir: string, repoRot: string, installert: InstallertClaude | null): string[] {
	const pinnet = pinnetClaudeVersjon(opencodeDir);
	if (!pinnet) return sjekkClaudeRøyktest(opencodeDir, repoRot, installert?.versjon ?? null);
	const varsler: string[] = [];
	if (installert && installert.versjon !== pinnet) {
		varsler.push(
			`Claude Code installed ${installert.versjon}, pinned ${pinnet}. Run: ${claudeInstallKommando(installert.form, pinnet)}`
		);
	}
	return [...varsler, ...sjekkClaudeRøyktest(opencodeDir, repoRot, pinnet)];
}

/**
 * Er selvoppdateringen av? MÅLT 2026-09-27 mot 2.1.282: `DISABLE_AUTOUPDATER=1`
 * i miljøet eller i `env` i en settings-fil gjør at «Checking for native
 * installer update» aldri kommer i debug-loggen; uten den kommer den innen ett
 * sekund. `pai claude sync` skriver den (`PatchClaudeSettings`). apt-pakken
 * oppdaterer seg ikke selv (bare `apt upgrade` gjør det), så der er den ikke
 * påkrevd. Ukjent eller ødelagt settings-fil gir ingenting (regel 1).
 */
export function sjekkAutoOppdatering(
	form: ClaudeForm | null,
	env: NodeJS.ProcessEnv = process.env,
	settings: string = join(homedir(), ".claude", "settings.json")
): string[] {
	if (!form || form === "apt" || env.DISABLE_AUTOUPDATER) return [];
	if (!existsSync(settings)) return [`Claude Code updates itself past the pin (${settings} does not exist). Run: pai claude sync`];
	const innhold = lesJson(settings);
	if (!innhold) return [];
	const e = innhold.env ?? {};
	if (typeof e !== "object" || e === null || "DISABLE_AUTOUPDATER" in e) return [];
	return [`Claude Code updates itself past the pin (DISABLE_AUTOUPDATER is missing in ${settings}). Run: pai claude sync`];
}

/**
 * Det `pai --claude` sjekker før Claude Code startes. `PAI_CLAUDE_BIN` er
 * overstyringen for testing (og røyktesten selv), og da gjelder ingenting.
 */
export function selvtestClaude(
	opencodeDir: string,
	repoRot: string,
	env: NodeJS.ProcessEnv = process.env,
	settings?: string
): Selvtest {
	if (env.PAI_CLAUDE_BIN) return { varsler: [] };
	const installert = installertClaude(env);
	return {
		varsler: [
			...sjekkClaudePinning(opencodeDir, repoRot, installert),
			...sjekkAutoOppdatering(installert?.form ?? null, env, settings),
		],
	};
}

// ============================================================================
// K11 — ingen v1-binær på maskinen
// ============================================================================

/** Stedet v1s egen installasjon (`curl opencode.ai/install`) la binæren. */
export function v1InstallSti(home: string = homedir()): string {
	return join(home, ".opencode", "bin", "opencode");
}

function hovedversjon(tekst: string): number | null {
	const m = tekst.match(/(\d+)\.\d+\.\d+/);
	return m ? Number(m[1]) : null;
}

/**
 * Er en `opencode` på PATH v1? Stien avgjør i de vanlige tilfellene, uten å
 * starte noe: v2 ligger under `@opencode/cli`, v1 under `opencode-ai` eller i
 * v1-installasjonen. Bare en ukjent sti koster en `--version`.
 *
 * I tvil: nei. En advarsel om en binær som ikke er v1, er M-23 på nytt.
 */
function erV1(sti: string, home: string): boolean {
	let ekte = sti;
	try {
		ekte = realpathSync(sti);
	} catch {
		return false;
	}
	if (ekte.includes("/@opencode/cli/")) return false;
	if (ekte.includes("/opencode-ai/") || ekte === v1InstallSti(home)) return true;
	try {
		const r = Bun.spawnSync([ekte, "--version"], { stdin: "ignore", timeout: 2000 });
		return hovedversjon(r.stdout.toString()) === 1;
	} catch {
		return false;
	}
}

/**
 * Finnes en v1-binær? v1 kjører sin egen `bun install` i `.opencode/` uten
 * `postinstall` første gang den starter, og gjør v2-binæren til en plassholder
 * (MÅLT, fase 7). K9 ser symptomet; dette er årsaken, og den er borte fra
 * repoet, men ikke nødvendigvis fra maskinen.
 */
export function sjekkV1Binær(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
	const funnet = new Set<string>();
	const installert = v1InstallSti(home);
	if (existsSync(installert)) funnet.add(installert);

	const påPath = Bun.which("opencode", { PATH: env.PATH ?? "" });
	if (påPath && erV1(påPath, home)) funnet.add(påPath);

	return [...funnet].map(
		(sti) =>
			`An OpenCode v1 binary exists: ${sti}. If it runs, the v2 binary becomes a placeholder. ` +
			`Remove it: rm ${sti} (or uninstall opencode-ai)`
	);
}

// ============================================================================
// K27 — ingen rester i plugin-katalogene
// ============================================================================

/**
 * Katalogene v2 laster plugins fra: `plugins/` i `.opencode/` og i den globale
 * konfigkatalogen (UTLEDET fra 2.0.18-binæren: én funksjon slår sammen
 * `<config>/plugins` og `<prosjekt>/.opencode/plugins`, og en annen laster hver
 * underkatalog der). PAI registrerer adapteren selv med
 * `OPENCODE_CONFIG_CONTENT`, så ingen av dem skal ha innhold. v1s
 * `pai-unified.ts` der ga «2 plugins failed» i TUI-en (MÅLT, v2 fase 7).
 *
 * Taus når katalogen mangler eller er tom. `~/.config/opencode` peker inn i
 * repoet, så samme katalog kan dukke opp to ganger; den nevnes én gang.
 */
export function sjekkPluginRester(opencodeDir: string, configDir: string): string[] {
	const sett = new Set<string>();
	const varsler: string[] = [];
	for (const kandidat of [join(opencodeDir, "plugins"), join(configDir, "plugins")]) {
		let sti: string;
		let innhold: string[];
		try {
			sti = realpathSync(kandidat);
			innhold = readdirSync(sti).sort();
		} catch {
			continue;
		}
		if (sett.has(sti) || innhold.length === 0) continue;
		sett.add(sti);
		const vis = innhold.slice(0, 3).join(", ") + (innhold.length > 3 ? ", …" : "");
		varsler.push(
			`v2 loads plugins from ${sti} (${vis}), and PAI registers the adapter itself. ` +
				`Leftovers from v1? Move the directory out of the repo: mv ${sti} ~/plugins-rest`
		);
	}
	return varsler;
}

// ============================================================================
// K40 — launcheren bygger fra sitt eget tre
// ============================================================================

/**
 * Bygger launcheren konteksten fra et annet tre enn det den selv ligger i?
 * `OPENCODE_DIR` er `~/.opencode` når den ikke er satt, uansett hvor `pai.ts`
 * ble startet fra. `bun <annen klon>/.opencode/PAI/Tools/pai.ts` kjørte derfor
 * koden fra klonen mot konteksten, agentene og MEMORY fra treet symlenken peker
 * på, og bare fordi DA-navnene var ulike, ble `ClaudeSmoke` i jobbklonen rød
 * (M-45).
 *
 * Taus når `OPENCODE_DIR` er satt: da er valget tatt med vilje (røyktestene
 * setter den). Taus også når en av stiene ikke lar seg løse (regel 1).
 */
export function sjekkTreet(opencodeDir: string, egetTre: string, env: NodeJS.ProcessEnv = process.env): string[] {
	if (env.OPENCODE_DIR) return [];
	let bygger: string;
	let eget: string;
	try {
		bygger = realpathSync(opencodeDir);
		eget = realpathSync(egetTre);
	} catch {
		return [];
	}
	if (bygger === eget) return [];
	return [
		`The launcher is in ${eget}, but PAI is loaded from ${bygger} (${opencodeDir}). ` +
			`If ${eget} is the one you want: OPENCODE_DIR=${eget} bun ${join(eget, "PAI", "Tools", "pai.ts")}`,
	];
}

// ============================================================================
// Samlet
// ============================================================================

export interface Selvtest {
	/** Satt når motoren ikke kan startes. Launcheren avslutter med den. */
	stopp?: string;
	/** Én linje per avvik. Tom når alt er i orden. */
	varsler: string[];
}

/**
 * Alt launcheren sjekker før v2 startes.
 *
 * `PAI_OPENCODE2_BIN` er overstyringen for testing, og da gjelder ingen av
 * sjekkene: de handler om den pinnede binæren, og den startes ikke.
 */
export function selvtestV2(opencodeDir: string, repoRot: string, env: NodeJS.ProcessEnv = process.env): Selvtest {
	if (env.PAI_OPENCODE2_BIN) return { varsler: [] };
	const stopp = sjekkBinær(opencodeDir);
	if (stopp) return { stopp, varsler: [] };
	const home = env.HOME || homedir();
	const configDir = join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
	return {
		varsler: [
			...sjekkV1Binær(env, home),
			...sjekkPinning(opencodeDir, repoRot),
			...sjekkPluginRester(opencodeDir, configDir),
		],
	};
}
