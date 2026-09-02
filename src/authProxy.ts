// authProxy — local loopback reverse proxy establishing the dsh token-auth
// session server-side (0.1.14, ADR-30; design §3.4 contract R1-R10).
//
// Why a proxy at all (§0.3): dsh's session cookie is SameSite=Strict — a
// cross-site iframe (top-level origin vscode-webview://) never carries it, so
// pointing the panel iframe at the token URL directly loads only the shell
// while every /api request 401s (structurally unusable). A server-to-server
// forwarder is not bound by SameSite: the proxy holds the session cookie in
// memory and injects it on every forwarded request.
//
// Contract (design §3.4; each rule is PP-8-2 headlessly asserted):
//  R1 forward method/path/query/body and response status/body VERBATIM
//     (the only response mutation is R5's Set-Cookie strip).
//  R2 session bootstrap: once, at startup, `GET /?token=<t>` → upstream 303 +
//     Set-Cookie → the proxy retains `dsh-auth-<hash>=<value>` in memory.
//  R3 Host rewrite: every forwarded request's Host becomes the upstream
//     authority `<LOOPBACK>:<upstreamPort>` (Host fence, e2e L168-171 — a
//     forged Host 401s).
//  R4 Origin rewrite: an Origin header, WHEN PRESENT, is rewritten to the same
//     upstream authority (panel SPA fetches/WS handshakes carry
//     Origin=http://<LOOPBACK>:<proxyPort> — Host rewritten without Origin
//     rewritten = 403 on the whole data plane, E-TRUST-4). NO Origin → none
//     injected (upstream: "Absent Origin is fine", api-request-trust L112).
//  R5 response `Set-Cookie` ALWAYS stripped: the cookie is functionally dead
//     in a cross-site iframe, and a 30d credential must not leak into webview
//     storage. The session stays server-side (止于 proxy、不出 proxy).
//  R6 fence order: upstream 403 (trust fence) precedes 401 (cookie auth) —
//     the proxy's job is R3/R4 (never trip the 403); 401/403 responses are
//     forwarded verbatim, never swallowed or translated (honest pass-through).
//  R7 WS upgrade same fence: /api/remote.mux upgrade runs the identical
//     Origin rule (browser WS handshakes always carry Origin) — implemented as
//     a raw TCP forward with the SAME header rewrite, so the upstream 101 (or
//     403/401) crosses byte-for-byte.
//  R8 `sec-fetch-site` passes through untouched (iframe requests to their own
//     origin are same-origin; top-level GET / never reaches the /api fence).
//  R9 lifecycle: started/stopped by the runtime at the managed-launch /
//     stop / crash / force-relaunch landing points.
//  R10 session sources T → C: T = banner token (main path); C = self-minted
//     cookie from `<DSH_HOME>/.credentials.yaml` (read-only, never written
//     back; P-TOKEN-PROBE-1 verdict FEASIBLE) — C failure → honest degradation
//     (no fabricated session; the runtime shows the restart guidance).
//
// Safety envelope (design §0.4/§3.8): loopback bind only; NO credential ever
// touches disk from this module (memory-only session; D3: registry stores no
// token); zero npm dependencies; PURE NODE (no 'vscode' import). The proxy
// itself is unauthenticated — honest boundary: trust domain = the local user
// privilege domain, identical to the managed log's plaintext token; the
// upstream is loopback-only anyway, so the exposure surface is NOT enlarged
// (NOTE-2; a proxy auth layer is explicitly out of scope).
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { LOOPBACK_HOST } from './paths'

/** Session given to the proxy: T-path token and/or an established cookie. */
export interface AuthProxySession {
  /**
   * T path: the banner launch token (`?token=` value). When non-null the
   * proxy bootstraps once (`GET /?token=<t>` → 303 + Set-Cookie) and retains
   * the cookie in memory.
   */
  token: string | null
  /**
   * C path: an ALREADY-minted session cookie (`dsh-auth-<hash>=v1.…`, the
   * full Cookie-header pair). When non-null the bootstrap is skipped — the
   * cookie is used as-is (the banner-less / adopt-session fallback).
   */
  cookie: string | null
}

/** Handle returned by startAuthProxy; `stop()` releases the listener + sockets. */
export interface AuthProxyHandle {
  /** The local loopback port the proxy listens on (iframe target authority). */
  port: number
  /** Stop the proxy, destroy tracked sockets, release the port (idempotent). */
  stop(): void
}

