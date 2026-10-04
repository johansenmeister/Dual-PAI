#!/usr/bin/env bun
/**
 * BuildClaudePlugin.ts — generator for Claude Code-pluginens artefakter
 *
 * Fire ting genereres, og alle fire er speil av noe som allerede finnes:
 *
 *   `claude-plugin/skills/**`      ← `.opencode/skills/**`   (flatet, 60 skills)
 *   `claude-plugin/skill-map.json` ← samme traversering
 *   `claude-plugin/agents/*.md`    ← `.opencode/agents/*.md` + `profiles/claude.yaml`
 *   `claude-plugin/agent-alias.json` ← samme
 *   `claude-plugin/hooks/hooks.json` ← `src/adapter/routes.ts`
 *
 * HVORFOR SPEIL OG IKKE SYMLINK: Claude Code adresserer en skill med
 * KATALOGNAVNET (målt 2026-09-22, binærens egen tekst: «Skill names match the
 * skill's directory name»), og den godtar kun ett katalognivå under
 * `skills/`. Femti av seksti skills ligger på `Kategori/Skill/`, så treet må
 * flates. Et speil er dessuten det eneste som lar oss legge på
 * Claude-eksklusiv frontmatter uten at den lekker tilbake til OpenCode.
 *
 * INGEN TIDSSTEMPLER I UTDATA. Det er ikke en stilpreferanse: friskhets-
 * testen sammenligner generert utdata BYTE FOR BYTE mot fila på disk, og et
 * `generert: <dato>`-felt ville gjort den testen umulig å bestå. Det samme
 * gjelder alt annet maskinavhengig — se `utelat` i `profiles/claude.yaml`.
 *
 * Bruk:
 *   bun Tools/BuildClaudePlugin.ts            # skriv artefaktene
 *   bun Tools/BuildClaudePlugin.ts --sjekk    # bare rapporter drift, exit 1
 *
 * @module Tools/BuildClaudePlugin
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { HÅNDTERTE_HENDELSER } from "../claude-plugin/src/adapter/routes";
import { finnSkills, flattNavn, tilKebab } from "./lib/skill-walk";

// ---------------------------------------------------------------------------
// Faste valg
// ---------------------------------------------------------------------------

/**
 * Pluginens navn, slik `.claude-plugin/plugin.json` oppgir det.
 *
 * Det er ikke kosmetikk: Claude Code eksponerer plugin-agenter som
 * `<plugin>:<navn>` og plugin-skills som `<plugin>:<katalog>`. Endres dette,
 * endres hver eneste adresse i `agent-alias.json`.
 */
const PLUGIN_NAVN = "pai";

/**
 * Hook-timeout i sekunder, per hendelse.
 *
 * Verdiene ligger bevisst OVER dispatcherens egen vaktbikkje (se
 * `bin/pai-hook.ts`): PAI skal selv avgjøre hva som skjer når noe henger,
 * framfor at Claude Code dreper prosessen midt i en filskriving.
 *
 * Tabellen må dekke HVER hendelse i `HÅNDTERTE_HENDELSER`. Mangler én,
 * feiler generatoren — en default her ville gitt en ny hendelse et tilfeldig
 * tidsbudsjett ingen hadde vurdert.
 */
const TIMEOUT: Record<string, number> = {
	SessionStart: 45, // reaper + rydding + ~26 KB kontekst
	SessionEnd: 45, // hele teardown-kjeden
	UserPromptSubmit: 30,
	PreToolUse: 15, // fyrer på HVERT verktøykall — må være kort
	PostToolUse: 20,
	PostToolUseFailure: 15,
	Stop: 30,
	SubagentStart: 15,
	SubagentStop: 30,
	PreCompact: 15,
	PostCompact: 30,
	PermissionRequest: 15,
	PermissionDenied: 15,
};

/** Rekkefølgen hendelsene skrives i. Kun for lesbar diff. */
const HENDELSESREKKEFØLGE = [
	"SessionStart",
	"SessionEnd",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"Stop",
	"SubagentStart",
	"SubagentStop",
	"PreCompact",
	"PostCompact",
	"PermissionRequest",
	"PermissionDenied",
];

