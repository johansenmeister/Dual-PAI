/**
 * Kontrakt-test: `pai doctor` kaller hver sjekk sin (K51)
 *
 * Sjekkene i doctoren er testet som funksjoner (K5, K26, K29, K32, K40 og
 * selvtesten), men ingenting kjørte `cmdDoctor`. Da K40 ble tatt over, var
 * «kallet borte fra doctoren» den eneste av seks mutasjoner som slapp gjennom.
 *
 * Kjører den ekte launcheren mot et temp-tre bak en falsk `HOME`, uten
 * `opencode.db`, uten v2-binær, uten Claude og uten nettverk. Treet er bygget
 * så hver sjekk har noe å si fra om, fordi en taus ✅ ikke skiller «kalt og
 * fant ingenting» fra «ikke kalt». Den andre testen er den tause retningen for
 * de tre sjekkene treet kan gjøre grønne (regel 1 i «Vaktene: tre lag»).
 *
 * @module tests/pai-doctor
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const EKTE = join(import.meta.dir, "..", ".opencode");
const PAI_TS = join(EKTE, "PAI", "Tools", "pai.ts");

const OVERSKRIFTER = {
	tre: "The launcher (K40",
	v2: "OpenCode v2 (self-test",
	register: "Model registry",
	db: "v2 database (K10",
	mcp: "MCP servers (K26",
	effekt: "Handlers that run without effect (K5",
	speil: "Read-only mirrors (K57",
	nøkler: "The keys in .env (#162",
	claude: "Claude Code (self-test",
} as const;

let rot: string;
let home: string;
let tre: string;

/** Økter som har en PRD, men ingen `prd-synced`: K5 skal si fra om prd-sync. */
function øktUtenEffekt(dag: number): void {
	const d = join(tre, "MEMORY", "WORK", "2026-09", `2026-09-0${dag}T00-00-00_test`);
	mkdirSync(d, { recursive: true });
	writeFileSync(join(d, "META.yaml"), "status: COMPLETED\n");
	writeFileSync(join(d, "EFFEKTER.jsonl"), "");
	writeFileSync(join(d, "PRD.md"), "# PRD\n");
}

/** En liten `opencode.db` uten `models-dev:catalog`: K10 leser størrelsen, K29 sier fortsatt fra om katalogen. */
function litenDb(): void {
	const sti = join(home, ".local", "share", "opencode", "opencode.db");
	mkdirSync(dirname(sti), { recursive: true });
	const db = new Database(sti);
	db.run("CREATE TABLE t (b BLOB)");
	db.close();
}

function doctor(ekstra: Record<string, string> = {}): { kode: number; seksjoner: Map<string, string[]>; ut: string } {
	const r = Bun.spawnSync(["bun", PAI_TS, "doctor"], {
		cwd: rot,
		// Ikke `process.env`: PATH uten `~/.local/bin`, så maskinens Claude ikke finnes.
		env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, LC_ALL: "C.UTF-8", ...ekstra },
		stdout: "pipe",
		stderr: "pipe",
		timeout: 30_000,
	});
	const ut = r.stdout.toString();
	const seksjoner = new Map<string, string[]>();
	for (const blokk of ut.split(/\n\s*\n/)) {
		const [hode, ...linjer] = blokk.split("\n").filter((l) => l.trim());
		const nøkkel = Object.entries(OVERSKRIFTER).find(([, o]) => hode?.startsWith(o))?.[0];
		if (nøkkel) seksjoner.set(nøkkel, linjer);
	}
	return { kode: r.exitCode ?? -1, seksjoner, ut: ut + r.stderr.toString() };
}

beforeEach(() => {
	rot = mkdtempSync(join(tmpdir(), "pai-doctor-"));
	home = join(rot, "home");
	tre = join(rot, "tre", ".opencode");
	mkdirSync(join(tre, "PAI"), { recursive: true });
	mkdirSync(home);
	// Koden fra repoet, dataene fra temp-treet. `~/.opencode` er en symlenke, som på maskinene.
	symlinkSync(join(EKTE, "tools"), join(tre, "tools"));
	symlinkSync(join(EKTE, "PAI", "Tools"), join(tre, "PAI", "Tools"));
	symlinkSync(tre, join(home, ".opencode"));
	writeFileSync(
		join(tre, "package.json"),
		JSON.stringify({ dependencies: { "@opencode/cli": "0.0.1" }, pai: { claudeCode: "0.0.1" } })
	);
});

