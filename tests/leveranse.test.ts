/**
 * Kontrakt-test: `lev_jobb_markorer` i `docs/jobb-harness/leveranse.sh` (#290)
 *
 * Leveransen av #222 ble portet, røyktestet og testet før jobbens pre-push
 * stoppet en tillagt testlinje med hjemmeorganisasjonens navn (K21). Funksjonen
 * finner slike linjer før portingen, med samme regex som pre-push, og skal
 * være enig med den: summen teller, store og små bokstaver skilles, og det
 * jobben ikke får (`LEV_JOBB_UTELAT`), teller ikke.
 *
 * `docs/jobb-harness/` følger ikke med jobben eller kopiene, så testen hoppes
 * over der.
 *
 * @module tests/leveranse
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const LEVERANSE = join(import.meta.dir, "..", "docs", "jobb-harness", "leveranse.sh");
const PRE_PUSH = join(import.meta.dir, "..", "docs", "jobb-harness", "hooks", "pre-push");

/** Den første markøren i pre-push, så testen følger lista der. */
const markør = (): string => {
	const m = readFileSync(PRE_PUSH, "utf8").match(/^MARKORER='([^|']+)/m);
	if (!m?.[1]) throw new Error("fant ikke MARKORER i pre-push");
	return m[1].replaceAll("\\", "");
};

describe.skipIf(!existsSync(LEVERANSE))("lev_jobb_markorer (#290)", () => {
	let repo = "";
	const git = (...a: string[]): string => {
		const p = Bun.spawnSync(["git", "-C", repo, ...a], {
			env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
		});
		if (p.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${p.stderr}`);
		return p.stdout.toString().trim();
	};
	const commit = (filer: Record<string, string>): string => {
		for (const [f, innhold] of Object.entries(filer)) {
			mkdirSync(dirname(join(repo, f)), { recursive: true });
			writeFileSync(join(repo, f), innhold);
		}
		git("add", "-A");
		git("commit", "-qm", "c");
		return git("rev-parse", "HEAD");
	};
	const markorer = (fra: string, til: string): string[] => {
		const p = Bun.spawnSync(["bash", "-c", `. "${LEVERANSE}" && lev_jobb_markorer "$1" "$2" "$3"`, "_", repo, fra, til]);
		if (p.exitCode !== 0) throw new Error(`lev_jobb_markorer: ${p.stderr}`);
		return p.stdout.toString().split("\n").filter(Boolean);
	};

	beforeAll(() => {
		repo = mkdtempSync(join(tmpdir(), "pai-leveranse-"));
		git("init", "-q");
	});
	afterAll(() => rmSync(repo, { recursive: true, force: true }));

	test("en tillagt linje med en markør, med fil og linje", () => {
		const fra = commit({ "tests/a.test.ts": "const a = 1;\n" });
		const til = commit({ "tests/a.test.ts": `const a = 1;\nconst url = "repos/${markør()}/pai";\n` });
		expect(markorer(fra, til)).toEqual([`tests/a.test.ts: const url = "repos/${markør()}/pai";`]);
	});

	test("en markør fra den første av to commits er med", () => {
		const fra = commit({ "f.ts": "x\n" });
		commit({ "f.ts": `x\n${markør()}\n` });
		const til = commit({ "g.ts": "y\n" });
		expect(markorer(fra, til)).toEqual([`f.ts: ${markør()}`]);
	});

	test("summen teller: en markør som en senere commit fjerner, stopper ikke", () => {
		const fra = commit({ "b.ts": "x\n" });
		commit({ "b.ts": `x\n${markør()}\n` });
		const til = commit({ "b.ts": "x\nlab\n" });
		expect(markorer(fra, til)).toEqual([]);
	});

	test("det jobben ikke får (LEV_JOBB_UTELAT), teller ikke", () => {
		const fra = commit({ "c.ts": "x\n" });
		const til = commit({ "docs/dual-harness/handoff.md": `${markør()}\n`, "guide/x.md": `${markør()}\n` });
		expect(markorer(fra, til)).toEqual([]);
	});

	test("store og små bokstaver skilles, som i pre-push", () => {
		const fra = commit({ "d.ts": "x\n" });
		const til = commit({ "d.ts": `x\n${markør().toUpperCase()}\n` });
		expect(markorer(fra, til)).toEqual([]);
	});

	test("en fjernet linje med en markør teller ikke", () => {
		const fra = commit({ "e.ts": `${markør()}\n` });
		const til = commit({ "e.ts": "ren\n" });
		expect(markorer(fra, til)).toEqual([]);
	});
});

describe.skipIf(!existsSync(LEVERANSE))("lev_kopi_kilde", () => {
	let repo = "";
	const git = (...a: string[]): void => {
		const p = Bun.spawnSync(["git", "-C", repo, ...a], {
			env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
		});
		if (p.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${p.stderr}`);
	};
	const kilde = (): string =>
		Bun.spawnSync(["bash", "-c", `. "${LEVERANSE}" && lev_kopi_kilde "$1"`, "_", repo]).stdout.toString().trim();

	beforeAll(() => {
		repo = mkdtempSync(join(tmpdir(), "pai-leveranse-kilde-"));
		git("init", "-q");
	});
	afterAll(() => rmSync(repo, { recursive: true, force: true }));

	test("uten bygge-commit: ingenting", () => {
		git("commit", "-q", "--allow-empty", "-m", "start");
		expect(kilde()).toBe("");
	});

	test("bygge-commiten øverst: kilden i meldingen", () => {
		git("commit", "-q", "--allow-empty", "-m", "chore: oppdatert fra PAI abc1234 (1 commit)");
		expect(kilde()).toBe("abc1234");
	});

	test("en håndredigering på toppen: fortsatt den nyeste bygge-commitens kilde", () => {
		git("commit", "-q", "--allow-empty", "-m", "Update README.md");
		expect(kilde()).toBe("abc1234");
	});
});

