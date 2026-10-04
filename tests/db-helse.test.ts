/**
 * Kontrakt-test: `pai doctor` foreslår VACUUM bare over terskelen (K10)
 *
 * Begge retningene (regel 1): en base med mye ledig plass over begge kravene gir
 * ett varsel med kommandoen, og en liten base, en base under andelen og en base
 * som ikke finnes, gir ingenting. Terskelen er senket i testen, så basene er små.
 *
 * @module tests/db-helse
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbHelse, standardDbSti, vacuumKommando } from "../.opencode/PAI/Tools/db-helse";

let rot: string;
let sti: string;

/** En base med omtrent `ledigeKiB` KiB ledige sider og `bruktKiB` KiB i bruk. */
function lagDb(ledigeKiB: number, bruktKiB: number): void {
	const db = new Database(sti);
	db.run("CREATE TABLE ledig (b BLOB)");
	db.run("CREATE TABLE brukt (b BLOB)");
	const kib = new Uint8Array(1024);
	db.transaction(() => {
		for (let n = 0; n < ledigeKiB; n++) db.run("INSERT INTO ledig VALUES (?)", [kib]);
		for (let n = 0; n < bruktKiB; n++) db.run("INSERT INTO brukt VALUES (?)", [kib]);
	})();
	db.run("DELETE FROM ledig");
	db.close();
}

const MIB = 1024 * 1024;

beforeEach(() => {
	rot = mkdtempSync(join(tmpdir(), "pai-db-helse-"));
	sti = join(rot, "opencode.db");
});

afterEach(() => {
	rmSync(rot, { recursive: true, force: true });
});

describe("dbHelse (K10)", () => {
	test("over begge kravene: ett varsel med størrelsen og kommandoen", () => {
		lagDb(2048, 256);
		const h = dbHelse(sti, 1 * MIB, 0.3);
		expect(h.varsler).toHaveLength(1);
		expect(h.varsler[0]).toContain("is free pages (auto_vacuum is off)");
		expect(h.varsler[0]).toContain(vacuumKommando(sti));
		expect(h.ledig ?? 0).toBeGreaterThan(1 * MIB);
	});

	test("mye ledig, men under byte-kravet: taus (en liten base er ikke et funn)", () => {
		lagDb(2048, 256);
		expect(dbHelse(sti, 64 * MIB, 0.3).varsler).toEqual([]);
	});

	test("over byte-kravet, men under andelen: taus", () => {
		lagDb(1024, 4096);
		expect(dbHelse(sti, 512 * 1024, 0.3).varsler).toEqual([]);
	});

	test("ingen base: taus, og størrelsen er ukjent", () => {
		expect(dbHelse(sti)).toEqual({ varsler: [], ledig: null, totalt: null });
	});

	test("en fil som ikke er en SQLite-base: taus", () => {
		writeFileSync(sti, "ikke en database");
		expect(dbHelse(sti, 0, 0).varsler).toEqual([]);
	});

	test("kommandoen virker: basen krymper", () => {
		lagDb(2048, 16);
		const før = readFileSync(sti).length;
		const r = Bun.spawnSync(["bash", "-c", vacuumKommando(sti)], { stdout: "pipe", stderr: "pipe" });
		expect(r.exitCode).toBe(0);
		expect(readFileSync(sti).length).toBeLessThan(før / 4);
	});

	test("standardstien følger XDG_DATA_HOME, så HOME", () => {
		expect(standardDbSti({ XDG_DATA_HOME: "/x" })).toBe("/x/opencode/opencode.db");
		expect(standardDbSti({ HOME: "/h" })).toBe("/h/.local/share/opencode/opencode.db");
	});
});
