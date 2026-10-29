/**
 * check-firewall.sh against canned API answers (#414): the report says when the
 * firewall runs another series or edition than the endpoints are verified on.
 *
 * FirewallStatus is shared with the work tree and the copies (#466), so the test
 * goes with it; the Claude mirror links it in under claude-plugin/, which is how
 * bun test finds it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "check-firewall.sh");
const API_DOC = join(import.meta.dir, "..", "OpnSenseApi.md");
const dirs: string[] = [];

/** A healthy firewall; `product` replaces firmware/status' product block, `extra` adds to the environment. */
function run(product: Record<string, string>, extra: Record<string, string> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "fw-fixtures-"));
	dirs.push(dir);
	const answers: Record<string, unknown> = {
		core_system_status: { metadata: { system: { status: 2, message: "OK" } } },
		core_firmware_status: { product: { product_latest: "", ...product } },
		diagnostics_firewall_log: [
			{ action: "block", interface: "igc1", dir: "in", src: "198.51.100.7", dst: "203.0.113.1", dstport: "22", label: "x", __timestamp__: "2026-10-11T00:00:00" },
		],
		firewall_filter_searchRule: { rows: [] },
		crowdsec_service_status: { status: "running" },
		crowdsec_general_get: { general: { agent_enabled: "1", lapi_enabled: "1", firewall_bouncer_enabled: "1" } },
		crowdsec_alerts_search: { rows: [] },
		crowdsec_decisions_search: { rows: [] },
		crowdsec_bouncers_search: { rows: [{ name: "cs-firewall-bouncer" }] },
		ids_service_status: { status: "running" },
		ids_settings_get: { ids: { general: { enabled: "1", interfaces: { wan: { value: "WAN", selected: 1 } } } } },
		ids_service_queryAlerts: { rows: [{ timestamp: "2026-10-11T00:00:00", alert: "ET INFO x" }] },
	};
	for (const [name, body] of Object.entries(answers)) writeFileSync(join(dir, `${name}.json`), JSON.stringify(body));
	const env = join(dir, "env");
	writeFileSync(env, "OPNSENSE_API_URL=https://firewall.invalid\nOPNSENSE_API_KEY=k\nOPNSENSE_API_SECRET=s\n");
	const p = Bun.spawnSync(["bash", SCRIPT], {
		env: { ...process.env, OPNSENSE_ENV_FILE: env, OPNSENSE_FIXTURES: dir, ...extra },
	});
	expect(p.exitCode).toBe(0);
	return JSON.parse(p.stdout.toString());
}

/** VERIFIED as the script sets it: series/edition pairs, and the first one split. */
function verified(): { list: string[]; series: string; edition: string } {
	const raw = readFileSync(SCRIPT, "utf8").match(/^VERIFIED="([^"]+)"/m)?.[1] ?? "";
	const list = raw.split(" ").filter(Boolean);
	const [series = "", edition = ""] = (list[0] ?? "").split("/");
	return { list, series, edition };
}

/**
 * Same canned firewall as `run`, but lets delta tests (#223) control the CSV path,
 * the firmware version, and the row counts that feed rules_total/cs_alerts_total.
 */
function runDelta(
	opts: {
		csv?: string;
		version?: string;
		rulesRows?: unknown[];
		alertsRows?: unknown[];
		history?: boolean;
		envExtra?: string;
		home?: string;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "fw-fixtures-"));
	dirs.push(dir);
	const answers: Record<string, unknown> = {
		core_system_status: { metadata: { system: { status: 2, message: "OK" } } },
		core_firmware_status: {
			product: {
				product_id: "opnsense",
				product_series: "26.7",
				product_latest: "",
				product_version: opts.version ?? "26.7.5",
			},
		},
		diagnostics_firewall_log: [
			{ action: "block", interface: "igc1", dir: "in", src: "198.51.100.7", dst: "203.0.113.1", dstport: "22", label: "x", __timestamp__: "2026-10-11T00:00:00" },
		],
		firewall_filter_searchRule: { rows: opts.rulesRows ?? [] },
		crowdsec_service_status: { status: "running" },
		crowdsec_general_get: { general: { agent_enabled: "1", lapi_enabled: "1", firewall_bouncer_enabled: "1" } },
		crowdsec_alerts_search: { rows: opts.alertsRows ?? [] },
		crowdsec_decisions_search: { rows: [] },
		crowdsec_bouncers_search: { rows: [{ name: "cs-firewall-bouncer" }] },
		ids_service_status: { status: "running" },
		ids_settings_get: { ids: { general: { enabled: "1", interfaces: { wan: { value: "WAN", selected: 1 } } } } },
		ids_service_queryAlerts: { rows: [] },
	};
	for (const [name, body] of Object.entries(answers)) writeFileSync(join(dir, `${name}.json`), JSON.stringify(body));
	const env = join(dir, "env");
	writeFileSync(env, `OPNSENSE_API_URL=https://fw.invalid\nOPNSENSE_API_KEY=k\nOPNSENSE_API_SECRET=s\n${opts.envExtra ?? ""}`);
	const args = [...(opts.csv ? ["--csv", opts.csv] : []), ...(opts.history ? ["--history"] : [])];
	const p = Bun.spawnSync(["bash", SCRIPT, ...args], {
		env: { ...process.env, OPNSENSE_ENV_FILE: env, OPNSENSE_FIXTURES: dir, ...(opts.home ? { HOME: opts.home } : {}) },
	});
	expect(p.exitCode).toBe(0);
	return JSON.parse(p.stdout.toString());
}

