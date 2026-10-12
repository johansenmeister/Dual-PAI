/**
 * Contract test: komodo.ts reads, and keeps the secrets out (#380, job #23)
 *
 * Komodo's read API returns secrets in several places. The fixtures put a
 * marker in every one of them, and no command may print it. They also hold
 * the fields the tool should print, so a projection that drops everything
 * would not pass either. Field names are from komodo_client 2.3.2.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Env, type Fetch, loadEnv, parseDotenv, read, run } from "./komodo";

const SECRET = "s3cr3t-must-not-leak";
const ENV: Env = { host: "https://komodo.example", key: "K", secret: "S" };

const STACK_LIST = [
	{
		id: "st1",
		name: "web",
		type: "Stack",
		template: false,
		tags: ["prod"],
		info: {
			server_name: "docker",
			state: "running",
			status: "Up 2 days",
			repo: "org/stacks",
			branch: "main",
			deployed_hash: "abc",
			latest_hash: "def",
			missing_files: [],
			services: [{ service: "app", image: "app:1", latest_image: "app:2", update_available: true }],
			// Not in the allowlist: a field a later Komodo might add.
			future_field: SECRET,
		},
	},
];

const STACK = {
	_id: { $oid: "st1" },
	name: "web",
	config: {
		server_id: "srv1",
		repo: "org/stacks",
		branch: "main",
		file_paths: ["compose.yaml"],
		environment: `DB_PASSWORD=${SECRET}`,
		file_contents: `services: {app: {environment: [PW=${SECRET}]}}`,
		webhook_secret: SECRET,
	},
	info: {
		deployed_hash: "abc",
		deployed_message: "bump app",
		deployed_contents: [{ path: "compose.yaml", contents: SECRET }],
		deployed_config: `PW: ${SECRET}`,
		remote_contents: [{ path: "compose.yaml", contents: SECRET }],
		remote_errors: [{ path: "broken.yaml", contents: SECRET }],
		deployed_services: [{ service_name: "app", container_name: "web-app-1" }],
	},
};

const SERVICES = [
	{
		service: "app",
		image: "app:1",
		update_available: false,
		container: { name: "web-app-1", state: "running", status: "Up", image: "app:1", labels: { auth: SECRET } },
	},
];

const UPDATE = {
	_id: { $oid: "up1" },
	operation: "DeployStack",
	status: "Complete",
	success: false,
	start_ts: 1_760_000_000_000,
	end_ts: 1_760_000_060_000,
	operator: "ada",
	target: { type: "Stack", id: "st1" },
	prev_toml: `environment = "PW=${SECRET}"`,
	current_toml: `environment = "PW=${SECRET}"`,
	other_data: SECRET,
	logs: [
		{ stage: "Compose Config", command: "docker compose config", stdout: `PW: ${SECRET}`, stderr: SECRET, success: true, start_ts: 1, end_ts: 2 },
		{ stage: "compose config", command: "x", stdout: SECRET, stderr: "", success: true, start_ts: 1, end_ts: 2 },
		{ stage: "Compose Up", command: "docker compose up -d", stdout: "", stderr: "pull access denied for app", success: false, start_ts: 3, end_ts: 4 },
	],
};

const SYNC = {
	name: "stacks",
	config: { delete: false, managed: false },
	info: {
		pending_hash: "fff",
		pending_message: "add db",
		resource_updates: [{ target: { type: "Stack", id: "db" }, data: { type: "Create", data: { name: "db", proposed: SECRET } } }],
		variable_updates: [{ type: "Update", data: { proposed: SECRET, current: SECRET } }],
		pending_deploys: [{ target: { type: "Stack", id: "db" }, reason: SECRET }],
		remote_contents: [{ resource_path: "x", path: "stacks.toml", contents: SECRET }],
	},
};

const RESPONSES: Record<string, unknown> = {
	ListStacks: STACK_LIST,
	GetStack: STACK,
	ListStackServices: SERVICES,
	ListServers: [{ id: "srv1", name: "docker", info: { state: "Ok", version: "2.3.3", region: "", public_key: SECRET } }],
	ListUpdates: { updates: [{ id: "up1", operation: "DeployStack", status: "Complete", success: false, start_ts: 1, username: "ada", target: { type: "Stack", id: "st1" }, other_data: SECRET }] },
	GetUpdate: UPDATE,
	ListResourceSyncs: [{ id: "sy1", name: "stacks", info: { state: "Pending", managed: false, last_sync_ts: 1, last_sync_message: "ok" } }],
	GetResourceSync: SYNC,
};

/** A fake Komodo that answers from RESPONSES and records each call. */
function fake() {
	const calls: { url: string; init: RequestInit }[] = [];
	const fetchFn: Fetch = async (url, init) => {
		calls.push({ url, init });
		const type = url.split("/").pop() ?? "";
		return new Response(JSON.stringify(RESPONSES[type] ?? null), { status: 200 });
	};
	return { calls, fetchFn };
}

const COMMANDS = [["stacks"], ["stack", "web"], ["servers"], ["updates"], ["updates", "--stack", "web"], ["update", "up1"], ["syncs"], ["sync", "stacks"]];

