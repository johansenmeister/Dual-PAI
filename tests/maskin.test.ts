/**
 * Contract test: the machine profile, `pai maskin --sjekk` (#472, phase 1) and
 * `pai maskin` (phase 2).
 *
 * `parseProfile` refuses what the profile cannot mean, all errors at once.
 * `assess` and `plan` are pure, so each status and each action is tested from
 * a built observation. `observe`, `check`, `apply` and `setUp` run against real
 * git repos and symlinks in a temp HOME, with `run` replaced for everything but
 * git, so no test asks or changes the real systemd.
 *
 * @module tests/maskin
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	type Action,
	actionLine,
	apply,
	assess,
	type Context,
	check,
	defaultContext,
	type Observation,
	type Profile,
	ProfileError,
	parseProfile,
	plan,
	problems,
	roleFor,
	setUp,
	shortHost,
	stepLine,
} from "../.opencode/PAI/Tools/maskin";

const EKTE = join(import.meta.dir, "..", ".opencode");
const PAI_TS = join(EKTE, "PAI", "Tools", "pai.ts");
const TEMPLATE = join(EKTE, "PAI", "MASKINER.template.yaml");
const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(d);
	return d;
}

const PROFILE = `
repoer:
  scripts: { url: git@git.example.com:org/scripts.git, sti: ~/repos/scripts }
  docs: { url: git@git.example.com:org/docs.git, sti: ~/repos/docs, les: true }
roller:
  server:
    repoer: [scripts, docs]
    enheter:
      - { repo: scripts, fil: systemd/docs-pull.service }
      - { repo: scripts, fil: systemd/docs-pull.timer, aktiver: true }
    linger: true
    env: [SMTP_HOST, REPORT_RECIPIENT]
  arbeidsstasjon:
    repoer: [docs]
maskiner:
  srv-1: server
  laptop-1: arbeidsstasjon
`;

function errors(text: string): string[] {
	try {
		parseProfile(text);
	} catch (e) {
		if (e instanceof ProfileError) return e.errors;
		throw e;
	}
	return [];
}

describe("parseProfile", () => {
	test("the template for public parses, so a new user starts from a valid file", () => {
		const p = parseProfile(readFileSync(TEMPLATE, "utf8"));
		expect(Object.keys(p.roller)).toEqual(["server", "arbeidsstasjon"]);
	});

	test("a valid profile: defaults for les, aktiver and linger", () => {
		const p = parseProfile(PROFILE);
		expect(p.repoer.scripts).toEqual({ url: "git@git.example.com:org/scripts.git", sti: "~/repos/scripts", les: false });
		expect(p.roller.server.enheter[0]).toEqual({ repo: "scripts", fil: "systemd/docs-pull.service", aktiver: false });
		expect(p.roller.arbeidsstasjon.linger).toBe(false);
		expect(p.maskiner).toEqual({ "srv-1": "server", "laptop-1": "arbeidsstasjon" });
	});

	test("every error at once, each naming where it is", () => {
		const e = errors(`
repoer:
  pai: { url: x, sti: ~/x }
  a: { url: x, sti: relativ, lest: true }
roller:
  r:
    repoer: [a, mangler]
    enheter:
      - { repo: b, fil: systemd/x.service }
      - { repo: a, fil: ../x.service }
      - { repo: a, fil: systemd/x.conf }
      - { repo: pai, fil: systemd/dobbel.timer }
      - { repo: pai, fil: andre/dobbel.timer }
    env: [lowercase]
    linnger: true
maskiner:
  h: finnes-ikke
`);
		expect(e).toEqual([
			'repo "pai" is the PAI repo itself and cannot be defined',
			'unknown key "lest" in repo "a"',
			'repo "a": sti must start with ~/ or /',
			'unknown key "linnger" in role "r"',
			'role "r": repo "mangler" is not defined',
			'role "r": the unit\'s repo "b" is not defined',
			'role "r": "../x.service" is not a relative path to a systemd unit',
			'role "r": "systemd/x.conf" is not a relative path to a systemd unit',
			'role "r": "lowercase" is not a key name',
			// Two files with one name would be one link in the unit directory.
			'role "r": unit x.service is listed twice',
			'role "r": unit dobbel.timer is listed twice',
			'machine "h": role "finnes-ikke" is not defined',
		]);
	});

	test("a unit from a repo the role does not clone is refused", () => {
		expect(errors("repoer: { a: { url: x, sti: ~/a } }\nroller: { r: { enheter: [{ repo: a, fil: s/x.timer }] } }")).toEqual([
			'role "r": unit s/x.timer is from "a", which the role does not clone',
		]);
	});

	test("not YAML, and not a map, are errors too", () => {
		expect(errors("a: [")[0]).toStartWith("not valid YAML");
		expect(errors("- a")).toEqual(["the profile must be a map with repoer, roller and maskiner"]);
	});
});

describe("roleFor", () => {
	const p = parseProfile(PROFILE);
	test("the short host name, so srv-1.example.com is srv-1", () => {
		expect(shortHost("srv-1.example.com")).toBe("srv-1");
		expect(roleFor(p, "srv-1.example.com")).toEqual({ role: "server" });
	});
	test("--rolle wins, and an unknown role or host is named", () => {
		expect(roleFor(p, "srv-1", "arbeidsstasjon")).toEqual({ role: "arbeidsstasjon" });
		expect(roleFor(p, "srv-1", "ingen")).toEqual({ unknown: "ingen" });
		expect(roleFor(p, "ny-maskin")).toEqual({ unknown: "ny-maskin" });
	});
});

describe("assess is pure: each status from an observation", () => {
	const p: Profile = parseProfile(PROFILE);
	const ctx = { home: "/h", paiRepo: "/pai", unitDir: "/h/.config/systemd/user" };
	const unit = (o: Partial<Observation["units"][string]> = {}) => ({
		sourceExists: true,
		kind: "symlink" as const,
		pointsRight: true,
		target: "/h/repos/scripts/systemd/x",
		enabled: "enabled",
		failed: false,
		...o,
	});
	const allOk = (): Observation => ({
		repos: {
			scripts: { exists: true, remote: "git@git.example.com:org/scripts.git", dirty: false },
			docs: { exists: true, remote: "git@git.example.com:org/docs.git", dirty: false },
		},
		units: { "docs-pull.service": unit({ enabled: "static" }), "docs-pull.timer": unit() },
		linger: true,
		envSet: new Set(["SMTP_HOST", "REPORT_RECIPIENT"]),
		cronLines: 0,
	});
	const one = (o: Observation, type: string, name: string) => {
		const s = assess(p, "server", o, ctx).find((x) => x.type === type && x.name === name);
		if (!s) throw new Error(`no step ${type} ${name}`);
		return s;
	};

	test("everything as the profile says: all ok, no problems", () => {
		const steps = assess(p, "server", allOk(), ctx);
		expect(steps.map((s) => s.status)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok", "ok"]);
		expect(problems(steps)).toEqual([]);
	});

	test("a repo that is not cloned gives the clone command, with ~ expanded", () => {
		const o = allOk();
		o.repos.docs = { exists: false, remote: null, dirty: null };
		expect(one(o, "repo", "docs")).toEqual({
			type: "repo",
			name: "docs",
			status: "missing",
			message: "~/repos/docs is not cloned",
			command: "git clone git@git.example.com:org/docs.git /h/repos/docs",
		});
	});

	test("another origin is drift; local changes count only in a read-only clone", () => {
		const o = allOk();
		o.repos.scripts = { exists: true, remote: "git@other:x.git", dirty: true };
		expect(one(o, "repo", "scripts").status).toBe("drift");
		o.repos.scripts = { exists: true, remote: "git@git.example.com:org/scripts.git", dirty: true };
		expect(one(o, "repo", "scripts").status).toBe("ok");
		o.repos.docs.dirty = true;
		expect(one(o, "repo", "docs").status).toBe("drift");
	});

	test("units: each way a link can be wrong", () => {
		const cases: [Partial<Observation["units"][string]>, string, string][] = [
			[{ kind: "missing", target: null }, "missing", "ln -s /h/repos/scripts/systemd/docs-pull.timer /h/.config/systemd/user/docs-pull.timer"],
			[{ kind: "file", target: null }, "drift", ""],
			[{ pointsRight: false, target: "/elsewhere" }, "drift", ""],
			[{ sourceExists: false }, "drift", ""],
			[{ failed: true }, "drift", "journalctl --user -u docs-pull.timer -n 20"],
			[{ enabled: "disabled" }, "missing", "systemctl --user enable --now docs-pull.timer"],
		];
		for (const [obs, status, command] of cases) {
			const o = allOk();
			o.units["docs-pull.timer"] = unit(obs);
			const s = one(o, "unit", "docs-pull.timer");
			expect([s.status, s.command ?? ""], JSON.stringify(obs)).toEqual([status, command]);
		}
	});

	test("a unit is not enabled when aktiver is false: a static service is ok", () => {
		expect(one(allOk(), "unit", "docs-pull.service").status).toBe("ok");
	});

	test("a unit whose repo is not cloned says so, not that the link is missing", () => {
		const o = allOk();
		o.repos.scripts = { exists: false, remote: null, dirty: null };
		expect(one(o, "unit", "docs-pull.timer").message).toBe("repo scripts is not cloned");
	});

	test("linger: on, off with the command, and unknown as manual", () => {
		const o = allOk();
		o.linger = false;
		expect(one(o, "linger", "linger")).toMatchObject({ status: "missing", command: "loginctl enable-linger" });
		o.linger = null;
		expect(one(o, "linger", "linger").status).toBe("manual");
	});

	test(".env keys are manual, never with a value", () => {
		const o = allOk();
		o.envSet = new Set(["SMTP_HOST"]);
		expect(one(o, "env", "REPORT_RECIPIENT")).toMatchObject({ status: "manual", message: "is not set in .env (you set it yourself)" });
		o.envSet = null;
		expect(one(o, "env", "SMTP_HOST").message).toBe("there is no .env");
	});

	test("cron lines are a warning, which is not a problem", () => {
		const o = allOk();
		o.cronLines = 3;
		const steps = assess(p, "server", o, ctx);
		expect(steps.at(-1)?.status).toBe("warning");
		expect(problems(steps)).toEqual([]);
	});

	test("stepLine: the command only when the step is not ok", () => {
		expect(stepLine({ type: "repo", name: "a", status: "ok", message: "~/a", command: "x" })).toBe("✅ repo a ~/a");
		expect(stepLine({ type: "repo", name: "a", status: "missing", message: "m", command: "x" })).toBe("❌ repo a m: x");
		expect(stepLine({ type: "repo", name: "a", status: "missing", message: "m" }, false)).toBe("repo a m");
	});
});

describe("plan is pure: the actions for what is missing, never for drift", () => {
	const p: Profile = parseProfile(PROFILE);
	const ctx = { home: "/h", paiRepo: "/pai", unitDir: "/u" };
	const unit = (o: Partial<Observation["units"][string]> = {}) => ({
		sourceExists: true,
		kind: "symlink" as const,
		pointsRight: true,
		target: "/x",
		enabled: "enabled",
		failed: false,
		...o,
	});
	const obs = (o: Partial<Observation> = {}): Observation => ({
		repos: {
			scripts: { exists: true, remote: "git@git.example.com:org/scripts.git", dirty: false },
			docs: { exists: true, remote: "git@git.example.com:org/docs.git", dirty: false },
		},
		units: { "docs-pull.service": unit({ enabled: "static" }), "docs-pull.timer": unit() },
		linger: true,
		envSet: new Set(),
		cronLines: 0,
		...o,
	});
	const lines = (o: Observation) => plan(p, "server", o, ctx).map(actionLine);

	test("as the profile says: nothing to do, also with .env keys missing (they are yours)", () => {
		expect(lines(obs())).toEqual([]);
	});

	test("missing links: link, reload, then enable the one with aktiver", () => {
		const o = obs({
			units: { "docs-pull.service": unit({ kind: "missing", target: null, enabled: "not-found" }), "docs-pull.timer": unit({ kind: "missing", target: null, enabled: "not-found" }) },
		});
		expect(lines(o)).toEqual([
			"ln -s /h/repos/scripts/systemd/docs-pull.service /u/docs-pull.service",
			"ln -s /h/repos/scripts/systemd/docs-pull.timer /u/docs-pull.timer",
			"systemctl --user daemon-reload",
			"systemctl --user enable --now docs-pull.timer",
		]);
	});

	test("a linked unit that is not enabled is enabled", () => {
		expect(lines(obs({ units: { "docs-pull.service": unit({ enabled: "static" }), "docs-pull.timer": unit({ enabled: "disabled" }) } }))).toEqual([
			"systemctl --user daemon-reload",
			"systemctl --user enable --now docs-pull.timer",
		]);
	});

	test("drift gets no action: a regular file, a wrong link, a missing source, a failed unit", () => {
		for (const bad of [
			{ kind: "file" as const, target: null, enabled: "disabled" },
			{ pointsRight: false, enabled: "disabled" },
			{ sourceExists: false, kind: "missing" as const, enabled: "disabled" },
			{ failed: true, enabled: "disabled" },
		]) {
			expect(lines(obs({ units: { "docs-pull.service": unit({ enabled: "static" }), "docs-pull.timer": unit(bad) } })), JSON.stringify(bad)).toEqual([]);
		}
		const other = obs();
		other.repos.scripts.remote = "git@other:x.git";
		expect(lines(other)).toEqual([]);
	});

	test("a repo that is not cloned is cloned; its units wait for the next round", () => {
		const o = obs({ units: { "docs-pull.service": unit({ sourceExists: false, kind: "missing" }), "docs-pull.timer": unit({ sourceExists: false, kind: "missing" }) } });
		o.repos.scripts = { exists: false, remote: null, dirty: null };
		expect(lines(o)).toEqual(["git clone git@git.example.com:org/scripts.git /h/repos/scripts"]);
	});

	test("linger only when it is off, not when loginctl did not answer", () => {
		expect(lines(obs({ linger: false }))).toEqual(["loginctl enable-linger"]);
		expect(lines(obs({ linger: null }))).toEqual([]);
	});
});

/** A temp HOME with a git repo, a PAI tree and a stubbed `run`. */
function machine() {
	const home = tmp("maskin-home-");
	const opencode = join(home, "pai", ".opencode");
	mkdirSync(join(opencode, "PAI", "USER"), { recursive: true });
	mkdirSync(join(home, "pai", "systemd"), { recursive: true });
	writeFileSync(join(home, "pai", "systemd", "pai-pull.timer"), "[Timer]\n");
	const scripts = join(home, "repos", "scripts");
	mkdirSync(join(scripts, "systemd"), { recursive: true });
	Bun.spawnSync(["git", "init", "-q", scripts]);
	Bun.spawnSync(["git", "-C", scripts, "remote", "add", "origin", "git@git.example.com:org/scripts.git"]);
	writeFileSync(join(scripts, "systemd", "docs-pull.timer"), "[Timer]\n");
	writeFileSync(join(scripts, "systemd", "docs-pull.service"), "[Service]\n");
	Bun.spawnSync(["git", "-C", scripts, "add", "-A"]);
	Bun.spawnSync(["git", "-C", scripts, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "x"]);
	writeFileSync(join(opencode, ".env"), "SMTP_HOST=relay.example.com\nREPORT_RECIPIENT=\n");
	const calls: string[] = [];
	const answers: Record<string, { code: number; out: string }> = {
		"systemctl --user is-enabled docs-pull.timer": { code: 0, out: "enabled" },
		"systemctl --user is-enabled docs-pull.service": { code: 0, out: "static" },
		"systemctl --user is-enabled pai-pull.timer": { code: 1, out: "disabled" },
		"loginctl show-user t --property=Linger --value": { code: 0, out: "no" },
		"crontab -l": { code: 1, out: "" },
	};
	const base = defaultContext(opencode, home, { XDG_CONFIG_HOME: join(home, ".config") });
	const ctx: Context = {
		...base,
		user: "t",
		run: (cmd, args, cwd) => {
			const key = `${cmd} ${args.join(" ")}`;
			calls.push(key);
			if (cmd === "git") return base.run(cmd, args, cwd);
			return answers[key] ?? { code: 1, out: "" };
		},
	};
	return { home, opencode, scripts, ctx, calls };
}