const CSV_HEADER =
	"checked_utc,overall,version,update_available,blocks,passes,rejects,wan_blocks_in,cs_assessment,cs_alerts_total,cs_active_bans,rules_total";

afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("check-firewall.sh: the version guard (#414)", () => {
	const { list, series } = verified();

	test("the script verifies at least one series/edition pair", () => {
		expect(list.length).toBeGreaterThan(0);
		for (const pair of list) expect(pair).toMatch(/^\d+\.\d+\/(CE|BE)$/);
	});

	test("the same series and edition: verified, overall OK", () => {
		const r = run({ product_id: "opnsense", product_series: series, product_version: `${series}.6_3` });
		expect(r.system.verified).toEqual({ list, matches: true, note: "" });
		expect(r.overall).toBe("OK");
	});

	test("every pair in the list is verified, not only the first", () => {
		const ids: Record<string, string> = { CE: "opnsense", BE: "opnsense-business" };
		for (const pair of list) {
			const [s = "", e = ""] = pair.split("/");
			const r = run({ product_id: ids[e], product_series: s, product_version: `${s}.2` });
			expect(r.system.verified.matches).toBe(true);
			expect(r.overall).toBe("OK");
		}
	});

	test("another series: not verified, ADVARSEL, and the note names both", () => {
		const r = run({ product_id: "opnsense", product_series: "27.1", product_version: "27.1" });
		expect(r.system.verified.matches).toBe(false);
		expect(r.overall).toBe("ADVARSEL");
		expect(r.system.verified.note).toContain(`verifisert på ${list.join(", ")}`);
		expect(r.system.verified.note).toContain("kjører 27.1/CE");
	});

	test("the next minor in the same major: not verified either", () => {
		const [major, minor] = series.split(".").map(Number);
		const next = `${major}.${minor + 1}`;
		const r = run({ product_id: "opnsense", product_series: next, product_version: next });
		expect(r.system.verified.matches).toBe(false);
		expect(r.overall).toBe("ADVARSEL");
	});

	test("the business edition in the same series: not verified", () => {
		const r = run({ product_id: "opnsense-business", product_series: series, product_version: `${series}.1` });
		expect(r.system.edition).toBe("BE");
		expect(r.system.verified.matches).toBe(false);
		expect(r.overall).toBe("ADVARSEL");
	});

	test("without product_series, the series is major.minor of the version", () => {
		expect(run({ product_id: "opnsense", product_version: `${series}.9_2` }).system.series).toBe(series);
		// 26.10 is not 26.1: the minor part is the whole number.
		expect(run({ product_id: "opnsense", product_version: "26.10.1" }).system.series).toBe("26.10");
	});

	test("without product_id the edition is unknown, and not verified", () => {
		const r = run({ product_series: series, product_version: series });
		expect(r.system.edition).toBe("ukjent");
		expect(r.system.verified.matches).toBe(false);
	});

	test("OpnSenseApi.md names the pairs the script compares with", () => {
		expect(readFileSync(API_DOC, "utf8")).toContain(`\`VERIFIED="${list.join(" ")}"\``);
	});
});

