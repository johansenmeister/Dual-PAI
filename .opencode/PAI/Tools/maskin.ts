/**
 * Machine setup from a profile (#472, docs/maskinoppsett/plan.md).
 *
 * `PAI/USER/MASKINER.yaml` says what each role needs (clones, systemd user
 * units linked from a repo, linger, the `.env` keys) and which machine has
 * which role, by host name. `observe` looks at the machine, and `assess` is a
 * pure function from profile, role and observation to steps with a status.
 * `pai maskin --sjekk` prints them, and `maskin-helse.ts` gives `pai doctor` a
 * section from the same steps.
 *
 * Phase 2: `plan` is a pure function to the actions that make a `missing`
 * step ok (clone, link, daemon-reload, enable, linger), and `apply` runs them,
 * each checking first. Drift is never acted on: something that is there and
 * wrong is shown with its command, and left alone.
 *
 * The profile's keys (`repoer`, `roller`, `maskiner`, `sti`, `les`, `enheter`,
 * `aktiver`) are data, as written in the plan; everything else here is English.
 *
 * Secrets are never done by the tool: a missing `.env` value is `manual`, with
 * the key's name and never its value. Units are only ever symlinks into a repo,
 * never written from text.
 *
 * @module PAI/Tools/maskin
 */

import { spawnSync } from "bun";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { parse } from "yaml";
import { parseEnv } from "./pai-env";

/** A unit's `repo:` with this name is the PAI repo itself, and its `systemd/`. */
export const PAI_REPO = "pai";

export interface RepoSpec {
	url: string;
	/** As written in the profile, `~/` allowed. */
	sti: string;
	/** A read-only clone: never changed locally, pulled with `--ff-only`. */
	les: boolean;
}

export interface UnitSpec {
	repo: string;
	/** Relative to the repo's root, e.g. `systemd/docs-pull.timer`. */
	fil: string;
	aktiver: boolean;
}

export interface RoleSpec {
	repoer: string[];
	enheter: UnitSpec[];
	linger: boolean;
	/** Key names in `.env`, never values. */
	env: string[];
}

export interface Profile {
	repoer: Record<string, RepoSpec>;
	roller: Record<string, RoleSpec>;
	maskiner: Record<string, string>;
}

export class ProfileError extends Error {
	constructor(
		readonly source: string,
		readonly errors: string[],
	) {
		super(`${source}: ${errors.join("; ")}`);
	}
}

const UNIT = /\.(service|timer|path|socket|target)$/;
const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Every key outside `allowed` is a typo until proven otherwise. */
function unknownKeys(obj: Record<string, unknown>, allowed: string[], where: string, errors: string[]): void {
	for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`unknown key "${k}" in ${where}`);
}

