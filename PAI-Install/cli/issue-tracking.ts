#!/usr/bin/env bun
/**
 * issue-tracking.ts — hvor PAI noterer feil og forbedringer (#162, #246)
 *
 * Kjøreplanens steg 8 (`SETUP.md`) spør brukeren om en fil i repoet eller en
 * git-server med issues, og dette verktøyet skriver valget inn i
 * `.opencode/PAI/USER/INFRASTRUCTURE.md`, som modellen får i hver økt. Før #246
 * kopierte modellen seksjonen selv fra guiden. Det gikk i laben, men
 * gratismodellen skifter fra dag til dag, hvert kall teller mot Zens rategrense,
 * og en modellkopi kan ikke testes.
 *
 * Teksten står ett sted: `guide/issue-tracking.md`. Verktøyet leser seksjonen og
 * oppskriften derfra, så en endring i guiden når brukeren neste gang verktøyet
 * kjøres, og en guide verktøyet ikke lenger finner fram i, stopper `bun test`.
 *
 * Seksjonen begynner med `## Faults and improvements` og varer til neste
 * `## `-overskrift utenfor en kodeblokk. En ny kjøring bytter den ut, så et
 * bytte fra fil til server (eller tilbake) etterlater ingen gammel regel.
 * `ISSUES.md` lages bare hvis den mangler; oppføringene i den står.
 *
 * Bruk:
 *   bun PAI-Install/cli/issue-tracking.ts --file
 *   bun PAI-Install/cli/issue-tracking.ts --gitea <eier>/<repo>
 *   bun PAI-Install/cli/issue-tracking.ts --gitlab <gruppe>/<repo>
 *   bun PAI-Install/cli/issue-tracking.ts --github <eier>/<repo>
 *   bun PAI-Install/cli/issue-tracking.ts --show
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");

export const OVERSKRIFT = "## Faults and improvements";

export type Server = "gitea" | "gitlab" | "github";

/** Hva `<server>` blir i seksjonen, og overskriften oppskriften står under i guiden. */
const SERVERE: Record<Server, { navn: string; merke: string }> = {
	gitea: { navn: "your Gitea (`GITEA_API_URL` in `~/.opencode/.env`)", merke: "**Gitea**" },
	gitlab: { navn: "your GitLab (`GITLAB_URL` in `~/.opencode/.env`)", merke: "**GitLab**" },
	github: { navn: "GitHub", merke: "**GitHub**" },
};

/** Første kodeblokk av språket `språk` etter `merke` (og etter `fra`), uten gjerdene. */
export function blokkEtter(tekst: string, merke: string, språk: string, fra = 0): string {
	const i = tekst.indexOf(merke, fra);
	if (i < 0) throw new Error(`guide/issue-tracking.md has no "${merke}"`);
	const start = tekst.indexOf(`\`\`\`${språk}\n`, i);
	if (start < 0) throw new Error(`guide/issue-tracking.md has no \`\`\`${språk} block after "${merke}"`);
	const innhold = start + språk.length + 4;
	const slutt = tekst.indexOf("\n```", innhold);
	if (slutt < 0) throw new Error(`guide/issue-tracking.md: the block after "${merke}" is not closed`);
	return tekst.slice(innhold, slutt + 1);
}

/** Seksjonen for fila, slik guiden har den. */
export function filseksjon(guide: string): string {
	const del = guide.indexOf("## A file in the repository");
	return blokkEtter(guide, "The section for `INFRASTRUCTURE.md`", "markdown", del);
}

/** Seksjonen for en git-server, med repoet, serveren og oppskriften fylt inn. */
export function serverseksjon(guide: string, server: Server, repo: string): string {
	const del = guide.indexOf("### The section for `INFRASTRUCTURE.md`");
	const mal = blokkEtter(guide, "### The section for `INFRASTRUCTURE.md`", "markdown", del);
	const oppskrift = blokkEtter(guide, SERVERE[server].merke, "bash", del);
	const [eier, navn] = repo.split("/");
	const fylt = oppskrift
		.replaceAll("<owner>/<repo>", repo)
		.replaceAll("<group>%2F<repo>", `${eier}%2F${navn}`);
	const seksjon = mal.replaceAll("<owner>/<repo>", repo).replaceAll("<server>", SERVERE[server].navn);
	return `${seksjon}\n\`\`\`bash\n${fylt}\`\`\`\n`;
}

