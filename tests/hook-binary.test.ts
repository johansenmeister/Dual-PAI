/**
 * Kontrakt-tester for den kompilerte hook-binæren (batch 12)
 *
 * Tre ting må holdes i live her, og de har hver sin feilmodus:
 *
 *   1. **Ferskhetsvakten.** En stale binær kjører gammel sikkerhetskode
 *      stumt. Vakten må si fra — og må IKKE si fra når ingen binær finnes,
 *      for en advarsel som alltid står er en advarsel ingen leser.
 *   2. **Oppstarterens prioritet.** `bin/pai-hook` må velge `.bin` når den
 *      finnes og falle tilbake på kilden når den ikke gjør det. Faller
 *      fallbacken bort, er PAI av på et friskt klonet repo.
 *   3. **Kildelista.** `KILDEKATALOGER` avgjør hva vakten ser. En katalog som
 *      forsvinner fra lista gjør vakten verre enn ingen vakt: den melder
 *      «fersk» om noe som ikke er det.
 *
 * @module tests/hook-binary
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	BINÆRNAVN,
	KILDEKATALOGER,
	binærSti,
	nyesteKildeendring,
	repoRotFraPlugin,
	sjekkFerskhet,
} from "../claude-plugin/src/binaer";

const REPO = join(import.meta.dir, "..");

/** Bygg et minimalt falskt repo: <rot>/claude-plugin/{bin,src} + <rot>/.opencode/pai-core */
function lagFalsktRepo(navn: string): string {
	const rot = join("/tmp", `pai-binaer-test-${navn}-${process.pid}`);
	rmSync(rot, { recursive: true, force: true });
	for (const deler of KILDEKATALOGER) {
		mkdirSync(join(rot, ...deler), { recursive: true });
	}
	return rot;
}

/** Sett mtime på en fil til et gitt antall sekunder fra nå. */
function settAlder(sti: string, sekunderFraNå: number): void {
	const t = new Date(Date.now() + sekunderFraNå * 1000);
	utimesSync(sti, t, t);
}

describe("sjekkFerskhet", () => {
	test("ingen binær bygget → fersk, og finnes=false", () => {
		const rot = lagFalsktRepo("ingen");
		try {
			const f = sjekkFerskhet(rot);
			// Uten binær kjører oppstarteren kilden direkte. Da er ingenting
			// stale, og vakten skal tie.
			expect(f.finnes).toBe(false);
			expect(f.fersk).toBe(true);
		} finally {
			rmSync(rot, { recursive: true, force: true });
		}
	});

	test("binær nyere enn kilden → fersk", () => {
		const rot = lagFalsktRepo("fersk");
		try {
			const kilde = join(rot, ".opencode", "pai-core", "index.ts");
			writeFileSync(kilde, "export const x = 1;");
			settAlder(kilde, -60);

			const bin = binærSti(join(rot, "claude-plugin"));
			writeFileSync(bin, "#!/bin/sh\n");
			settAlder(bin, 0);

			const f = sjekkFerskhet(rot);
			expect(f.finnes).toBe(true);
			expect(f.fersk).toBe(true);
		} finally {
			rmSync(rot, { recursive: true, force: true });
		}
	});

	test("kilde nyere enn binæren → STALE", () => {
		const rot = lagFalsktRepo("stale");
		try {
			const bin = binærSti(join(rot, "claude-plugin"));
			writeFileSync(bin, "#!/bin/sh\n");
			settAlder(bin, -60);

			const kilde = join(rot, ".opencode", "pai-core", "index.ts");
			writeFileSync(kilde, "export const x = 1;");
			settAlder(kilde, 0);

			const f = sjekkFerskhet(rot);
			expect(f.finnes).toBe(true);
			expect(f.fersk).toBe(false);
			expect(f.nyesteKilde).toBeGreaterThan(f.bygget);
		} finally {
			rmSync(rot, { recursive: true, force: true });
		}
	});

	test("en endring i EN NØSTET katalog teller også", () => {
		// Den asymmetriske testen: uten rekursjon ville vakten sett bare
		// toppnivåfiler, og en endring i pai-core/handlers/ ville passert som
		// fersk. Det er nøyaktig den stille feilen vakten finnes for.
		const rot = lagFalsktRepo("nostet");
		try {
			const bin = binærSti(join(rot, "claude-plugin"));
			writeFileSync(bin, "#!/bin/sh\n");
			settAlder(bin, -60);

			const dypt = join(rot, ".opencode", "pai-core", "handlers");
			mkdirSync(dypt, { recursive: true });
			const kilde = join(dypt, "security-validator.ts");
			writeFileSync(kilde, "export const x = 1;");
			settAlder(kilde, 0);

			expect(sjekkFerskhet(rot).fersk).toBe(false);
		} finally {
			rmSync(rot, { recursive: true, force: true });
		}
	});

	test("kun .ts teller — en ny loggfil gjør ikke binæren stale", () => {
		const rot = lagFalsktRepo("kunts");
		try {
			const bin = binærSti(join(rot, "claude-plugin"));
			writeFileSync(bin, "#!/bin/sh\n");
			settAlder(bin, -60);

			const støy = join(rot, "claude-plugin", "src", "notater.md");
			writeFileSync(støy, "# ikke kildekode");
			settAlder(støy, 0);

			expect(sjekkFerskhet(rot).fersk).toBe(true);
		} finally {
			rmSync(rot, { recursive: true, force: true });
		}
	});
});