afterEach(() => {
	rmSync(rot, { recursive: true, force: true });
});

describe("pai doctor kaller hver sjekk (K51)", () => {
	test("hver seksjon sier fra med sin egen sjekks melding", () => {
		writeFileSync(
			join(tre, "opencode.json"),
			JSON.stringify({
				mcp: { doed: { type: "local", command: ["sh", "-c", "echo nøkkelen mangler >&2; exit 1"] } },
			})
		);
		for (const dag of [1, 2, 3]) øktUtenEffekt(dag);
		litenDb();
		// Et speil med en ukommittert fil: K57 skal si fra.
		const speil = join(home, "speil");
		mkdirSync(speil);
		Bun.spawnSync(["git", "init", "-q", speil]);
		writeFileSync(join(speil, "side.md"), "lokal\n");
		mkdirSync(join(tre, "PAI", "USER"));
		writeFileSync(join(tre, "PAI", "USER", "SKRIVEBESKYTTET.json"), JSON.stringify({ stier: ["~/speil"] }));
		// En .env andre kan lese: nøkkelsjekken skal si fra.
		writeFileSync(join(tre, ".env.example"), "# ## G\nA_KEY=\n");
		writeFileSync(join(tre, ".env"), "A_KEY=1\n");
		chmodSync(join(tre, ".env"), 0o644);

		const { kode, seksjoner, ut } = doctor();
		expect([...seksjoner.keys()], ut).toEqual(Object.keys(OVERSKRIFTER));
		const i = (s: string) => (seksjoner.get(s) ?? []).join("\n");

		expect(i("tre")).toContain("❌ The launcher is in ");
		expect(i("v2")).toContain("❌ The v2 binary is missing");
		expect(i("register")).toContain("❌ the model catalog is missing");
		// Terskelen er testet i db-helse.test.ts; her er det kallet: størrelsen står der.
		expect(seksjoner.get("db")).toEqual(["  ✅ 0 MB, below the threshold"]);
		expect(i("mcp")).toContain("❌ MCP server doed is in opencode.json, but Claude does not have it");
		expect(i("mcp")).toContain("❌ MCP server doed died at startup (exit 1): nøkkelen mangler");
		expect(i("effekt")).toContain("❌ prd-sync: a PRD in the session directory in 3 of the last 3 sessions");
		expect(i("speil")).toContain(`❌ ${join(home, "speil")}: 1 local change(s) in a read-only mirror`);
		expect(i("nøkler")).toContain(`❌ ${join(tre, ".env")} is readable by others (644)`);
		expect(i("claude")).toContain("❌ ClaudeSmoke has not passed against Claude Code 0.0.1");
		// En sjekk som ikke lot seg laste, er ikke en sjekk som kjørte.
		expect(ut).not.toContain("could not");
		expect(ut).toContain("❌ 9 problem(s)");
		expect(kode).toBe(1);
	});

	test("taus der treet er i orden: eksplisitt OPENCODE_DIR, ingen MCP-servere, ingen økter", () => {
		symlinkSync(join(EKTE, ".env.example"), join(tre, ".env.example"));
		const { seksjoner, ut } = doctor({ OPENCODE_DIR: join(home, ".opencode") });
		expect([...seksjoner.keys()], ut).toEqual(Object.keys(OVERSKRIFTER));
		expect(seksjoner.get("tre")).toEqual([`  ✅ ${tre}`]);
		expect(seksjoner.get("mcp")).toEqual(["  ✅ no issues"]);
		expect(seksjoner.get("effekt")).toEqual(["  ✅ no issues (0 sessions with markers)"]);
		expect(seksjoner.get("db")).toEqual(["  ✅ no opencode.db to check"]);
		expect(seksjoner.get("speil")).toEqual(["  ✅ no paths in PAI/USER/SKRIVEBESKYTTET.json"]);
		expect(seksjoner.get("nøkler")).toEqual(["  ✅ no .env yet (every key is optional)"]);
		expect(ut).not.toContain("could not");
	});
});