describe("check-firewall.sh: delta against the previous CSV row (#223)", () => {
	const csvDir = mkdtempSync(join(tmpdir(), "fw-csv-"));
	dirs.push(csvDir);

	test("without --csv there is no delta", () => {
		const r = runDelta();
		expect(r.delta).toBeNull();
	});

	test("a CSV file with only a header gives no delta", () => {
		const csv = join(csvDir, "header-only.csv");
		writeFileSync(csv, `${CSV_HEADER}\n`);
		const r = runDelta({ csv });
		expect(r.delta).toBeNull();
	});

	test("a changed version and rules_total show up in delta.changed", () => {
		const csv = join(csvDir, "version-change.csv");
		writeFileSync(csv, `${CSV_HEADER}\n"2026-09-26T18:17:29Z","OK","26.7.4_1",false,10,34,0,10,"AKTIV",314,3,36\n`);
		const r = runDelta({ csv, version: "26.7.5", rulesRows: Array(37).fill({}) });
		expect(r.delta.previous_checked_utc).toBe("2026-09-26T18:17:29Z");
		expect(r.delta.version).toEqual({ previous: "26.7.4_1", current: "26.7.5", changed: true });
		expect(r.delta.rules_total).toEqual({ previous: 36, current: 37, changed: true, diff: 1 });
		expect(r.delta.changed).toEqual(expect.arrayContaining(["version", "rules_total"]));
	});

	test("an unchanged field is not listed in delta.changed", () => {
		const csv = join(csvDir, "no-change.csv");
		writeFileSync(csv, `${CSV_HEADER}\n"2026-09-26T18:17:29Z","OK","26.7.5",false,10,34,0,10,"AKTIV",10,3,1\n`);
		const r = runDelta({ csv, version: "26.7.5", rulesRows: [{}] });
		expect(r.delta.version).toEqual({ previous: "26.7.5", current: "26.7.5", changed: false });
		expect(r.delta.rules_total).toEqual({ previous: 1, current: 1, changed: false, diff: 0 });
		expect(r.delta.changed).not.toContain("version");
		expect(r.delta.changed).not.toContain("rules_total");
	});

	test("an unreadable previous row gives no delta, and the report and the new row still come out", () => {
		const csv = join(csvDir, "truncated.csv");
		writeFileSync(csv, `${CSV_HEADER}\n"2026-09-26T18:17:29Z","OK"\n`);
		const r = runDelta({ csv, version: "26.7.5", rulesRows: [{}] });
		expect(r.delta).toBeNull();
		expect(r.system.version).toBe("26.7.5");
		expect(readFileSync(csv, "utf8").trim().split("\n")).toHaveLength(3);
	});

	test("a drop in cs_alerts_total is in delta but never in delta.changed", () => {
		const csv = join(csvDir, "alerts-drop.csv");
		writeFileSync(csv, `${CSV_HEADER}\n"2026-09-26T18:17:29Z","OK","26.7.4_1",false,10,34,0,10,"AKTIV",314,3,36\n`);
		const r = runDelta({ csv, version: "26.7.4_1", alertsRows: Array(182).fill({}) });
		expect(r.delta.cs_alerts_total).toEqual({ previous: 314, current: 182, changed: true, diff: -132 });
		expect(r.delta.changed).not.toContain("cs_alerts_total");
	});

	test("the appended row keeps the existing CSV format", () => {
		const csv = join(csvDir, "format.csv");
		const r = runDelta({ csv, version: "26.7.5", rulesRows: [{}] });
		const lines = readFileSync(csv, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe(CSV_HEADER);
		// checked_utc, overall, version and cs_assessment are quoted strings (per @csv);
		// update_available, the counts and rules_total stay bare numbers/booleans.
		expect(lines[1]).toMatch(
			/^"[^"]+","[A-ZÆØÅ ]+","26\.7\.5",(true|false),\d+,\d+,\d+,\d+,"[A-ZÆØÅ ]+",\d+,\d+,\d+$/,
		);
		expect(r.rules.total).toBe(1);
	});
});