describe("KILDEKATALOGER", () => {
	test("hver katalog finnes faktisk i repoet", () => {
		// Vakten ser kun det denne lista peker på. Flyttes en kilde uten at
		// lista følger med, melder vakten «fersk» om noe som ikke er det —
		// verre enn ingen vakt.
		for (const deler of KILDEKATALOGER) {
			expect(existsSync(join(REPO, ...deler))).toBe(true);
		}
	});

	test("lista dekker de tre kildene hooken faktisk bygges av", () => {
		const flate = KILDEKATALOGER.map((d) => d.join("/"));
		expect(flate).toContain("claude-plugin/bin");
		expect(flate).toContain("claude-plugin/src");
		expect(flate).toContain(".opencode/pai-core");
	});

	test("nyesteKildeendring finner noe i det ekte repoet", () => {
		expect(nyesteKildeendring(REPO)).toBeGreaterThan(0);
	});
});

describe("repoRotFraPlugin", () => {
	test("går ett hakk opp fra plugin-roten", () => {
		expect(repoRotFraPlugin("/home/x/repos/pai/claude-plugin")).toBe("/home/x/repos/pai");
	});
});

describe("bin/pai-hook — oppstarterens prioritet", () => {
	/** Lag en kjørbar stubb som skriver en markør, så vi ser hvem som ble valgt. */
	function stubb(sti: string, markør: string): void {
		writeFileSync(sti, `#!/bin/sh\nprintf '${markør}'\n`);
		chmodSync(sti, 0o755);
	}

	/** Kopier den EKTE oppstarteren til et tomt tre, så testen måler fila i repoet. */
	async function riggOppstarter(navn: string): Promise<string> {
		const rot = join("/tmp", `pai-oppstarter-${navn}-${process.pid}`);
		rmSync(rot, { recursive: true, force: true });
		mkdirSync(join(rot, "bin"), { recursive: true });
		const oppstarter = join(rot, "bin", "pai-hook");
		writeFileSync(oppstarter, await Bun.file(join(REPO, "claude-plugin", "bin", "pai-hook")).text());
		chmodSync(oppstarter, 0o755);
		return rot;
	}

	test("velger .bin når den finnes", async () => {
		const rot = await riggOppstarter("medbin");
		try {
			const oppstarter = join(rot, "bin", "pai-hook");
			stubb(join(rot, "bin", BINÆRNAVN), "FRA-BINAER");

			const p = Bun.spawnSync([oppstarter], {
				env: { ...process.env, CLAUDE_PLUGIN_ROOT: rot },
			});
			expect(new TextDecoder().decode(p.stdout)).toBe("FRA-BINAER");
		} finally {
			rmSync(rot, { recursive: true, force: true });
		}
	});

	test("faller tilbake på kilden når .bin mangler", async () => {
		// Fallbacken er grunnen til at et friskt klonet repo virker uten å
		// bygge noe. Forsvinner den, er PAI av på en ny maskin.
		const rot = await riggOppstarter("utenbin");
		try {
			const oppstarter = join(rot, "bin", "pai-hook");
			// Ingen .bin. Legg en pai-hook.ts som bun kan kjøre.
			writeFileSync(join(rot, "bin", "pai-hook.ts"), 'process.stdout.write("FRA-KILDEN");');

			const p = Bun.spawnSync([oppstarter], {
				env: { ...process.env, CLAUDE_PLUGIN_ROOT: rot },
				stdin: new Blob([""]),
			});
			expect(new TextDecoder().decode(p.stdout)).toBe("FRA-KILDEN");
		} finally {
			rmSync(rot, { recursive: true, force: true });
		}
	});
});