/** Feilmeldingen for et repo som ikke er `<eier>/<repo>`, eller null. */
export function ugyldigRepo(repo: string): string | null {
	return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? null : `"${repo}" is not <owner>/<repo>, such as my-org/pai`;
}

/** Bytt ut seksjonen, eller legg den til bakerst. Alt annet i fila står. */
export function medSeksjon(tekst: string, seksjon: string): string {
	const linjer = tekst.split("\n");
	const start = linjer.findIndex((l) => l.trimEnd() === OVERSKRIFT);
	if (start < 0) return `${tekst.trimEnd()}\n\n${seksjon.trimEnd()}\n`;
	let slutt = linjer.length;
	let iBlokk = false;
	for (let i = start + 1; i < linjer.length; i++) {
		if (linjer[i].startsWith("```")) iBlokk = !iBlokk;
		else if (!iBlokk && /^#{1,2} /.test(linjer[i])) {
			slutt = i;
			break;
		}
	}
	const etter = linjer.slice(slutt).join("\n");
	const før = linjer.slice(0, start).join("\n").trimEnd();
	return `${før ? `${før}\n\n` : ""}${seksjon.trimEnd()}\n${etter ? `\n${etter}` : ""}`;
}

/** Den nye `ISSUES.md`, med overskriften og rekkefølgen guiden beskriver. */
export const NY_ISSUES = "# Faults and improvements\n\nThe newest entry is at the top.\n";

function main(): number {
	const args = process.argv.slice(2);
	const infra = join(REPO, ".opencode", "PAI", "USER", "INFRASTRUCTURE.md");
	const issues = join(REPO, ".opencode", "PAI", "USER", "ISSUES.md");
	const guide = readFileSync(join(REPO, "guide", "issue-tracking.md"), "utf-8");
	if (!existsSync(infra)) {
		console.error(`${infra} is missing`);
		return 1;
	}
	const tekst = readFileSync(infra, "utf-8");

	if (args.includes("--show")) {
		const har = tekst.split("\n").some((l) => l.trimEnd() === OVERSKRIFT);
		const server = /issue list of `([^`]+)` on (.+?)\. /.exec(tekst);
		console.log(!har ? "not set up" : server ? `issues in ${server[1]} on ${server[2]}` : "a file: .opencode/PAI/USER/ISSUES.md");
		return 0;
	}

	if (args.includes("--file")) {
		writeFileSync(infra, medSeksjon(tekst, filseksjon(guide)));
		const ny = !existsSync(issues);
		if (ny) writeFileSync(issues, NY_ISSUES);
		console.log(`✓ the section in INFRASTRUCTURE.md: faults and ideas go to ${ny ? "a new" : "the"} .opencode/PAI/USER/ISSUES.md`);
		return 0;
	}

	const server = (["gitea", "gitlab", "github"] as const).find((s) => args.includes(`--${s}`));
	if (!server) {
		console.error("Choose one: --file, --gitea <owner>/<repo>, --gitlab <group>/<repo>, --github <owner>/<repo> (or --show)");
		return 1;
	}
	const repo = (args[args.indexOf(`--${server}`) + 1] ?? "").trim();
	const feil = ugyldigRepo(repo);
	if (feil) {
		console.error(`--${server}: ${feil}`);
		return 1;
	}
	writeFileSync(infra, medSeksjon(tekst, serverseksjon(guide, server, repo)));
	console.log(`✓ the section in INFRASTRUCTURE.md: faults and ideas go to the issues of ${repo} (${server})`);
	if (existsSync(issues)) console.log("  .opencode/PAI/USER/ISSUES.md stays as it is; move its open entries over if you want them there.");
	return 0;
}

if (import.meta.main) process.exit(main());
