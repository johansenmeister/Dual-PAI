/**
 * Selvtesten for OpenCode v2: K4, K9, K11, K13 og K27 i launcheren, K6 i adapteren.
 * For begge motorene: K40 (launcheren bygger fra sitt eget tre).
 * For Claude Code: C1 (pinningen og selvoppdateringen), C2 (kvitteringen) og K36.
 *
 * Hver sjekk bevises i BEGGE retninger: den slår ut når noe er galt, og den er
 * taus når alt er riktig. En selvtest som roper feil, er verre enn ingen
 * (M-23/M-24 gjorde `integrity-check` verdiløs med to permanente falske
 * alarmer). Ende-til-ende-delen kjører den ekte `pai.ts` mot en falsk
 * `.opencode/` der «binæren» er `/bin/echo`: en ekte ELF som skriver ut
 * argumentene, så testen ser at motoren ble startet.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	adapterHash,
	claudeAdapterFiler,
	claudeInstallKommando,
	erKjørbarBinær,
	installertClaude,
	installertClaudeVersjon,
	installertVersjon,
	kvitteringSti,
	lesClaudeKvittering,
	lesKvittering,
	pinnetClaudeVersjon,
	pinnetVersjon,
	selvtestClaude,
	selvtestV2,
	sjekkAutoOppdatering,
	sjekkBinær,
	sjekkClaudePinning,
	sjekkClaudeRøyktest,
	sjekkPinning,
	sjekkPluginRester,
	sjekkTreet,
	sjekkV1Binær,
	skrivClaudeKvittering,
	skrivKvittering,
	v1InstallSti,
	v2AdapterFiler,
} from "../.opencode/PAI/Tools/selvtest";
import adapter from "../.opencode/pai-adapters/opencode-v2";
import { SUBAGENT_PREFIKS } from "../.opencode/pai-adapters/opencode-v2/buss";
import { agentfiler, agentVarsel, primæreAgenter, REPO_AGENTER } from "../.opencode/pai-adapters/opencode-v2/selvtest";

const REPO = join(import.meta.dir, "..");
const PAI_TS = join(REPO, ".opencode", "PAI", "Tools", "pai.ts");
/** 229 byte tekst, som plassholderen `bun install` lot ligge i fase 7. */
const PLASSHOLDER = `#!/usr/bin/env node\n${"// postinstall was not run\n".repeat(8)}`;

const tmp = mkdtempSync(join(tmpdir(), "pai-selvtest-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let teller = 0;
/**
 * En `.opencode/` med pinning, installert pakke og binær. `binær` er en sti
 * det lenkes til, eller tekst som skrives som fil.
 */
function lagOpencode(o: { pinnet?: string; installert?: string; binær?: { lenke: string } | { tekst: string } }) {
	const dir = join(tmp, `oc-${teller++}`);
	const cli = join(dir, "node_modules", "@opencode", "cli");
	mkdirSync(join(cli, "bin"), { recursive: true });
	if (o.pinnet) {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "@opencode/cli": o.pinnet } }));
	}
	if (o.installert) writeFileSync(join(cli, "package.json"), JSON.stringify({ version: o.installert }));
	const bin = join(cli, "bin", "opencode.exe");
	if (o.binær && "lenke" in o.binær) symlinkSync(o.binær.lenke, bin);
	if (o.binær && "tekst" in o.binær) writeFileSync(bin, o.binær.tekst);
	return dir;
}

const kvittering = (versjon: string) => ({ versjon, dato: "2026-09-26", hooks: 10, sjekker: 33 });

/** En `claude` på PATH som lenker dit installeren eller npm legger den. */
function lagClaude(navn: string, mål: string[]): string {
	const rot = join(tmp, navn);
	const fil = join(rot, ...mål);
	mkdirSync(join(fil, ".."), { recursive: true });
	writeFileSync(fil, "#!/bin/sh\necho 9.9.9\n");
	chmodSync(fil, 0o755);
	mkdirSync(join(rot, "bin"));
	symlinkSync(fil, join(rot, "bin", "claude"));
	return join(rot, "bin");
}

describe("K9: binæren er en kjørbar binær", () => {
	test("en ELF er kjørbar", () => {
		expect(erKjørbarBinær("/bin/echo")).toBe(true);
	});

	test("plassholderen er det ikke, og launcheren stopper med reparasjonen", () => {
		const dir = lagOpencode({ binær: { tekst: PLASSHOLDER } });
		const melding = sjekkBinær(dir);
		expect(melding).toContain("is not executable");
		// Den MÅLTE reparasjonen. En vanlig `bun install` retter den ikke.
		expect(melding).toContain("rm -rf node_modules/@opencode/cli && bun install");
	});

	test("en binær som mangler, stopper også", () => {
		expect(sjekkBinær(lagOpencode({}))).toContain("The v2 binary is missing");
	});

	test("taus når binæren er ekte", () => {
		expect(sjekkBinær(lagOpencode({ binær: { lenke: "/bin/echo" } }))).toBeNull();
	});

	test("en tom fil og en fil på to byte er ikke kjørbare", () => {
		const tom = join(tmp, "tom");
		writeFileSync(tom, "");
		expect(erKjørbarBinær(tom)).toBe(false);
		const kort = join(tmp, "kort");
		writeFileSync(kort, "\x7fE");
		expect(erKjørbarBinær(kort)).toBe(false);
	});
});

