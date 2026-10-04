#!/usr/bin/env bun
/**
 * TrueNAS API Client — WebSocket JSON-RPC 2.0
 * Usage: bun Scripts/trueNasApi.ts [--pretty] [--compact] method1 [method2 ...]
 *
 * Reads TRUENAS_API_KEY from ~/.opencode/.env
 * Connects via WebSocket to wss://<host>/api/current, derived from TRUENAS_API_URL
 * Authenticates with auth.login_ex (API_KEY_PLAIN)
 * Calls each method sequentially, outputs JSON to stdout
 *
 * Flags:
 *   --pretty    Pretty-print JSON output
 *   --compact   Single-line JSON per method (default)
 *   --raw       Raw responses array (no labels)
 *   --timeout N WebSocket timeout in ms (default 15000)
 *
 * Examples:
 *   bun trueNasApi.ts system.info pool.query
 *   bun trueNasApi.ts --pretty system.info disk.query alert.list
 *   bun trueNasApi.ts --raw pool.query | jq '.[] | select(.status != "ONLINE")'
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// Parse args
const args = process.argv.slice(2);
const flags = { pretty: false, compact: true, raw: false, timeout: 15000 };
const methods: string[] = [];

for (const arg of args) {
  if (arg === "--pretty") {
    flags.pretty = true;
    flags.compact = false;
  } else if (arg === "--compact") {
    flags.compact = true;
    flags.pretty = false;
  } else if (arg === "--raw") {
    flags.raw = true;
  } else if (arg === "--timeout" && args.indexOf(arg) + 1 < args.length) {
    flags.timeout = parseInt(args[args.indexOf(arg) + 1], 10) || 15000;
  } else if (!arg.startsWith("--")) {
    methods.push(arg);
  }
}

if (methods.length === 0) {
  console.error("Usage: bun trueNasApi.ts [--pretty|--compact|--raw] method1 [method2 ...]");
  process.exit(1);
}

// Read API key
function loadApiKey(): string {
  const envPath = resolve(homedir(), ".opencode", ".env");
  try {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      if (line.startsWith("TRUENAS_API_KEY=")) {
        const key = line.split("=")[1].trim();
        if (!key || key === "YOUR_API_KEY_HERE") {
          throw new Error("TRUENAS_API_KEY is empty or placeholder");
        }
        return key;
      }
    }
    throw new Error("TRUENAS_API_KEY not set");
  } catch (e: any) {
    console.error("");
    console.error("╔══════════════════════════════════════════════════════════╗");
    console.error("║  MISSING TRUENAS_API_KEY                                ║");
    console.error("╠══════════════════════════════════════════════════════════╣");
    console.error("║                                                        ║");
    console.error("║  TrueNAS skill requires an API key.                     ║");
    console.error("║                                                        ║");
    console.error("║  1. Create a read-only API key in TrueNAS web UI:       ║");
    console.error("║     Settings → API Keys → Add                           ║");
    console.error("║     Username: pai-api (Readonly Admin)                  ║");
    console.error("║                                                        ║");
    console.error("║  2. Add to ~/.opencode/.env:                            ║");
    console.error("║     TRUENAS_API_URL=https://<din-truenas>/api/v2.0       ║");
    console.error("║     TRUENAS_API_KEY=<your-key>                           ║");
    console.error("║                                                        ║");
    console.error("║  Error: " + e.message.padEnd(49) + "║");
    console.error("╚══════════════════════════════════════════════════════════╝");
    console.error("");
    process.exit(1);
  }
}

const API_KEY = loadApiKey();

// Logic
const results: Record<string, any> = {};
let nextCall = 0;
let resolved = false;

/**
 * WebSocket-URL utledet fra TRUENAS_API_URL (M-29).
 *
 * Sto hardkodet som `wss://10.0.0.5/api/current` til 2026-09-23 — altså
 * én bestemt maskin på ett bestemt nett. Skriptet KREVER `TRUENAS_API_URL` i
 * sin egen feilmelding tjue linjer over, og ignorerte den så. Konsekvensen:
 * skillen kunne aldri virke noe annet sted, og en korrekt `.env` hjalp ikke
 * hvis verten byttet adresse.
 *
 * Fallbacken er en tydelig ugyldig plassholder framfor noens ekte adresse.
 * Feiler den, er det synlig; peker den på feil maskin, er det ikke.
 */
function wsUrlFraEnv(): string {
	const rå = process.env.TRUENAS_API_URL?.trim();
	if (!rå) {
		console.error("MISSING TRUENAS_API_URL — sett den i ~/.opencode/.env");
		process.exit(1);
	}
	// https://vert/api/v2.0 → wss://vert/api/current
	const u = new URL(rå);
	u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
	u.pathname = "/api/current";
	return u.toString();
}

const ws = new WebSocket(wsUrlFraEnv());

const timeout = setTimeout(() => {
  if (!resolved) {
    console.error("WebSocket timed out after", flags.timeout, "ms");
    ws.close();
    process.exit(1);
  }
}, flags.timeout);

function sendNext() {
  if (nextCall < methods.length) {
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: nextCall + 2,
      method: methods[nextCall],
    }));
    nextCall++;
  } else {
    resolved = true;
    clearTimeout(timeout);
    ws.close();
  }
}

ws.onopen = () => {
  ws.send(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "auth.login_ex",
    params: [{
      mechanism: "API_KEY_PLAIN",
      username: "pai-api",
      api_key: API_KEY,
    }],
  }));
};

ws.onmessage = (e: any) => {
  const msg = JSON.parse(e.data as string);
  if (msg.id === 1) {
    if (msg.result?.response_type !== "SUCCESS") {
      console.error("Auth failed:", JSON.stringify(msg.error || msg));
      ws.close();
      process.exit(1);
    }
    sendNext();
    return;
  }
  // Store result keyed by method name
  const methodIndex = msg.id - 2;
  if (methodIndex >= 0 && methodIndex < methods.length) {
    results[methods[methodIndex]] = msg.result;
  }
  sendNext();
};

ws.onerror = (e: any) => {
  console.error("WebSocket error:", e.message || e);
  ws.close();
  process.exit(1);
};

ws.onclose = () => {
  if (flags.raw) {
    // Output raw array of results
    console.log(JSON.stringify(Object.values(results)));
  } else if (flags.pretty) {
    for (const [method, result] of Object.entries(results)) {
      console.log(`--- ${method} ---`);
      console.log(JSON.stringify(result, null, 2));
    }
  } else {
    // Compact: one line per method
    for (const [method, result] of Object.entries(results)) {
      console.log(JSON.stringify({ method, result }));
    }
  }
};
