/**
 * Kontrakt-test: eierens og DA-ens navn står ikke i koden (K20)
 *
 * `V2Smoke` hadde DA-navnet som konstant og ville gitt to røde sjekker i
 * jobbtreet, der DA-en heter noe annet; `MineReflections.ts` sendte e-post som
 * hjemmes DA-navn fra jobben (rettet med `getDAName()`, PR #70). Samme klasse som
 * M-29: en eierverdi i koden, som ingen test ser.
 *
 * Navnene leses fra treet selv, så testen vokter hvert tre med sine egne navn:
 * DA-navnet fra `PAI/USER/DAIDENTITY.md` (sporet), navnet i identitetsmalen
 * `PAI/DAIDENTITY.template.md` når den finnes (den blir DA-navnet i public, #162;
 * «PAI» slapp gjennom hjemme og ble først rødt der), og DA- og eiernavnet fra
 * `settings.json` når den finnes (maskinlokal, ikke i en klone).
 *
 * @module tests/navn-i-koden
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = join(import.meta.dir, "..");
const OPENCODE = join(REPO, ".opencode");

/** Kodekatalogene. Tester og markdown kan nevne navnene med vilje. */
const KATALOGER = [
	"Tools",
	".opencode/PAI/Tools",
	".opencode/pai-core",
	".opencode/pai-adapters",
	"claude-plugin/src",
	"claude-plugin/mcp",
];

function daNavn(fil = join(OPENCODE, "PAI", "USER", "DAIDENTITY.md")): string | null {
	const da = readFileSync(fil, "utf8").match(/\*\*Name:\*\*\s*(.+)/)?.[1];
	return da?.trim() || null;
}

const MAL = join(OPENCODE, "PAI", "DAIDENTITY.template.md");

function navn(): string[] {
	const ut = new Set<string>();
	const da = daNavn();
	if (da) ut.add(da);
	const mal = existsSync(MAL) ? daNavn(MAL) : null;
	if (mal) ut.add(mal);
	const settings = join(OPENCODE, "settings.json");
	if (existsSync(settings)) {
		try {
			const s = JSON.parse(readFileSync(settings, "utf8")) as {
				daidentity?: { name?: unknown };
				principal?: { name?: unknown };
			};
			for (const n of [s.daidentity?.name, s.principal?.name]) if (typeof n === "string" && n.trim()) ut.add(n.trim());
		} catch {
			// En ødelagt settings.json er ikke denne testens sak.
		}
	}
	return [...ut];
}

function tsFiler(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
		const sti = join(dir, d.name);
		if (d.isDirectory()) return d.name === "node_modules" ? [] : tsFiler(sti);
		return d.name.endsWith(".ts") && !d.name.endsWith(".test.ts") ? [sti] : [];
	});
}

describe("navnene står ikke i koden (K20)", () => {
	const alle = navn();

	test("DA-navnet er lest fra DAIDENTITY.md", () => {
		// Uten det vokter testen ingenting i en klone, der settings.json ikke finnes.
		expect(daNavn()).not.toBeNull();
	});

	test("ingen kodelinje har et av navnene som literal", () => {
		const mønstre = alle.map((n) => new RegExp(`(?<![\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u"));
		const funn: string[] = [];
		for (const fil of KATALOGER.flatMap((k) => tsFiler(join(REPO, k)))) {
			readFileSync(fil, "utf8")
				.split("\n")
				.forEach((linje, i) => {
					if (mønstre.some((m) => m.test(linje))) funn.push(`${relative(REPO, fil)}:${i + 1}: ${linje.trim()}`);
				});
		}
		// Rød her: les navnet med `getDAName()`/`getPrincipalName()` (pai-core/lib/identity.ts),
		// eller fra DAIDENTITY.md som `V2Smoke` gjør.
		expect(funn).toEqual([]);
	});
});
