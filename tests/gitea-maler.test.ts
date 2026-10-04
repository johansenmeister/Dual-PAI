/**
 * Kontrakt-test: malene for Gitea-oppsettet (#162, fase 3)
 *
 * Prosedyren (`guide/gitea.md`) er kjørt ende til ende mot Proxmox VE 9.2
 * med Gitea 1.27.3 (2026-10-04). Her vokter vi to ting den hviler på:
 * compose-malen pinner en eksakt versjon, som motorene, og
 * `pve.sh` gir tokenet til curl gjennom en fildeskriptor, aldri som argument,
 * der det ville stått i `ps` og i et transkript.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAPPE = join(import.meta.dir, "..", "guide", "gitea");

describe("compose-malen", () => {
	for (const fil of ["compose.yml"]) {
		test(`${fil} pinner bildet til en eksakt versjon`, () => {
			const bilder = [...readFileSync(join(MAPPE, fil), "utf-8").matchAll(/^\s*image:\s*(\S+)/gm)].map((m) => m[1] ?? "");
			expect(bilder.length).toBe(1);
			for (const b of bilder) expect(b).toMatch(/:\d+\.\d+\.\d+$/);
		});
	}
});

describe("pve.sh", () => {
	let rot: string;
	const HEMMELIG = "hemmelig-0123456789abcdef";

	beforeEach(() => {
		rot = mkdtempSync(join(tmpdir(), "pve-sh-"));
		writeFileSync(
			join(rot, "test.env"),
			`PROXMOX_API_URL=https://pve.example:8006/api2/json/\nPROXMOX_TOKEN_ID=pai@pve!pai\nPROXMOX_TOKEN_SECRET=${HEMMELIG}\n`,
		);
		// Den falske curl skriver argumentene og innholdet i -K-fila.
		writeFileSync(
			join(rot, "curl"),
			`#!/bin/bash\nprintf '%s\\n' "$@" > "${rot}/argv"\nwhile [ $# -gt 0 ]; do [ "$1" = -K ] && cat "$2" > "${rot}/config"; shift; done\necho '{"data":{}}'\n`,
		);
		chmodSync(join(rot, "curl"), 0o755);
	});

	afterEach(() => rmSync(rot, { recursive: true, force: true }));

	function kall(...args: string[]) {
		return Bun.spawnSync(["bash", "-c", `. "${join(MAPPE, "pve.sh")}"; pve "$@"`, "pve", ...args], {
			env: { PATH: `${rot}:/usr/bin:/bin`, PVE_ENV: join(rot, "test.env") },
		});
	}

	test("syntaksen er gyldig", () => {
		expect(Bun.spawnSync(["bash", "-n", join(MAPPE, "pve.sh")]).exitCode).toBe(0);
	});

	test("tokenet går i -K-fila, ikke blant argumentene", () => {
		expect(kall("GET", "version").exitCode).toBe(0);
		expect(readFileSync(join(rot, "argv"), "utf-8")).not.toContain(HEMMELIG);
		expect(readFileSync(join(rot, "config"), "utf-8")).toBe(
			`header = "Authorization: PVEAPIToken=pai@pve!pai=${HEMMELIG}"\n`,
		);
	});

	test("adressen får /api2/json én gang, med eller uten den i .env", () => {
		kall("GET", "version");
		expect(readFileSync(join(rot, "argv"), "utf-8")).toContain("https://pve.example:8006/api2/json/version\n");
		writeFileSync(
			join(rot, "test.env"),
			`PROXMOX_API_URL=https://pve.example:8006\nPROXMOX_TOKEN_ID=a\nPROXMOX_TOKEN_SECRET=b\n`,
		);
		kall("GET", "version");
		expect(readFileSync(join(rot, "argv"), "utf-8")).toContain("https://pve.example:8006/api2/json/version\n");
	});
});

describe("skriptene", () => {
	const SKRIPT = ["vm.sh", "deploy.sh", "pai-setup.sh", "sync.sh"];

	test("syntaksen er gyldig", () => {
		for (const f of SKRIPT) expect(Bun.spawnSync(["bash", "-n", join(MAPPE, f)]).exitCode).toBe(0);
	});

	// Feil argumenter skal stoppe før skriptet rører nettverket eller en maskin.
	for (const [f, args, melding] of [
		["vm.sh", ["--node", "pve"], "missing --vmid"],
		["deploy.sh", ["vertenutenbruker"], "<user>@<host>"],
		["pai-setup.sh", ["a@b", "--gitea-user", "u", "--org", "o", "--access", "alt"], "tight or full"],
		["sync.sh", ["https://example.invalid/x.git"], "Usage"],
	] as const) {
		test(`${f} stopper på feil argumenter`, () => {
			const p = Bun.spawnSync(["bash", join(MAPPE, f), ...args], { env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" } });
			expect(p.exitCode).toBe(1);
			expect(p.stderr.toString()).toContain(melding);
		});
	}
});

describe("pve_check", () => {
	let rot: string;

	// Den falske curl svarer som Proxmox: versjonen, rettighetene per sti
	// (`?path=`), og lagringene på noden.
	function lag(rettigheter: Record<string, string[]>, lagringer: { storage: string; content: string }[]) {
		rot = mkdtempSync(join(tmpdir(), "pve-check-"));
		writeFileSync(join(rot, "test.env"), "PROXMOX_API_URL=https://pve.example:8006\nPROXMOX_TOKEN_ID=a\nPROXMOX_TOKEN_SECRET=b\n");
		writeFileSync(join(rot, "perms.json"), JSON.stringify(rettigheter));
		writeFileSync(join(rot, "storage.json"), JSON.stringify({ data: lagringer }));
		writeFileSync(
			join(rot, "curl"),
			`#!/bin/bash
for a; do url=$a; done
case $url in
  */version) echo '{"data":{"version":"9.2"}}' ;;
  *access/permissions?path=*) p=$(printf '%b' "\${url#*path=}" | sed 's/%2F/\\//g'); jq -c --arg p "$p" '{data: {($p): ((.[$p] // []) | map({(.): 1}) | add // {})}}' "${rot}/perms.json" ;;
  */storage) cat "${rot}/storage.json" ;;
