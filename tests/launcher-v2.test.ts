/**
 * Kontrakt-test: launcheren starter OpenCode v2 slik fase 0 målte at den må
 *
 * Tre krav fra målingen, og hvert av dem feiler STILLE hvis det brytes:
 *
 * - `--standalone` (B6). Uten den går TUI-en til den delte bakgrunnstjenesten:
 *   miljøet er fra den første CLI-en som startet den, og tjenesten gjenopptok
 *   krasjede økter og kjørte verktøykallene på nytt (MÅLT).
 * - aldri `--auto`. Den gjør PAIs `ask` til `allow` (MÅLT).
 * - adapteren via `OPENCODE_CONFIG_CONTENT`, aldri i den delte `plugin`-nøkkelen
 *   (B2).
 *
 * I tillegg: v1 er slettet, så `pai` uten flagg er v2 og `--v1` avvises med en
 * melding, og v2-avhengighetene er pinnet eksakt (B3).
 *
 * Ende-til-ende-delen kjører den ekte `pai.ts` med en falsk binær som skriver
 * ned hva den ble startet med. Den beviser at flaggparsingen faktisk når
 * v2-grenen, ikke bare at de rene funksjonene er riktige.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { V1_ER_SLETTET, v2Adapter, v2Binær, v2Oppstart } from "../.opencode/PAI/Tools/pai";

const REPO = join(import.meta.dir, "..");
const OPENCODE = join(REPO, ".opencode");
const PAI_TS = join(OPENCODE, "PAI", "Tools", "pai.ts");

describe("v2Oppstart", () => {
	const o = v2Oppstart("/rot/.opencode", {}, { PATH: "/usr/bin", PAI_OWNER_PID: "123" });

	test("binæren er den pinnede i node_modules", () => {
		expect(o.args[0]).toBe("/rot/.opencode/node_modules/@opencode/cli/bin/opencode.exe");
	});

	test("--standalone er alltid med (B6)", () => {
		expect(o.args).toContain("--standalone");
		expect(v2Oppstart("/r", { resume: true }, {}).args).toContain("--standalone");
	});

	test("--auto er aldri med", () => {
		expect(o.args).not.toContain("--auto");
		expect(v2Oppstart("/r", { resume: true }, {}).args).not.toContain("--auto");
	});

	test("-r gir --continue, og bare da", () => {
		expect(o.args).not.toContain("--continue");
		expect(v2Oppstart("/r", { resume: true }, {}).args).toContain("--continue");
	});

	test("adapteren registreres i OPENCODE_CONFIG_CONTENT, som katalog", () => {
		expect(JSON.parse(o.env.OPENCODE_CONFIG_CONTENT)).toEqual({
			plugin: ["/rot/.opencode/pai-adapters/opencode-v2"],
		});
	});

	test("PAI_ENABLED=1, og resten av miljøet følger med", () => {
		expect(o.env.PAI_ENABLED).toBe("1");
		expect(o.env.PATH).toBe("/usr/bin");
	});

	test("oppdateringssjekken er av, også når miljøet sier noe annet (#198)", () => {
		expect(o.env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
		expect(v2Oppstart("/r", {}, { OPENCODE_DISABLE_AUTOUPDATE: "0" }).env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
	});

	test("launcheren setter ikke PAI_HARNESS — adapteren gjør det i setup", () => {
		expect(o.env.PAI_HARNESS).toBeUndefined();
	});

	test("--prompt går til TUI-en som ett argument, og bare når den er gitt (#162)", () => {
		expect(o.args).not.toContain("--prompt");
		const p = v2Oppstart("/r", { prompt: "Read SETUP.md and follow it" }, {});
		expect(p.args.slice(-2)).toEqual(["--prompt", "Read SETUP.md and follow it"]);
		expect(p.args).toContain("--standalone");
	});

	test("PAI_OPENCODE2_BIN overstyrer binæren, flaggene står", () => {
		const f = v2Oppstart("/r", {}, { PAI_OPENCODE2_BIN: "/falsk" });
		expect(f.args).toEqual(["/falsk", "--standalone"]);
	});
});

describe("stiene finnes i repoet", () => {
	test("adapteren er en katalog med package.json", () => {
		expect(existsSync(join(v2Adapter(OPENCODE), "package.json"))).toBe(true);
	});

	test("v2Binær er der node_modules/.bin/opencode peker", () => {
		// `bun install` lager lenken. Peker den et annet sted, har pakken
		// flyttet binæren, og launcheren ville startet noe som ikke finnes.
		const lenke = join(OPENCODE, "node_modules", ".bin", "opencode");
		expect(realpathSync(lenke)).toBe(realpathSync(v2Binær(OPENCODE)));
	});
});

describe("pinningen (B3)", () => {
	const pkg = JSON.parse(readFileSync(join(OPENCODE, "package.json"), "utf-8"));

	for (const navn of ["@opencode/cli", "@opencode/plugin"]) {
		test(`${navn} er pinnet eksakt`, () => {
			expect(pkg.dependencies[navn]).toMatch(/^\d+\.\d+\.\d+$/);
		});
	}

	test("cli og plugin har samme versjon", () => {
		expect(pkg.dependencies["@opencode/plugin"]).toBe(pkg.dependencies["@opencode/cli"]);
	});

	test("postinstall er trustet, ellers nekter binæren å starte (MÅLT)", () => {
		expect(pkg.trustedDependencies).toContain("@opencode/cli");
	});

	test("adapteren står ikke i den delte plugin-nøkkelen (B2)", () => {
		const cfg = JSON.parse(readFileSync(join(OPENCODE, "opencode.json"), "utf-8"));
		const plugins: unknown[] = cfg.plugin ?? [];
		expect(plugins.some((p) => String(p).includes("opencode-v2"))).toBe(false);
	});
});

describe("ende til ende: pai.ts med en falsk binær", () => {
	const tmp = mkdtempSync(join(tmpdir(), "pai-launcher-"));
	const dir = join(tmp, "opencode");
	const falsk = join(tmp, "falsk-opencode");
	const ut = join(tmp, "startet.json");
	mkdirSync(dir);
	// Skriver argv og de relevante miljøvariablene, og avslutter.
	writeFileSync(
		falsk,
		`#!${process.execPath}
const e = process.env;
await Bun.write(${JSON.stringify(ut)}, JSON.stringify({
  args: process.argv.slice(2),
  PAI_ENABLED: e.PAI_ENABLED ?? null,
  PAI_HARNESS: e.PAI_HARNESS ?? null,
  OPENCODE_DISABLE_AUTOUPDATE: e.OPENCODE_DISABLE_AUTOUPDATE ?? null,
  OPENCODE_CONFIG_CONTENT: e.OPENCODE_CONFIG_CONTENT ?? null,
}));
process.exit(Number(e.FALSK_EXIT ?? 0));
`
	);
	chmodSync(falsk, 0o755);

	afterAll(() => rmSync(tmp, { recursive: true, force: true }));

	function kjørPai(args: string[], env: Record<string, string>) {
		rmSync(ut, { force: true });
		// PATH uten `~/.opencode/bin` og `~/.bun/bin`, så ingen ekte `opencode`
		// kan startes ved en feil.
		const p = Bun.spawnSync([process.execPath, PAI_TS, ...args], {
			cwd: tmp,
			stdin: "ignore",
			env: {
				PATH: "/usr/bin:/bin",
				HOME: tmp,
				OPENCODE_DIR: dir,
				PAI_OPENCODE2_BIN: falsk,
				...env,
			},
		});
		return {
			exitCode: p.exitCode,
			stderr: p.stderr.toString(),
			startet: existsSync(ut) ? JSON.parse(readFileSync(ut, "utf-8")) : null,
		};
	}

	test("pai --v2 -l starter v2 med --standalone og adapteren", () => {
		const r = kjørPai(["--v2", "-l"], {});
		expect(r.exitCode).toBe(0);
		expect(r.startet.args).toEqual(["--standalone"]);
		expect(r.startet.PAI_ENABLED).toBe("1");
		expect(r.startet.PAI_HARNESS).toBeNull();
		expect(r.startet.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
		expect(JSON.parse(r.startet.OPENCODE_CONFIG_CONTENT).plugin).toEqual([join(realpathSync(dir), "pai-adapters", "opencode-v2")]);
	});

	test("bare `pai` starter v2, uten PAI_MOTOR", () => {
		// Uten argumenter går `main` en egen vei (`cmdLaunch({})`), utenom
		// flaggparsingen. Og uten `-l` bytter den katalog til OPENCODE_DIR.
		const r = kjørPai([], {});
		expect(r.exitCode).toBe(0);
		expect(r.startet.args).toEqual(["--standalone"]);
	});

	test("pai -r -l gjenopptar i v2", () => {
		const r = kjørPai(["-r", "-l"], {});
		expect(r.exitCode).toBe(0);
		expect(r.startet.args).toEqual(["--standalone", "--continue"]);
	});

	test("pai -l --prompt <tekst> når v2-binæren, med teksten som ett argument (#162)", () => {
		const r = kjørPai(["-l", "--prompt", "Read /x/SETUP.md and follow it"], {});
		expect(r.exitCode).toBe(0);
		expect(r.startet.args).toEqual(["--standalone", "--prompt", "Read /x/SETUP.md and follow it"]);
	});

	test("pai --claude --prompt avvises før noe startes", () => {
		const r = kjørPai(["--claude", "--prompt", "hei"], {});
		expect(r.exitCode).not.toBe(0);
		expect(r.startet).toBeNull();
		expect(r.stderr).toContain("--prompt only applies to v2");
	});

	test("PAI_MOTOR=v1 har ingen virkning — variabelen leses ikke", () => {
		const r = kjørPai(["-l"], { PAI_MOTOR: "v1" });
		expect(r.exitCode).toBe(0);
		expect(r.startet.args).toEqual(["--standalone"]);
	});

	// M-51: launcheren avsluttet med 0 uansett hva motoren gjorde.
	test("pai gir motorens exitkode videre", () => {
		const r = kjørPai(["-l"], { FALSK_EXIT: "3" });
		expect(r.startet).not.toBeNull();
		expect(r.exitCode).toBe(3);
		// Uten argumenter er det en egen vei i `main`.
		expect(kjørPai([], { FALSK_EXIT: "4" }).exitCode).toBe(4);
	});

	test("pai --v1 avvises med meldingen, og ingenting startes", () => {
		const r = kjørPai(["--v1", "-l"], {});
		expect(r.exitCode).toBe(1);
		expect(r.startet).toBeNull();
		// Uten denne ville testen bestått på en hvilken som helst krasj.
		expect(r.stderr).toContain(V1_ER_SLETTET);
	});
});