/** Optional observability seam (runtime passes rlog; headless tests spy). */
export interface AuthProxyDeps {
  log?: (msg: string) => void
}

// --- C-path self-minting (browser-auth.ts isomorphic; E-PR-2/3/4) -----------

const COOKIE_PREFIX = 'dsh-auth-'
const COOKIE_PAYLOAD_VERSION = 1
/** Cookie max-age in days — upstream `cookieMaxAgeDays` default 30 (E-PR-6). */
const COOKIE_MAX_AGE_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
/** The credentials record key (`credentialKey('client-connection','browser-session')`). */
const AUTH_RECORD_KEY = 'client-connection/browser-session'
/** Name of the persistent secret file inside DSH_HOME (design §3.1-2). */
const CREDENTIALS_FILE = '.credentials.yaml'

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/**
 * The cookie name dsh derives for an authority: `dsh-auth-` +
 * base64url(sha256(authority)) (browser-auth.ts L106-108). The proxy rewrites
 * Host to `<LOOPBACK>:<upstreamPort>`, so the authority here is the SAME string
 * the upstream sees — the C-path minted name is naturally aligned with the
 * T-path bootstrap cookie (E-PR-4).
 */
export function dshCookieName(authority: string): string {
  return COOKIE_PREFIX + encodeBase64Url(crypto.createHash('sha256').update(authority).digest())
}

/**
 * C path (design §3.7): self-mint a session cookie from the persistent secret.
 * Inputs = the 43-char base64url secret from `<DSH_HOME>/.credentials.yaml` +
 * the authority (Host the upstream will see) + the local clock — ZERO server
 * interaction. Value shape = `v1.<body>.<sig>` where body is the base64url of
 * JSON `{version:1, authority, issuedAt, expiresAt}` and sig is base64url(
 * HMAC-SHA256(secret, body)) — byte-isomorphic to browser-auth.ts
 * encodeCookie (L129-132); the verification chain (L289-302) accepts it:
 * shape / HMAC / authority binding / 30d window.
 * Returns the full `name=value` pair (ready for a Cookie header), or null on
 * any malformed input (honest degradation, never throws).
 */