describe.skipIf(!existsSync(LEVERANSE))("lev_kopi_ulevert per kopi (#281)", () => {
	let repo = "";
	let fra = "";
	const git = (...a: string[]): string => {
		const p = Bun.spawnSync(["git", "-C", repo, ...a], {
			env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
		});
		if (p.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${p.stderr}`);
		return p.stdout.toString().trim();
	};
	const commit = (emne: string, filer: string[]): void => {
		for (const f of filer) {
			mkdirSync(dirname(join(repo, f)), { recursive: true });
			writeFileSync(join(repo, f), `${emne}\n`);
		}
		git("add", "-A");
		git("commit", "-qm", emne);
	};
	const ulevert = (kopi: string): string[] => {
		const p = Bun.spawnSync(["bash", "-c", `. "${LEVERANSE}" && lev_kopi_ulevert "$1" HEAD "$2" "$3"`, "_", repo, fra, kopi]);
		if (p.exitCode !== 0) throw new Error(`lev_kopi_ulevert: ${p.stderr}`);
		return p.stdout
			.toString()
			.split("\n")
			.filter(Boolean)
			.map((l) => l.slice(41))
			.sort();
	};

	beforeAll(() => {
		repo = mkdtempSync(join(tmpdir(), "pai-leveranse-kopi-"));
		git("init", "-q");
		commit("start", ["docs/kopiene/README.public.md", "docs/kopiene/README.privat.md", "docs/kjoreplan/plan.md", "docs/kjoreplan/public-en.tsv", "runbooks/a.md", "a.ts"]);
		fra = git("rev-parse", "HEAD");
		commit("planen", ["docs/kjoreplan/plan.md", "docs/harness-vedlikehold/plan.md"]);
		commit("runbook", ["runbooks/a.md"]);
		commit("handoveren", ["docs/dual-harness/handoff.md"]);
		commit("readme-public", ["docs/kopiene/README.public.md"]);
		commit("bildene", ["docs/kopiene/bilder/hero.svg"]);
		commit("readme-privat", ["docs/kopiene/README.privat.md"]);
		commit("oversettelsen", ["docs/kjoreplan/public-en.tsv"]);
		commit("koden", ["a.ts"]);
	});
	afterAll(() => rmSync(repo, { recursive: true, force: true }));

	test("public: bare det som former public", () => {
		expect(ulevert("pai-harness-public")).toEqual(["bildene", "koden", "oversettelsen", "readme-public"]);
	});

	test("den private: alt utenom handoveren, som før", () => {
		expect(ulevert("pai-harness")).toEqual(["bildene", "koden", "oversettelsen", "planen", "readme-privat", "readme-public", "runbook"]);
	});

	test("uten kopi: som den private", () => {
		expect(ulevert("")).toEqual(ulevert("pai-harness"));
	});
});

describe.skipIf(!existsSync(LEVERANSE))("lev_feil_identitet og lev_sett_identitet (#249)", () => {
	const JOBB = "jobb@example.com";
	const HJEMME = "hjemme@example.com";
	let repo = "";
	const git = (env: Record<string, string>, ...a: string[]): string => {
		const p = Bun.spawnSync(["git", "-C", repo, ...a], { env: { ...process.env, ...env } });
		if (p.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${p.stderr}`);
		return p.stdout.toString().trim();
	};
	const som = (epost: string) => ({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: epost, GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: epost });
	const commit = (epost: string, emne: string): string => {
		writeFileSync(join(repo, "f.txt"), `${emne}\n`);
		git(som(epost), "add", "-A");
		git(som(epost), "commit", "-qm", emne);
		return git({}, "rev-parse", "HEAD");
	};
	const bash = (kall: string, ...a: string[]): string => {
		const p = Bun.spawnSync(["bash", "-c", `. "${LEVERANSE}" && ${kall}`, "_", repo, ...a]);
		if (p.exitCode !== 0) throw new Error(`${kall}: ${p.stderr}`);
		return p.stdout.toString().trim();
	};

	beforeAll(() => {
		repo = mkdtempSync(join(tmpdir(), "pai-leveranse-id-"));
		git({}, "init", "-q");
		git({}, "config", "user.name", "t");
		git({}, "config", "user.email", JOBB);
	});
	afterAll(() => rmSync(repo, { recursive: true, force: true }));

	test("alt rent: ingenting", () => {
		const dev = commit(JOBB, "dev");
		commit(JOBB, "portet");
		expect(bash('lev_feil_identitet "$1" "$2" "$3"', dev, JOBB)).toBe("");
	});

	test("en håndfortsatt commit med hjemmes identitet og markør: settes på nytt, og resten står", () => {
		const dev = commit(JOBB, "dev2");
		const portet = commit(JOBB, "portet2");
		commit(HJEMME, `fortsatt for hånd, fra ${markør()}`);
		commit(JOBB, "etter");
		expect(bash('lev_feil_identitet "$1" "$2" "$3"', dev, JOBB)).toBe(portet);
		bash('lev_sett_identitet "$1" "$2"', portet);
		expect(git({}, "log", "--format=%ae %ce", `${dev}..HEAD`).split("\n")).toEqual(Array(3).fill(`${JOBB} ${JOBB}`));
		expect(git({}, "log", "-1", "--format=%s", "HEAD~1")).toBe("fortsatt for hånd, fra [hjemme]");
		expect(git({}, "rev-parse", "HEAD~2")).toBe(portet);
		expect(bash('lev_feil_identitet "$1" "$2" "$3"', dev, JOBB)).toBe("");
	});

	test("bare hjemmes identitet er nok, med en ren melding", () => {
		const dev = commit(JOBB, "dev4");
		commit(HJEMME, "ren melding");
		expect(bash('lev_feil_identitet "$1" "$2" "$3"', dev, JOBB)).toBe(dev);
	});

	test("bare markør i meldingen er nok", () => {
		const dev = commit(JOBB, "dev3");
		commit(JOBB, `melding med ${markør()}`);
		expect(bash('lev_feil_identitet "$1" "$2" "$3"', dev, JOBB)).toBe(dev);
	});
});
