/**
 * Kontrakt-test: stiene i SETUP.md, guide/ og README-ene finnes i repoet (#219)
 *
 * Kjøreplanen (`SETUP.md`), runbookene i `guide/` og README-ene (rotens og
 * kopienes i `docs/kopiene/`, som `bygg.sh` legger i roten) peker til filer og verktøy
 * med stier relative til repoet, og en gratismodell følger dem ordrett. Flyttes
 * eller omdøpes en fil, står kjøreplanen igjen med en død kommando, og modellen
 * gjetter. `markdown-stier.test.ts` ser bare `~/.opencode/…`, og
 * `runbook-lenker.test.ts` ser lenker til markdown, ikke kode- og verktøystier.
 *
 * Testen henter hver sti som begynner med en sporet toppkatalog, i prosa,
 * backticks og kodeblokker, og krever at den er sporet (eller en katalog med
 * sporede filer). Plassholdere (`<…>`, `*`, `$`, `{`) hoppes over. Det som først
 * lages av installasjonen eller brukeren, står i `LAGES_SENERE` med grunnen.
 *
 * The public README's images are in `docs/kopiene/bilder/` in the source and in
 * `assets/` in public, where `bygg.sh` puts them; in the copies' READMEs, `assets/`
 * is read as the source path.
 *
 * `SETUP.md` og `guide/` følger ikke med jobben, så testen hoppes over der.
 *
 * @module tests/kjoreplan-stier
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const TOPP = [".opencode", "PAI-Install", "scripts", "guide", "Tools", "runbooks", "config", "docs", "assets"];

/** Stier dokumentene nevner, men som ikke er sporet: de lages etter klonen. */
const LAGES_SENERE: Record<string, string> = {
	".opencode/settings.json": "installeren skriver den, maskinlokal og gitignorert",
	".opencode/node_modules/.bin/opencode": "bun install",
	".opencode/PAI/USER/ISSUES.md": "oppsettet lager den (guide/issue-tracking.md)",
	".opencode/PAI/USER/ABOUTME.md": "intervjuet i SETUP.md lager den",
	".opencode/PAI/USER/AISTEERINGRULES.md": "brukeren lager den ved behov",
	".opencode/PAI/USER/TELOS/TELOS.md": "intervjuet i SETUP.md lager den (guide/telos.md)",
};

/** Repo-stier i en markdowntekst, uten plassholdere og uten avsluttende tegnsetting. */
export function stierI(tekst: string): string[] {
	const mønster = new RegExp(`(?:^|[\\s\`"'(=\\[])((?:${TOPP.map((t) => t.replace(".", "\\.")).join("|")})/[^\\s\`"'),;\\]]*)`, "gm");
	const stier = new Set<string>();
	for (const m of tekst.matchAll(mønster)) {
		const sti = m[1].replace(/[.:]+$/, "");
		if (/[<*${]/.test(sti)) continue;
		stier.add(sti);
	}
	return [...stier];
}

/** Sporet som fil, eller som katalog med minst én sporet fil under seg. */
export function finnes(sti: string, sporet: Set<string>): boolean {
	const s = sti.replace(/\/$/, "");
	if (sporet.has(s)) return true;
	for (const f of sporet) if (f.startsWith(`${s}/`)) return true;
	return false;
}

const SETUP = join(REPO, "SETUP.md");

describe.skipIf(!existsSync(SETUP))("stiene i SETUP.md, guide/ og README-ene finnes (#219)", () => {
	const ls = (...a: string[]) =>
		Bun.spawnSync(["git", "ls-files", ...a], { cwd: REPO }).stdout.toString().split("\n").filter(Boolean);
	const sporet = new Set(ls());
	const dokumenter = ["SETUP.md", "README.md", ...ls("guide", "docs/kopiene").filter((f) => f.endsWith(".md"))];

	for (const dok of dokumenter) {
		test(dok, () => {
			const inSource = (s: string) => (dok.startsWith("docs/kopiene/") ? s.replace(/^assets\//, "docs/kopiene/bilder/") : s);
			const døde = stierI(readFileSync(join(REPO, dok), "utf-8")).filter(
				(s) => !finnes(inSource(s), sporet) && !(s in LAGES_SENERE)
			);
			expect(døde).toEqual([]);
		});
	}

	test("hver sti i LAGES_SENERE er fortsatt nevnt, og fortsatt ikke sporet", () => {
		const nevnt = new Set(dokumenter.flatMap((d) => stierI(readFileSync(join(REPO, d), "utf-8"))));
		const foreldet = Object.keys(LAGES_SENERE).filter((s) => !nevnt.has(s) || finnes(s, sporet));
		expect(foreldet).toEqual([]);
	});
});

describe("stierI og finnes", () => {
	const sporet = new Set(["PAI-Install/cli/identity.ts", "guide/gitea/pve.sh"]);

	test("en omdøpt fil er død; en katalog med filer finnes", () => {
		const t = "Run: `bun PAI-Install/cli/identitet.ts --name x`, then see guide/gitea/.";
		expect(stierI(t)).toEqual(["PAI-Install/cli/identitet.ts", "guide/gitea/"]);
		expect(finnes("PAI-Install/cli/identitet.ts", sporet)).toBe(false);
		expect(finnes("guide/gitea/", sporet)).toBe(true);
	});

	test("plassholdere og tegnsetting", () => {
		expect(stierI("`guide/gitea/<name>-compose.yml` og (scripts/x.sh). og guide/*.md")).toEqual(["scripts/x.sh"]);
	});

	test("kodeblokker og lenker", () => {
		expect(stierI("```bash\nbash guide/gitea/pve.sh --check\n```\n[x](guide/gitea.md)")).toEqual([
			"guide/gitea/pve.sh",
			"guide/gitea.md",
		]);
	});
});
