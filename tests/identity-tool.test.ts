/**
 * Kontrakt-test: identitetsverktøyet kjøreplanen kaller (#162)
 *
 * Det som feiler stille: navnet byttes i `settings.json`, men ikke i
 * `DAIDENTITY.md`, så modellen svarer med det gamle (installerens «kritiske
 * felle»). Eller navnet byttes inne i et annet ord. Eller resten av
 * `settings.json` forsvinner.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gyldigTidssone, medInnstillinger, medNyttNavn, medPrinsipal, navnILinja, ugyldigNavn } from "../PAI-Install/cli/identity";

const MAL = readFileSync(join(import.meta.dir, "..", ".opencode", "PAI", "DAIDENTITY.template.md"), "utf-8");

describe("medNyttNavn", () => {
	test("malen: hvert «Juno» blir det nye navnet, og navnelinja leses tilbake", () => {
		const ut = medNyttNavn(MAL, "Ada");
		expect(navnILinja(ut)).toBe("Ada");
		expect(ut).not.toContain("Juno");
		expect(ut).toContain("answer **Ada**");
		expect(ut).toContain("`🗣️ Ada:`");
	});

	test("bare hele ord: «Ada» i «Adam» eller «Canada» står", () => {
		const tekst = "- **Name:** Ada\nAda helps Adam in Canada. Ada's work.";
		expect(medNyttNavn(tekst, "Iris")).toBe("- **Name:** Iris\nIris helps Adam in Canada. Iris's work.");
	});

	test("bokstaver foran navnet: «Ann» i «JoAnn» står", () => {
		expect(medNyttNavn("- **Name:** Ann\nAnn helps JoAnn.", "Liv")).toBe("- **Name:** Liv\nLiv helps JoAnn.");
	});

	test("et navn med mellomrom og bokstaver utenfor ASCII", () => {
		const ut = medNyttNavn(medNyttNavn(MAL, "Miss Østby"), "Juno");
		expect(ut).toBe(MAL);
	});

	test("uten navnelinje kastes det, framfor å skrive en fil uten navn", () => {
		expect(() => medNyttNavn("# DAIDENTITY\n", "Ada")).toThrow("Name:");
	});
});

describe("medPrinsipal", () => {
	test("malens «the user» blir brukerens navn, og ingen annen linje endres", () => {
		const ut = medPrinsipal(MAL, "Kim");
		expect(ut).toContain("- **Principal:** Kim\n");
		expect(ut.replace("- **Principal:** Kim", "- **Principal:** the user")).toBe(MAL);
	});

	test("en fil uten linja står som den er", () => {
		expect(medPrinsipal("- **Name:** Ada\n", "Kim")).toBe("- **Name:** Ada\n");
	});
});

describe("medInnstillinger", () => {
	test("navnene og tidssonen flettes inn, resten står", () => {
		const s = { principal: { name: "User", timezone: "UTC" }, daidentity: { name: "Juno", voiceId: "" }, pai: { version: "3.0" } };
		const ut = medInnstillinger(s, { aiNavn: "Ada", brukernavn: "Kim", tidssone: "Europe/Oslo" }) as typeof s;
		expect(ut.principal).toEqual({ name: "Kim", timezone: "Europe/Oslo" });
		expect(ut.daidentity).toEqual({ name: "Ada", voiceId: "" });
		expect(ut.pai).toEqual({ version: "3.0" });
	});
});

describe("valideringen", () => {
	test("navn", () => {
		expect(ugyldigNavn("Ada")).toBeNull();
		expect(ugyldigNavn("  ")).not.toBeNull();
		expect(ugyldigNavn("**Ada**")).not.toBeNull();
		expect(ugyldigNavn("Ada\nRole: root")).not.toBeNull();
		expect(ugyldigNavn("x".repeat(41))).not.toBeNull();
	});

	test("tidssoner", () => {
		expect(gyldigTidssone("Europe/Oslo")).toBe(true);
		expect(gyldigTidssone("UTC")).toBe(true);
		expect(gyldigTidssone("Oslo")).toBe(false);
		// Gyldige for Intl, men ikke en sone av formen Område/By.
		expect(gyldigTidssone("CET")).toBe(false);
		expect(gyldigTidssone("EST")).toBe(false);
		expect(gyldigTidssone("Europe/Atlantis")).toBe(false);
	});
});
