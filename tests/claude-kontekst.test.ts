/**
 * Kontrakt-test: PAI-konteksten når modellen under Claude Code (K-10)
 *
 * Claude Code legger hook-kontekst over 10 000 tegn i en fil og gir modellen
 * bare de første 2 KB (MÅLT 2.1.283). PAI-konteksten er 26 KB hjemme og 40 KB
 * på jobb, så algoritmen og identiteten nådde aldri modellen, og ingenting sa
 * fra: hooken logget «Context injected successfully».
 *
 * Kuren har tre deler, og hver av dem feiler stumt hvis den brytes:
 *
 *   1. `pai --claude` sender konteksten med `--append-system-prompt-file` og
 *      setter `PAI_CONTEXT_FILE`.
 *   2. Med `PAI_CONTEXT_FILE` satt gir SessionStart ingen `context.build`.
 *   3. Uten launcheren, og over taket, sender hooken en kort beskjed i stedet
 *      for en forhåndsvisning modellen ikke kan bruke.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tilKjernehendelser } from "../claude-plugin/src/adapter/in";
import { CLAUDE_HOOK_TAK, tilHookUtdata } from "../claude-plugin/src/adapter/out";
import { claudeOppstart, tolkFlaggsjekk } from "../.opencode/PAI/Tools/pai";

const REPO = join(import.meta.dir, "..");
const PAI_TS = join(REPO, ".opencode", "PAI", "Tools", "pai.ts");

describe("claudeOppstart", () => {
	test("med kontekstfil: flagget, og PAI_CONTEXT_FILE til hookene", () => {
		const o = claudeOppstart("/bin/claude", "/plugin", "/tmp/k.md", {}, { PATH: "/usr/bin" });
		expect(o.args).toEqual(["/bin/claude", "--plugin-dir", "/plugin", "--append-system-prompt-file", "/tmp/k.md"]);
		expect(o.env.PAI_CONTEXT_FILE).toBe("/tmp/k.md");
		expect(o.env.PAI_ENABLED).toBe("1");
		expect(o.env.PAI_HARNESS).toBe("claude");
	});

	test("uten kontekstfil: intet flagg, og en arvet PAI_CONTEXT_FILE fjernes", () => {
		// En arvet verdi ville fått hookene til å tro at konteksten var gitt.
		const o = claudeOppstart("/bin/claude", "/plugin", null, {}, { PAI_CONTEXT_FILE: "/gammel" });
		expect(o.args).not.toContain("--append-system-prompt-file");
		expect(o.env.PAI_CONTEXT_FILE).toBeUndefined();
	});

	test("resume gir --continue", () => {
		expect(claudeOppstart("/c", "/p", "/k", { resume: true }, {}).args.at(-1)).toBe("--continue");
	});
});

describe("SessionStart: context.build bare når launcheren ikke ga konteksten", () => {
	const opprinnelig = process.env.PAI_CONTEXT_FILE;
	afterEach(() => {
		if (opprinnelig === undefined) delete process.env.PAI_CONTEXT_FILE;
		else process.env.PAI_CONTEXT_FILE = opprinnelig;
	});
	const payload = { hook_event_name: "SessionStart", session_id: "s1", cwd: "/tmp", source: "startup" };

	test("uten PAI_CONTEXT_FILE: session.start og context.build", () => {
		delete process.env.PAI_CONTEXT_FILE;
		expect(tilKjernehendelser(payload).map((h) => h.type)).toEqual(["session.start", "context.build"]);
	});

	test("med PAI_CONTEXT_FILE: bare session.start", () => {
		process.env.PAI_CONTEXT_FILE = "/tmp/k.md";
		expect(tilKjernehendelser(payload).map((h) => h.type)).toEqual(["session.start"]);
	});
});

describe("hook-taket", () => {
	const kontekst = (n: number) => JSON.parse(tilHookUtdata("SessionStart", { additionalContext: ["x".repeat(n)] }));

	test("under taket går konteksten uendret", () => {
		expect(kontekst(CLAUDE_HOOK_TAK).hookSpecificOutput.additionalContext).toHaveLength(CLAUDE_HOOK_TAK);
	});

	test("over taket: en kort beskjed som peker på pai --claude", () => {
		const ut = kontekst(CLAUDE_HOOK_TAK + 1).hookSpecificOutput.additionalContext as string;
		expect(ut.length).toBeLessThan(CLAUDE_HOOK_TAK);
		expect(ut).toContain("pai --claude");
		expect(ut).toContain(String(CLAUDE_HOOK_TAK + 1));
	});

	test("taket er det målte", () => {
		// `jDo=1e4` i 2.1.283. Heves det, sendes en kontekst Claude Code kutter.
		expect(CLAUDE_HOOK_TAK).toBe(10_000);
	});
});

describe("ende til ende: pai --claude med en falsk claude", () => {
	// Egen rot med symlenker til den ekte kjernen og PAI-treet: konteksten
	// bygges av de ekte filene, men hook-binæren bygges ikke i repoet (bygget
	// feiler her, og launcheren fortsetter med en advarsel, som den skal).
	const tmp = mkdtempSync(join(tmpdir(), "pai-claude-kontekst-"));
	const rot = join(tmp, "rot");
	const opencode = join(rot, ".opencode");
	mkdirSync(opencode, { recursive: true });
	for (const navn of ["pai-core", "PAI"]) symlinkSync(join(REPO, ".opencode", navn), join(opencode, navn));
	const falsk = join(tmp, "falsk-claude");
	const ut = join(tmp, "startet.json");
	writeFileSync(
		falsk,
		`#!${process.execPath}
import { existsSync, readFileSync } from "node:fs";
const a = process.argv.slice(2);
const i = a.indexOf("--append-system-prompt-file");
const fil = i >= 0 ? a[i + 1] : null;
await Bun.write(${JSON.stringify(ut)}, JSON.stringify({
  args: a,
  fil,
  innhold: fil && existsSync(fil) ? readFileSync(fil, "utf-8") : null,
  PAI_CONTEXT_FILE: process.env.PAI_CONTEXT_FILE ?? null,
  PAI_ENABLED: process.env.PAI_ENABLED ?? null,
}));
process.exit(Number(process.env.FALSK_EXIT ?? 0));
`
	);
	chmodSync(falsk, 0o755);
	afterAll(() => rmSync(tmp, { recursive: true, force: true }));

	const p = Bun.spawnSync([process.execPath, PAI_TS, "--claude", "-l"], {
		cwd: tmp,
		stdin: "ignore",
		env: {
			PATH: "/usr/bin:/bin",
			HOME: tmp,
			OPENCODE_DIR: opencode,
			PAI_CLAUDE_BIN: falsk,
			PAI_CLAUDE_PLUGIN_DIR: join(REPO, "claude-plugin"),
		},
	});
	const startet = existsSync(ut) ? JSON.parse(readFileSync(ut, "utf-8")) : null;

	test("claude startes med kontekstfila, og hookene får vite det", () => {
		expect(p.exitCode).toBe(0);
		expect(startet.fil).not.toBeNull();
		expect(startet.PAI_CONTEXT_FILE).toBe(startet.fil);
		expect(startet.PAI_ENABLED).toBe("1");
	});

	test("fila er hele konteksten, også det som ligger over hook-taket", () => {
		expect(startet.innhold).toStartWith("<system-reminder>\nPAI CONTEXT");
		expect(startet.innhold.length).toBeGreaterThan(CLAUDE_HOOK_TAK);
		// Det siste som legges til, står etter 2 KB-forhåndsvisningen.
		expect(startet.innhold).toContain("--- AI Identity ---");
	});

	test("fila er slettet når økten er over", () => {
		expect(existsSync(startet.fil)).toBe(false);
	});

	// M-51: launcheren avsluttet med 0 uansett hva claude gjorde, og ryddingen
	// skal skje også når den feiler.
	test("pai --claude gir claudes exitkode videre, og rydder likevel", () => {
		const f = Bun.spawnSync([process.execPath, PAI_TS, "--claude", "-l"], {
			cwd: tmp,
			stdin: "ignore",
			env: {
				PATH: "/usr/bin:/bin",
				HOME: tmp,
				OPENCODE_DIR: opencode,
				PAI_CLAUDE_BIN: falsk,
				PAI_CLAUDE_PLUGIN_DIR: join(REPO, "claude-plugin"),
				FALSK_EXIT: "3",
			},
		});
		const feilet = JSON.parse(readFileSync(ut, "utf-8"));
		expect(f.exitCode).toBe(3);
		expect(existsSync(feilet.fil)).toBe(false);
	});

	test("taus om treet når OPENCODE_DIR er satt (K40)", () => {
		expect(p.stdout.toString()).not.toContain("The launcher is in");
	});

	test("K40: ~/.opencode peker på et annet tre enn launcherens: varsel, og claude startes", () => {
		const hjem = join(tmp, "hjem");
		mkdirSync(hjem);
		symlinkSync(opencode, join(hjem, ".opencode"));
		rmSync(ut, { force: true });
		const q = Bun.spawnSync([process.execPath, PAI_TS, "--claude", "-l"], {
			cwd: tmp,
			stdin: "ignore",
			env: { PATH: "/usr/bin:/bin", HOME: hjem, PAI_CLAUDE_BIN: falsk, PAI_CLAUDE_PLUGIN_DIR: join(REPO, "claude-plugin") },
		});
		expect(q.exitCode).toBe(0);
		expect(q.stdout.toString()).toContain(`PAI: The launcher is in ${realpathSync(join(REPO, ".opencode"))}, but PAI is loaded from`);
		expect(existsSync(ut)).toBe(true);
	});
});

describe("tolkFlaggsjekk — pai claude doctor", () => {
	// Tekstene er de målte fra 2.1.283, ordrett.
	test("flagget finnes", () => {
		expect(tolkFlaggsjekk("Error: Append system prompt file not found: /finnes/ikke/pai-doctor.md")).toBe("ja");
	});
	test("flagget er ukjent", () => {
		expect(tolkFlaggsjekk("error: unknown option '--append-system-prompt-file'")).toBe("nei");
	});
	test("alt annet er ukjent, ikke nei", () => {
		expect(tolkFlaggsjekk("")).toBe("ukjent");
		expect(tolkFlaggsjekk("error: unknown option '--noe-annet'")).toBe("ukjent");
		expect(tolkFlaggsjekk("Error: Input must be provided either through stdin or as a prompt argument")).toBe("ukjent");
	});
});
