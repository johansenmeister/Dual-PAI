/**
 * Access to BrowserSession (#356)
 *
 * BrowserSession is an HTTP server that drives the assistant's browser
 * (navigate, read pages, run JavaScript), and it lives up to 30 minutes after
 * the session. It listened on every interface without authentication and
 * answered with `Access-Control-Allow-Origin: *`: anyone on the same network,
 * and any web page open in the user's own browser, could drive it.
 *
 * Now the server listens on loopback only, every request must carry the
 * session token, and a request with an `Origin` header (what a browser sends)
 * is refused before the token is checked. The token is kept in a state file
 * only the user can read, under `XDG_RUNTIME_DIR` when there is one, and with
 * the uid in its name otherwise.
 *
 * Server and client both take all of this from here, so they cannot drift.
 */

import { closeSync, constants, fstatSync, fchmodSync, ftruncateSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Loopback: not reachable from the network. */
export const HOSTNAME = '127.0.0.1'

export interface SessionState {
  pid: number
  port: number
  token: string
  sessionId: string
  startedAt: string
  headless: boolean
  url: string
}

/** The state file: per user, not a shared name in /tmp. */
export function stateFile(): string {
  const dir = process.env.XDG_RUNTIME_DIR || tmpdir()
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user'
  return join(dir, `pai-browser-session-${uid}.json`)
}

export function newToken(): string {
  return randomBytes(32).toString('hex')
}

export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * `null` when the request may pass, otherwise the response to send. A browser
 * sends `Origin` on a cross-origin request; `Browse.ts` does not, so a request
 * with `Origin` comes from a web page and is refused.
 */
export function reject(req: Request, token: string): Response | null {
  const deny = (status: number, error: string) =>
    new Response(JSON.stringify({ success: false, error }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  if (req.headers.get('origin') !== null) return deny(403, 'Forbidden')
  if (!token || !sameText(req.headers.get('authorization') ?? '', `Bearer ${token}`)) return deny(401, 'Unauthorized')
  return null
}

/**
 * Writes the state with mode 0600. `O_NOFOLLOW` and the owner check keep a
 * symlink, or a file another user put there first, from receiving the token.
 */
export function writeState(state: SessionState, file = stateFile()): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  try {
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
    if (uid !== undefined && fstatSync(fd).uid !== uid) throw new Error(`${file} is owned by another user`)
    fchmodSync(fd, 0o600)
    ftruncateSync(fd, 0)
    writeSync(fd, JSON.stringify(state, null, 2))
  } finally {
    closeSync(fd)
  }
}

export function readState(file = stateFile()): SessionState | null {
  try {
    const text = readFileSync(file, 'utf-8')
    return text.trim() ? (JSON.parse(text) as SessionState) : null
  } catch {
    return null
  }
}

export function removeState(file = stateFile()): void {
  try {
    unlinkSync(file)
  } catch {}
}