esac
`,
		);
		chmodSync(join(rot, "curl"), 0o755);
	}

	afterEach(() => rmSync(rot, { recursive: true, force: true }));

	function sjekk() {
		const p = Bun.spawnSync(
			["bash", "-c", `. "${join(MAPPE, "pve.sh")}"; pve_check pve pai-lab local-lvm local vmbr0`],
			{ env: { PATH: `${rot}:/usr/bin:/bin`, PVE_ENV: join(rot, "test.env") } },
		);
		return { kode: p.exitCode, ut: p.stdout.toString() };
	}

	const POOL = ["VM.Allocate", "VM.PowerMgmt", "VM.Config.CDROM", "VM.Config.CPU", "VM.Config.Cloudinit", "VM.Config.Disk", "VM.Config.HWType", "VM.Config.Memory", "VM.Config.Network", "VM.Config.Options", "Datastore.AllocateSpace"];
	const ALT = {
		"/pool/pai-lab": POOL,
		"/storage/local-lvm": ["Datastore.AllocateSpace"],
		"/storage/local": ["Datastore.AllocateTemplate"],
		"/sdn/zones/localnetwork/vmbr0": ["SDN.Use"],
		"/nodes/pve": ["Sys.AccessNetwork"],
	};
	const LAGRINGER = [
		{ storage: "local", content: "iso,vztmpl,import" },
		{ storage: "local-lvm", content: "images,rootdir" },
	];

	test("alt på plass gir bare ✓ og exit 0", () => {
		lag(ALT, LAGRINGER);
		const r = sjekk();
		expect(r.kode).toBe(0);
		expect(r.ut).not.toContain("✗");
		expect(r.ut.match(/✓/g)?.length).toBe(7);
	});

	test("en manglende rettighet på broen navngis, og exit er 1", () => {
		lag({ ...ALT, "/sdn/zones/localnetwork/vmbr0": [] }, LAGRINGER);
		const r = sjekk();
		expect(r.kode).toBe(1);
		expect(r.ut).toContain("✗ /sdn/zones/localnetwork/vmbr0 is missing: SDN.Use");
	});

	test("én av poolens rettigheter mangler, og bare den nevnes", () => {
		lag({ ...ALT, "/pool/pai-lab": POOL.filter((p) => p !== "VM.Config.Cloudinit") }, LAGRINGER);
		const r = sjekk();
		expect(r.kode).toBe(1);
		expect(r.ut).toContain("✗ /pool/pai-lab is missing: VM.Config.Cloudinit\n");
	});

	test("en lagring uten innholdstypen import stopper", () => {
		lag(ALT, [{ storage: "local", content: "iso,vztmpl" }, LAGRINGER[1] as { storage: string; content: string }]);
		const r = sjekk();
		expect(r.kode).toBe(1);
		expect(r.ut).toContain("✗ local cannot hold the cloud image");
	});
});