describe("K4: installert er pinnet, og V2Smoke er kjørt mot den", () => {
	test("versjonene leses fra package.json, ikke fra binæren", () => {
		const dir = lagOpencode({ pinnet: "2.0.18", installert: "2.0.16" });
		expect(pinnetVersjon(dir)).toBe("2.0.18");
		expect(installertVersjon(dir)).toBe("2.0.16");
	});

	test("taus når installert, pinnet og kvitteringen stemmer", () => {
		const dir = lagOpencode({ pinnet: "2.0.18", installert: "2.0.18" });
		skrivKvittering(dir, kvittering("2.0.18"));
		expect(sjekkPinning(dir, "/repo")).toEqual([]);
	});

	test("installert ≠ pinnet gir bun install", () => {
		const dir = lagOpencode({ pinnet: "2.0.18", installert: "2.0.16" });
		skrivKvittering(dir, kvittering("2.0.18"));
		const v = sjekkPinning(dir, "/repo");
		expect(v).toHaveLength(1);
		expect(v[0]).toContain("installed 2.0.16, pinned 2.0.18");
		expect(v[0]).toContain("bun install");
	});

	test("en bump uten ny kvittering gir V2Smoke, med den gamle versjonen", () => {
		const dir = lagOpencode({ pinnet: "2.0.19", installert: "2.0.19" });
		skrivKvittering(dir, kvittering("2.0.18"));
		const v = sjekkPinning(dir, "/repo");
		expect(v).toHaveLength(1);
		expect(v[0]).toContain("has not passed against v2 2.0.19");
		expect(v[0]).toContain("receipt: 2.0.18");
		expect(v[0]).toContain("cd /repo && bun Tools/V2Smoke.ts");
	});

	test("ingen kvittering gir V2Smoke", () => {
		const dir = lagOpencode({ pinnet: "2.0.18", installert: "2.0.18" });
		expect(sjekkPinning(dir, "/repo")[0]).toContain("receipt: none");
	});

	test("kvitteringen skrives og leses tilbake", () => {
		const dir = lagOpencode({});
		skrivKvittering(dir, kvittering("2.0.18"));
		expect(lesKvittering(dir)).toEqual(kvittering("2.0.18"));
	});

	test("merknadene (K55) leses tilbake, og en ødelagt liste forkastes", () => {
		const dir = lagOpencode({});
		skrivKvittering(dir, { ...kvittering("2.0.18"), merknader: ["edit: ny nøkkel replaceAll"] });
		expect(lesKvittering(dir)?.merknader).toEqual(["edit: ny nøkkel replaceAll"]);
		writeFileSync(kvitteringSti(dir), JSON.stringify({ ...kvittering("2.0.18"), merknader: [1, "x"] }));
		expect(lesKvittering(dir)).toEqual(kvittering("2.0.18"));
	});

	test("uten pinning er det ingenting å sammenligne med", () => {
		expect(sjekkPinning(lagOpencode({ installert: "2.0.18" }), "/repo")).toEqual([]);
	});
});

describe("K4: repoets kvittering gjelder den pinnede versjonen", () => {
	// Vakten over vokter en bump på en maskin. Denne vokter repoet selv: en
	// commit som bumper pinningen uten en grønn røyktest, feiler her.
	test("kvitteringen i .opencode/ har den pinnede versjonen", () => {
		const oc = join(REPO, ".opencode");
		expect(lesKvittering(oc)?.versjon).toBe(pinnetVersjon(oc) as string);
	});
});

describe("C2: ClaudeSmoke er kjørt mot installert Claude Code", () => {
	test("installeren: versjonen leses fra lenkemålet, uten å starte noe", () => {
		// Skriptet sier 9.9.9; svarer funksjonen 2.1.283, ble det ikke startet.
		const bin = lagClaude("claude-installer", ["share", "claude", "versions", "2.1.283"]);
		expect(installertClaudeVersjon({ PATH: bin })).toBe("2.1.283");
	});

	test("npm: versjonen leses fra pakkens package.json", () => {
		const bin = lagClaude("claude-npm", ["lib", "node_modules", "@anthropic-ai", "claude-code", "cli.js"]);
		writeFileSync(join(tmp, "claude-npm", "lib", "node_modules", "@anthropic-ai", "claude-code", "package.json"), JSON.stringify({ version: "2.1.274" }));
		expect(installertClaudeVersjon({ PATH: bin })).toBe("2.1.274");
	});

	test("en ukjent sti avgjøres av --version, og uten claude er svaret null", () => {
		expect(installertClaudeVersjon({ PATH: lagClaude("claude-ukjent", ["opt", "claude"]) })).toBe("9.9.9");
		mkdirSync(join(tmp, "uten-claude"));
		expect(installertClaudeVersjon({ PATH: join(tmp, "uten-claude") })).toBeNull();
	});

	test("taus når kvitteringen har installert versjon", () => {
		const oc = lagOpencode({});
		skrivClaudeKvittering(oc, kvittering("2.1.283"));
		expect(lesClaudeKvittering(oc)?.versjon).toBe("2.1.283");
		expect(sjekkClaudeRøyktest(oc, "/repo", "2.1.283")).toEqual([]);
	});

	test("en annen versjon enn kvitteringens gir ClaudeSmoke, med begge versjonene", () => {
		const oc = lagOpencode({});
		skrivClaudeKvittering(oc, kvittering("2.1.283"));
		const v = sjekkClaudeRøyktest(oc, "/repo", "2.1.290");
		expect(v).toHaveLength(1);
		expect(v[0]).toContain("2.1.290");
		expect(v[0]).toContain("receipt: 2.1.283");
		expect(v[0]).toContain("cd /repo && bun Tools/ClaudeSmoke.ts");
	});

	test("ingen kvittering gir ClaudeSmoke; ukjent installert versjon gir ingenting", () => {
		const oc = lagOpencode({});
		expect(sjekkClaudeRøyktest(oc, "/repo", "2.1.283")[0]).toContain("receipt: none");
		expect(sjekkClaudeRøyktest(oc, "/repo", null)).toEqual([]);
	});

	test("selvtestClaude: PAI_CLAUDE_BIN slår den av, ellers følger den PATH", () => {
		const oc = lagOpencode({});
		const bin = lagClaude("claude-samlet", ["share", "claude", "versions", "2.1.290"]);
		// Settings-fila er med, så testen aldri leser brukerens ekte `~/.claude/`.
		const settings = join(tmp, "settings-samlet.json");
		writeFileSync(settings, JSON.stringify({ env: { DISABLE_AUTOUPDATER: "1" } }));
		expect(selvtestClaude(oc, "/repo", { PATH: bin, PAI_CLAUDE_BIN: "/x" }, settings).varsler).toEqual([]);
		expect(selvtestClaude(oc, "/repo", { PATH: bin }, settings).varsler).toEqual([
			expect.stringContaining("Claude Code 2.1.290"),
		]);
	});

	test("repoets kvittering finnes, og er fra en grønn kjøring", () => {
		const k = lesClaudeKvittering(join(REPO, ".opencode"));
		expect(k?.versjon).toMatch(/^\d+\.\d+\.\d+$/);
		expect(k?.hooks).toBeGreaterThan(0);
	});
});

