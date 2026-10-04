/**
 * Kontrakt-test: de åtte oppføringene som sto åpne i registeret
 *
 * H-10, M-02, M-03, M-05, M-07, M-09, M-13 og M-18 lå der fra før
 * dual-harness-prosjektet, i filer som ble flyttet uendret. Felles for dem er
 * at ingen av dem feilet høylytt: en feil modell, en avkuttet læring, en falsk
 * karakter, en trunkert META, en tapt oppføring, en skriving utenfor MEMORY og
 * to statuser som ikke stemte. Registeret i `runbooks/hooksystemet.md` har
 * detaljene.
 *
 * Alt isoleres via PAI_HOME. `teardown`-kjeden kjøres ikke herfra (se
 * `dispatch-events.test.ts`); M-13 testes på kontrakten den leser.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempHome: string;
const lagret: Record<string, string | undefined> = {};

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "pai-registeret-"));
	for (const k of ["PAI_HOME", "PAI_HARNESS"]) lagret[k] = process.env[k];
	process.env.PAI_HOME = tempHome;
});

afterEach(() => {
	for (const [k, v] of Object.entries(lagret)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(tempHome, { recursive: true, force: true });
});

describe("H-10 — en leverandør uten preset gir den konfigurerte modellen, ikke zen", () => {
	const opprinneligCwd = process.cwd();
	let prosjekt: string;

	beforeEach(() => {
		// `readOpencodeConfig` leter i cwd og forelderen, så testen lager
		// prosjektet ett nivå ned i temp-hjemmet.
		prosjekt = join(tempHome, "prosjekt");
		mkdirSync(prosjekt);
		process.chdir(prosjekt);
	});

	afterEach(() => process.chdir(opprinneligCwd));

	function konfig(innhold: object): void {
		writeFileSync(join(prosjekt, "opencode.json"), JSON.stringify(innhold));
	}

	test("fireworks-ai/ rapporteres ikke som zen", async () => {
		const { getModelConfig } = await import("../.opencode/pai-core/lib/model-config");
		const modell = "fireworks-ai/accounts/fireworks/routers/deepseek-flash-latest";
		konfig({ model: modell, agent: { Engineer: { model: "fireworks-ai/annen" } } });

		const c = getModelConfig();
		expect(c.model_provider).toBe("custom");
		expect(c.models.default).toBe(modell);
		// Validering gikk til `opencode/ling-…`, en modell ingen hadde valgt.
		expect(c.models.validation).toBe(modell);
		expect(c.models.agents.intern).toBe(modell);
		// `agent`-blokken vinner fortsatt over fallbacken.
		expect(c.models.agents.engineer).toBe("fireworks-ai/annen");
	});

	test("xai/ likeså", async () => {
		const { getModel } = await import("../.opencode/pai-core/lib/model-config");
		konfig({ model: "xai/grok-5" });
		expect(getModel("validation")).toBe("xai/grok-5");
	});

	test("kjente prefikser bruker fortsatt sitt preset", async () => {
		const { getModelConfig } = await import("../.opencode/pai-core/lib/model-config");
		konfig({ model: "anthropic/claude-sonnet-5" });
		expect(getModelConfig().model_provider).toBe("anthropic");
	});

	test("uten konfig er zen fortsatt standarden", async () => {
		const { getModelConfig } = await import("../.opencode/pai-core/lib/model-config");
		expect(getModelConfig().model_provider).toBe("zen");
	});
});

describe("M-02 — ## Learning-formen går til slutten av teksten, ikke til første z", () => {
	test("en læring med z i seg kuttes ikke", async () => {
		const { extractLearningsFromText } = await import(
			"../.opencode/pai-core/handlers/learning-capture"
		);
		const tekst = "## Learning\n\nTimezone-feilen skyldtes at vi aldri leste den konfigurerte sonen.";
		const [læring] = extractLearningsFromText(tekst, "THREAD.md");
		expect(læring?.content).toBe("Timezone-feilen skyldtes at vi aldri leste den konfigurerte sonen.");
	});

	test("neste overskrift avslutter fortsatt", async () => {
		const { extractLearningsFromText } = await import(
			"../.opencode/pai-core/handlers/learning-capture"
		);
		const tekst = "## Takeaway\n\nMål mekanismen, ikke bare symptomet.\n## Neste\n\nannet";
		const [læring] = extractLearningsFromText(tekst, "THREAD.md");
		expect(læring?.content).toBe("Mål mekanismen, ikke bare symptomet.");
	});
});

describe("M-03 — et antall er ikke en karakter", () => {
	test.each([
		"3 tester feiler",
		"2 filer mangler i speilet",
		"5 minutter til",
	])("«%s» gir ingen karakter", async (melding) => {
		const { detectRating } = await import("../.opencode/pai-core/handlers/rating-capture");
		expect(detectRating(melding)).toBeNull();
	});

	test.each([
		["8", 8],
		["9/10", 9],
		["7 - trenger mer arbeid", 7],
		["6: ok", 6],
		["10!", 10],
	])("«%s» er fortsatt %d", async (melding, karakter) => {
		const { detectRating } = await import("../.opencode/pai-core/handlers/rating-capture");
		expect(detectRating(melding)?.score).toBe(karakter);
	});
});

describe("M-05 — en lesefeil på META.yaml trunkerer den ikke", () => {
	test("EACCES gir feil og urørt META, og tilstanden står igjen", async () => {
		const { completeWorkSession, createWorkSession } = await import(
			"../.opencode/pai-core/handlers/work-tracker"
		);
		const { getCurrentWorkPath } = await import("../.opencode/pai-core/lib/paths");
		const res = await createWorkSession("en melding som er lang nok til en økt", "ses_m05");
		const meta = join(res.session?.path as string, "META.yaml");
		const før = readFileSync(meta, "utf-8");

		// Skrivbar, men ikke lesbar: da lykkes skrivingen som trunkerte. Med
		// 0o000 feiler den også, og testen ville passert på den gamle koden.
		chmodSync(meta, 0o200);
		try {
			const utfall = await completeWorkSession("ses_m05");
			expect(utfall.success).toBe(false);
		} finally {
			chmodSync(meta, 0o644);
		}
		expect(readFileSync(meta, "utf-8")).toBe(før);
		// Reaperen skal kunne prøve igjen.
		expect(await getCurrentWorkPath("ses_m05")).toBe(res.session?.path as string);
	});

	test("manglende META er fortsatt ikke en feil", async () => {
		const { completeWorkSession, createWorkSession } = await import(
			"../.opencode/pai-core/handlers/work-tracker"
		);
		const res = await createWorkSession("en melding som er lang nok til en økt", "ses_m05b");
		rmSync(join(res.session?.path as string, "META.yaml"));
		const utfall = await completeWorkSession("ses_m05b");
		expect(utfall.success).toBe(true);
		expect(utfall.completed_at).toBeDefined();
	});
});

describe("M-07 — registeret skrives under lås", () => {
	test("mens en annen prosess holder låsen, skrives ingenting", async () => {
		const { getRegistryPath, readRegistry, registerSubagentStart } = await import(
			"../.opencode/pai-core/handlers/session-registry"
		);
		const lås = `${getRegistryPath("ses_m07")}.lock`;
		mkdirSync(join(tempHome, "MEMORY", "STATE"), { recursive: true });
		writeFileSync(lås, "");

		await registerSubagentStart("ses_m07", "agent-1", "Engineer");
		expect(readRegistry("ses_m07").entries).toHaveLength(0);
		expect(existsSync(lås)).toBe(true);

		rmSync(lås);
		await registerSubagentStart("ses_m07", "agent-1", "Engineer");
		expect(readRegistry("ses_m07").entries).toHaveLength(1);
		// Låsen slippes etter skrivingen.
		expect(existsSync(lås)).toBe(false);
	});

	test("en etterlatt lås blokkerer ikke for alltid", async () => {
		const { getRegistryPath, readRegistry, registerSubagentStart, REGISTRY_LOCK_STALE_MS } =
			await import("../.opencode/pai-core/handlers/session-registry");
		const lås = `${getRegistryPath("ses_m07b")}.lock`;
		mkdirSync(join(tempHome, "MEMORY", "STATE"), { recursive: true });
		writeFileSync(lås, "");
		const gammel = (Date.now() - REGISTRY_LOCK_STALE_MS - 5_000) / 1000;
		utimesSync(lås, gammel, gammel);

		await registerSubagentStart("ses_m07b", "agent-1", "Engineer");
		expect(readRegistry("ses_m07b").entries).toHaveLength(1);
	});
});

describe("M-09 — work_dir fra tilstandsfila må ligge under WORK", () => {
	function tilstand(sessionId: string, workDir: string): void {
		const stateDir = join(tempHome, "MEMORY", "STATE");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(
			join(stateDir, `current-work-${sessionId}.json`),
			JSON.stringify({ session_id: sessionId, work_dir: workDir, session_dir: workDir })
		);
	}

	test.each([
		["../../utenfor", "relativ ut av treet"],
		["/etc", "absolutt et annet sted"],
		["2026-09/../../STATE", "via .. inn i søsterkatalogen"],
	])("%s (%s) avvises", async (workDir) => {
		const { getCurrentWorkPath } = await import("../.opencode/pai-core/lib/paths");
		tilstand("ses_m09", workDir);
		expect(await getCurrentWorkPath("ses_m09")).toBeNull();
	});

	test("en økt under WORK godtas, relativ og absolutt", async () => {
		const { getCurrentWorkPath, getWorkDir } = await import("../.opencode/pai-core/lib/paths");
		tilstand("ses_m09r", "2026-09/økt");
		expect(await getCurrentWorkPath("ses_m09r")).toBe(join(getWorkDir(), "2026-09/økt"));
		tilstand("ses_m09a", join(getWorkDir(), "2026-09/økt"));
		expect(await getCurrentWorkPath("ses_m09a")).toBe(join(getWorkDir(), "2026-09/økt"));
	});

	test("samme sti gjennom en symlenke til treet godtas", async () => {
		// `~/.opencode` er en symlenke til repoet: en tilstand skrevet med den
		// ene formen og lest med den andre er ikke et utbrudd.
		const { getCurrentWorkPath, getWorkDir } = await import("../.opencode/pai-core/lib/paths");
		mkdirSync(join(getWorkDir(), "2026-09", "økt"), { recursive: true });
		const lenke = join(tempHome, "lenke");
		symlinkSync(tempHome, lenke);
		tilstand("ses_m09s", join(lenke, "MEMORY", "WORK", "2026-09", "økt"));
		expect(await getCurrentWorkPath("ses_m09s")).not.toBeNull();
	});

	test("økta skrives ikke utenfor: fullføringen ser ingen økt", async () => {
		const { completeWorkSession } = await import("../.opencode/pai-core/handlers/work-tracker");
		const utenfor = join(tempHome, "utenfor");
		mkdirSync(utenfor);
		writeFileSync(join(utenfor, "META.yaml"), "status: ACTIVE\n");
		tilstand("ses_m09w", utenfor);

		await completeWorkSession("ses_m09w");
		expect(readFileSync(join(utenfor, "META.yaml"), "utf-8")).toBe("status: ACTIVE\n");
	});
});

describe("M-13 — «fullført» betyr at noe ble fullført", () => {
	test("uten økt: success, men ingen completed_at", async () => {
		const { completeWorkSession } = await import("../.opencode/pai-core/handlers/work-tracker");
		const utfall = await completeWorkSession("ses_finnes_ikke");
		expect(utfall.success).toBe(true);
		expect(utfall.completed_at).toBeUndefined();
	});

	test("med økt: completed_at, og andre gang ingen", async () => {
		const { completeWorkSession, createWorkSession } = await import(
			"../.opencode/pai-core/handlers/work-tracker"
		);
		await createWorkSession("en melding som er lang nok til en økt", "ses_m13");
		expect((await completeWorkSession("ses_m13")).completed_at).toBeDefined();
		expect((await completeWorkSession("ses_m13")).completed_at).toBeUndefined();
	});

	test("teardown gater merknaden på completed_at, ikke på success", () => {
		// Teardown-kjeden kjøres ikke herfra (se modulkommentaren), så
		// koblingen pinnes i kilden.
		const kilde = readFileSync(join(import.meta.dir, "../.opencode/pai-core/dispatch/session.ts"), "utf-8");
		const blokk = kilde.slice(kilde.indexOf("completeWorkSession(sessionId);"), kilde.indexOf('"work-completed"'));
		expect(blokk).toContain("completeResult.completed_at");
		expect(blokk).not.toContain("completeResult.success");
	});
});

describe("M-18 — THREAD.md følger META til COMPLETED", () => {
	test("headeren byttes på øktnivå og i oppgaven, bare første forekomst", async () => {
		const { appendToThread, completeWorkSession, createWorkSession } = await import(
			"../.opencode/pai-core/handlers/work-tracker"
		);
		const res = await createWorkSession("en melding som er lang nok til en økt", "ses_m18");
		const sti = res.session?.path as string;
		await appendToThread("**User:** skriv `**Status:** ACTIVE` i README", "ses_m18");

		await completeWorkSession("ses_m18");

		const tråd = readFileSync(join(sti, "THREAD.md"), "utf-8");
		expect(tråd).toContain("**Status:** COMPLETED");
		// Innholdet lenger ned er brukerens, ikke headeren.
		expect(tråd).toContain("skriv `**Status:** ACTIVE` i README");
		expect(readFileSync(join(sti, "tasks", "main", "THREAD.md"), "utf-8")).toContain(
			"**Status:** COMPLETED"
		);
	});
});

describe("M-41 — tittelen beholder æøå", () => {
	test("«Kjør» blir ikke «Kj r»", async () => {
		const { inferTitle } = await import("../.opencode/pai-core/handlers/work-tracker");
		expect(inferTitle("Kjør kommandoen på første økt, takk!")).toBe("Kjør kommandoen på første økt takk");
	});

	test("katalognavnet er fortsatt ASCII", async () => {
		const { createWorkSession } = await import("../.opencode/pai-core/handlers/work-tracker");
		const res = await createWorkSession("Kjør kommandoen på første økt, takk", "ses_m41");
		expect(res.session?.title).toBe("Kjør kommandoen på første økt takk");
		expect(res.session?.id).toMatch(/_kj-r-kommandoen-p-f-rste-kt-takk$/);
	});
});
