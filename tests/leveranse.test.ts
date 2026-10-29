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

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
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

describe.skipIf(!existsSync(LEVERANSE))("lev_jobb_utelat: Infrastructure skills the job gets (#380)", () => {
	let repo = "";
	const git = (...a: string[]): string => {
		const p = Bun.spawnSync(["git", "-C", repo, ...a], {
			env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
		});
		if (p.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${p.stderr}`);
		return p.stdout.toString().trim();
	};
	const commit = (files: Record<string, string>, remove: string[] = []): string => {
		for (const [f, content] of Object.entries(files)) {
			mkdirSync(dirname(join(repo, f)), { recursive: true });
			writeFileSync(join(repo, f), content);
		}
		for (const f of remove) git("rm", "-rq", f);
		git("add", "-A");
		git("commit", "-qm", "c");
		return git("rev-parse", "HEAD");
	};
	const bash = (script: string, ...args: string[]): string[] => {
		const p = Bun.spawnSync(["bash", "-c", `. "${LEVERANSE}" && ${script}`, "_", ...args]);
		if (p.exitCode !== 0) throw new Error(`${script}: ${p.stderr}`);
		return p.stdout.toString().split("\n").filter(Boolean);
	};
	const INFRA = ".opencode/skills/Infrastructure";

	beforeAll(() => {
		repo = mkdtempSync(join(tmpdir(), "pai-leveranse-infra-"));
		git("init", "-q");
		commit({
			[`${INFRA}/SKILL.md`]: "category\n",
			[`${INFRA}/Komodo/SKILL.md`]: "komodo\n",
			[`${INFRA}/Homelab/SKILL.md`]: "home\n",
			[`${INFRA}/Gone/SKILL.md`]: "old\n",
		});
		commit({}, [`${INFRA}/Gone`]);
	});
	afterAll(() => rmSync(repo, { recursive: true, force: true }));

	const infraExcludes = () => bash(`lev_jobb_utelat "$1"`, repo).filter((p) => p.startsWith(INFRA) || p.includes("skill-map"));

	test("every child of Infrastructure is excluded except the listed skills, a deleted one too", () => {
		expect(infraExcludes()).toEqual([
			`${INFRA}/Gone`,
			`${INFRA}/Homelab`,
			`${INFRA}/SKILL.md`,
			"claude-plugin/skill-map.json",
		]);
	});

	test("a new home skill is excluded until it is listed", () => {
		commit({ [`${INFRA}/Fresh/SKILL.md`]: "new\n" });
		expect(infraExcludes()).toContain(`${INFRA}/Fresh`);
		expect(infraExcludes()).not.toContain(`${INFRA}/Komodo`);
	});

	test("a marker in Komodo counts, one in a home skill does not", () => {
		const from = git("rev-parse", "HEAD");
		const to = commit({
			[`${INFRA}/Komodo/SKILL.md`]: `komodo\n${markør()}\n`,
			[`${INFRA}/Homelab/SKILL.md`]: `home\n${markør()}\n`,
		});
		expect(bash(`lev_jobb_markorer "$1" "$2" "$3"`, repo, from, to)).toEqual([`${INFRA}/Komodo/SKILL.md: ${markør()}`]);
	});

	test("git apply with Leveranse.sh's excludes keeps Komodo and drops the rest", () => {
		const to = commit({
			[`${INFRA}/Komodo/Workflows/Status.md`]: "deep\n",
			[`${INFRA}/Homelab/Workflows/Deep.md`]: "deep\n",
			"claude-plugin/skill-map.json": "{}\n",
		});
		const excludes = bash(`lev_jobb_utelat "$1"`, repo).flatMap((p) => [`--exclude=${p}`, `--exclude=${p}/*`]);
		const p = Bun.spawnSync(["bash", "-c", 'r=$1 h=$2; shift 2; git -C "$r" format-patch -1 --stdout "$h" | git apply --numstat "$@"', "_", repo, to, ...excludes]);
		const files = p.stdout.toString().split("\n").filter(Boolean).map((l) => l.split("\t")[2]);
		expect(files).toEqual([`${INFRA}/Komodo/Workflows/Status.md`]);
	});
});

describe.skipIf(!existsSync(LEVERANSE))("lev_testtall (#328)", () => {
	let dir = "";
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pai-leveranse-testtall-"));
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const counts = (log: string): string => {
		const file = join(dir, "test.log");
		writeFileSync(file, log);
		return Bun.spawnSync(["bash", "-c", `. "${LEVERANSE}" && lev_testtall "$1"`, "_", file]).stdout.toString().trim();
	};
	const esc = String.fromCharCode(27);

	test("without colour: the counts as before", () => {
		expect(counts("some output\n 12 pass\n 0 fail\n 30 expect() calls\n")).toBe("12 pass\n 0 fail");
	});

	test("with colour (FORCE_COLOR): the same counts", () => {
		const log = `${esc}[0m${esc}[32m 12 pass${esc}[0m\n${esc}[0m${esc}[2m 0 fail${esc}[0m\n${esc}[31m 1 error${esc}[0m\n`;
		expect(counts(log)).toBe("12 pass\n 0 fail\n 1 error");
	});

	test("no log: empty, not an error", () => {
		expect(Bun.spawnSync(["bash", "-c", `. "${LEVERANSE}" && lev_testtall /does/not/exist`]).stdout.toString()).toBe("");
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
	const source = (): string =>
		Bun.spawnSync(["bash", "-c", `. "${LEVERANSE}" && lev_kopi_kilde "$1"`, "_", repo]).stdout.toString().trim();

	beforeAll(() => {
		repo = mkdtempSync(join(tmpdir(), "pai-leveranse-kilde-"));
		git("init", "-q");
	});
	afterAll(() => rmSync(repo, { recursive: true, force: true }));

	test("no build commit: nothing", () => {
		git("commit", "-q", "--allow-empty", "-m", "start");
		expect(source()).toBe("");
	});

	test("build commit on top: the source in its message", () => {
		git("commit", "-q", "--allow-empty", "-m", "chore: oppdatert fra PAI abc1234 (1 commit)");
		expect(source()).toBe("abc1234");
	});

	test("a hand edit on top: still the newest build commit's source", () => {
		git("commit", "-q", "--allow-empty", "-m", "Update README.md");
		expect(source()).toBe("abc1234");
	});
});

describe.skipIf(!existsSync(LEVERANSE))("lev_kopi_kilde and lev_kopi_upushet against origin/main (#330)", () => {
	let dir = "";
	let clone = "";
	const git = (cwd: string, ...a: string[]): string => {
		const p = Bun.spawnSync(["git", "-C", cwd, ...a], {
			env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
		});
		if (p.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${p.stderr}`);
		return p.stdout.toString().trim();
	};
	const lev = (fn: string): string =>
		Bun.spawnSync(["bash", "-c", `. "${LEVERANSE}" && ${fn} "$1"`, "_", clone]).stdout.toString().trim();

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pai-leveranse-upushet-"));
		git(dir, "init", "-q", "--bare", "-b", "main", "remote.git");
		git(dir, "clone", "-q", join(dir, "remote.git"), "clone");
		clone = join(dir, "clone");
		git(clone, "commit", "-q", "--allow-empty", "-m", "chore: oppdatert fra PAI aaa1111 (1 commit)");
		git(clone, "push", "-q", "origin", "HEAD:main");
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test("all pushed: the source from origin/main, nothing unpushed", () => {
		expect(lev("lev_kopi_kilde")).toBe("aaa1111");
		expect(lev("lev_kopi_upushet")).toBe("");
	});

	test("a build commit that was never pushed does not count as delivered", () => {
		git(clone, "commit", "-q", "--allow-empty", "-m", "chore: oppdatert fra PAI bbb2222 (1 commit)");
		expect(lev("lev_kopi_kilde")).toBe("aaa1111");
		const unpushed = lev("lev_kopi_upushet").split("\n");
		expect(unpushed).toHaveLength(1);
		expect(unpushed[0].slice(41)).toBe("chore: oppdatert fra PAI bbb2222 (1 commit)");
	});

	test("after the push it is delivered", () => {
		git(clone, "push", "-q", "origin", "HEAD:main");
		expect(lev("lev_kopi_kilde")).toBe("bbb2222");
		expect(lev("lev_kopi_upushet")).toBe("");
	});
});

describe.skipIf(!existsSync(LEVERANSE))("lev_kopi_tilstand: what happens to a clone before the build (#330, #449)", () => {
	let dir = "";
	const git = (cwd: string, ...a: string[]): string => {
		const p = Bun.spawnSync(["git", "-C", cwd, ...a], {
			env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
		});
		if (p.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${p.stderr}`);
		return p.stdout.toString().trim();
	};
	const tilstand = (clone: string): string =>
		Bun.spawnSync(["bash", "-c", `. "${LEVERANSE}" && lev_kopi_tilstand "$1"`, "_", clone]).stdout.toString().trim();
	const bygg = (clone: string, kilde: string) =>
		git(clone, "commit", "-q", "--allow-empty", "-m", `chore: oppdatert fra PAI ${kilde} (1 commit)`);

	/** A remote with one build, and two clones of it: «denne» (this machine's) and «annen». */
	function oppsett(): { denne: string; annen: string } {
		dir = mkdtempSync(join(tmpdir(), "pai-leveranse-tilstand-"));
		git(dir, "init", "-q", "--bare", "-b", "main", "remote.git");
		git(dir, "clone", "-q", join(dir, "remote.git"), "denne");
		const denne = join(dir, "denne");
		bygg(denne, "aaa1111");
		git(denne, "push", "-q", "origin", "HEAD:main");
		git(dir, "clone", "-q", join(dir, "remote.git"), "annen");
		return { denne, annen: join(dir, "annen") };
	}
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("in step with origin/main: ok", () => {
		const { denne } = oppsett();
		expect(tilstand(denne)).toBe("ok");
	});

	test("another clone pushed a build: behind after the fetch, and set to origin/main", () => {
		const { denne, annen } = oppsett();
		bygg(annen, "bbb2222");
		git(annen, "push", "-q", "origin", "HEAD:main");
		// Before the fetch the clone cannot know; that is what #449 was.
		expect(tilstand(denne)).toBe("ok");
		git(denne, "fetch", "-q", "origin");
		expect(tilstand(denne)).toBe("nullstill 0 1");
	});

	test("an unpushed build on top of an old main, and behind", () => {
		const { denne, annen } = oppsett();
		bygg(annen, "bbb2222");
		git(annen, "push", "-q", "origin", "HEAD:main");
		bygg(denne, "ccc3333");
		git(denne, "fetch", "-q", "origin");
		expect(tilstand(denne)).toBe("nullstill 1 1");
	});

	test("an unpushed commit that is not a build stops", () => {
		const { denne } = oppsett();
		git(denne, "commit", "-q", "--allow-empty", "-m", "Update README.md");
		expect(tilstand(denne)).toBe("stopp");
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

describe.skipIf(!existsSync(LEVERANSE))("why the job's Gitea does not answer (#190)", () => {
	// cloud-init rewrites /etc/hosts at boot, so the tunnel can be up while the
	// name is gone. Before #190 every failed fetch said "is wg-jobb up?".
	const diagnose = (env: Record<string, string>) => {
		const p = Bun.spawnSync(["bash", "-c", `. "${LEVERANSE}" && lev_jobb_nett`], { env: { ...process.env, ...env } });
		return { code: p.exitCode, out: p.stdout.toString().trim() };
	};

	test("tunnel down: says so, and exits 1", () => {
		const r = diagnose({ LEV_IP_LINK: "false", LEV_OPPSLAG: "true" });
		expect(r.code).toBe(1);
		expect(r.out).toStartWith("wg-jobb er nede");
	});

	test("tunnel up, name missing: points at /etc/hosts and #190, not the tunnel", () => {
		const r = diagnose({ LEV_IP_LINK: "true", LEV_OPPSLAG: "false" });
		expect(r.code).toBe(1);
		expect(r.out).toContain("wg-jobb er oppe");
		expect(r.out).toContain("git.work.example.internal mangler i /etc/hosts");
		expect(r.out).toContain("#190");
	});

	test("both missing: the tunnel comes first, since PostUp adds the name when it comes up", () => {
		const r = diagnose({ LEV_IP_LINK: "false", LEV_OPPSLAG: "false" });
		expect(r.code).toBe(1);
		expect(r.out).toStartWith("wg-jobb er nede");
	});

	test("both in place: prints nothing, exits 0", () => {
		expect(diagnose({ LEV_IP_LINK: "true", LEV_OPPSLAG: "true" })).toEqual({ code: 0, out: "" });
	});

	test("the name is what the lookup is asked for", () => {
		const r = diagnose({ LEV_IP_LINK: "true", LEV_OPPSLAG: "test git.work.example.internal =" });
		expect(r.code).toBe(0);
	});
});
