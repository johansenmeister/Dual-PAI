/**
 * Kontrakt-test: påminnelsen om LEARN-refleksjonen (#315, jobb #4)
 *
 * LEARN-sjekken i `isc-validator` ser bare svar med LEARN-fasen, og i `warn`
 * når den bare loggen. En økt som startet i FULL og fortsatte i ITERATION,
 * sluttet uten refleksjon og uten at noen sa fra. Nå bærer arbeidsøktlinja
 * (M-47) en påminnelse så lenge økten har en PRD og ingen refleksjon er
 * skrevet etter at den startet.
 *
 * Den siste testen kjører kommandoen påminnelsen selv gir, og krever at
 * påminnelsen er borte etterpå. Peker linja på et annet tre enn sjekken
 * leser, står påminnelsen igjen for alltid.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLearningDir, getPaiHome, getStateDir, getWorkDir } from "../.opencode/pai-core/lib/paths";
import { arbeidsøktKontekst } from "../.opencode/pai-core/dispatch/arbeidsokt";

const STARTET = "2026-10-06T08:00:00.000Z";
const PÅMINNELSE = "no LEARN reflection yet";

let opprinneligEnabled: string | undefined;

beforeAll(() => {
	opprinneligEnabled = process.env.PAI_ENABLED;
	process.env.PAI_ENABLED = "1";
});

afterAll(() => {
	if (opprinneligEnabled === undefined) delete process.env.PAI_ENABLED;
	else process.env.PAI_ENABLED = opprinneligEnabled;
});

function refleksjonsfil(): string {
	return join(getLearningDir(), "REFLECTIONS", "algorithm-reflections.jsonl");
}

beforeEach(() => {
	rmSync(refleksjonsfil(), { force: true });
});

function skrivRefleksjoner(...rader: Record<string, unknown>[]): void {
	mkdirSync(join(getLearningDir(), "REFLECTIONS"), { recursive: true });
	writeFileSync(refleksjonsfil(), rader.map((r) => `${JSON.stringify(r)}\n`).join(""));
}

function lagØkt(sessionId: string, opts: { prd?: boolean; meta?: string } = {}): string {
	const rel = `2026-10/${sessionId}_refleksjon`;
	const dir = join(getWorkDir(), rel);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "META.yaml"),
		opts.meta ?? `status: ACTIVE\nstarted_at: ${STARTET}\ntitle: "test"\neffort_level: Standard\n`,
	);
	if (opts.prd ?? true) writeFileSync(join(dir, "PRD.md"), "---\nstatus: COMPLETED\n---\n");
	mkdirSync(getStateDir(), { recursive: true });
	writeFileSync(
		join(getStateDir(), `current-work-${sessionId}.json`),
		JSON.stringify({ session_id: sessionId, work_dir: rel, session_dir: rel }),
	);
	return dir;
}

describe("påminnelsen om refleksjonen", () => {
	test("PRD og ingen refleksjonsfil gir påminnelse", async () => {
		lagØkt("ses_r_ingen_fil");
		expect(await arbeidsøktKontekst("ses_r_ingen_fil")).toContain(PÅMINNELSE);
	});

	test("en refleksjon fra før økten startet teller ikke", async () => {
		lagØkt("ses_r_gammel");
		skrivRefleksjoner({ timestamp: "2026-10-05T12:00:00+02:00", reflection_q1: "gammel" });
		expect(await arbeidsøktKontekst("ses_r_gammel")).toContain(PÅMINNELSE);
	});

	test("tidssonen regnes med: 09:30+02:00 er før en start 08:00Z", async () => {
		// 07:30Z. Leser noe klokkeslettet uten forskyvningen, ser den senere ut.
		lagØkt("ses_r_tidssone");
		skrivRefleksjoner({ timestamp: "2026-10-06T09:30:00+02:00", reflection_q1: "før start" });
		expect(await arbeidsøktKontekst("ses_r_tidssone")).toContain(PÅMINNELSE);
	});

	test("en refleksjon etter start fjerner påminnelsen", async () => {
		lagØkt("ses_r_skrevet");
		skrivRefleksjoner({ timestamp: "2026-10-06T10:30:00+02:00", reflection_q1: "ny" });
		const linje = await arbeidsøktKontekst("ses_r_skrevet");
		expect(linje).toContain("PAI work session directory");
		expect(linje).not.toContain(PÅMINNELSE);
	});

	test("den eldre formen med `ts` teller også", async () => {
		lagØkt("ses_r_ts");
		skrivRefleksjoner({ ts: "2026-10-06T09:00:00Z", q1_self: "kortform" });
		expect(await arbeidsøktKontekst("ses_r_ts")).not.toContain(PÅMINNELSE);
	});

	test("uten PRD ingen påminnelse", async () => {
		lagØkt("ses_r_uten_prd", { prd: false });
		const linje = await arbeidsøktKontekst("ses_r_uten_prd");
		expect(linje).toContain("PAI work session directory");
		expect(linje).not.toContain(PÅMINNELSE);
	});

	test("under Standard ingen påminnelse: LEARN kjører ikke der", async () => {
		lagØkt("ses_r_fast", {
			meta: `status: ACTIVE\nstarted_at: ${STARTET}\ntitle: "test"\neffort_level: Fast\n`,
		});
		expect(await arbeidsøktKontekst("ses_r_fast")).not.toContain(PÅMINNELSE);
	});

	test("uten started_at ingen påminnelse: ingenting å måle mot", async () => {
		lagØkt("ses_r_uten_start", { meta: `status: ACTIVE\ntitle: "test"\n` });
		expect(await arbeidsøktKontekst("ses_r_uten_start")).not.toContain(PÅMINNELSE);
	});

	test("kommandoen i påminnelsen skriver der sjekken leser", async () => {
		lagØkt("ses_r_rundtur");
		// Det midlertidige treet har ikke verktøyene, et ekte tre har dem.
		// En lenke, så verktøyet er det samme som i repoet.
		const verktøykatalog = join(getPaiHome(), "PAI", "Tools");
		mkdirSync(join(getPaiHome(), "PAI"), { recursive: true });
		symlinkSync(join(import.meta.dir, "../.opencode/PAI/Tools"), verktøykatalog);
		const linje = (await arbeidsøktKontekst("ses_r_rundtur")) ?? "";
		const treff = linje.match(/PAI_DIR=(\S+) bun (\S+WriteReflection\.ts)/);
		expect(treff).not.toBeNull();
		const [, paiDir, verktøy] = treff as RegExpMatchArray;

		const kjøring = Bun.spawnSync(
			[
				"bun",
				verktøy,
				"--task",
				"rundtur",
				"--effort",
				"Standard",
				"--sentiment",
				"7",
				"--q1",
				"a",
				"--q2",
				"b",
				"--q3",
				"c",
			],
			{ env: { ...process.env, PAI_DIR: paiDir }, stdout: "pipe", stderr: "pipe" },
		);
		unlinkSync(verktøykatalog);
		expect(kjøring.stderr.toString()).toBe("");
		expect(kjøring.exitCode).toBe(0);
		expect(await arbeidsøktKontekst("ses_r_rundtur")).not.toContain(PÅMINNELSE);
	});
});
