/**
 * Finds the environment variables skills and tools read (#183).
 *
 * Code (`.ts`, `.js`, `.mjs`, `.py`): `process.env.X`, `Bun.env.X`,
 * `process.env["X"]`, `os.environ`/`os.getenv`, a parsed `.env` object named
 * `env`/`ENV` (`env.X`, `ENV["X"]`, `env.get("X")`), and `"X=` in a string, the
 * form the hand-written `.env` parsers match lines with. A write
 * (`process.env.X = …`) or a `delete` is not a read.
 *
 * Shell (`.sh`, and the bash/sh fences in markdown): `$X` and `${X}` where X is
 * not assigned in the same file, or in the same skill for markdown, where a
 * workflow uses what the skill's API page sets up. `X="${X:-default}"` is
 * counted: it reads X from the environment before giving it a default.
 *
 * @module tests/lib/env-lesere
 */

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";

const NAME = "[A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9]|[A-Z][A-Z0-9]{2,}";
const NOT_WRITE = "(?!\\s*=[^=])";
/** `delete env.X` removes a key from a child's environment; it is not a read. */
const NOT_DELETE = "(?<!delete\\s+)";

const CODE_READS = [
	`${NOT_DELETE}(?:process\\.env|Bun\\.env|import\\.meta\\.env)\\.(${NAME})\\b${NOT_WRITE}`,
	`(?:process\\.env|Bun\\.env)\\[\\s*["'\`](${NAME})["'\`]\\s*\\]${NOT_WRITE}`,
	`os\\.(?:environ\\.get|getenv)\\(\\s*["'](${NAME})["']`,
	`\\b(?:env|ENV|environ)(?:\\.get)?[[(]\\s*["'](${NAME})["']`,
	`${NOT_DELETE}\\benv\\.(${NAME})\\b${NOT_WRITE}`,
];
/** Only in code files: in a markdown fence, `"NAME=${value}"` is usually a cookie or a header. */
const ENV_LINE = `["'](${NAME})=`;

const SHELL_FENCES = new Set(["bash", "sh", "shell", "zsh"]);

function matches(text: string, pattern: string): string[] {
	return [...text.matchAll(new RegExp(pattern, "g"))].map((m) => m[1]);
}

export function codeReads(text: string, envLines = true): string[] {
	const patterns = envLines ? [...CODE_READS, ENV_LINE] : CODE_READS;
	return [...new Set(patterns.flatMap((p) => matches(text, p)))];
}

/** Names the shell text assigns: `X=`, `export`/`local`/`readonly`/`declare X=`, `for X in`, `read X`. */
export function shellAssigned(text: string): Set<string> {
	const set = new Set<string>();
	const assign = `(?:^|[\\s;&|(])(?:(?:export|local|readonly|declare(?:\\s+-\\w+)*)\\s+)?(${NAME})(?:\\[[^\\]]*\\])?\\+?=`;
	for (const v of matches(text, assign)) set.add(v);
	for (const v of matches(text, `\\bfor\\s+(${NAME})\\s+in\\b`)) set.add(v);
	for (const m of text.matchAll(/\bread\s+(?:-\w+\s+(?:'[^']*'\s+|"[^"]*"\s+)?)*([A-Z_][A-Z0-9_ ]*)/g))
		for (const v of m[1].split(/\s+/)) if (v) set.add(v);
	return set;
}

export function shellReads(text: string, assignedElsewhere: Set<string> = new Set()): string[] {
	const assigned = shellAssigned(text);
	const selfDefault = new Set<string>();
	for (const m of text.matchAll(new RegExp(`(${NAME})=["']?\\$\\{(${NAME}):?[-=]`, "g")))
		if (m[1] === m[2]) selfDefault.add(m[1]);
	const used = matches(text, `\\$\\{?(${NAME})\\b`);
	return [...new Set(used.filter((v) => selfDefault.has(v) || !(assigned.has(v) || assignedElsewhere.has(v))))];
}

export function markdownFences(text: string): { lang: string; body: string }[] {
	return [...text.matchAll(/^[ \t]*```(\w*)[^\n]*\n([\s\S]*?)^[ \t]*```/gm)].map((m) => ({ lang: m[1], body: m[2] }));
}

function walk(dir: string, out: string[]): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (name === "node_modules" || name.startsWith(".")) continue;
		const path = join(dir, name);
		const st = lstatSync(path);
		// skills/PAI is a symlink to PAI/; PAI/Tools is scanned on its own.
		if (st.isSymbolicLink()) continue;
		if (st.isDirectory()) walk(path, out);
		else out.push(path);
	}
}

/** The skill a file belongs to: the nearest directory up with a SKILL.md, else its own directory. */
function skillOf(file: string, root: string, skillDirs: Set<string>): string {
	let dir = dirname(file);
	while (dir.startsWith(root) && dir !== root) {
		if (skillDirs.has(dir)) return dir;
		dir = dirname(dir);
	}
	return dirname(file);
}

export interface EnvReads {
	/** Variable → files (relative to the tree) that read it. */
	reads: Map<string, string[]>;
	files: number;
}

/** Every variable read under `roots` (relative to `tree`, usually `.opencode`). */
export function envReads(tree: string, roots: string[]): EnvReads {
	const files: string[] = [];
	for (const r of roots) walk(join(tree, r), files);
	const skillDirs = new Set(files.filter((f) => f.endsWith(`${sep}SKILL.md`)).map(dirname));

	const shellBySkill = new Map<string, string>();
	const fences = new Map<string, { lang: string; body: string }[]>();
	for (const f of files.filter((x) => extname(x) === ".md")) {
		const fs = markdownFences(readFileSync(f, "utf-8"));
		fences.set(f, fs);
		const skill = skillOf(f, tree, skillDirs);
		const sh = fs.filter((x) => SHELL_FENCES.has(x.lang)).map((x) => x.body);
		shellBySkill.set(skill, [shellBySkill.get(skill) ?? "", ...sh].join("\n"));
	}

	const reads = new Map<string, string[]>();
	const add = (names: string[], file: string) => {
		for (const n of names) reads.set(n, [...(reads.get(n) ?? []), relative(tree, file)]);
	};
	let scanned = 0;
	for (const f of files) {
		const ext = extname(f);
		if ([".ts", ".js", ".mjs", ".py"].includes(ext)) add(codeReads(readFileSync(f, "utf-8")), f);
		else if (ext === ".sh") add(shellReads(readFileSync(f, "utf-8")), f);
		else if (ext === ".md") {
			const fs = fences.get(f) ?? [];
			const sh = fs.filter((x) => SHELL_FENCES.has(x.lang)).map((x) => x.body).join("\n");
			const skillShell = shellAssigned(shellBySkill.get(skillOf(f, tree, skillDirs)) ?? "");
			const names = [...codeReads(fs.map((x) => x.body).join("\n"), false), ...shellReads(sh, skillShell)];
			add([...new Set(names)], f);
		} else continue;
		scanned++;
	}
	return { reads, files: scanned };
}

/** The keys in `.env.example`: lines `NAME=`, not commented out. */
export function templateKeys(text: string): Set<string> {
	return new Set([...text.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((m) => m[1]));
}