const BANNER = (kilde: string) => [
	`# GENERERT av Tools/BuildClaudePlugin.ts — ikke rediger.`,
	`# Kilde: ${kilde}`,
	`# Endringer hører hjemme i kilden; kjør deretter generatoren på nytt.`,
];

// ---------------------------------------------------------------------------
// Planen — ren data, så testen kan bygge den uten å skrive noe
// ---------------------------------------------------------------------------

export interface GenerertFil {
	/** Sti relativt til reporoten. */
	sti: string;
	innhold: string;
}

export interface GenerertLenke {
	/** Sti relativt til reporoten. */
	sti: string;
	/** Lenkemålet, relativt til lenkas egen katalog. */
	mål: string;
}

export interface Byggeplan {
	filer: GenerertFil[];
	lenker: GenerertLenke[];
	/** Kataloger generatoren eier i sin helhet, og derfor kan tømme. */
	eideKataloger: string[];
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

interface Frontmatter {
	felt: Map<string, string>;
	/** Alt etter det avsluttende `---`, ordrett. */
	kropp: string;
}

/**
 * Del et markdown-dokument i frontmatter og kropp.
 *
 * Bevisst enkel: verdiene brukes ordrett, ikke tolket. En YAML-parser her
 * ville normalisert sitattegn og linjeskift, og da er kroppen ikke lenger
 * «verbatim» på den måten friskhetstesten sjekker.
 */
function delFrontmatter(innhold: string): Frontmatter {
	const treff = innhold.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	const felt = new Map<string, string>();
	if (!treff) return { felt, kropp: innhold };

	for (const linje of treff[1].split(/\r?\n/)) {
		if (/^\s*#/.test(linje) || linje.trim() === "") continue;
		const m = linje.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		// Fortsettelseslinjer i flerlinjes YAML har ingen nøkkel. De hører til
		// forrige felt, og vi tar dem med der framfor å miste dem.
		if (!m) {
			const sisteNøkkel = [...felt.keys()].pop();
			if (sisteNøkkel) felt.set(sisteNøkkel, `${felt.get(sisteNøkkel)}\n${linje}`);
			continue;
		}
		felt.set(m[1], m[2]);
	}
	return { felt, kropp: innhold.slice(treff[0].length) };
}

/** Bygg frontmatter på nytt: banner som YAML-kommentar, så feltene i oppgitt rekkefølge. */
function byggFrontmatter(kilde: string, felt: Array<[string, string]>): string {
	return ["---", ...BANNER(kilde), ...felt.map(([k, v]) => `${k}: ${v}`), "---", ""].join("\n");
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

const SKILL_NAVN_MØNSTER = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Stiene git FAKTISK sporer under en katalog, repo-relative.
 *
 * M-28: speilet skal utledes av det git sporer, ikke av hva som tilfeldigvis
 * ligger på disk. `claude-plugin/skills/` er selv sporet (309 filer) og
 * `sync-end.sh` gjør `git add -A`, så en symlink til noe maskinlokalt ble
 * committet — og de andre maskinene fikk en DINGLENDE lenke.
 *
 * Første forsøk brukte `git check-ignore`, og det var feil diagnose. Den
 * konkrete kilden på pc-en var `MusicLibrary/Tools`, en TOM katalog fra
 * 2026-07-05. Git kan ikke representere tomme kataloger i det hele tatt: de
 * er hverken sporet, ignorert eller utrackede — `git status --ignored` sier
 * ingenting om dem. `check-ignore` svarte derfor «ikke ignorert», og
 * filteret slapp den gjennom.
 *
 * `ls-files` fanger alle tre tilfellene med én regel: tom katalog,
 * gitignorert katalog og utracket lokal fil er alle «ikke sporet».
 *
 * FAIL-OPEN: svarer git ikke, returneres `null` og INGENTING filtreres. Et
 * speil med en lenke for mye er synlig i `git status`; et speil som mangler
 * lenker fordi en sjekk feilet stille, er usynlig.
 */
async function finnSporede(rot: string, underKatalog: string): Promise<Set<string> | null> {
	try {
		const proc = Bun.spawn(["git", "ls-files", "-z", "--", underKatalog], {
			cwd: rot,
			stdout: "pipe",
			stderr: "ignore",
		});
		const ut = await new Response(proc.stdout).text();
		const kode = await proc.exited;
		if (kode !== 0) return null;
		return new Set(ut.split("\0").filter(Boolean));
	} catch {
		return null;
	}
}

/** Sporer git noe PÅ eller UNDER denne stien? */
function erSporet(sporede: Set<string>, relativSti: string): boolean {
	if (sporede.has(relativSti)) return true;
	const prefiks = `${relativSti}/`;
	for (const s of sporede) {
		if (s.startsWith(prefiks)) return true;
	}
	return false;
}

async function planleggSkills(
	rot: string
): Promise<{ filer: GenerertFil[]; lenker: GenerertLenke[]; kart: Record<string, unknown> }> {
	const skills = await finnSkills(join(rot, ".opencode/skills"));
	const filer: GenerertFil[] = [];
	const lenker: GenerertLenke[] = [];
	const kandidater: Array<GenerertLenke & { kilde: string }> = [];
	const kart: Record<string, { kilde: string; segmenter: string[]; navn: string }> = {};
	const aliaser: Record<string, string> = {};
	const tvetydige = new Set<string>();
	const settNavn = new Map<string, string>();

	for (const skill of skills) {
		const kildesti = relative(rot, skill.dir);

		// HARD FEIL, ikke en advarsel. Claude Code laster ikke en skill som
		// ligger dypere enn ett nivå — målt 2026-09-22: `skills/Kat/Dyp/`
		// forsvant sporløst fra skill-lista. En advarsel ville gitt oss
		// nøyaktig den stille formen for tap resten av registeret er fullt av.
		if (skill.segmenter.length > 2) {
			throw new Error(
				`Skill for dypt nestet: ${kildesti}\n` +
					`Claude Code laster kun skills/<katalog>/SKILL.md. Flat den, eller ` +
					`legg den til i IKKE_SKILLS i Tools/lib/skill-walk.ts.`
			);
		}

		const navn = flattNavn(skill.segmenter);
		if (!SKILL_NAVN_MØNSTER.test(navn)) {
			throw new Error(`Ugyldig flatt skill-navn «${navn}» fra ${kildesti}`);
		}
		const tidligere = settNavn.get(navn);
		if (tidligere) {
			throw new Error(
				`Navnekollisjon på «${navn}»: ${tidligere} og ${kildesti} flater til samme navn.`
			);
		}
		settNavn.set(navn, kildesti);

		const råInnhold = await readFile(skill.skillMd, "utf-8");
		const { felt, kropp } = delFrontmatter(råInnhold);

		// `name` skrives om til det flate navnet. Katalognavnet er det Claude
		// Code faktisk adresserer med (målt), så feltet er strengt tatt
		// dekorativt — men et `name` som sier noe annet enn adressen er en
		// felle for den neste som leser fila.
		const beskrivelse = felt.get("description") ?? "";
		const skillNavn = skill.segmenter[skill.segmenter.length - 1];

		filer.push({
			sti: join("claude-plugin/skills", navn, "SKILL.md"),
			innhold:
				byggFrontmatter(`${kildesti}/SKILL.md`, [
					["name", navn],
					["description", beskrivelse],
				]) + kropp,
		});

		kart[navn] = { kilde: kildesti, segmenter: skill.segmenter, navn: skillNavn };

		// Aliaser lar skill-guard slå opp på navnet KILDEN bruker. OpenCode
		// sender `Proxmox`, Claude Code sender `pai:infrastructure-proxmox`.
		for (const alias of [skillNavn.toLowerCase(), tilKebab(skillNavn)]) {
			if (alias === navn) continue;
			if (aliaser[alias] && aliaser[alias] !== navn) tvetydige.add(alias);
			aliaser[alias] = navn;
		}

		// Sidefiler symlenkes framfor å kopieres: `Workflows/` og `Scripts/`
		// er kildens egne, de leses aldri av Claude Code selv (kun av det
		// SKILL.md peker på), og en kopi ville vært 60 nye steder å drive fra.
		for (const oppføring of await readdir(skill.dir, { withFileTypes: true })) {
			if (oppføring.name === "SKILL.md" || oppføring.name.startsWith(".")) continue;
			const lenkesti = join("claude-plugin/skills", navn, oppføring.name);
			kandidater.push({
				sti: lenkesti,
				mål: relative(join(rot, dirname(lenkesti)), join(skill.dir, oppføring.name)),
				kilde: join(skill.dir, oppføring.name),
			});
		}
	}

	// === M-28: SPEILET UTLEDES AV DET GIT SPORER ===
	//
	// Ikke av hva som ligger på disk. Se `finnSporede` for hvorfor
	// `check-ignore` ikke holdt: en TOM katalog er hverken sporet eller
	// ignorert, og det var nøyaktig den formen defekten hadde.
	const sporede = await finnSporede(rot, ".opencode/skills");
	for (const k of kandidater) {
		if (sporede) {
			const rel = relative(rot, k.kilde);
			if (!erSporet(sporede, rel)) continue;
		}
		lenker.push({ sti: k.sti, mål: k.mål });
	}

	// En tvetydig alias fjernes framfor å peke ett tilfeldig sted. Da svarer
	// oppslaget «vet ikke», som er sant, i stedet for å svare feil.
	for (const alias of tvetydige) delete aliaser[alias];

	return {
		filer,
		lenker,
		kart: {
			_kommentar: [
				"GENERERT av Tools/BuildClaudePlugin.ts — ikke rediger.",
				"",
				"Flatt skill-navn → kilden speilet kom fra. Konsumeres av",
				"pai-core/handlers/skill-guard.ts, som ellers gjør sitt eget",
				"katalogsøk og dermed ikke kan vite hva Claude-siden faktisk",
				"eksponerer.",
				"",
				"Claude Code adresserer en skill som `pai:<flatt-navn>` — slå av",
				"prefikset før oppslag. `aliaser` dekker navnet KILDEN bruker,",
				"som er det OpenCode-siden sender (`Proxmox`, ikke",
				"`infrastructure-proxmox`).",
			],
			plugin: PLUGIN_NAVN,
			skills: kart,
			aliaser,
		},
	};
}

// ---------------------------------------------------------------------------
// Agenter
// ---------------------------------------------------------------------------

interface AgentProfil {
	default_model: string;
	agents: Record<string, { model?: string; tools?: string }>;
	utelat: Set<string>;
}

/**
 * Les `profiles/claude.yaml`.
 *
 * Håndskrevet parser framfor en YAML-avhengighet: fila er vår egen, formen
 * er to nivåer dyp, og repoet har ingen YAML-pakke i dag. Feiler den, feiler
 * den høyt — en profil som stilletiende blir tom ville gitt alle agentene
 * `inherit` uten at noe sa fra.
 */
function lesProfil(yaml: string): AgentProfil {
	const profil: AgentProfil = { default_model: "inherit", agents: {}, utelat: new Set() };
	let seksjon: "agents" | "utelat" | null = null;
	let agent: string | null = null;

	for (const rå of yaml.split(/\r?\n/)) {
		const linje = rå.replace(/\s+#.*$/, "");
		if (linje.trim() === "" || /^\s*#/.test(rå)) continue;

		const topp = linje.match(/^([a-z_]+):\s*(.*)$/);
		if (topp) {
			if (topp[1] === "default_model") profil.default_model = topp[2].trim();
			seksjon = topp[1] === "agents" ? "agents" : topp[1] === "utelat" ? "utelat" : null;
			agent = null;
			continue;
		}

		if (seksjon === "utelat") {
			const m = linje.match(/^\s*-\s*(.+)$/);
			if (m) profil.utelat.add(m[1].trim());
			continue;
		}

		if (seksjon === "agents") {
			const agentLinje = linje.match(/^ {2}([A-Za-z][A-Za-z0-9_]*):\s*$/);
			if (agentLinje) {
				agent = agentLinje[1];
				profil.agents[agent] = {};
				continue;
			}
			const felt = linje.match(/^ {4}(model|tools):\s*(.+)$/);
			if (felt && agent) {
				profil.agents[agent][felt[1] as "model" | "tools"] = felt[2].trim();
			}
		}
	}
	return profil;
}

async function planleggAgenter(
	rot: string
): Promise<{ filer: GenerertFil[]; alias: Record<string, unknown> }> {
	const profilSti = join(rot, ".opencode/profiles/claude.yaml");
	if (!existsSync(profilSti)) {
		throw new Error(`Mangler ${relative(rot, profilSti)} — agentprofilen er ikke valgfri.`);
	}
	const profil = lesProfil(await readFile(profilSti, "utf-8"));

	const agentDir = join(rot, ".opencode/agents");
	const filer: GenerertFil[] = [];
	const aliaser: Record<string, string> = {};

	const navnene = (await readdir(agentDir))
		.filter((f) => f.endsWith(".md"))
		.sort((a, b) => a.localeCompare(b));

	for (const fil of navnene) {
		const kildesti = relative(rot, join(agentDir, fil));
		const { felt, kropp } = delFrontmatter(await readFile(join(agentDir, fil), "utf-8"));
		const navn = felt.get("name")?.trim();
		if (!navn) throw new Error(`Agent uten «name» i frontmatter: ${kildesti}`);
		if (profil.utelat.has(navn)) continue;

		const oppsett = profil.agents[navn] ?? {};
		const modell = oppsett.model ?? profil.default_model;

		// `color` droppes. Målt 2026-09-22 at Claude Code laster en agent MED
		// feltet uten å klage, så dette er ikke en nødvendighet — men fargen
		// er OpenCode-TUI-ens, identiteten bæres av karakterarket, og et felt
		// motoren ikke bruker er et felt ingen vedlikeholder.
		const frontmatterFelt: Array<[string, string]> = [
			["name", navn],
			["description", felt.get("description") ?? ""],
		];
		// `inherit` betyr «sesjonens modell», og det er Claude Codes default.
		// Å skrive det ut ville vært å oppgi en modell vi ikke har målt at
		// enumen godtar.
		if (modell && modell !== "inherit") frontmatterFelt.push(["model", modell]);
		if (oppsett.tools) frontmatterFelt.push(["tools", oppsett.tools]);

		filer.push({
			sti: join("claude-plugin/agents", fil),
			innhold: byggFrontmatter(kildesti, frontmatterFelt) + kropp,
		});

		// MÅLT 2026-09-22, ende-til-ende: et BART agentnavn resolver ikke.
		//   «Agent type 'ProbeCamelCase' not found. Available agents: …,
		//    probe:ProbeCamelCase, …»
		// Promptmaterialet i dette repoet sier `subagent_type: "Engineer"` 139
		// steder. Uten denne tabellen — og omskrivingen i `dispatch/tool.ts`
		// som leser den — er hver eneste genererte agent uadresserbar.
		const adresse = `${PLUGIN_NAVN}:${navn}`;
		for (const alias of [navn, navn.toLowerCase(), tilKebab(navn)]) {
			aliaser[alias] = adresse;
		}
	}

	if (filer.length === 0) throw new Error("Ingen agenter generert — profilen utelater alle.");

	return {
		filer,
		alias: {
			_kommentar: [
				"GENERERT av Tools/BuildClaudePlugin.ts — ikke rediger.",
				"",
				"Claude Code eksponerer plugin-agenter som `<plugin>:<navn>`, og et",
				"BART navn resolver ikke. Målt 2026-09-22, ende-til-ende:",
				"  «Agent type 'ProbeCamelCase' not found. Available agents: …,",
				"   probe:ProbeCamelCase, …»",
				"",
				"Promptmaterialet sier `subagent_type: \"Engineer\"`. PreToolUse",
				"skriver om verdien via `updatedInput` før motoren slår den opp —",
				"målt at omskrivingen skjer FØR oppslaget, så et bart navn virker.",
				"Uten denne tabellen er hver genererte agent uadresserbar.",
			],
			plugin: PLUGIN_NAVN,
			aliaser,
		},
	};
}

// ---------------------------------------------------------------------------
// hooks.json
// ---------------------------------------------------------------------------

/**
 * Bygg `hooks.json` fra rutetabellen.
 *
 * Retningen er med vilje: rutetabellen er kilden, `hooks.json` er avledet.
 * Registrerer vi en hendelse motoren skal fyre på, men glemmer den i
 * rutetabellen, forkaster hurtigutgangen den — stille. Genereres fila fra
 * settet, kan de to ikke gå fra hverandre.
 *
 * INGEN MATCHERS, fortsatt med vilje. Filtreringen på verktøynavn ligger i
 * `routes.ts`, der den speiler kjernens egne navnetester og låses av en test
 * som leser begge. To kilder til samme regel er to steder å glemme et
 * verktøy, og bare den ene er testbar.
 */
export function byggHooksJson(hendelser: Iterable<string> = HÅNDTERTE_HENDELSER): string {
	const sett = new Set(hendelser);
	const rekkefølge = [
		...HENDELSESREKKEFØLGE.filter((h) => sett.has(h)),
		...[...sett].filter((h) => !HENDELSESREKKEFØLGE.includes(h)).sort(),
	];

	const hooks: Record<string, unknown> = {};
	for (const hendelse of rekkefølge) {
		const timeout = TIMEOUT[hendelse];
		if (timeout === undefined) {
			throw new Error(
				`Hendelsen «${hendelse}» står i rutetabellen, men mangler timeout i ` +
					`TIMEOUT i Tools/BuildClaudePlugin.ts. Sett et bevisst tidsbudsjett — ` +
					`en default ville gitt den et tilfeldig ett.`
			);
		}
		hooks[hendelse] = [
			{
				hooks: [
					{
						type: "command",
						// Kun stien, aldri «bun <fil>». Det er kontrakten som gjør
						// `bun build --compile` i batch 12 gratis: en kompilert
						// binær på samme sti krever ingen reinstall.
						// biome-ignore lint/suspicious/noTemplateCurlyInString: ${CLAUDE_PLUGIN_ROOT} er en literal motoren substituerer
						command: "${CLAUDE_PLUGIN_ROOT}/bin/pai-hook",
						// EXEC-FORM (M-42): med `args` kjører Claude Code
						// kommandoen uten skall. Som skallkommando ble en
						// plugin-sti med mellomrom splittet, og ingen hook fyrte
						// (MÅLT 2.1.283), heller ikke sikkerhetsvakten.
						args: [],
						timeout,
					},
				],
			},
		];
	}

	return `${JSON.stringify(
		{
			// `description`, ikke `_kommentar`: Claude Code kjenner den nøkkelen,
			// og en ukjent gir en advarsel i hver økt (MÅLT 2.1.283).
			description: [
				"GENERERT av Tools/BuildClaudePlugin.ts fra HÅNDTERTE_HENDELSER i",
				"src/adapter/routes.ts — ikke rediger.",
				"",
				"ÉN oppføring per hendelse, ikke én per handler. Dispatcheren",
				"fan-outer internt, så 25 handlere koster tretten prosesser og ikke 25.",
				"",
				"INGEN matchers, med vilje. Claude Codes matcher filtrerer på",
				"verktøynavn, og den samme filtreringen ligger i routes.ts — der den",
				"kan speile kjernens egne navnetester og låses av en test som leser",
				"begge. Prisen er én bun-oppstart (~69 ms målt) for kall",
				"hurtigutgangen forkaster; gevinsten er at filtreringen ikke kan",
				"drive fra kjernen uten at en test faller.",
				"",
				"`timeout` er sekunder og ligger bevisst over dispatcherens egen",
				"vaktbikkje (bin/pai-hook.ts): PAI skal selv avgjøre hva som skjer",
				"når noe henger, framfor at Claude Code dreper prosessen midt i en",
				"filskriving.",
			]
				.filter((linje) => linje !== "")
				.join(" "),
			hooks,
		},
		null,
		2
	)}\n`;
}

// ---------------------------------------------------------------------------
// Samlet plan
// ---------------------------------------------------------------------------

function somJson(verdi: unknown): string {
	return `${JSON.stringify(verdi, null, 2)}\n`;
}

/**
 * Bygg hele planen uten å røre filsystemet utover å lese kildene.
 *
 * Det er DENNE funksjonen friskhetstesten kaller. Skrivingen ligger i
 * `skrivPlan`, så testen kan sammenligne mot disk uten å endre noe — en test
 * som må generere for å teste, tester seg selv.
 */
export async function byggPlan(rot: string): Promise<Byggeplan> {
	const skills = await planleggSkills(rot);
	const agenter = await planleggAgenter(rot);

	return {
		filer: [
			...skills.filer,
			...agenter.filer,
			{ sti: "claude-plugin/skill-map.json", innhold: somJson(skills.kart) },
			{ sti: "claude-plugin/agent-alias.json", innhold: somJson(agenter.alias) },
			{ sti: "claude-plugin/hooks/hooks.json", innhold: byggHooksJson() },
		],
		lenker: skills.lenker,
		eideKataloger: ["claude-plugin/skills", "claude-plugin/agents"],
	};
}

/** Skriv planen til disk. Eide kataloger tømmes først, så en slettet kilde faktisk forsvinner. */
export async function skrivPlan(rot: string, plan: Byggeplan): Promise<void> {
	for (const katalog of plan.eideKataloger) {
		await rm(join(rot, katalog), { recursive: true, force: true });
	}
	for (const fil of plan.filer) {
		const full = join(rot, fil.sti);
		await mkdir(dirname(full), { recursive: true });
		await writeFile(full, fil.innhold, "utf-8");
	}
	for (const lenke of plan.lenker) {
		const full = join(rot, lenke.sti);
		await mkdir(dirname(full), { recursive: true });
		await symlink(lenke.mål, full);
	}
}

/**
 * Sammenlign planen med det som faktisk ligger på disk.
 *
 * @returns Én linje per avvik. Tom liste betyr at speilet er ferskt.
 */
export async function finnDrift(rot: string, plan: Byggeplan): Promise<string[]> {
	const avvik: string[] = [];

	for (const fil of plan.filer) {
		const full = join(rot, fil.sti);
		if (!existsSync(full)) {
			avvik.push(`missing: ${fil.sti}`);
			continue;
		}
		if ((await readFile(full, "utf-8")) !== fil.innhold) avvik.push(`drifted: ${fil.sti}`);
	}

	for (const lenke of plan.lenker) {
		const full = join(rot, lenke.sti);
		try {
			const faktisk = await readlink(full);
			if (faktisk !== lenke.mål) {
				avvik.push(`link points elsewhere: ${lenke.sti} → ${faktisk} (expected ${lenke.mål})`);
			}
		} catch {
			avvik.push(`missing link: ${lenke.sti}`);
		}
	}

	// Den andre retningen: en fil i speilet som planen ikke kjenner, er en
	// skill eller agent som er SLETTET i kilden. Uten denne sjekken ville den
	// blitt liggende og fortsatt bli lastet av Claude Code.
	const forventet = new Set([...plan.filer, ...plan.lenker].map((f) => f.sti));
	for (const katalog of plan.eideKataloger) {
		for (const funnet of await listRekursivt(rot, katalog)) {
			if (!forventet.has(funnet)) avvik.push(`orphan: ${funnet}`);
		}
	}

	return avvik;
}

async function listRekursivt(rot: string, katalog: string): Promise<string[]> {
	const full = join(rot, katalog);
	if (!existsSync(full)) return [];
	const ut: string[] = [];
	for (const oppføring of await readdir(full, { withFileTypes: true })) {
		const sti = join(katalog, oppføring.name);
		// Symlinker rapporteres som seg selv, ikke traverseres: de PEKER inn i
		// kilden, og å gå ned i dem ville listet hele kildetreet som speil.
		if (oppføring.isSymbolicLink() || !oppføring.isDirectory()) ut.push(sti);
		else ut.push(...(await listRekursivt(rot, sti)));
	}
	return ut;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
	const rot = join(import.meta.dir, "..");
	const plan = await byggPlan(rot);

	if (process.argv.includes("--sjekk")) {
		const avvik = await finnDrift(rot, plan);
		if (avvik.length === 0) {
			console.log(`✓ Speilet er ferskt (${plan.filer.length} filer, ${plan.lenker.length} lenker)`);
			process.exit(0);
		}
		console.error(`✗ ${avvik.length} avvik mellom kilde og speil:`);
		for (const linje of avvik) console.error(`  ${linje}`);
		console.error("\nKjør: bun Tools/BuildClaudePlugin.ts");
		process.exit(1);
	}

	await skrivPlan(rot, plan);
	console.log(`✓ Skrev ${plan.filer.length} filer og ${plan.lenker.length} symlinker`);
}
