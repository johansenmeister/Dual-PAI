/**
 * Contract test: trueNasApi.ts sends params with a call (#311)
 *
 * The script sent only the method name over the JSON-RPC websocket, never
 * `params` — so a call that needs arguments (e.g. `disk.smartctl` with
 * `["sdc", ["-g", "wcache"]]`) could never work. `parseArgs` and
 * `buildRequest` live in trueNasArgs.ts, which neither loads .env nor
 * connects, so this runs without a real TrueNAS.
 */
import { describe, expect, test } from "bun:test";
import { buildRequest, parseArgs } from "./trueNasArgs";

describe("parseArgs: flags and methods, unchanged without params", () => {
	test("plain methods, no params — same shape as before the fix", () => {
		const { flags, calls } = parseArgs(["system.info", "pool.query"]);
		expect(flags).toEqual({ pretty: false, compact: true, raw: false, timeout: 15000 });
		expect(calls).toEqual([{ method: "system.info" }, { method: "pool.query" }]);
	});

	test("flags: --pretty, --raw, --timeout", () => {
		const { flags, calls } = parseArgs(["--pretty", "--raw", "--timeout", "5000", "alert.list"]);
		expect(flags).toEqual({ pretty: true, compact: false, raw: true, timeout: 5000 });
		expect(calls).toEqual([{ method: "alert.list" }]);
	});

	test("--compact after --pretty wins back", () => {
		const { flags } = parseArgs(["--pretty", "--compact", "system.info"]);
		expect(flags.pretty).toBe(false);
		expect(flags.compact).toBe(true);
	});

	test("no methods at all — empty calls, caller decides what to do", () => {
		expect(parseArgs(["--pretty"]).calls).toEqual([]);
	});
});

describe("parseArgs: params for a method", () => {
	test("a JSON array right after a method becomes its params", () => {
		const { calls } = parseArgs(["disk.smartctl", '["sdc",["-g","wcache"]]']);
		expect(calls).toEqual([{ method: "disk.smartctl", params: ["sdc", ["-g", "wcache"]] }]);
	});

	test("several methods, only one with params", () => {
		const { calls } = parseArgs(["system.info", "disk.smartctl", '["sdc"]', "pool.query"]);
		expect(calls).toEqual([{ method: "system.info" }, { method: "disk.smartctl", params: ["sdc"] }, { method: "pool.query" }]);
	});

	test("params survive alongside flags in any position", () => {
		const { flags, calls } = parseArgs(["--pretty", "disk.smartctl", '["sdc"]']);
		expect(flags.pretty).toBe(true);
		expect(calls).toEqual([{ method: "disk.smartctl", params: ["sdc"] }]);
	});

	test("invalid JSON is rejected, not silently dropped or sent as a method", () => {
		expect(() => parseArgs(["disk.smartctl", "[sdc"])).toThrow(/invalid JSON/);
	});

	test("a JSON value that is not an array is rejected", () => {
		expect(() => parseArgs(["disk.smartctl", '{"disk":"sdc"}'])).toThrow(/must be a JSON array/);
	});

	test("a method that already got params cannot get a second array", () => {
		expect(() => parseArgs(["disk.smartctl", "[1,2]", '["x"]'])).toThrow(/already has params/);
	});

	test("params with no preceding method is rejected", () => {
		expect(() => parseArgs(['["sdc"]'])).toThrow(/no preceding method/);
	});
});

describe("buildRequest: the actual JSON-RPC message", () => {
	test("with params: they are in the request", () => {
		expect(buildRequest(2, { method: "disk.smartctl", params: ["sdc", ["-g", "wcache"]] })).toEqual({
			jsonrpc: "2.0",
			id: 2,
			method: "disk.smartctl",
			params: ["sdc", ["-g", "wcache"]],
		});
	});

	test("without params: the same request as before the fix — no params key at all", () => {
		const req = buildRequest(2, { method: "system.info" });
		expect(req).toEqual({ jsonrpc: "2.0", id: 2, method: "system.info" });
		expect(Object.keys(req)).not.toContain("params");
	});

	test("an empty params array is still sent (distinct from no params)", () => {
		expect(buildRequest(2, { method: "catalog.sync", params: [] })).toEqual({
			jsonrpc: "2.0",
			id: 2,
			method: "catalog.sync",
			params: [],
		});
	});
});