const MACHINE_PROFILE = `
repoer:
  scripts: { url: git@git.example.com:org/scripts.git, sti: ~/repos/scripts }
roller:
  server:
    repoer: [scripts]
    enheter:
      - { repo: scripts, fil: systemd/docs-pull.service }
      - { repo: scripts, fil: systemd/docs-pull.timer, aktiver: true }
      - { repo: pai, fil: systemd/pai-pull.timer, aktiver: true }
    linger: true
    env: [SMTP_HOST, REPORT_RECIPIENT]
maskiner:
  srv-1: server
`;

describe("check: observe a real temp machine, then assess", () => {
	test("links, a dangling link, enabled state, linger, .env and cron, as one result", () => {
		const m = machine();
		writeFileSync(join(m.opencode, "PAI", "USER", "MASKINER.yaml"), MACHINE_PROFILE);
		const unitDir = join(m.home, ".config", "systemd", "user");
		mkdirSync(unitDir, { recursive: true });
		symlinkSync(join(m.scripts, "systemd", "docs-pull.service"), join(unitDir, "docs-pull.service"));
		symlinkSync(join(m.scripts, "systemd", "docs-pull.timer"), join(unitDir, "docs-pull.timer"));
		// A link to where the file used to be: dangling.
		symlinkSync(join(m.home, "gammel", "pai-pull.timer"), join(unitDir, "pai-pull.timer"));

		const r = check(m.opencode, m.home, { host: "srv-1.example.com", ctx: m.ctx });
		if (r.kind !== "checked") throw new Error(JSON.stringify(r));
		expect(r.role).toBe("server");
		expect(r.steps.map((s) => `${s.status} ${s.type} ${s.name}`)).toEqual([
			"ok repo scripts",
			"ok unit docs-pull.service",
			"ok unit docs-pull.timer",
			"drift unit pai-pull.timer",
			"missing linger linger",
			"ok env SMTP_HOST",
			"manual env REPORT_RECIPIENT",
		]);
		// Only reading commands: nothing that changes the machine.
		for (const c of m.calls) expect(c).toMatch(/^(git -C \S+ (remote get-url origin|status --porcelain)|systemctl --user is-(enabled|failed)|loginctl show-user|crontab -l)/);
	});

	test("no profile, a broken profile, and a host not in the profile", () => {
		const m = machine();
		expect(check(m.opencode, m.home, { ctx: m.ctx }).kind).toBe("no-profile");
		writeFileSync(join(m.opencode, "PAI", "USER", "MASKINER.yaml"), "roller: { r: { linger: ja } }\n");
		expect(check(m.opencode, m.home, { ctx: m.ctx })).toMatchObject({ kind: "bad-profile", errors: ['role "r": linger must be true or false'] });
		writeFileSync(join(m.opencode, "PAI", "USER", "MASKINER.yaml"), MACHINE_PROFILE);
		expect(check(m.opencode, m.home, { host: "ny", ctx: m.ctx })).toMatchObject({ kind: "unknown", name: "ny", roles: ["server"] });
	});
});