describe("binæren er gitignorert", () => {
	test(".gitignore dekker claude-plugin/bin/*.bin", async () => {
		// 81 MB i git ville vært en engangsfeil ingen får ryddet opp i.
		const ignore = await Bun.file(join(REPO, ".gitignore")).text();
		expect(ignore).toContain("claude-plugin/bin/*.bin");
	});
});

describe("stale-varselet er KOBLET OPP i SessionStart", () => {
	/**
	 * Ende-til-ende gjennom den ekte dispatcheren.
	 *
	 * Grunnen til at denne finnes: en mutasjonstest 2026-09-22 koblet
	 * `medStaleVarsel` fra kallstedet, og HELE suiten på 494 tester forble
	 * grønn. Funksjonen kunne altså vært død kode uten at noe falt — samme
	 * feilklasse som M-19 (foreldreløse ordlister) og K-08 (en gren som aldri
	 * kjørte). En vakt ingen test holder i live, er ingen vakt.
	 */
	async function kjørSessionStart(pluginRot: string, paiHome: string): Promise<string> {
		const p = Bun.spawnSync(["bun", join(REPO, "claude-plugin", "bin", "pai-hook.ts")], {
			env: {
				...process.env,
				CLAUDE_PLUGIN_ROOT: pluginRot,
				PAI_HOME: paiHome,
				PAI_LOG_PATH: join(paiHome, "debug.log"),
			},
			stdin: new Blob([
				JSON.stringify({
					session_id: "stale-test",
					transcript_path: "/tmp/x",
					cwd: paiHome,
					hook_event_name: "SessionStart",
					source: "startup",
				}),
			]),
		});
		return new TextDecoder().decode(p.stdout);
	}

	/** Rigg et tre som SER UT som repoet: <rot>/claude-plugin + <rot>/.opencode/pai-core */
	function riggTre(navn: string): { repoRot: string; pluginRot: string; paiHome: string } {
		const repoRot = join("/tmp", `pai-stale-e2e-${navn}-${process.pid}`);
		rmSync(repoRot, { recursive: true, force: true });
		for (const deler of KILDEKATALOGER) mkdirSync(join(repoRot, ...deler), { recursive: true });
		const paiHome = join(repoRot, ".opencode");
		mkdirSync(join(paiHome, "MEMORY", "STATE"), { recursive: true });
		return { repoRot, pluginRot: join(repoRot, "claude-plugin"), paiHome };
	}

	test("STALE binær → systemMessage når brukeren", async () => {
		const { repoRot, pluginRot, paiHome } = riggTre("stale");
		try {
			const bin = binærSti(pluginRot);
			writeFileSync(bin, "#!/bin/sh\n");
			settAlder(bin, -120);

			const kilde = join(repoRot, ".opencode", "pai-core", "index.ts");
			writeFileSync(kilde, "export const x = 1;");
			settAlder(kilde, 0);

			const ut = await kjørSessionStart(pluginRot, paiHome);
			const svar = JSON.parse(ut) as { systemMessage?: string };
			expect(svar.systemMessage).toBeDefined();
			expect(svar.systemMessage).toContain("pai claude sync");
		} finally {
			rmSync(repoRot, { recursive: true, force: true });
		}
	});

	test("FERSK binær → ingen systemMessage", async () => {
		// Asymmetrien som gjør testen over verdt noe: uten denne ville en
		// implementasjon som ALLTID varsler også bestått.
		const { repoRot, pluginRot, paiHome } = riggTre("fersk");
		try {
			const kilde = join(repoRot, ".opencode", "pai-core", "index.ts");
			writeFileSync(kilde, "export const x = 1;");
			settAlder(kilde, -120);

			const bin = binærSti(pluginRot);
			writeFileSync(bin, "#!/bin/sh\n");
			settAlder(bin, 0);

			const ut = await kjørSessionStart(pluginRot, paiHome);
			expect((JSON.parse(ut) as { systemMessage?: string }).systemMessage).toBeUndefined();
		} finally {
			rmSync(repoRot, { recursive: true, force: true });
		}
	});

	test("INGEN binær → ingen systemMessage", async () => {
		const { repoRot, pluginRot, paiHome } = riggTre("ingen");
		try {
			const ut = await kjørSessionStart(pluginRot, paiHome);
			expect((JSON.parse(ut) as { systemMessage?: string }).systemMessage).toBeUndefined();
		} finally {
			rmSync(repoRot, { recursive: true, force: true });
		}
	});
});