describe("no secret leaves the tool", () => {
	test.each(COMMANDS.map((c) => [c.join(" "), c]))("%s", async (_name, command) => {
		const { fetchFn } = fake();
		const out = JSON.stringify(await run(command as string[], ENV, fetchFn));
		expect(out).not.toContain(SECRET);
		expect(out.length).toBeGreaterThan(20);
	});
});

describe("what it does print", () => {
	test("stacks: state and update flags", async () => {
		const [stack] = (await run(["stacks"], ENV, fake().fetchFn)) as Record<string, unknown>[];
		expect(stack).toMatchObject({ name: "web", server: "docker", state: "running", latest_hash: "def" });
		expect(stack.services).toEqual([{ service: "app", image: "app:1", latest_image: "app:2", update_available: true }]);
	});

	test("stack: config without values, and the containers", async () => {
		const out = (await run(["stack", "web"], ENV, fake().fetchFn)) as Record<string, unknown>;
		expect(out).toMatchObject({ id: "st1", file_paths: ["compose.yaml"], deployed_services: ["app"], remote_errors: ["broken.yaml"] });
		expect(out.services).toEqual([
			{ service: "app", image: "app:1", update_available: false, container: { name: "web-app-1", state: "running", status: "Up", image: "app:1" } },
		]);
	});

	test("update: the failing stage's error, and every Compose Config stage withheld", async () => {
		const out = (await run(["update", "up1"], ENV, fake().fetchFn)) as { logs: Record<string, unknown>[] };
		expect(out.logs.map((l) => l.stage)).toEqual(["Compose Config", "compose config", "Compose Up"]);
		expect(out.logs[0]).not.toHaveProperty("stdout");
		expect(out.logs[1]).not.toHaveProperty("stdout");
		expect(out.logs[2]).toMatchObject({ success: false, stderr: "pull access denied for app" });
	});

	test("update: a long stream keeps its tail", async () => {
		const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
		RESPONSES.GetUpdate = { ...UPDATE, logs: [{ stage: "Compose Up", stdout: long, stderr: "", success: true }] };
		try {
			const out = (await run(["update", "up1"], ENV, fake().fetchFn)) as { logs: { stdout: string }[] };
			expect(out.logs[0].stdout).toStartWith("… (60 lines cut)");
			expect(out.logs[0].stdout).toEndWith("line 99");
		} finally {
			RESPONSES.GetUpdate = UPDATE;
		}
	});

	test("sync: what would change, as a summary", async () => {
		const out = await run(["sync", "stacks"], ENV, fake().fetchFn);
		expect(out).toMatchObject({
			pending_message: "add db",
			resource_updates: [{ type: "Stack", id: "db", change: "Create" }],
			variable_updates: 1,
			pending_deploys: [{ type: "Stack", id: "db" }],
		});
	});

	test("updates --stack filters on the stack's id", async () => {
		const { calls, fetchFn } = fake();
		await run(["updates", "--stack", "web"], ENV, fetchFn);
		const list = calls.find((c) => c.url.endsWith("/ListUpdates"));
		expect(JSON.parse(String(list?.init.body))).toEqual({ query: { "target.type": "Stack", "target.id": "st1" }, page: 0 });
	});
});

describe("read-only", () => {
	test("every command calls /read/ and nothing else", async () => {
		const { calls, fetchFn } = fake();
		for (const c of COMMANDS) await run(c, ENV, fetchFn);
		expect(calls.length).toBeGreaterThan(COMMANDS.length);
		for (const c of calls) expect(c.url).toStartWith("https://komodo.example/read/");
	});

	test("the key goes in the headers, and an unknown command does not call", async () => {
		const { calls, fetchFn } = fake();
		await read(ENV, "ListServers", {}, fetchFn);
		expect(calls[0].init.headers).toMatchObject({ "x-api-key": "K", "x-api-secret": "S" });
		await expect(run(["deploy", "web"], ENV, fetchFn)).rejects.toThrow("usage");
		await expect(read(ENV, "../write/DeployStack", {}, fetchFn)).rejects.toThrow("not a read request");
		expect(calls).toHaveLength(1);
	});
});

describe("the environment", () => {
	test(".env lines, with export and quotes", () => {
		expect(parseDotenv(`# c\nexport A="1"\nB='2'\nC=3=4\n`)).toEqual({ A: "1", B: "2", C: "3=4" });
	});

	test("read from .env when not set, and the environment wins", () => {
		const dir = mkdtempSync(join(tmpdir(), "komodo-env-"));
		try {
			const file = join(dir, ".env");
			writeFileSync(file, "KOMODO_CLI_HOST=https://k.example/\nKOMODO_CLI_KEY=fromfile\nKOMODO_CLI_SECRET=s\n");
			expect(loadEnv({}, [file])).toEqual({ host: "https://k.example", key: "fromfile", secret: "s" });
			expect(loadEnv({ KOMODO_CLI_KEY: "fromenv" }, [file]).key).toBe("fromenv");
			expect(() => loadEnv({}, [join(dir, "none")])).toThrow("missing KOMODO_CLI_HOST, KOMODO_CLI_KEY, KOMODO_CLI_SECRET");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