describe("pai maskin on the command line", () => {
	function pai(args: string[], home: string) {
		const r = Bun.spawnSync(["bun", PAI_TS, ...args], {
			env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, OPENCODE_DIR: join(home, ".opencode"), LC_ALL: "C.UTF-8" },
			stdout: "pipe",
			stderr: "pipe",
		});
		return { kode: r.exitCode, ut: r.stdout.toString() + r.stderr.toString() };
	}
	function tree(): string {
		const home = tmp("maskin-cli-");
		const opencode = join(home, "pai", ".opencode");
		mkdirSync(join(opencode, "PAI"), { recursive: true });
		symlinkSync(join(EKTE, "PAI", "Tools"), join(opencode, "PAI", "Tools"));
		symlinkSync(opencode, join(home, ".opencode"));
		return home;
	}

	test("without --sjekk it clones what is missing, then checks; a second run does nothing", () => {
		const home = tree();
		const source = join(home, "kilde");
		Bun.spawnSync(["git", "init", "-q", source]);
		Bun.spawnSync(["git", "-C", source, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "x"]);
		const profil = join(home, "p.yaml");
		writeFileSync(profil, `repoer: { a: { url: ${source}, sti: ~/a } }\nroller: { r: { repoer: [a] } }\n`);
		const r = pai(["maskin", "--profil", profil, "--rolle", "r"], home);
		expect(r.ut).toContain(`✅ git clone ${source} ${join(home, "a")}\n`);
		expect(r.ut).toContain("✅ repo a ~/a");
		expect(r.kode).toBe(0);
		const again = pai(["maskin", "--profil", profil, "--rolle", "r"], home);
		expect(again.ut).toContain("nothing to do");
		expect(again.kode).toBe(0);
	});

	test("--sjekk says pai maskin does the missing steps", () => {
		const home = tree();
		const profil = join(home, "p.yaml");
		writeFileSync(profil, "repoer: { a: { url: git@x:a.git, sti: ~/a } }\nroller: { r: { repoer: [a] } }\n");
		expect(pai(["maskin", "--sjekk", "--profil", profil, "--rolle", "r"], home).ut).toContain("pai maskin does the steps that are missing");
	});

	test("an unknown flag is refused", () => {
		const r = pai(["maskin", "--sjekk", "--fiks"], tree());
		expect(r.kode).toBe(1);
		expect(r.ut).toContain("Unknown flag for pai maskin: --fiks");
	});

	test("--sjekk with --profil and --rolle prints the steps and exits 1 when one is not ok", () => {
		const home = tree();
		const profil = join(home, "p.yaml");
		writeFileSync(profil, "repoer: { a: { url: git@x:a.git, sti: ~/a } }\nroller: { r: { repoer: [a] } }\n");
		const r = pai(["maskin", "--sjekk", "--profil", profil, "--rolle", "r"], home);
		expect(r.ut).toContain("role r");
		expect(r.ut).toContain(`❌ repo a ~/a is not cloned: git clone git@x:a.git ${join(home, "a")}`);
		expect(r.kode).toBe(1);
	});

	test("--json gives the result for a model to read", () => {
		const home = tree();
		const profil = join(home, "p.yaml");
		writeFileSync(profil, "roller: { r: {} }\n");
		const r = pai(["maskin", "--sjekk", "--json", "--profil", profil, "--rolle", "r"], home);
		expect(JSON.parse(r.ut)).toMatchObject({ kind: "checked", role: "r" });
		expect(r.kode).toBe(0);
	});
});