/** The profile as text to a checked Profile. All errors at once, so one run shows them all. */
export function parseProfile(text: string, source = "MASKINER.yaml"): Profile {
	let raw: unknown;
	try {
		raw = parse(text);
	} catch (e) {
		throw new ProfileError(source, [`not valid YAML: ${e instanceof Error ? e.message : String(e)}`]);
	}
	const errors: string[] = [];
	if (!isObject(raw)) throw new ProfileError(source, ["the profile must be a map with repoer, roller and maskiner"]);
	unknownKeys(raw, ["repoer", "roller", "maskiner"], "the top level", errors);

	const repos: Record<string, RepoSpec> = {};
	const rawRepos = raw.repoer ?? {};
	if (!isObject(rawRepos)) errors.push("repoer must be a map");
	else
		for (const [name, r] of Object.entries(rawRepos)) {
			if (name === PAI_REPO) {
				errors.push(`repo "${PAI_REPO}" is the PAI repo itself and cannot be defined`);
				continue;
			}
			if (!isObject(r)) {
				errors.push(`repo "${name}" must be a map`);
				continue;
			}
			unknownKeys(r, ["url", "sti", "les"], `repo "${name}"`, errors);
			if (typeof r.url !== "string" || !r.url) errors.push(`repo "${name}" has no url`);
			if (typeof r.sti !== "string" || !r.sti) errors.push(`repo "${name}" has no sti`);
			else if (!r.sti.startsWith("~/") && !r.sti.startsWith("/")) errors.push(`repo "${name}": sti must start with ~/ or /`);
			if (r.les !== undefined && typeof r.les !== "boolean") errors.push(`repo "${name}": les must be true or false`);
			repos[name] = { url: String(r.url ?? ""), sti: String(r.sti ?? ""), les: r.les === true };
		}

	const roles: Record<string, RoleSpec> = {};
	const rawRoles = raw.roller ?? {};
	if (!isObject(rawRoles)) errors.push("roller must be a map");
	else
		for (const [name, r] of Object.entries(rawRoles)) {
			if (!isObject(r)) {
				errors.push(`role "${name}" must be a map`);
				continue;
			}
			unknownKeys(r, ["repoer", "enheter", "linger", "env"], `role "${name}"`, errors);
			const role: RoleSpec = { repoer: [], enheter: [], linger: false, env: [] };
			if (r.repoer !== undefined) {
				if (!Array.isArray(r.repoer)) errors.push(`role "${name}": repoer must be a list`);
				else
					for (const rn of r.repoer) {
						if (typeof rn !== "string" || !(rn in repos)) errors.push(`role "${name}": repo "${rn}" is not defined`);
						else role.repoer.push(rn);
					}
			}
			if (r.enheter !== undefined) {
				if (!Array.isArray(r.enheter)) errors.push(`role "${name}": enheter must be a list`);
				else
					for (const u of r.enheter) {
						if (!isObject(u)) {
							errors.push(`role "${name}": a unit must be a map with repo and fil`);
							continue;
						}
						unknownKeys(u, ["repo", "fil", "aktiver"], `a unit in role "${name}"`, errors);
						const repo = typeof u.repo === "string" ? u.repo : "";
						const fil = typeof u.fil === "string" ? u.fil : "";
						if (repo !== PAI_REPO && !(repo in repos)) errors.push(`role "${name}": the unit's repo "${repo}" is not defined`);
						else if (repo !== PAI_REPO && !role.repoer.includes(repo))
							errors.push(`role "${name}": unit ${fil} is from "${repo}", which the role does not clone`);
						if (!UNIT.test(fil) || fil.startsWith("/") || fil.split("/").includes(".."))
							errors.push(`role "${name}": "${fil}" is not a relative path to a systemd unit`);
						if (u.aktiver !== undefined && typeof u.aktiver !== "boolean")
							errors.push(`role "${name}": aktiver must be true or false`);
						role.enheter.push({ repo, fil, aktiver: u.aktiver === true });
					}
			}
			if (r.linger !== undefined && typeof r.linger !== "boolean") errors.push(`role "${name}": linger must be true or false`);
			role.linger = r.linger === true;
			if (r.env !== undefined) {
				if (!Array.isArray(r.env)) errors.push(`role "${name}": env must be a list of key names`);
				else
					for (const k of r.env) {
						if (typeof k !== "string" || !ENV_KEY.test(k)) errors.push(`role "${name}": "${k}" is not a key name`);
						else role.env.push(k);
					}
			}
			const names = role.enheter.map((u) => basename(u.fil));
			for (const n of new Set(names.filter((n, i) => names.indexOf(n) !== i)))
				errors.push(`role "${name}": unit ${n} is listed twice`);
			roles[name] = role;
		}

	const machines: Record<string, string> = {};
	const rawMachines = raw.maskiner ?? {};
	if (!isObject(rawMachines)) errors.push("maskiner must be a map from host name to role");
	else
		for (const [host, role] of Object.entries(rawMachines)) {
			if (typeof role !== "string" || !(role in roles)) errors.push(`machine "${host}": role "${role}" is not defined`);
			else machines[host] = role;
		}

	if (errors.length > 0) throw new ProfileError(source, errors);
	return { repoer: repos, roller: roles, maskiner: machines };
}

/** The short host name: `laptop-1.example.com` and `laptop-1` are the same machine. */
export function shortHost(name: string = hostname()): string {
	return name.split(".")[0] ?? name;
}

/** The role for this machine: `--rolle` first, then the host name in the profile. */
export function roleFor(profile: Profile, host: string, override?: string): { role: string } | { unknown: string } {
	if (override !== undefined) return override in profile.roller ? { role: override } : { unknown: override };
	const role = profile.maskiner[shortHost(host)];
	return role === undefined ? { unknown: shortHost(host) } : { role };
}