describe("K13 og K36: kvitteringen gjelder adapterkoden", () => {
	/** Skriver filene (relativ sti → innhold) under `rot`. */
	function lagFiler(rot: string, filer: Record<string, string>): string {
		for (const [sti, innhold] of Object.entries(filer)) {
			mkdirSync(join(rot, sti, ".."), { recursive: true });
			writeFileSync(join(rot, sti), innhold);
		}
		return rot;
	}
	const V2 = { "pai-adapters/opencode-v2/index.ts": "export default 1;\n", "pai-adapters/opencode-v2/buss.ts": "// buss\n" };
	const CLAUDE = {
		"claude-plugin/src/adapter/in.ts": "// inn\n",
		"claude-plugin/bin/pai-hook": "#!/bin/sh\n",
		"claude-plugin/hooks/hooks.json": "{}\n",
		"claude-plugin/.mcp.json": "{}\n",
	};
	/** En `.opencode/` med v2-adapteren, pinnet og installert 2.0.18. */
	function lagV2(filer: Record<string, string> = V2): string {
		return lagFiler(lagOpencode({ pinnet: "2.0.18", installert: "2.0.18" }), filer);
	}
	const hashV2 = (oc: string) => adapterHash(oc, v2AdapterFiler(oc)) as string;

	test("hashen avhenger av relativ sti og innhold, ikke av roten eller rekkefølgen", () => {
		const a = lagV2();
		const b = lagV2();
		expect(hashV2(a)).toMatch(/^[0-9a-f]{64}$/);
		expect(hashV2(b)).toBe(hashV2(a));
		expect(adapterHash(a, [...v2AdapterFiler(a)].reverse())).toBe(hashV2(a));
		writeFileSync(join(b, "pai-adapters/opencode-v2/buss.ts"), "// buss endret\n");
		expect(hashV2(b)).not.toBe(hashV2(a));
		// Samme innhold under et annet navn er en annen adapter.
		const c = lagV2({ "pai-adapters/opencode-v2/index.ts": "export default 1;\n", "pai-adapters/opencode-v2/bus.ts": "// buss\n" });
		expect(hashV2(c)).not.toBe(hashV2(a));
	});

	test("ingen filer gir null, så selvtesten tier", () => {
		expect(adapterHash(tmp, [])).toBeNull();
		expect(adapterHash(tmp, [join(tmp, "finnes-ikke.ts")])).toBeNull();
	});

	test("Claude: pluginens kode og konfig er med, det genererte og den bygde binæren er ikke", () => {
		const rot = lagFiler(join(tmp, `k36-filer-${teller++}`), {
			...CLAUDE,
			"claude-plugin/bin/pai-hook.bin": "ELF",
			"claude-plugin/skills/a/SKILL.md": "# a\n",
			"claude-plugin/agents/b.md": "# b\n",
			"claude-plugin/skill-map.json": "{}\n",
		});
		const rel = claudeAdapterFiler(rot)
			.map((f) => f.slice(rot.length + 1))
			.sort();
		expect(rel).toEqual(Object.keys(CLAUDE).sort());
	});

	test("v2: taus når kvitteringen har adapterens hash", () => {
		const oc = lagV2();
		skrivKvittering(oc, { ...kvittering("2.0.18"), adapter: hashV2(oc) });
		expect(lesKvittering(oc)?.adapter).toBe(hashV2(oc));
		expect(sjekkPinning(oc, "/repo")).toEqual([]);
	});

	test("v2: en endret adapter gir V2Smoke, med datoen og kommandoen", () => {
		const oc = lagV2();
		skrivKvittering(oc, { ...kvittering("2.0.18"), adapter: hashV2(oc) });
		writeFileSync(join(oc, "pai-adapters/opencode-v2/index.ts"), "export default 2;\n");
		const v = sjekkPinning(oc, "/repo");
		expect(v).toHaveLength(1);
		expect(v[0]).toContain("the adapter as it is now");
		expect(v[0]).toContain("receipt 2026-09-26");
		expect(v[0]).toContain("cd /repo && bun Tools/V2Smoke.ts");
	});

	test("v2: en kvittering uten hash dekker ikke adapteren", () => {
		const oc = lagV2();
		skrivKvittering(oc, kvittering("2.0.18"));
		expect(sjekkPinning(oc, "/repo")).toEqual([expect.stringContaining("has no adapter hash")]);
	});

	test("v2: en bump sier fra om versjonen, ikke om adapteren i tillegg", () => {
		const oc = lagFiler(lagOpencode({ pinnet: "2.0.19", installert: "2.0.19" }), V2);
		skrivKvittering(oc, { ...kvittering("2.0.18"), adapter: "gammel" });
		const v = sjekkPinning(oc, "/repo");
		expect(v).toHaveLength(1);
		expect(v[0]).toContain("against v2 2.0.19");
	});

	test("Claude: taus med riktig hash, og ClaudeSmoke når pluginen er endret", () => {
		const rot = lagFiler(join(tmp, `k36-${teller++}`), CLAUDE);
		const oc = lagOpencode({});
		skrivClaudeKvittering(oc, { ...kvittering("2.1.283"), adapter: adapterHash(rot, claudeAdapterFiler(rot)) as string });
		expect(sjekkClaudeRøyktest(oc, rot, "2.1.283")).toEqual([]);
		writeFileSync(join(rot, "claude-plugin/hooks/hooks.json"), '{"hooks":{}}\n');
		const v = sjekkClaudeRøyktest(oc, rot, "2.1.283");
		expect(v).toHaveLength(1);
		expect(v[0]).toContain("the plugin as it is now");
		expect(v[0]).toContain(`cd ${rot} && bun Tools/ClaudeSmoke.ts`);
	});

	test("Claude: en kvittering uten hash dekker ikke pluginen; uten plugin tier den", () => {
		const rot = lagFiler(join(tmp, `k36-uten-${teller++}`), CLAUDE);
		const oc = lagOpencode({});
		skrivClaudeKvittering(oc, kvittering("2.1.283"));
		expect(sjekkClaudeRøyktest(oc, rot, "2.1.283")).toEqual([expect.stringContaining("has no adapter hash")]);
		expect(sjekkClaudeRøyktest(oc, "/repo", "2.1.283")).toEqual([]);
	});

	test("repoets kvitteringer har en hash, så røyktestene skriver den", () => {
		const oc = join(REPO, ".opencode");
		expect(lesKvittering(oc)?.adapter).toMatch(/^[0-9a-f]{64}$/);
		expect(lesClaudeKvittering(oc)?.adapter).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("C1: Claude Code er pinnet, og selvoppdateringen er av", () => {
	/** En `.opencode/` med `pai.claudeCode`, og eventuelt en Claude-kvittering. */
	function lagPinnet(pinnet: string | null, kvitteringFor?: string): string {
		const dir = join(tmp, `c1-${teller++}`);
		mkdirSync(dir);
		const pkg = { dependencies: { "@opencode/cli": "2.0.18" }, ...(pinnet ? { pai: { claudeCode: pinnet } } : {}) };
		writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
		if (kvitteringFor) skrivClaudeKvittering(dir, kvittering(kvitteringFor));
		return dir;
	}
	const installer = (versjon: string) => ({ versjon, form: "installer" as const });

	test("pinningen leses fra pai.claudeCode, og uten den er svaret null", () => {
		expect(pinnetClaudeVersjon(lagPinnet("2.1.283"))).toBe("2.1.283");
		expect(pinnetClaudeVersjon(lagPinnet(null))).toBeNull();
	});

	test("taus når installert, pinnet og kvitteringen stemmer", () => {
		expect(sjekkClaudePinning(lagPinnet("2.1.283", "2.1.283"), "/repo", installer("2.1.283"))).toEqual([]);
	});

	test("etter en pull av en bump: bare installasjonen, med kommandoen for installeren", () => {
		const v = sjekkClaudePinning(lagPinnet("2.1.290", "2.1.290"), "/repo", installer("2.1.283"));
		expect(v).toEqual(["Claude Code installed 2.1.283, pinned 2.1.290. Run: claude install 2.1.290"]);
	});

	test("selvoppdatert forbi pinningen gir installasjonen, ikke ClaudeSmoke", () => {
		// Kvitteringen gjelder pinningen, så det er installasjonen som er feil.
		const v = sjekkClaudePinning(lagPinnet("2.1.283", "2.1.283"), "/repo", installer("2.1.290"));
		expect(v).toHaveLength(1);
		expect(v[0]).toContain("Run: claude install 2.1.283");
	});

	test("en bump uten ny kvittering gir ClaudeSmoke mot den pinnede, med den gamle kvitteringen", () => {
		const v = sjekkClaudePinning(lagPinnet("2.1.290", "2.1.283"), "/repo", installer("2.1.290"));
		expect(v).toHaveLength(1);
		expect(v[0]).toContain("Claude Code 2.1.290");
		expect(v[0]).toContain("receipt: 2.1.283");
	});

	test("uten claude på maskinen gjelder bare kvitteringen mot pinningen", () => {
		expect(sjekkClaudePinning(lagPinnet("2.1.283", "2.1.283"), "/repo", null)).toEqual([]);
		expect(sjekkClaudePinning(lagPinnet("2.1.283"), "/repo", null)[0]).toContain("receipt: none");
	});

	test("uten pinning sammenlignes kvitteringen med installert, som før C1", () => {
		expect(sjekkClaudePinning(lagPinnet(null, "2.1.283"), "/repo", installer("2.1.283"))).toEqual([]);
		expect(sjekkClaudePinning(lagPinnet(null, "2.1.283"), "/repo", installer("2.1.290"))[0]).toContain("ClaudeSmoke");
	});

	test("kommandoen følger formen: installer, npm og apt", () => {
		expect(claudeInstallKommando("installer", "2.1.290")).toBe("claude install 2.1.290");
		expect(claudeInstallKommando("ukjent", "2.1.290")).toBe("claude install 2.1.290");
		expect(claudeInstallKommando("npm", "2.1.290")).toBe("npm install -g @anthropic-ai/claude-code@2.1.290");
		// Pakkekilden har hver versjon som `<versjon>-1`, og holdet må løftes for å bytte.
		const apt = claudeInstallKommando("apt", "2.1.290");
		expect(apt).toContain("claude-code=2.1.290-1");
		expect(apt).toContain("--allow-change-held-packages");
		expect(apt).toContain("apt-mark hold claude-code");
	});

	test("formen: installeren og npm fra stien, apt fra /usr/bin/claude, resten ukjent", () => {
		const katalog = join(tmp, "claude-apt");
		mkdirSync(katalog);
		const fil = join(katalog, "claude");
		writeFileSync(fil, "#!/bin/sh\necho '2.1.274 (Claude Code)'\n");
		chmodSync(fil, 0o755);
		expect(installertClaude({ PATH: katalog }, fil)).toEqual({ versjon: "2.1.274", form: "apt" });
		expect(installertClaude({ PATH: katalog }, "/usr/bin/claude")).toEqual({ versjon: "2.1.274", form: "ukjent" });
		const bin = lagClaude("claude-form", ["share", "claude", "versions", "2.1.283"]);
		expect(installertClaude({ PATH: bin })).toEqual({ versjon: "2.1.283", form: "installer" });
	});

	test("installerens ~/.local/bin/claude går foran PATH, som i launcheren", () => {
		const hjem = join(tmp, "hjem-c1");
		const lokal = lagClaude("claude-lokal", ["share", "claude", "versions", "2.1.283"]);
		mkdirSync(join(hjem, ".local"), { recursive: true });
		symlinkSync(lokal, join(hjem, ".local", "bin"));
		const path = lagClaude("claude-path", ["share", "claude", "versions", "2.1.290"]);
		expect(installertClaude({ HOME: hjem, PATH: path })?.versjon).toBe("2.1.283");
		expect(installertClaude({ HOME: join(tmp, "hjem-uten"), PATH: path })?.versjon).toBe("2.1.290");
	});

	describe("selvoppdateringen", () => {
		const settings = (innhold: string | null): string => {
			const sti = join(tmp, `settings-${teller++}.json`);
			if (innhold !== null) writeFileSync(sti, innhold);
			return sti;
		};
		const med = JSON.stringify({ env: { DISABLE_AUTOUPDATER: "1", PAI_CONTEXT: "1" } });
		const uten = JSON.stringify({ env: { PAI_CONTEXT: "1" }, model: "opus" });

		test("taus når DISABLE_AUTOUPDATER står i settings.json", () => {
			expect(sjekkAutoOppdatering("installer", {}, settings(med))).toEqual([]);
		});

		test("mangler den, sier den fra med pai claude sync", () => {
			const v = sjekkAutoOppdatering("installer", {}, settings(uten));
			expect(v).toHaveLength(1);
			expect(v[0]).toContain("DISABLE_AUTOUPDATER is missing");
			expect(v[0]).toContain("Run: pai claude sync");
		});

		test("uten env-blokk og uten fil sier den også fra", () => {
			expect(sjekkAutoOppdatering("npm", {}, settings(JSON.stringify({ model: "opus" })))[0]).toContain("pai claude sync");
			expect(sjekkAutoOppdatering("installer", {}, settings(null))[0]).toContain("does not exist");
		});

		test("taus når miljøet har den, for apt, og uten claude", () => {
			expect(sjekkAutoOppdatering("installer", { DISABLE_AUTOUPDATER: "1" }, settings(uten))).toEqual([]);
			expect(sjekkAutoOppdatering("apt", {}, settings(uten))).toEqual([]);
			expect(sjekkAutoOppdatering(null, {}, settings(uten))).toEqual([]);
		});

		test("en ødelagt settings-fil gir ingenting (i tvil: taus)", () => {
			expect(sjekkAutoOppdatering("installer", {}, settings("{ikke json"))).toEqual([]);
			expect(sjekkAutoOppdatering("installer", {}, settings(JSON.stringify({ env: "tull" })))).toEqual([]);
		});

		test("selvtestClaude tar den med, etter pinningen", () => {
			const oc = lagPinnet("2.1.283", "2.1.283");
			const bin = lagClaude("claude-c1", ["share", "claude", "versions", "2.1.283"]);
			expect(selvtestClaude(oc, "/repo", { PATH: bin }, settings(med)).varsler).toEqual([]);
			expect(selvtestClaude(oc, "/repo", { PATH: bin }, settings(uten)).varsler).toEqual([
				expect.stringContaining("DISABLE_AUTOUPDATER is missing"),
			]);
		});
	});
});

describe("C1: repoets pinning", () => {
	// Vokter repoet selv, som K4: en commit som bumper Claude-pinningen uten
	// en grønn ClaudeSmoke, eller som skriver en kvittering uten å bumpe, feiler.
	test("Claude-kvitteringen i .opencode/ har den pinnede versjonen", () => {
		const oc = join(REPO, ".opencode");
		expect(pinnetClaudeVersjon(oc)).toMatch(/^\d+\.\d+\.\d+$/);
		expect(lesClaudeKvittering(oc)?.versjon).toBe(pinnetClaudeVersjon(oc) as string);
	});
});

describe("K11: ingen v1-binær på maskinen", () => {
	const hjem = join(tmp, "hjem");
	const tomPath = join(tmp, "tom-path");
	mkdirSync(tomPath);

	test("taus uten v1-binær og uten opencode på PATH", () => {
		expect(sjekkV1Binær({ PATH: tomPath }, hjem)).toEqual([]);
	});

	test("v1-installasjonen i ~/.opencode/bin meldes, med rm", () => {
		const h = join(tmp, "hjem-v1");
		mkdirSync(join(h, ".opencode", "bin"), { recursive: true });
		writeFileSync(v1InstallSti(h), "v1");
		const v = sjekkV1Binær({ PATH: tomPath }, h);
		expect(v).toHaveLength(1);
		expect(v[0]).toContain(`rm ${v1InstallSti(h)}`);
	});

	test("en opencode-ai på PATH meldes, uten å startes", () => {
		const pkg = join(tmp, "npm", "node_modules", "opencode-ai", "bin");
		mkdirSync(pkg, { recursive: true });
		// Kaster hvis den startes: stien alene skal avgjøre.
		writeFileSync(join(pkg, "opencode"), "#!/bin/sh\nexit 99\n");
		chmodSync(join(pkg, "opencode"), 0o755);
		const p = join(tmp, "path-v1");
		mkdirSync(p);
		symlinkSync(join(pkg, "opencode"), join(p, "opencode"));
		expect(sjekkV1Binær({ PATH: p }, hjem)).toHaveLength(1);
	});

	test("v2 på PATH meldes ikke, og startes ikke", () => {
		// Stien avgjør. Uten den ville v2 svart riktig på `--version` også,
		// men til 300 ms per oppstart (regel 4): markøren beviser at ingenting
		// ble kjørt.
		const markør = join(tmp, "v2-ble-startet");
		const dir = lagOpencode({ binær: { tekst: `#!/bin/sh\ntouch ${markør}\necho "opencode v2.0.18"\n` } });
		const bin = join(dir, "node_modules", "@opencode", "cli", "bin", "opencode.exe");
		chmodSync(bin, 0o755);
		const p = join(tmp, "path-v2");
		mkdirSync(p);
		symlinkSync(bin, join(p, "opencode"));
		expect(sjekkV1Binær({ PATH: p }, hjem)).toEqual([]);
		expect(existsSync(markør)).toBe(false);
	});

	test("en ukjent opencode avgjøres av --version: 1.x meldes, 2.x ikke", () => {
		for (const [versjon, antall] of [
			["1.18.32", 1],
			["opencode v2.0.18", 0],
		] as const) {
			const p = join(tmp, `path-ukjent-${antall}`);
			mkdirSync(p);
			writeFileSync(join(p, "opencode"), `#!/bin/sh\necho "${versjon}"\n`);
			chmodSync(join(p, "opencode"), 0o755);
			expect(sjekkV1Binær({ PATH: p }, hjem)).toHaveLength(antall);
		}
	});
});

describe("K27: ingen rester i plugin-katalogene", () => {
	function kataloger(navn: string) {
		const dir = join(tmp, `k27-${navn}`, ".opencode");
		const config = join(tmp, `k27-${navn}`, "config", "opencode");
		mkdirSync(dir, { recursive: true });
		mkdirSync(config, { recursive: true });
		return { dir, config };
	}

	test("taus når ingen av katalogene finnes", () => {
		const { dir, config } = kataloger("ingen");
		expect(sjekkPluginRester(dir, config)).toEqual([]);
	});

	test("taus når katalogen finnes, men er tom", () => {
		const { dir, config } = kataloger("tom");
		mkdirSync(join(dir, "plugins"));
		mkdirSync(join(config, "plugins"));
		expect(sjekkPluginRester(dir, config)).toEqual([]);
	});

	test("v1s pai-unified.ts i .opencode/plugins meldes, med stien og mv", () => {
		const { dir, config } = kataloger("v1");
		mkdirSync(join(dir, "plugins", "handlers"), { recursive: true });
		writeFileSync(join(dir, "plugins", "pai-unified.ts"), "export default {}");
		const v = sjekkPluginRester(dir, config);
		expect(v).toHaveLength(1);
		expect(v[0]).toContain("handlers, pai-unified.ts");
		expect(v[0]).toContain(`mv ${join(dir, "plugins")}`);
	});

	test("den globale konfigkatalogen sjekkes også", () => {
		const { dir, config } = kataloger("global");
		mkdirSync(join(config, "plugins", "noe"), { recursive: true });
		expect(sjekkPluginRester(dir, config)[0]).toContain(join(config, "plugins"));
	});

	test("samme katalog gjennom en symlenke nevnes én gang", () => {
		// ~/.config/opencode → repo/.opencode, som på jobbmaskinene før overgangen.
		const { dir } = kataloger("lenke");
		mkdirSync(join(dir, "plugins", "rest"), { recursive: true });
		const lenke = join(tmp, "k27-lenke", "config-lenke");
		symlinkSync(dir, lenke);
		expect(sjekkPluginRester(dir, lenke)).toHaveLength(1);
	});
});

describe("selvtestV2 samlet", () => {
	test("K27 går gjennom selvtesten, med konfigkatalogen fra XDG_CONFIG_HOME", () => {
		const dir = lagOpencode({ binær: { lenke: "/bin/echo" } });
		const xdg = join(tmp, "k27-xdg");
		mkdirSync(join(xdg, "opencode", "plugins", "rest"), { recursive: true });
		const s = selvtestV2(dir, "/repo", { PATH: "", HOME: join(tmp, "hjem"), XDG_CONFIG_HOME: xdg });
		expect(s.varsler.some((v) => v.includes(join(xdg, "opencode", "plugins")))).toBe(true);
	});

	test("PAI_OPENCODE2_BIN slår av alle sjekkene", () => {
		const dir = lagOpencode({ binær: { tekst: PLASSHOLDER } });
		expect(selvtestV2(dir, "/repo", { PAI_OPENCODE2_BIN: "/falsk" })).toEqual({ varsler: [] });
	});

	test("en plassholder stopper, og varslene sjekkes ikke", () => {
		const dir = lagOpencode({ pinnet: "2.0.18", binær: { tekst: PLASSHOLDER } });
		const s = selvtestV2(dir, "/repo", { PATH: "", HOME: join(tmp, "hjem") });
		expect(s.stopp).toContain("is not executable");
	});
});

describe("K40: launcheren bygger fra sitt eget tre", () => {
	const eget = join(REPO, ".opencode");

	test("taus når OPENCODE_DIR er det samme treet, også gjennom en symlenke", () => {
		expect(sjekkTreet(eget, eget, {})).toEqual([]);
		const lenke = join(tmp, "k40-lenke");
		symlinkSync(eget, lenke);
		expect(sjekkTreet(lenke, eget, {})).toEqual([]);
	});

	test("et annet tre gir én linje med begge stiene og kommandoen (M-45)", () => {
		const annet = lagOpencode({});
		const v = sjekkTreet(annet, eget, {});
		expect(v).toHaveLength(1);
		expect(v[0]).toContain(`The launcher is in ${realpathSync(eget)}, but PAI is loaded from ${realpathSync(annet)}`);
		expect(v[0]).toContain(`OPENCODE_DIR=${realpathSync(eget)} bun `);
	});

	test("taus når OPENCODE_DIR er satt med vilje, som i røyktestene", () => {
		expect(sjekkTreet(lagOpencode({}), eget, { OPENCODE_DIR: "/hvor/som/helst" })).toEqual([]);
	});

	test("taus når en av stiene ikke finnes (regel 1)", () => {
		expect(sjekkTreet(join(tmp, "finnes-ikke"), eget, {})).toEqual([]);
		expect(sjekkTreet(eget, join(tmp, "finnes-ikke"), {})).toEqual([]);
	});
});

describe("ende til ende: pai.ts gjennom selvtesten", () => {
	function kjørPai(dir: string, utenOpencodeDir = false) {
		const env: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: join(tmp, "hjem"), OPENCODE_DIR: dir };
		if (utenOpencodeDir) {
			// Som på en maskin: `~/.opencode` er en symlenke, og OPENCODE_DIR er ikke satt.
			const hjem = join(tmp, `hjem-${teller++}`);
			mkdirSync(hjem);
			symlinkSync(dir, join(hjem, ".opencode"));
			env.HOME = hjem;
			delete env.OPENCODE_DIR;
		}
		const p = Bun.spawnSync([process.execPath, PAI_TS, "-l"], {
			cwd: tmp,
			stdin: "ignore",
			env,
		});
		return { exitCode: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
	}

	test("alt i orden: taus, og motoren startes", () => {
		const dir = lagOpencode({ pinnet: "2.0.18", installert: "2.0.18", binær: { lenke: "/bin/echo" } });
		skrivKvittering(dir, kvittering("2.0.18"));
		const r = kjørPai(dir);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).not.toContain("PAI:");
		// `/bin/echo` skriver argumentene: motoren ble startet.
		expect(r.stdout).toContain("--standalone");
	});

	test("en plassholder: stopp med reparasjonen, og ingenting startes", () => {
		const dir = lagOpencode({ pinnet: "2.0.18", installert: "2.0.18", binær: { tekst: PLASSHOLDER } });
		const r = kjørPai(dir);
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("is not executable");
		expect(r.stdout).not.toContain("--standalone");
	});

	test("en bump uten røyktest: varsel, og motoren startes likevel uten å vente", () => {
		// stdin er ikke en terminal, så launcheren venter ikke på Enter.
		const dir = lagOpencode({ pinnet: "2.0.19", installert: "2.0.19", binær: { lenke: "/bin/echo" } });
		skrivKvittering(dir, kvittering("2.0.18"));
		const r = kjørPai(dir);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("PAI: V2Smoke has not passed against v2 2.0.19");
		expect(r.stdout).toContain("--standalone");
	});

	test("K40: ~/.opencode peker på et annet tre enn launcherens: varsel, og motoren startes", () => {
		const dir = lagOpencode({ pinnet: "2.0.18", installert: "2.0.18", binær: { lenke: "/bin/echo" } });
		skrivKvittering(dir, kvittering("2.0.18"));
		const r = kjørPai(dir, true);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain(`PAI: The launcher is in ${realpathSync(join(REPO, ".opencode"))}, but PAI is loaded from`);
		expect(r.stdout).toContain("--standalone");
	});
});

// ─── K6: agenter som ikke kan spawnes som subagent ─────────────────────────

describe("K6: de rene funksjonene", () => {
	test("agentfilene er navnene uten .md, og en katalog som mangler, gir ingenting", () => {
		const k = join(tmp, "agenter-a");
		mkdirSync(k);
		writeFileSync(join(k, "Engineer.md"), "");
		writeFileSync(join(k, "notat.txt"), "");
		expect(agentfiler([k, join(tmp, "finnes-ikke")])).toEqual(["Engineer"]);
	});

	test("repoets egne agenter finnes der selvtesten leter", () => {
		expect(agentfiler([REPO_AGENTER])).toContain("Engineer");
	});

	const liste = {
		data: [
			{ id: "build", mode: "primary" },
			{ id: "Engineer", mode: "all" },
			{ id: "egen", mode: "primary" },
		],
	};

	test("en agent med fil og mode primary meldes", () => {
		expect(primæreAgenter(liste, ["Engineer", "Egen"])).toEqual(["Egen"]);
	});

	test("motorens egne primæragenter meldes ikke, de har ingen fil", () => {
		expect(primæreAgenter(liste, ["Engineer"])).toEqual([]);
	});

	test("taus når alle agentene med fil har mode all", () => {
		expect(primæreAgenter({ data: [{ id: "Engineer", mode: "all" }] }, ["Engineer"])).toEqual([]);
		expect(agentVarsel([])).toBeNull();
	});

	test("et svar uten data er ingen agenter", () => {
		expect(primæreAgenter(undefined, ["Engineer"])).toEqual([]);
		expect(primæreAgenter({ data: "tull" }, ["Engineer"])).toEqual([]);
	});

	test("varselet nevner agenten og kuren", () => {
		const v = agentVarsel(["Egen"]) as string;
		expect(v).toContain("Egen");
		expect(v).toContain("mode: all");
	});
});

describe("K6: gjennom adapteren", () => {
	const lagret: Record<string, string | undefined> = {};
	const ekteFetch = globalThis.fetch;
	const cleanups: (() => Promise<void>)[] = [];
	const prosjekt = join(tmp, "prosjekt");

	beforeAll(() => {
		for (const k of ["PAI_HOME", "PAI_HARNESS", "PAI_LOG_PATH", "PAI_ENABLED"]) lagret[k] = process.env[k];
		process.env.PAI_HOME = join(tmp, "pai-home");
		process.env.PAI_LOG_PATH = join(tmp, "v2.log");
		delete process.env.PAI_ENABLED;
		// `session.start` gjør en versjonssjekk mot GitHub. Ingen nett i test.
		globalThis.fetch = (async () => {
			throw new Error("ingen nett i test");
		}) as unknown as typeof fetch;
		mkdirSync(join(prosjekt, ".opencode", "agents"), { recursive: true });
		cpSync(join(REPO_AGENTER, "Intern.md"), join(prosjekt, ".opencode", "agents", "Egen.md"));
	});

	afterEach(() => {
		// `setup` setter PAI_HARNESS for hele prosessen.
		if (lagret.PAI_HARNESS === undefined) delete process.env.PAI_HARNESS;
		else process.env.PAI_HARNESS = lagret.PAI_HARNESS;
	});

	afterAll(async () => {
		for (const c of cleanups.splice(0)) await c();
		globalThis.fetch = ekteFetch;
		for (const [k, v] of Object.entries(lagret)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	async function oppsett(agenter: { id: string; mode: string }[] | "kast") {
		const registrert = new Map<string, (e: unknown) => Promise<void>>();
		const domene = (navn: string) => ({
			hook: async (hook: string, cb: (e: unknown) => Promise<void>) => {
				registrert.set(`${navn}.${hook}`, cb);
				return { dispose: async () => {} };
			},
		});
		let kall = 0;
		const ctx = {
			location: { directory: prosjekt },
			tool: domene("tool"),
			session: domene("session"),
			shell: domene("shell"),
			permission: domene("permission"),
			agent: {
				list: async () => {
					kall++;
					if (agenter === "kast") throw new Error("agentlista feilet");
					return { data: agenter };
				},
			},
			event: { subscribe: async function* () {} },
		};
		// biome-ignore lint/suspicious/noExplicitAny: falsk kontekst med bare domenene adapteren bruker
		cleanups.push((await adapter.setup(ctx as any)) as () => Promise<void>);
		const hook = (navn: string) => registrert.get(navn) as (e: unknown) => Promise<void>;
		return { hook, kall: () => kall };
	}

	async function kontekstEtterPrompt(hook: (n: string) => (e: unknown) => Promise<void>, sessionID: string) {
		await hook("session.prompt")({ sessionID, prompt: { text: "hei", files: [] } });
		const e = { sessionID, agent: "build", system: [] as { type: string; text: string }[] };
		await hook("session.context")(e);
		return e.system.map((d) => d.text);
	}

	test("en primær agent fra prosjektets agents/ når konteksten", async () => {
		const { hook } = await oppsett([
			{ id: "Egen", mode: "primary" },
			{ id: "build", mode: "primary" },
		]);
		const tekster = await kontekstEtterPrompt(hook, "ses_k6a");
		expect(tekster.some((t) => t.includes("PAI-selvtest") && t.includes("Egen"))).toBe(true);
		expect(tekster.some((t) => t.includes("build"))).toBe(false);
	});

	test("taus når agenten har mode all", async () => {
		const { hook } = await oppsett([{ id: "Egen", mode: "all" }]);
		const tekster = await kontekstEtterPrompt(hook, "ses_k6b");
		expect(tekster.some((t) => t.includes("PAI-selvtest"))).toBe(false);
	});

	test("motoren spørres én gang per prosess, ikke per tur", async () => {
		const { hook, kall } = await oppsett([{ id: "Egen", mode: "primary" }]);
		await kontekstEtterPrompt(hook, "ses_k6c");
		await kontekstEtterPrompt(hook, "ses_k6c");
		expect(kall()).toBe(1);
	});

	test("en barneøkts prompt kjører ikke sjekken", async () => {
		const { hook, kall } = await oppsett([{ id: "Egen", mode: "primary" }]);
		await hook("session.prompt")({
			sessionID: "ses_k6barn",
			prompt: { text: `${SUBAGENT_PREFIKS}\nGjør noe` },
		});
		expect(kall()).toBe(0);
	});

	test("en agentliste som kaster, velter ikke konteksten", async () => {
		const { hook, kall } = await oppsett("kast");
		expect(await kontekstEtterPrompt(hook, "ses_k6d")).toEqual([]);
		expect(kall()).toBe(1);
	});
});