/** A machine whose systemctl remembers what was enabled, and whose loginctl remembers linger. */
function statefulMachine() {
	const m = machine();
	const enabled = new Set<string>();
	let linger = false;
	const calls: string[] = [];
	const base = m.ctx.run;
	m.ctx.run = (cmd, args, cwd) => {
		const key = `${cmd} ${args.join(" ")}`;
		calls.push(key);
		if (cmd === "git") return base(cmd, args, cwd);
		if (key.startsWith("systemctl --user enable --now ")) {
			enabled.add(args.at(-1) ?? "");
			return { code: 0, out: "" };
		}
		if (key === "systemctl --user daemon-reload") return { code: 0, out: "" };
		if (key.startsWith("systemctl --user is-enabled ")) {
			const n = args.at(-1) ?? "";
			return enabled.has(n) ? { code: 0, out: "enabled" } : n.endsWith(".service") ? { code: 0, out: "static" } : { code: 1, out: "disabled" };
		}
		if (key === "loginctl enable-linger") {
			linger = true;
			return { code: 0, out: "" };
		}
		if (key.startsWith("loginctl show-user")) return { code: 0, out: linger ? "yes" : "no" };
		return { code: 1, out: "" };
	};
	return { ...m, calls };
}

describe("apply and setUp: a temp machine made as the profile says", () => {
	test("from nothing: clone, then link the clone's units, reload, enable, and linger after a yes", () => {
		const m = statefulMachine();
		// The profile's repo is cloned from the machine's own scripts repo, to a new place.
		const profile = MACHINE_PROFILE.replace("url: git@git.example.com:org/scripts.git, sti: ~/repos/scripts", `url: ${m.scripts}, sti: ~/klon/scripts`);
		writeFileSync(join(m.opencode, "PAI", "USER", "MASKINER.yaml"), profile);
		const questions: string[] = [];
		const { done, result } = setUp(m.opencode, m.home, (q) => {
			questions.push(q);
			return true;
		}, { host: "srv-1", ctx: m.ctx });

		const unitDir = join(m.home, ".config", "systemd", "user");
		expect(done.map((d) => `${d.ok ? "ok" : "no"} ${actionLine(d.action)}`)).toEqual([
			`ok git clone ${m.scripts} ${join(m.home, "klon", "scripts")}`,
			`ok ln -s ${join(m.home, "pai", "systemd", "pai-pull.timer")} ${join(unitDir, "pai-pull.timer")}`,
			"ok systemctl --user daemon-reload",
			"ok systemctl --user enable --now pai-pull.timer",
			"ok loginctl enable-linger",
			// Round two: the clone's units.
			`ok ln -s ${join(m.home, "klon", "scripts", "systemd", "docs-pull.service")} ${join(unitDir, "docs-pull.service")}`,
			`ok ln -s ${join(m.home, "klon", "scripts", "systemd", "docs-pull.timer")} ${join(unitDir, "docs-pull.timer")}`,
			"ok systemctl --user daemon-reload",
			"ok systemctl --user enable --now docs-pull.timer",
		]);
		expect(questions).toHaveLength(1);
		expect(readlinkSync(join(unitDir, "docs-pull.timer"))).toBe(join(m.home, "klon", "scripts", "systemd", "docs-pull.timer"));
		if (result.kind !== "checked") throw new Error(result.kind);
		// Only the .env key the user sets is left.
		expect(problems(result.steps).map((s) => `${s.type} ${s.name}`)).toEqual(["env REPORT_RECIPIENT"]);

		const again = setUp(m.opencode, m.home, () => true, { host: "srv-1", ctx: m.ctx });
		expect(again.done).toEqual([]);
	});

	test("linger without a yes is not turned on, and loginctl enable-linger is never run", () => {
		const m = statefulMachine();
		writeFileSync(join(m.opencode, "PAI", "USER", "MASKINER.yaml"), "roller: { r: { linger: true } }\nmaskiner: { srv-1: r }\n");
		const { done, result } = setUp(m.opencode, m.home, () => false, { host: "srv-1", ctx: m.ctx });
		expect(done).toEqual([{ action: { type: "linger" }, ok: false, message: "not turned on (no yes)" }]);
		expect(m.calls).not.toContain("loginctl enable-linger");
		if (result.kind !== "checked") throw new Error(result.kind);
		expect(problems(result.steps).map((s) => s.type)).toEqual(["linger"]);
	});

	test("an enable that fails is shown with systemd's words, and not tried again in round two", () => {
		const m = statefulMachine();
		writeFileSync(join(m.opencode, "PAI", "USER", "MASKINER.yaml"), "roller: { r: { enheter: [{ repo: pai, fil: systemd/pai-pull.timer, aktiver: true }] } }\nmaskiner: { srv-1: r }\n");
		const run = m.ctx.run;
		m.ctx.run = (cmd, args, cwd) =>
			args.includes("enable") ? { code: 1, out: "", err: "Failed to enable unit: Unit pai-pull.service not found." } : run(cmd, args, cwd);
		const { done } = setUp(m.opencode, m.home, () => false, { host: "srv-1", ctx: m.ctx });
		expect(done.map((d) => `${d.ok ? "ok" : "no"} ${actionLine(d.action)}`)).toEqual([
			`ok ln -s ${join(m.home, "pai", "systemd", "pai-pull.timer")} ${join(m.home, ".config", "systemd", "user", "pai-pull.timer")}`,
			"ok systemctl --user daemon-reload",
			"no systemctl --user enable --now pai-pull.timer",
		]);
		expect(done[2].message).toBe("Failed to enable unit: Unit pai-pull.service not found.");
	});

	test("drift is left alone: a regular file where a link should be is not touched", () => {
		const m = statefulMachine();
		writeFileSync(join(m.opencode, "PAI", "USER", "MASKINER.yaml"), MACHINE_PROFILE);
		const unitDir = join(m.home, ".config", "systemd", "user");
		mkdirSync(unitDir, { recursive: true });
		writeFileSync(join(unitDir, "docs-pull.timer"), "[Timer]\n# by hand\n");
		const { done } = setUp(m.opencode, m.home, () => false, { host: "srv-1", ctx: m.ctx });
		expect(readFileSync(join(unitDir, "docs-pull.timer"), "utf8")).toBe("[Timer]\n# by hand\n");
		expect(done.map((d) => actionLine(d.action))).not.toContain("systemctl --user enable --now docs-pull.timer");
	});

	test("apply checks first: something on the path is left alone, and a failed clone says why", () => {
		const m = statefulMachine();
		const link = join(m.home, "l.timer");
		writeFileSync(link, "x");
		const there = join(m.home, "finnes");
		mkdirSync(there);
		const actions: Action[] = [
			{ type: "link", name: "l.timer", source: join(m.scripts, "systemd", "docs-pull.timer"), link },
			{ type: "clone", name: "a", url: join(m.home, "ingen-repo"), path: join(m.home, "ny") },
			{ type: "clone", name: "b", url: m.scripts, path: there },
		];
		const done = apply(actions, m.ctx, () => true);
		expect(done.map((d) => d.ok)).toEqual([false, false, false]);
		expect(lstatSync(link).isSymbolicLink()).toBe(false);
		expect(done[1].message).toContain("does not exist");
		expect(existsSync(join(m.home, "ny"))).toBe(false);
		expect(done[2].message).toBe(`${there} exists and is not a clone; left alone`);
	});
});

