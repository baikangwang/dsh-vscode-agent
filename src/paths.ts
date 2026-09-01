// Paths for the DSH runtime registry, startup lock and logs.
// Pure Node (no vscode dependency) so it can be exercised headlessly.
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'

/**
 * Single source of truth for the loopback bind host (F3). Referenced by the
 * dsh `--host` argument, the probe/url builders, `portBindable`'s bind address
 * and the netstat loopback-address filter. Never introduce a new bare
 * `127.0.0.1` literal elsewhere; the only exempted existing literals are the
 * webview CSP `frame-src http://127.0.0.1:*` (security constraint) and the
 * `URL_RE` in dshProcess.ts (F4 — pre-existing, same source, left untouched).
 */
export const LOOPBACK_HOST = '127.0.0.1'

/** Application data dir for this extension's coordination artifacts. */
export function dataDir(): string {
  // Overridable for headless tests; Windows default: %LOCALAPPDATA%\DshVscode
  if (process.env.DSH_VSCODE_DATA_DIR) return process.env.DSH_VSCODE_DATA_DIR
  const local = process.env.LOCALAPPDATA
  const base = local && local.length > 0 ? local : os.tmpdir()
  return path.join(base, 'DshVscode')
}

export function instanceFile(): string {
  return path.join(dataDir(), 'instance.json')
}

export function startupLockFile(): string {
  return path.join(dataDir(), 'startup.lock')
}

export function logFile(): string {
  return path.join(dataDir(), 'logs', 'dsh.log')
}

export function logsDir(): string {
  return path.join(dataDir(), 'logs')
}

/** Keep only the newest N=3 `dsh-*.log` files in the managed-launch log dir
 *  (per-day rotation; prevents log bloat, §9). Never touches dsh.log/runtime.log.
 *
 *  0.1.11 ADR-24 #45 (§4.9.1): the three-stage launch markers are SIBLING
 *  files of a per-launch log (`<log>.cmd-start` | `.node-start` | `.node-exit`)
 *  and share its lifecycle — every marker whose base log is rotated out in
 *  THIS batch is deleted in the same batch ("纳入同轮转批次", same keep=3
 *  policy, never an independent growth surface). Cleanup is deliberately
 *  same-batch only: markers of surviving logs and orphan markers (base already
 *  gone) are left alone (conservative; no speculative deletes). */
export const MANAGED_DSH_LOG_RE = /^dsh-\d{8}-\d{6}\.log$/

/** 0.1.11 marker instrumentation (§4.9.1): filename suffixes appended to the
 *  per-launch log path to form the marker sibling family. Single source shared
 *  by the payload builder (dshProcess.ts) and the rotation below. */
export const MARKER_SUFFIX_CMD_START = '.cmd-start'
export const MARKER_SUFFIX_NODE_START = '.node-start'
export const MARKER_SUFFIX_NODE_EXIT = '.node-exit'
/** ADR-25-③ (#55-②③, 0.1.12): resolver child-process output sibling suffix
 *  (`<log>.resolver`) — keeps the resolver's stdout/stderr (npm view version
 *  tokens etc.) OUT of the per-launch dsh log (R3's 11B false clue +
 *  parseSelfVersion first-line misread surface). Same lifecycle as the marker
 *  family: joins the rotate-same-batch cleanup below (never an independent
 *  growth surface); resolver evidence stays queryable in the sibling. */
export const MARKER_SUFFIX_RESOLVER = '.resolver'
export const DSH_LOG_MARKER_SUFFIXES: readonly string[] = [
  MARKER_SUFFIX_CMD_START,
  MARKER_SUFFIX_NODE_START,
  MARKER_SUFFIX_NODE_EXIT,
  MARKER_SUFFIX_RESOLVER,
]

/** Marker sibling path for a per-launch log (§4.9.1: `<LOG><suffix>`). */
export function dshLogMarkerFile(logFile: string, suffix: string): string {
  return `${logFile}${suffix}`
}

export function rotateDshLogs(dir: string, keep = 3): void {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => MANAGED_DSH_LOG_RE.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t) // newest first
    const stale = files.slice(keep)
    for (const old of stale) {
      fs.unlinkSync(path.join(dir, old.f))
    }
    if (stale.length === 0) return
    // #45: marker siblings of THIS batch's rotated-out logs join the same
    // batch (lifecycle bound to their base log, §4.9.1).
    const staleBases = new Set(stale.map((s) => s.f))
    for (const entry of fs.readdirSync(dir)) {
      const suffix = DSH_LOG_MARKER_SUFFIXES.find((sfx) => entry.endsWith(sfx))
      if (suffix === undefined) continue
      if (staleBases.has(entry.slice(0, entry.length - suffix.length))) {
        try {
          fs.unlinkSync(path.join(dir, entry))
        } catch {
          /* per-file best-effort */
        }
      }
    }
  } catch {
    /* rotation is best-effort */
  }
}

/** Managed-launch detached dsh stdout/stderr log file: logs/dsh-<ts>.log.
 *  The file name MUST match the spawn redirect target AND the file that
 *  `resolvePortFromLog` tails (F-PORT: single log data source). */
export function managedDshLogFile(ts = new Date()): string {
  const dir = logsDir()
  ensureDataDir()
  const p2 = (n: number) => String(n).padStart(2, '0')
  const name = `dsh-${ts.getFullYear()}${p2(ts.getMonth() + 1)}${p2(ts.getDate())}-${p2(ts.getHours())}${p2(ts.getMinutes())}${p2(ts.getSeconds())}.log`
  const file = path.join(dir, name)
  rotateDshLogs(dir, 3)
  return file
}

/** Decision-trace log written by the runtime orchestration (all start/shutdown branches). */
export function runtimeLogFile(): string {
  return path.join(dataDir(), 'logs', 'runtime.log')
}

/**
 * Runtime freshness meta file (ADR-13, 0.1.7): dataDir()/dsh-runtime-meta/<channel>.json.
 * Carries ONLY { lastCheckAt, knownVersion } — pure metadata, never a package
 * install (single runtime source of truth stays the npx cache, ADR-12 v2.1).
 * The channel is sanitized to a safe file-name segment (defensive; values are
 * 'latest' | 'preview' | an exact version in practice).
 */
export function runtimeMetaFile(channel: string): string {
  const safe = channel.replace(/[^A-Za-z0-9._-]/g, '_')
  return path.join(dataDir(), 'dsh-runtime-meta', `${safe}.json`)
}

/**
 * Append a decision-trace line to logs/runtime.log. Shared by the runtime
 * orchestration, the managed-launcher fallback decisions and the dshResolver
 * (full decision trajectory, design §4.1.2/§10). Diagnostics only; never throws.
 */
export function appendDecisionLog(msg: string): void {
  try {
    const file = runtimeLogFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `[${new Date().toISOString()}] [win ${process.pid}] ${msg}\n`, 'utf8')
  } catch {
    /* diagnostics must never break the runtime */
  }
}

export function ensureDataDir(): void {
  const { mkdirSync } = require('node:fs') as typeof import('node:fs')
  mkdirSync(dataDir(), { recursive: true })
  const logs = path.join(dataDir(), 'logs')
  mkdirSync(logs, { recursive: true })
}