export function mintSessionCookie(secretBase64Url: string, authority: string, nowMs: number = Date.now()): string | null {
  try {
    if (typeof secretBase64Url !== 'string' || secretBase64Url.length === 0) return null
    if (typeof authority !== 'string' || authority.length === 0) return null
    const secret = Buffer.from(secretBase64Url.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
    if (secret.byteLength !== 32) return null
    const issuedAt = nowMs
    const expiresAt = issuedAt + COOKIE_MAX_AGE_DAYS * DAY_MS
    const body = encodeBase64Url(
      Buffer.from(JSON.stringify({ version: COOKIE_PAYLOAD_VERSION, authority, issuedAt, expiresAt }), 'utf8'),
    )
    const sig = encodeBase64Url(crypto.createHmac('sha256', secret).update(body).digest())
    return `${dshCookieName(authority)}=v1.${body}.${sig}`
  } catch {
    return null
  }
}

/**
 * Minimal indentation-style YAML subset reader for the dsh credentials file
 * (structure per P-TOKEN-PROBE-1 E-PR-1/2: `version/refs/records` sections;
 * the record `records['client-connection/browser-session'].payload.secret`).
 * Reads ONLY — the file is never written back (design §0.4). Returns the
 * 43-char base64url secret, or null when the file/record is unreadable
 * (honest degradation — the runtime falls back to the restart guidance).
 */
export function readCredentialsSecret(dshHome: string): string | null {
  try {
    const home = dshHome != null && dshHome.trim().length > 0 ? dshHome.trim() : path.join(os.homedir(), '.dsh')
    const text = fs.readFileSync(path.join(home, CREDENTIALS_FILE), 'utf8')
    const lines = text.split(/\r?\n/)
    // Walk with an indentation stack; locate records → <AUTH_RECORD_KEY> →
    // payload → secret. Only plain `key: value` scalars are interpreted.
    type Node = { indent: number; key: string }
    const stack: Node[] = []
    let inTargetRecord = false
    let inPayload = false
    for (const rawLine of lines) {
      const trimmed = rawLine.replace(/#.*$/, '').trimEnd()
      if (trimmed.length === 0) continue
      const indent = rawLine.length - rawLine.trimStart().length
      const m = /^([^:]+):\s*(.*)$/.exec(trimmed)
      if (m === null) continue
      const key = m[1].trim().replace(/^['"]|['"]$/g, '')
      const value = m[2].trim()
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
      stack.push({ indent, key })
      const keys = stack.map((n) => n.key)
      inTargetRecord = keys.length >= 2 && keys[0] === 'records' && keys[1] === AUTH_RECORD_KEY
      inPayload = inTargetRecord && keys.length >= 3 && keys[2] === 'payload'
      if (inPayload && key === 'secret' && value.length > 0) {
        return value.replace(/^['"]|['"]$/g, '')
      }
    }
    return null
  } catch {
    return null
  }
}

// --- proxy internals ---------------------------------------------------------

/** Headers that must not cross the hop verbatim (RFC 7230 §6.1 hop-by-hop). */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

/**
 * Build the upstream request headers for one client request (R3/R4 + cookie
 * injection + hop-by-hop strip). Returns a flat lowercase-keyed header bag.
 * `keepUpgradeHop` (R7 WS upgrade path only): a WebSocket handshake IS the
 * hop — `Upgrade`/`Connection` must cross to the upstream verbatim or the
 * upgrade route never fires there (every other hop-by-hop header still goes).
 */
function buildUpstreamHeaders(
  clientHeaders: http.IncomingHttpHeaders,
  upstreamAuthority: string,
  sessionCookie: string | null,
  keepUpgradeHop = false,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(clientHeaders)) {
    const lower = key.toLowerCase()
    if (HOP_BY_HOP.has(lower) && !(keepUpgradeHop && (lower === 'upgrade' || lower === 'connection'))) continue
    if (lower === 'host' || lower === 'origin' || lower === 'cookie') continue // rewritten below
    if (Array.isArray(value)) {
      if (value.length > 0) out[lower] = value.join(', ')
    } else if (typeof value === 'string') {
      out[lower] = value
    }
  }
  // R3: Host = the upstream authority (socket target) — the Host fence binds
  // every request to the loopback socket the proxy actually dials.
  out['host'] = upstreamAuthority
  // R4: Origin, WHEN PRESENT, becomes the same upstream authority; absent
  // Origin stays absent (upstream L112: absent is fine — do NOT inject).
  if (typeof clientHeaders['origin'] === 'string' && clientHeaders['origin'].length > 0) {
    out['origin'] = `http://${upstreamAuthority}`
  }
  // Cookie injection (R2): the proxy-held session pair replaces/merges into
  // the Cookie header. Client cookies other than the dsh-auth pair survive.
  if (sessionCookie !== null) {
    const cookieName = sessionCookie.slice(0, sessionCookie.indexOf('='))
    const clientCookie = typeof clientHeaders['cookie'] === 'string' ? clientHeaders['cookie'] : ''
    const kept = clientCookie
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith(`${cookieName}=`))
    out['cookie'] = [...kept, sessionCookie].join('; ')
  }
  return out
}

/** Extract the `dsh-auth-…` cookie pair from a Set-Cookie header array. */
function captureSessionCookie(setCookie: string[] | undefined): string | null {
  if (!Array.isArray(setCookie)) return null
  for (const entry of setCookie) {
    if (typeof entry !== 'string' || !entry.startsWith(COOKIE_PREFIX)) continue
    const pair = entry.split(';', 1)[0].trim()
    if (pair.includes('=')) return pair
  }
  return null
}

/**
 * Start the loopback authProxy (design §3.4). Resolves with the handle as soon
 * as the local listener is up (millisecond-scale); the session bootstrap (R2)
 * runs fire-and-forget afterwards and is rlog-traced — until it lands, cookie
 * injection is skipped and upstream answers pass through verbatim (the
 * runtime's 401 diversion owns the degraded case).
 */
export function startAuthProxy(
  upstreamPort: number,
  session: AuthProxySession,
  deps?: AuthProxyDeps,
): Promise<AuthProxyHandle> {
  const log = deps?.log ?? (() => {})
  const upstreamAuthority = `${LOOPBACK_HOST}:${String(upstreamPort)}`
  let heldCookie: string | null = session.cookie

  const server = http.createServer((req, res) => {
    void handleRequest(req, res)
  })
  // R7: WS upgrade = raw TCP forward with the SAME header rewrite (the
  // upstream's 101 / 403 / 401 crosses byte-for-byte; frames are opaque).
  const sockets = new Set<net.Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
    sockets.add(clientSocket)
    clientSocket.on('close', () => sockets.delete(clientSocket))
    // R7: keepUpgradeHop — the WS handshake's Upgrade/Connection cross verbatim.
    const headers = buildUpstreamHeaders(req.headers, upstreamAuthority, heldCookie, true)
    let raw = `${req.method} ${req.url ?? '/'} HTTP/1.1\r\n`
    for (const [key, value] of Object.entries(headers)) raw += `${key}: ${value}\r\n`
    raw += '\r\n'
    const upstream = net.connect({ host: LOOPBACK_HOST, port: upstreamPort }, () => {
      upstream.write(raw)
      if (head.length > 0) upstream.write(head)
      clientSocket.pipe(upstream)
      upstream.pipe(clientSocket)
    })
    sockets.add(upstream)
    upstream.on('close', () => sockets.delete(upstream))
    const tear = (): void => {
      try { clientSocket.destroy() } catch { /* ignore */ }
      try { upstream.destroy() } catch { /* ignore */ }
    }
    upstream.on('error', tear)
    clientSocket.on('error', tear)
  })

  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    for (const socket of sockets) {
      try { socket.destroy() } catch { /* ignore */ }
    }
    sockets.clear()
    try { server.close(() => { /* best-effort */ }) } catch { /* ignore */ }
  }

  const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const headers = buildUpstreamHeaders(req.headers, upstreamAuthority, heldCookie)
    let upstreamRes: http.IncomingMessage | null = null
    try {
      upstreamRes = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const upstreamReq = http.request(
          { host: LOOPBACK_HOST, port: upstreamPort, method: req.method, path: req.url ?? '/', headers },
          (r) => resolve(r),
        )
        upstreamReq.on('error', reject)
        req.pipe(upstreamReq)
      })
    } catch (err) {
      // Upstream unreachable: honest pass-through semantics — surface 502 with
      // the reason; never fabricate a dsh-shaped answer (design §3.4 R1 spirit).
      log(`authProxy: upstream unreachable (${(err as Error).message})`)
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`dsh upstream unreachable: ${(err as Error).message}\n`)
      } else {
        try { res.destroy() } catch { /* ignore */ }
      }
      return
    }
    // R5: Set-Cookie ALWAYS stripped (the session stays server-side).
    const outHeaders: Record<string, string | string[]> = {}
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      const lower = key.toLowerCase()
      if (lower === 'set-cookie' || HOP_BY_HOP.has(lower)) continue
      outHeaders[lower] = value as string | string[]
    }
    res.writeHead(upstreamRes.statusCode ?? 502, outHeaders)
    upstreamRes.pipe(res)
    upstreamRes.on('error', () => {
      try { res.destroy() } catch { /* ignore */ }
    })
  }

  /** R2: one-shot session bootstrap from the banner token. */
  const bootstrapSession = async (): Promise<void> => {
    if (session.token === null || session.token.length === 0) return
    try {
      const res = await fetch(`http://${upstreamAuthority}/?token=${encodeURIComponent(session.token)}`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
      const captured = captureSessionCookie(res.headers.getSetCookie?.() ?? undefined)
      if (res.status === 303 && captured !== null) {
        heldCookie = captured
        log(`authProxy: session bootstrapped via banner token (token=<REDACTED>, cookie retained server-side)`)
      } else {
        log(`authProxy: session bootstrap did not yield a cookie (status=${res.status}, cookie=${captured === null ? 'none' : 'captured'}); requests pass through until the runtime's 401 diversion rebuilds the session`)
      }
    } catch (err) {
      log(`authProxy: session bootstrap failed (${(err as Error).message}); requests pass through`)
    }
  }

  return new Promise<AuthProxyHandle>((resolve, reject) => {
    server.once('error', (err) => {
      if (!stopped) reject(err)
    })
    // Loopback-only bind, OS-assigned random port (design §0.4 / §3.4).
    server.listen({ host: LOOPBACK_HOST, port: 0 }, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      if (!port) {
        stop()
        reject(new Error('authProxy: listener resolved without a port'))
        return
      }
      log(`authProxy: listening on ${LOOPBACK_HOST}:${port} -> upstream ${upstreamAuthority} (session ${session.cookie !== null ? 'C-path cookie' : session.token !== null ? 'T-path token' : 'none'})`)
      void bootstrapSession()
      resolve({ port, stop })
    })
  })
}