/**
 * The units in the PAI repo's `systemd/` (plan rule: units are symlinked, never
 * written from text, so a broken one is broken on every machine). Needs a user
 * manager (MEASURED: without XDG_RUNTIME_DIR verify fails on any unit), so the
 * tool is proved able first, on a good and a bad unit.
 */
const VERIFY = Bun.which("systemd-analyze");
function verify(dir: string, files: string[]): { code: number; out: string } {
	const r = Bun.spawnSync([VERIFY ?? "systemd-analyze", "--user", "verify", ...files.map((f) => join(dir, f))], { stdout: "pipe", stderr: "pipe" });
	return { code: r.exitCode ?? -1, out: r.stdout.toString() + r.stderr.toString() };
}
const verifyWorks = (() => {
	if (!VERIFY) return false;
	const d = mkdtempSync(join(tmpdir(), "maskin-verify-"));
	dirs.push(d);
	writeFileSync(join(d, "ok.service"), "[Unit]\nDescription=ok\n[Service]\nType=oneshot\nExecStart=/bin/true\n");
	return verify(d, ["ok.service"]).code === 0;
})();

describe.skipIf(!verifyWorks)("systemd-analyze --user verify on the units in systemd/", () => {
	test("the tool catches what has given false success before: % in ExecStart and a calendar it does not know", () => {
		const d = tmp("maskin-verify-bad-");
		writeFileSync(join(d, "pst.service"), "[Unit]\nDescription=x\n[Service]\nType=oneshot\nExecStart=/bin/echo %Q\n");
		writeFileSync(join(d, "cal.timer"), "[Unit]\nDescription=x\n[Timer]\nOnCalendar=daglig\n");
		expect(verify(d, ["pst.service"]).code).toBe(1);
		expect(verify(d, ["cal.timer"]).code).toBe(1);
	});

	test("every unit in the PAI repo's systemd/ verifies", () => {
		const dir = join(import.meta.dir, "..", "systemd");
		const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.(service|timer|path|socket|target)$/.test(f)) : [];
		if (files.length === 0) return;
		const r = verify(dir, files);
		expect(r.code, r.out).toBe(0);
	});
});