export function expandHome(p: string, home: string): string {
	return p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

export interface Context {
	home: string;
	/** The PAI repo's root, with symlinks resolved. */
	paiRepo: string;
	/** Where user units are linked: `$XDG_CONFIG_HOME/systemd/user`. */
	unitDir: string;
	envFile: string;
	user: string;
	/** `err` is stderr, for a command that changes something and can fail. */
	run: (cmd: string, args: string[], cwd?: string) => { code: number; out: string; err?: string };
}

export function defaultContext(opencodeDir: string, home: string, env: NodeJS.ProcessEnv = process.env): Context {
	const config = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
	return {
		home,
		paiRepo: realpathSync(join(opencodeDir, "..")),
		unitDir: join(config, "systemd", "user"),
		envFile: join(opencodeDir, ".env"),
		user: userInfo().username,
		run: (cmd, args, cwd) => {
			try {
				const r = spawnSync([cmd, ...args], {
					cwd,
					stdin: "inherit",
					stdout: "pipe",
					stderr: "pipe",
					// No password prompt from git: a clone that needs one fails and says so.
					env: { ...env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
				});
				return { code: r.exitCode ?? -1, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
			} catch {
				// The command is not on PATH.
				return { code: -1, out: "" };
			}
		},
	};
}

/** Where a unit's repo is on this machine: the PAI repo, or the clone the profile names. */
export function unitRepoRoot(profile: Profile, u: UnitSpec, ctx: Pick<Context, "home" | "paiRepo">): string {
	return u.repo === PAI_REPO ? ctx.paiRepo : expandHome(profile.repoer[u.repo]?.sti ?? "", ctx.home);
}

export interface RepoObs {
	exists: boolean;
	remote: string | null;
	dirty: boolean | null;
}

export interface UnitObs {
	/** Whether the unit's file exists in its repo. */
	sourceExists: boolean;
	kind: "symlink" | "file" | "missing";
	/** Whether the link resolves to the unit's file in the repo. */
	pointsRight: boolean;
	/** The link's target with symlinks resolved, when it resolves. */
	target: string | null;
	/** `systemctl --user is-enabled`; null when systemctl could not answer. */
	enabled: string | null;
	failed: boolean;
}

export interface Observation {
	repos: Record<string, RepoObs>;
	/** Keyed by the unit's file name. */
	units: Record<string, UnitObs>;
	/** null when loginctl could not answer. */
	linger: boolean | null;
	/** Keys with a value in `.env`; null when there is no `.env`. */
	envSet: Set<string> | null;
	/** Non-comment lines in `crontab -l`; null when crontab could not answer. */
	cronLines: number | null;
}

/** What the machine has, for the role. Reads only. */
export function observe(profile: Profile, roleName: string, ctx: Context): Observation {
	const role = profile.roller[roleName];
	const repos: Record<string, RepoObs> = {};
	for (const name of role?.repoer ?? []) {
		const path = expandHome(profile.repoer[name]?.sti ?? "", ctx.home);
		if (!existsSync(join(path, ".git"))) {
			repos[name] = { exists: false, remote: null, dirty: null };
			continue;
		}
		const remote = ctx.run("git", ["-C", path, "remote", "get-url", "origin"]);
		const status = ctx.run("git", ["-C", path, "status", "--porcelain"]);
		repos[name] = {
			exists: true,
			remote: remote.code === 0 ? remote.out : null,
			dirty: status.code === 0 ? status.out !== "" : null,
		};
	}

	const units: Record<string, UnitObs> = {};
	for (const u of role?.enheter ?? []) {
		const name = basename(u.fil);
		const link = join(ctx.unitDir, name);
		const source = join(unitRepoRoot(profile, u, ctx), u.fil);
		const sourceExists = existsSync(source);
		let kind: UnitObs["kind"] = "missing";
		let target: string | null = null;
		try {
			const st = lstatSync(link);
			kind = st.isSymbolicLink() ? "symlink" : "file";
			if (kind === "symlink") target = realpathSync(link);
		} catch {
			// Missing, or a dangling link (realpath throws): target stays null.
		}
		const en = ctx.run("systemctl", ["--user", "is-enabled", name]);
		const failed = ctx.run("systemctl", ["--user", "is-failed", "--quiet", name]);
		units[name] = {
			sourceExists,
			kind,
			pointsRight: sourceExists && target !== null && target === realpathSync(source),
			target,
			enabled: en.out || (en.code === -1 ? null : "not-found"),
			failed: failed.code === 0,
		};
	}

	let linger: boolean | null = null;
	if (role?.linger) {
		const l = ctx.run("loginctl", ["show-user", ctx.user, "--property=Linger", "--value"]);
		linger = l.code === 0 ? l.out === "yes" : null;
	}

	let envSet: Set<string> | null = null;
	if (existsSync(ctx.envFile)) {
		const parsed = parseEnv(readFileSync(ctx.envFile, "utf8"));
		envSet = new Set(Object.entries(parsed).filter(([, v]) => v !== "").map(([k]) => k));
	}

	const cron = ctx.run("crontab", ["-l"]);
	// `crontab -l` exits 1 with "no crontab for <user>": no lines, not an unknown.
	const cronLines =
		cron.code === 0
			? cron.out.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).length
			: cron.code === -1
				? null
				: 0;

	return { repos, units, linger, envSet, cronLines };
}

export type Status = "ok" | "missing" | "drift" | "manual" | "warning";

export interface Step {
	type: "repo" | "unit" | "linger" | "env" | "cron";
	name: string;
	status: Status;
	message: string;
	/** The command that fixes it, when there is one the user can run. */
	command?: string;
}

/** The steps for the role, from what was observed. Pure: no fs, no processes. */
export function assess(
	profile: Profile,
	roleName: string,
	obs: Observation,
	ctx: Pick<Context, "home" | "paiRepo" | "unitDir">,
): Step[] {
	const role = profile.roller[roleName];
	if (!role) return [];
	const steps: Step[] = [];

	for (const name of role.repoer) {
		const spec = profile.repoer[name];
		const path = expandHome(spec?.sti ?? "", ctx.home);
		const o = obs.repos[name];
		if (!spec || !o?.exists) {
			steps.push({ type: "repo", name, status: "missing", message: `${spec?.sti} is not cloned`, command: `git clone ${spec?.url} ${path}` });
		} else if (o.remote !== spec.url) {
			steps.push({ type: "repo", name, status: "drift", message: `origin is ${o.remote ?? "not set"}, the profile says ${spec.url}` });
		} else if (spec.les && o.dirty) {
			steps.push({
				type: "repo",
				name,
				status: "drift",
				message: `local changes in a read-only clone (${spec.sti})`,
				command: `git -C ${path} status`,
			});
		} else steps.push({ type: "repo", name, status: "ok", message: spec.sti });
	}

	for (const u of role.enheter) {
		const name = basename(u.fil);
		const want = join(unitRepoRoot(profile, u, ctx), u.fil);
		const link = join(ctx.unitDir, name);
		const o = obs.units[name];
		if (u.repo !== PAI_REPO && !obs.repos[u.repo]?.exists) {
			steps.push({ type: "unit", name, status: "missing", message: `repo ${u.repo} is not cloned` });
		} else if (!o?.sourceExists) {
			steps.push({ type: "unit", name, status: "drift", message: `${u.fil} is not in repo ${u.repo}` });
		} else if (o.kind === "missing") {
			steps.push({ type: "unit", name, status: "missing", message: "is not linked", command: `ln -s ${want} ${link}` });
		} else if (o.kind === "file") {
			steps.push({ type: "unit", name, status: "drift", message: `${link} is a regular file, not a symlink to ${want}` });
		} else if (!o.pointsRight) {
			steps.push({ type: "unit", name, status: "drift", message: `points to ${o.target ?? "nothing"}, not ${want}` });
		} else if (o.failed) {
			steps.push({ type: "unit", name, status: "drift", message: "has failed", command: `journalctl --user -u ${name} -n 20` });
		} else if (u.aktiver && o.enabled !== "enabled") {
			steps.push({
				type: "unit",
				name,
				status: "missing",
				message: `is not enabled (${o.enabled ?? "unknown"})`,
				command: `systemctl --user enable --now ${name}`,
			});
		} else steps.push({ type: "unit", name, status: "ok", message: u.aktiver ? "linked and enabled" : "linked" });
	}

	if (role.linger) {
		if (obs.linger === true) steps.push({ type: "linger", name: "linger", status: "ok", message: "on" });
		else if (obs.linger === false)
			steps.push({
				type: "linger",
				name: "linger",
				status: "missing",
				message: "is off, and the role runs without anyone logged in",
				command: "loginctl enable-linger",
			});
		else steps.push({ type: "linger", name: "linger", status: "manual", message: "loginctl did not answer" });
	}

	for (const k of role.env) {
		if (obs.envSet?.has(k)) steps.push({ type: "env", name: k, status: "ok", message: "set" });
		else
			steps.push({
				type: "env",
				name: k,
				status: "manual",
				message: obs.envSet === null ? "there is no .env" : "is not set in .env (you set it yourself)",
			});
	}

	if (obs.cronLines && obs.cronLines > 0)
		steps.push({
			type: "cron",
			name: "crontab",
			status: "warning",
			message: `${obs.cronLines} cron line(s): the profile knows only systemd, and the cron jobs are to become timers`,
			command: "crontab -l",
		});

	return steps;
}

/** Steps that keep the machine from being what the profile says. A `warning` does not. */
export function problems(steps: Step[]): Step[] {
	return steps.filter((s) => s.status !== "ok" && s.status !== "warning");
}

export const PROFILE_PATH = join("PAI", "USER", "MASKINER.yaml");

export type CheckResult =
	| { kind: "no-profile"; path: string }
	| { kind: "bad-profile"; path: string; errors: string[] }
	| { kind: "unknown"; path: string; name: string; roles: string[] }
	| { kind: "checked"; path: string; host: string; role: string; steps: Step[] };

/** The whole check for this machine: read the profile, find the role, observe, assess. */
export function check(
	opencodeDir: string,
	home: string,
	opts: { profile?: string; role?: string; host?: string; ctx?: Context } = {},
): CheckResult {
	const path = opts.profile ?? join(opencodeDir, PROFILE_PATH);
	if (!existsSync(path)) return { kind: "no-profile", path };
	let profile: Profile;
	try {
		profile = parseProfile(readFileSync(path, "utf8"), path);
	} catch (e) {
		if (e instanceof ProfileError) return { kind: "bad-profile", path, errors: e.errors };
		throw e;
	}
	const host = shortHost(opts.host ?? hostname());
	const r = roleFor(profile, host, opts.role);
	if ("unknown" in r) return { kind: "unknown", path, name: r.unknown, roles: Object.keys(profile.roller) };
	const ctx = opts.ctx ?? defaultContext(opencodeDir, home);
	return { kind: "checked", path, host, role: r.role, steps: assess(profile, r.role, observe(profile, r.role, ctx), ctx) };
}

export type Action =
	| { type: "clone"; name: string; url: string; path: string }
	| { type: "link"; name: string; source: string; link: string }
	| { type: "daemon-reload" }
	| { type: "enable"; name: string }
	| { type: "linger" };

/**
 * What makes the role's `missing` steps ok, in the order they must run. Pure.
 * Drift is not here: a wrong link, a regular file, another origin or a failed
 * unit is the user's to look at. A unit whose repo is not cloned yet waits for
 * the next round, after the clone (`apply` observes again).
 */
export function plan(profile: Profile, roleName: string, obs: Observation, ctx: Pick<Context, "home" | "paiRepo" | "unitDir">): Action[] {
	const role = profile.roller[roleName];
	if (!role) return [];
	const clones: Action[] = [];
	for (const name of role.repoer) {
		const spec = profile.repoer[name];
		if (spec && !obs.repos[name]?.exists) clones.push({ type: "clone", name, url: spec.url, path: expandHome(spec.sti, ctx.home) });
	}
	const links: Action[] = [];
	const enables: Action[] = [];
	for (const u of role.enheter) {
		const name = basename(u.fil);
		const o = obs.units[name];
		if (!o?.sourceExists || o.failed) continue;
		if (u.repo !== PAI_REPO && !obs.repos[u.repo]?.exists) continue;
		if (o.kind === "missing") links.push({ type: "link", name, source: join(unitRepoRoot(profile, u, ctx), u.fil), link: join(ctx.unitDir, name) });
		else if (o.kind !== "symlink" || !o.pointsRight) continue;
		if (u.aktiver && o.enabled !== "enabled") enables.push({ type: "enable", name });
	}
	const reload: Action[] = links.length + enables.length > 0 ? [{ type: "daemon-reload" }] : [];
	const linger: Action[] = role.linger && obs.linger === false ? [{ type: "linger" }] : [];
	return [...clones, ...links, ...reload, ...enables, ...linger];
}

export interface Done {
	action: Action;
	ok: boolean;
	message: string;
}

export function actionLine(a: Action): string {
	switch (a.type) {
		case "clone":
			return `git clone ${a.url} ${a.path}`;
		case "link":
			return `ln -s ${a.source} ${a.link}`;
		case "daemon-reload":
			return "systemctl --user daemon-reload";
		case "enable":
			return `systemctl --user enable --now ${a.name}`;
		case "linger":
			return "loginctl enable-linger";
	}
}

/**
 * Runs the actions. Each checks first, so a second run does nothing, and a
 * path that has something on it is never written over. Linger only after
 * `confirm` says yes: it keeps the user's services running after logout.
 */
export function apply(actions: Action[], ctx: Context, confirm: (question: string) => boolean): Done[] {
	const done: Done[] = [];
	const fail = (action: Action, r: { code: number; out: string; err?: string }) =>
		done.push({ action, ok: false, message: (r.err || r.out || `exit ${r.code}`).split("\n").slice(-3).join(" ") });
	for (const a of actions) {
		switch (a.type) {
			case "clone": {
				if (existsSync(a.path)) {
					done.push({ action: a, ok: false, message: `${a.path} exists and is not a clone; left alone` });
					break;
				}
				mkdirSync(dirname(a.path), { recursive: true });
				const r = ctx.run("git", ["clone", "-q", a.url, a.path]);
				if (r.code === 0) done.push({ action: a, ok: true, message: `cloned to ${a.path}` });
				else fail(a, r);
				break;
			}
			case "link": {
				let there = true;
				try {
					lstatSync(a.link);
				} catch {
					there = false;
				}
				if (there) {
					done.push({ action: a, ok: false, message: `${a.link} exists; left alone` });
					break;
				}
				mkdirSync(dirname(a.link), { recursive: true });
				symlinkSync(a.source, a.link);
				done.push({ action: a, ok: true, message: `linked to ${a.source}` });
				break;
			}
			case "daemon-reload":
			case "enable": {
				const args = a.type === "enable" ? ["--user", "enable", "--now", a.name] : ["--user", "daemon-reload"];
				const r = ctx.run("systemctl", args);
				if (r.code === 0) done.push({ action: a, ok: true, message: a.type === "enable" ? "enabled and started" : "reloaded" });
				else fail(a, r);
				break;
			}
			case "linger": {
				if (!confirm(`Turn on linger for ${ctx.user}, so the user services run without anyone logged in?`)) {
					done.push({ action: a, ok: false, message: "not turned on (no yes)" });
					break;
				}
				const r = ctx.run("loginctl", ["enable-linger"]);
				if (r.code === 0) done.push({ action: a, ok: true, message: "on" });
				else fail(a, r);
				break;
			}
		}
	}
	return done;
}

/**
 * `pai maskin`: plan and apply until nothing more can be done, then check.
 * Two rounds are enough: the second links the units of the repos the first
 * cloned. A round that does nothing ends it.
 */
export function setUp(
	opencodeDir: string,
	home: string,
	confirm: (question: string) => boolean,
	opts: { profile?: string; role?: string; host?: string; ctx?: Context } = {},
): { done: Done[]; result: CheckResult } {
	const done: Done[] = [];
	const first = check(opencodeDir, home, opts);
	if (first.kind !== "checked") return { done, result: first };
	const path = opts.profile ?? join(opencodeDir, PROFILE_PATH);
	const profile = parseProfile(readFileSync(path, "utf8"), path);
	const ctx = opts.ctx ?? defaultContext(opencodeDir, home);
	const tried = new Set<string>();
	for (let round = 0; round < 2; round++) {
		// A failed action is not tried again; daemon-reload goes with each round's links.
		const actions = plan(profile, first.role, observe(profile, first.role, ctx), ctx).filter(
			(a) => a.type === "daemon-reload" || !tried.has(actionLine(a)),
		);
		if (actions.every((a) => a.type === "daemon-reload")) break;
		for (const a of actions) tried.add(actionLine(a));
		done.push(...apply(actions, ctx, confirm));
	}
	return { done, result: check(opencodeDir, home, { ...opts, ctx }) };
}

const ICON: Record<Status, string> = { ok: "✅", missing: "❌", drift: "❌", manual: "✋", warning: "⚠️ " };

/** One line per step, as `pai maskin --sjekk` and `pai doctor` print them. */
export function stepLine(s: Step, icon = true): string {
	const tail = s.status !== "ok" && s.command ? `: ${s.command}` : "";
	return `${icon ? `${ICON[s.status]} ` : ""}${s.type} ${s.name} ${s.message}${tail}`;
}
