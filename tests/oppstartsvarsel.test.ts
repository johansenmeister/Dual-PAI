/**
 * Oppstartsvarslene (#14 steg 2): tall fra et lokalt speil ved øktstart
 *
 * Regel 1 for en selvtest: bevist i begge retninger. Varselet kommer når en
 * fil treffer, og er taust ved 0, ved manglende konfig og ved alt som er
 * ugyldig i den.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUserSystemContext } from "../.opencode/pai-core/dispatch/context";
import { OPPSTARTSVARSEL_FIL, oppstartsvarsler, tell } from "../.opencode/pai-core/lib/oppstartsvarsel";

let rot: string;
let pai: string;
let speil: string;
let forrigeHjem: string | undefined;

const konfig = (innhold: string) => {
	mkdirSync(join(pai, "PAI", "USER"), { recursive: true });
	writeFileSync(join(pai, OPPSTARTSVARSEL_FIL), innhold);
};

const sak = (sti: string, status: string) => {
	mkdirSync(join(speil, sti, ".."), { recursive: true });
	writeFileSync(join(speil, sti), `---\nglpi_id: 1\nstatus: ${status}\n---\n\n# Tittel\n`);
};

const gyldig = (katalog = speil) =>
	JSON.stringify({ varsler: [{ katalog, linje: "^status: løst$", tekst: "Løste saker: {n}" }] });

beforeAll(() => {
	forrigeHjem = process.env.PAI_HOME;
	rot = mkdtempSync(join(tmpdir(), "pai-oppstartsvarsel-"));
});

afterAll(() => {
	process.env.PAI_HOME = forrigeHjem;
	rmSync(rot, { recursive: true, force: true });
});

beforeEach(() => {
	pai = mkdtempSync(join(rot, "pai-"));
	speil = mkdtempSync(join(rot, "speil-"));
});

describe("varselet kommer", () => {
	test("én linje med tallet når filer treffer, rekursivt", () => {
		sak("problems/1.md", "løst");
		sak("problems/2.md", "ny");
		sak("tickets/3.md", "løst");
		konfig(gyldig());
		expect(oppstartsvarsler(pai)).toEqual(["Løste saker: 2"]);
	});

	test("en hel linje kreves: «status: løst» inne i brødteksten teller ikke", () => {
		mkdirSync(join(speil, "problems"), { recursive: true });
		writeFileSync(join(speil, "problems/9.md"), "---\nstatus: ny\n---\nForrige status: løst i går\n");
		expect(tell(speil, /^status: løst$/m)).toBe(0);
	});

	test("i konteksten til modellen, under PAI_HOME", async () => {
		sak("problems/1.md", "løst");
		konfig(gyldig());
		process.env.PAI_HOME = pai;
		const res = await loadUserSystemContext();
		expect(res?.context).toContain("--- Startup notices ---");
		expect(res?.context).toContain("- Løste saker: 1");
	});
});

describe("varselet er taust", () => {
	test("ved 0 treff", async () => {
		sak("problems/1.md", "lukket");
		konfig(gyldig());
		expect(oppstartsvarsler(pai)).toEqual([]);
		process.env.PAI_HOME = pai;
		expect((await loadUserSystemContext())?.context).not.toContain("Startup notices");
	});

	test("uten konfig (hjemme finnes fila ikke)", () => {
		sak("problems/1.md", "løst");
		expect(oppstartsvarsler(pai)).toEqual([]);
	});

	test("når katalogen ikke finnes på maskinen", () => {
		konfig(gyldig(join(rot, "finnes-ikke")));
		expect(oppstartsvarsler(pai)).toEqual([]);
	});

	test("filer under .git og andre enn .md teller ikke", () => {
		sak(".git/x.md", "løst");
		mkdirSync(join(speil, "problems"), { recursive: true });
		writeFileSync(join(speil, "problems/1.txt"), "status: løst\n");
		konfig(gyldig());
		expect(oppstartsvarsler(pai)).toEqual([]);
	});

	test("ugyldig konfig kaster aldri", () => {
		sak("problems/1.md", "løst");
		for (const innhold of [
			"{ ikke json",
			"null",
			'"en streng"',
			'{"varsler": "ikke en liste"}',
			'{"varsler": [42, null, {"katalog": 1}]}',
			JSON.stringify({ varsler: [{ katalog: "repos/relativ", linje: "x", tekst: "{n}" }] }),
			JSON.stringify({ varsler: [{ katalog: speil, linje: "(", tekst: "{n}" }] }),
		]) {
			konfig(innhold);
			expect(oppstartsvarsler(pai), innhold).toEqual([]);
		}
	});

	test("en ugyldig regex stopper bare sitt eget varsel", () => {
		sak("problems/1.md", "løst");
		konfig(
			JSON.stringify({
				varsler: [
					{ katalog: speil, linje: "(", tekst: "ødelagt {n}" },
					{ katalog: speil, linje: "^status: løst$", tekst: "Løste saker: {n}" },
				],
			})
		);
		expect(oppstartsvarsler(pai)).toEqual(["Løste saker: 1"]);
	});
});
