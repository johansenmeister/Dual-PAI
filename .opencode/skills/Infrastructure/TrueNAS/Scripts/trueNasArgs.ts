/**
 * Argument parsing and request building for trueNasApi.ts (#311).
 *
 * Pure, so the test can import it without loading .env or connecting
 * to TrueNAS.
 */

export interface Flags {
  pretty: boolean;
  compact: boolean;
  raw: boolean;
  timeout: number;
}

export interface MethodCall {
  method: string;
  params?: unknown[];
}

/**
 * Parses CLI args into flags and the methods to call, each with its
 * optional params.
 *
 * A method name never starts with "[" or "{", so a non-flag argument that
 * does is always a params attempt for the method right before it
 * (JSON-parsed, must be an array); anything else is a new method name.
 * Throws on params with no preceding method, a method that already has
 * params, invalid JSON, or a parsed value that is not an array — the caller
 * must not connect to TrueNAS in that case.
 */
export function parseArgs(args: string[]): { flags: Flags; calls: MethodCall[] } {
  const flags: Flags = { pretty: false, compact: true, raw: false, timeout: 15000 };
  const calls: MethodCall[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--pretty") {
      flags.pretty = true;
      flags.compact = false;
    } else if (arg === "--compact") {
      flags.compact = true;
      flags.pretty = false;
    } else if (arg === "--raw") {
      flags.raw = true;
    } else if (arg === "--timeout") {
      flags.timeout = parseInt(args[++i], 10) || 15000;
    } else if (arg.startsWith("[") || arg.startsWith("{")) {
      const last = calls[calls.length - 1];
      if (!last) throw new Error(`params with no preceding method: ${arg}`);
      if (last.params !== undefined) throw new Error(`method ${last.method} already has params`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(arg);
      } catch {
        throw new Error(`invalid JSON params for ${last.method}: ${arg}`);
      }
      if (!Array.isArray(parsed)) throw new Error(`params for ${last.method} must be a JSON array, got: ${arg}`);
      last.params = parsed;
    } else if (!arg.startsWith("--")) {
      calls.push({ method: arg });
    }
  }

  return { flags, calls };
}

/** The JSON-RPC request for one call. `params` is only present when given — matches pre-params behavior when absent. */
export function buildRequest(id: number, call: MethodCall): Record<string, unknown> {
  const req: Record<string, unknown> = { jsonrpc: "2.0", id, method: call.method };
  if (call.params !== undefined) req.params = call.params;
  return req;
}
