/**
 * Nøkkelsjekken: satt eller mangler, aldri verdiene (#162 fase 1)
 *
 * Det sjekken lover, er at en verdi fra `.env` aldri står i det den skriver.
 * Den siste testen kjører `pai keys` mot et temp-tre og leter etter verdiene i
 * utdataene. Malen testes også: en verdi i `.env.example` som brukeren kopierer
 * uendret, ville sjekken telt som en satt nøkkel.
 *
 * @module tests/nokkel-helse
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { lesMal, nøkkelHelse, satteNøkler } from "../.opencode/PAI/Tools/nokkel-helse";

const EKTE = join(import.meta.dir, "..", ".opencode");

let rot: string;
let tre: string;
let home: string;

beforeEach(() => {
	rot = mkdtempSync(join(tmpdir(), "nokkel-helse-"));
	tre = join(rot, ".opencode");
	home = join(rot, "home");
	mkdirSync(tre);
	mkdirSync(home);
	writeFileSync(join(tre, ".env.example"), "# topp\n# ## Første\nA_KEY=\nB_KEY=\n\n# ## Andre\n# C_KEY= er en kommentar\nD_KEY=\n");
});

afterEach(() => {
	rmSync(rot, { recursive: true, force: true });
});

function env(tekst: string, modus = 0o600): void {
	writeFileSync(join(tre, ".env"), tekst);
	chmodSync(join(tre, ".env"), modus);
}

describe("lesMal", () => {
	test("gruppene i rekkefølge, kommenterte nøkler er ikke nøkler", () => {
		expect(lesMal(readFileSync(join(tre, ".env.example"), "utf-8"))).toEqual([
			{ navn: "Første", nøkler: ["A_KEY", "B_KEY"] },
			{ navn: "Andre", nøkler: ["D_KEY"] },
		]);
	});

	test("nøkler før første gruppe havner i Other", () => {
		expect(lesMal("X=\n# ## G\nY=\n")).toEqual([
			{ navn: "Other", nøkler: ["X"] },
			{ navn: "G", nøkler: ["Y"] },
		]);
	});
});

describe("satteNøkler", () => {
	test("tom, tomme anførselstegn og kommentarer er ikke satt", () => {
		const s = satteNøkler('A=1\nB=\nC=""\n# D=1\nexport E=x\n  F = "y"\nG=\'\'\n');
		expect([...s].sort()).toEqual(["A", "E", "F"]);
	});

	test("en senere tom linje opphever en tidligere verdi", () => {
		expect(satteNøkler("A=1\nA=\n").has("A")).toBe(false);
	});
});

describe("nøkkelHelse", () => {
	test("satt og mangler per gruppe", () => {
		env("A_KEY=1\nD_KEY=2\n");
		const h = nøkkelHelse(tre, home);
		expect(h.grupper.map((g) => g.nøkler.filter((n) => n.satt).map((n) => n.navn))).toEqual([["A_KEY"], ["D_KEY"]]);
		expect(h.problemer).toEqual([]);
		expect(h.varsler).toEqual([]);
	});

	test("en .env andre kan lese, er et problem", () => {
		env("A_KEY=1\n", 0o644);
		expect(nøkkelHelse(tre, home).problemer).toEqual([`${join(tre, ".env")} is readable by others (644): chmod 600 ${join(tre, ".env")}`]);
	});

	test("nøkler som ikke står i malen, er en varsel med navnet", () => {
		env("A_KEY=1\nZ_KEY=2\nY_KEY=\n");
		const h = nøkkelHelse(tre, home);
		expect(h.ukjente).toEqual(["Z_KEY"]);
		expect(h.varsler).toEqual(["1 key(s) in .env are not in .env.example: Z_KEY"]);
	});

	test("~/.config/PAI/.env gir en varsel", () => {
		mkdirSync(join(home, ".config", "PAI"), { recursive: true });
		writeFileSync(join(home, ".config", "PAI", ".env"), "");
		expect(nøkkelHelse(tre, home).varsler[0]).toContain(".config/PAI/.env exists, but no tool reads it any more");
	});

	test("uten .env og uten mal: ingen problemer, én varsel om malen", () => {
		rmSync(join(tre, ".env.example"));
		const h = nøkkelHelse(tre, home);
		expect(h.envFinnes).toBe(false);
		expect(h.problemer).toEqual([]);
		expect(h.varsler).toEqual([`did not find ${join(tre, ".env.example")}: cannot tell which keys are missing`]);
	});
});

describe("den ekte malen", () => {
	const tekst = readFileSync(join(EKTE, ".env.example"), "utf-8");

	test("ingen nøkkel har en verdi, så en uendret kopi gir null satte", () => {
		expect([...satteNøkler(tekst)]).toEqual([]);
	});

	test("hver nøkkel står én gang, i en navngitt gruppe", () => {
		const grupper = lesMal(tekst);
		const alle = grupper.flatMap((g) => g.nøkler);
		expect(new Set(alle).size).toBe(alle.length);
		expect(grupper.map((g) => g.navn)).not.toContain("Other");
	});
});

describe("pai keys", () => {
	test("skriver navnene og aldri verdiene", () => {
		mkdirSync(join(tre, "PAI"));
		symlinkSync(join(EKTE, "PAI", "Tools"), join(tre, "PAI", "Tools"));
		const verdier = ["hemmelig-verdi-a1", "hemmelig-verdi-z9"];
		env(`A_KEY=${verdier[0]}\nZ_KEY="${verdier[1]}"\n`, 0o644);
		const r = Bun.spawnSync(["bun", join(EKTE, "PAI", "Tools", "pai.ts"), "keys"], {
			env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, OPENCODE_DIR: tre },
			stdout: "pipe",
			stderr: "pipe",
		});
		const ut = r.stdout.toString() + r.stderr.toString();
		expect(ut).toContain("✅ A_KEY");
		expect(ut).toContain("·  B_KEY");
		expect(ut).toContain("1 of 3 set");
		expect(ut).toContain("Z_KEY");
		for (const v of verdier) expect(ut).not.toContain(v);
		expect(r.exitCode).toBe(0);
	});
});