describe("check-firewall.sh --history: the file comes from .env (#466)", () => {
	test("FIREWALL_HISTORY_CSV in .env is the history file, and history_file names it", () => {
		const dir = mkdtempSync(join(tmpdir(), "fw-history-"));
		dirs.push(dir);
		const csv = join(dir, "sub", "history.csv");
		const r = runDelta({ history: true, envExtra: `FIREWALL_HISTORY_CSV=${csv}\n` });
		expect(r.history_file).toBe(csv);
		expect(readFileSync(csv, "utf8").split("\n")[0]).toBe(CSV_HEADER);
	});

	test("without FIREWALL_HISTORY_CSV it is MEMORY/STATE under ~/.opencode", () => {
		const home = mkdtempSync(join(tmpdir(), "fw-home-"));
		dirs.push(home);
		const r = runDelta({ history: true, home });
		// One string, as in the script: the default path is part of its contract.
		const expected = join(home, ".opencode/MEMORY/STATE/firewall-history.csv");
		expect(r.history_file).toBe(expected);
		expect(existsSync(expected)).toBe(true);
	});

	test("--csv wins over --history, and without either there is no history_file", () => {
		const dir = mkdtempSync(join(tmpdir(), "fw-history-"));
		dirs.push(dir);
		const csv = join(dir, "explicit.csv");
		expect(runDelta({ csv, history: true, envExtra: `FIREWALL_HISTORY_CSV=${join(dir, "other.csv")}\n` }).history_file).toBe(csv);
		expect(runDelta().history_file).toBeNull();
	});
});

/**
 * #493: the ACME status comes from the certificate the firewall serves, not from
 * api/acmeclient/*, whose answers can hold the DNS token and the account key. The
 * test makes a real certificate and moves the clock with OPNSENSE_NOW.
 */
describe.skipIf(!Bun.which("openssl"))("check-firewall.sh: the certificate (#493)", () => {
	const DAG = 86_400;
	const verifiedNow = () => {
		const { series, edition } = verified();
		return { product_id: edition === "BE" ? "opnsense-business" : "opnsense", product_series: series, product_version: `${series}.1` };
	};

	/** A self-signed certificate valid for `days`, and its notBefore as epoch seconds. */
	function cert(days: number): { file: string; start: number } {
		const dir = mkdtempSync(join(tmpdir(), "fw-cert-"));
		dirs.push(dir);
		const file = join(dir, "cert.pem");
		const r = Bun.spawnSync([
			"openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
			"-subj", "/CN=firewall.invalid", "-days", String(days), "-keyout", join(dir, "key.pem"), "-out", file,
		]);
		expect(r.exitCode).toBe(0);
		const start = Bun.spawnSync(["openssl", "x509", "-noout", "-startdate", "-in", file]).stdout.toString();
		return { file, start: Math.floor(Date.parse(start.replace(/^notBefore=/, "").trim()) / 1000) };
	}

	const at = (c: { file: string; start: number }, ageDays: number, extra: Record<string, string> = {}) =>
		run(verifiedNow(), { OPNSENSE_CERT_FILE: c.file, OPNSENSE_NOW: String(c.start + ageDays * DAG), ...extra });

	test("a 90-day certificate 30 days old: OK, and the days are counted", () => {
		const r = at(cert(90), 30);
		expect(r.certificate).toMatchObject({
			readable: true,
			subject: expect.stringContaining("firewall.invalid"),
			days_left: 60,
			age_days: 30,
			lifetime_days: 90,
			renew_after_days: 60,
			renewal_overdue: false,
			assessment: "OK",
		});
		expect(r.overall).toBe("OK");
	});

	test("70 days old with a 60-day interval: the renewal did not happen, ADVARSEL", () => {
		const r = at(cert(90), 70);
		expect(r.certificate.renewal_overdue).toBe(true);
		expect(r.certificate.assessment).toBe("FORNYELSE UTEBLITT");
		expect(r.overall).toBe("ADVARSEL");
	});

	test("ACME_RENEW_DAYS moves the line", () => {
		expect(at(cert(90), 70, { ACME_RENEW_DAYS: "80" }).certificate.assessment).toBe("OK");
	});

	test("under 14 days left, and expired", () => {
		const c = cert(90);
		expect(at(c, 80).certificate.assessment).toBe("UTLØPER SNART");
		expect(at(c, 91).certificate.assessment).toBe("UTLØPT");
		expect(at(c, 91).overall).toBe("ADVARSEL");
	});

	test("a long-lived certificate is not judged on renewal", () => {
		const r = at(cert(365), 200);
		expect(r.certificate.renew_after_days).toBeNull();
		expect(r.certificate.renewal_overdue).toBe(false);
		expect(r.certificate.assessment).toBe("OK");
	});

	test("without a certificate it is unknown, and overall is not touched", () => {
		const r = run(verifiedNow());
		expect(r.certificate).toEqual({ readable: false, assessment: "UKJENT" });
		expect(r.overall).toBe("OK");
	});

	test("the script never calls api/acmeclient", () => {
		expect(readFileSync(SCRIPT, "utf8")).not.toMatch(/api_(get|post)\s+"\/api\/acmeclient/);
	});
});
