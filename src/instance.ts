// Application-level lifecycle arbitration: the instance registry (who owns the
// dsh runtime and which VSCode windows are attached), the atomic startup lock
// (first-window arbitration), process liveness and port/PID helpers.
// Pure Node (no vscode dependency) so it can be exercised headlessly.
import * as fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { ensureDataDir, instanceFile, startupLockFile, LOOPBACK_HOST } from './paths'

export interface DshRecord {
  /** PID of the dsh web process (null when an external instance's PID could not be resolved). */
  pid: number | null
  /** Port the dsh web server listens on. */
  port: number
  /**
   * Ownership used by last-window stop arbitration (ADR-4, P0-F):
   * - 'managed-own' = this extension代拉的一个 detached 独立常驻 dsh（仅最后窗口+防误杀才停）
   * - 'extension'   = legacy/other extension-managed dsh（同样仅最后窗口才停）
   * - 'external'    = 手动 cmd 或其它工具起的 dsh（最后窗口不杀，保留 known-external 记录）
   */
  managedBy: 'extension' | 'external' | 'managed-own'
  startedAt: string
}

export interface WindowRecord {
  /** VSCode app name (e.g. 'Visual Studio Code' / 'Visual Studio Code - Insiders'). */
  app: string
  /** Extension host process PID (unique per window). */
  pid: number
  /** The moment this window was FIRST attached; same-pid re-registration
   *  preserves it (ADR-16: first-attachment semantics, never reset). */
  startedAt: string
}

export interface InstanceState {
  dsh: DshRecord | null
  windows: WindowRecord[]
}

export function emptyInstance(): InstanceState {
  return { dsh: null, windows: [] }
}

// ---------------------------------------------------------------- registry

export function readInstance(): InstanceState {
  ensureDataDir()
  try {
    const raw = fs.readFileSync(instanceFile(), 'utf8')
    const parsed = JSON.parse(raw) as InstanceState
    if (!parsed || typeof parsed !== 'object') return emptyInstance()
    return {
      dsh: parsed.dsh ?? null,
      windows: Array.isArray(parsed.windows) ? parsed.windows : [],
    }
  } catch {
    return emptyInstance()
  }
}

/** Atomic write: temp file + rename. Low-frequency (window activate/exit), safe under contention. */
export function writeInstance(state: InstanceState): void {
  ensureDataDir()
  const file = instanceFile()
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

// ---------------------------------------------------------------- liveness

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM' // exists but not ours
  }
}

export function dshAlive(inst: InstanceState): boolean {
  return inst.dsh !== null && inst.dsh.pid !== null && isAlive(inst.dsh.pid)
}

// ---------------------------------------------------------------- window registry

export function registerWindow(inst: InstanceState, app: string, pid: number): InstanceState {
  const next = { ...inst, windows: [...inst.windows] }
  const idx = next.windows.findIndex((w) => w.pid === pid)
  const existing = idx >= 0 ? next.windows[idx] : null
  // ADR-16: same-pid re-registration keeps the FIRST-attachment startedAt;
  // only a genuinely new window pid gets a fresh timestamp.
  const rec: WindowRecord = {
    app,
    pid,
    startedAt: existing !== null ? existing.startedAt : new Date().toISOString(),
  }
  if (idx >= 0) next.windows[idx] = rec
  else next.windows.push(rec)
  return next
}

export function unregisterWindow(inst: InstanceState, pid: number): InstanceState {
  return { ...inst, windows: inst.windows.filter((w) => w.pid !== pid) }
}

// ------------------------------------------------------- stale-window healing (ADR-15)

/**
 * Identity verdict for a (live) window pid, P-STALEWIN §4.2.1:
 * - 'exthost'  : CommandLine contains `--type=extensionHost` (the deterministic,
 *                channel/version-stable VSCode extension-host signature) -> KEEP.
 * - 'foreign'  : query succeeded with a non-empty CommandLine that does not
 *                match -> the pid is no longer a VSCode extension host
 *                (reused/stale) -> CLEAR.
 * - 'unknown'  : query failed / timed out / empty CommandLine -> KEEP
 *                (safe-side: 宁留勿误清, same direction as the shutdown
 *                triple-gate; never clear on unknown).
 */
export type IdentityVerdict = 'exthost' | 'foreign' | 'unknown'

/** One CIM identity query per pid per TTL (WMI cold start 0.5-3s; ADR-15 cache). */
export const IDENTITY_CACHE_TTL_MS = 60_000
const identityCache = new Map<number, { at: number; verdict: IdentityVerdict }>()

/** Cached identity verdict (module-level Map<pid, {at, verdict}>, TTL-bounded). */
export function processIdentitySync(pid: number, timeoutMs: number): IdentityVerdict {
  const hit = identityCache.get(pid)
  if (hit !== undefined && Date.now() - hit.at < IDENTITY_CACHE_TTL_MS) return hit.verdict
  const verdict = queryIdentitySync(pid, timeoutMs)
  identityCache.set(pid, { at: Date.now(), verdict })
  return verdict
}

/** One CIM query fetching Name + CommandLine (bounded powershell spawnSync). */
function queryIdentitySync(pid: number, timeoutMs: number): IdentityVerdict {
  try {
    const out = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -First 1 -Property Name, CommandLine; if ($p) { $p | ConvertTo-Json -Compress }`,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: timeoutMs },
    )
    if (out.status !== 0) return 'unknown'
    const text = out.stdout.trim()
    if (text.length === 0) return 'unknown' // no match / no output -> safe-side
    let parsed: { Name?: unknown; CommandLine?: unknown } | null = null
    try {
      parsed = JSON.parse(text) as { Name?: unknown; CommandLine?: unknown }
    } catch {
      return 'unknown'
    }
    const cl = typeof parsed?.CommandLine === 'string' ? parsed.CommandLine : ''
    if (cl.length === 0) return 'unknown' // empty CommandLine -> unknown (safe-side)
    return cl.includes('--type=extensionHost') ? 'exthost' : 'foreign'
  } catch {
    return 'unknown'
  }
}

export interface ScrubResult {
  /** Scrubbed instance (windows[] with stale entries removed). */
  inst: InstanceState
  /** Number of removed entries. */
  removed: number
  /** The removed pids (liveness-dead first, then identity-foreign). */
  removedPids: number[]
}

/**
 * T1 liveness scrub (instant, zero I/O): drop window entries whose pid is no
 * longer alive (`process.kill(pid,0)`). Covers the force-killed-host scenario.
 */
export function scrubDeadWindowsSync(inst: InstanceState): ScrubResult {
  const removedPids = inst.windows.filter((w) => !isAlive(w.pid)).map((w) => w.pid)
  const kept = inst.windows.filter((w) => isAlive(w.pid))
  return { inst: { ...inst, windows: kept }, removed: removedPids.length, removedPids }
}

/**
 * Full stale-window scrub (ADR-15): liveness first, then a bounded identity
 * check for the SURVIVING pids (pid-reuse guard). 'foreign' entries are
 * removed; 'exthost' and 'unknown' are always kept (safe-side). Callers pass
 * `timeoutMs` per identity query (T1b async: 10s; T2 exit path: 2s) and may
 * inject `identityCheck` for headless tests (PW-3).
 */
export function scrubWindowsWithIdentitySync(
  inst: InstanceState,
  timeoutMs: number,
  identityCheck?: (pid: number) => IdentityVerdict,
): ScrubResult {
  const dead = inst.windows.filter((w) => !isAlive(w.pid)).map((w) => w.pid)
  let kept = inst.windows.filter((w) => isAlive(w.pid))
  const check = identityCheck ?? ((pid: number) => processIdentitySync(pid, timeoutMs))
  const foreign: number[] = []
  kept = kept.filter((w) => {
    const verdict = check(w.pid)
    if (verdict === 'foreign') {
      foreign.push(w.pid)
      return false
    }
    return true // 'exthost' keep; 'unknown' keep (safe-side, never clear)
  })
  const removedPids = [...dead, ...foreign]
  return { inst: { ...inst, windows: kept }, removed: removedPids.length, removedPids }
}

// ---------------------------------------------------------------- startup lock

export interface LockPayload {
  pid: number
  app: string
  createdAt: string
}

/**
 * Try to acquire the startup lock with an exclusive create ('wx').
 * Reclaims a stale lock whose PID is no longer alive. Returns the lock payload
 * on success, null when another window currently holds it.
 */
export function acquireStartupLock(app: string): LockPayload | null {
  ensureDataDir()
  const file = startupLockFile()
  const payload: LockPayload = { pid: process.pid, app, createdAt: new Date().toISOString() }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx')
      fs.writeFileSync(fd, JSON.stringify(payload), 'utf8')
      fs.closeSync(fd)
      return payload
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') return null
      // stale check
      try {
        const held = JSON.parse(fs.readFileSync(file, 'utf8')) as LockPayload
        if (held && typeof held.pid === 'number' && isAlive(held.pid)) return null
        fs.unlinkSync(file) // holder died; reclaim on next attempt
      } catch {
        fs.unlinkSync(file) // corrupt lock; reclaim
      }
    }
  }
  return null
}

export function releaseStartupLock(): void {
  try {
    fs.unlinkSync(startupLockFile())
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- port / pid helpers

export interface PortPid {
  pid: number
  address: string
}

/** Resolve the PID listening on 127.0.0.1:<port> via netstat (Windows). */
export function resolvePortPid(port: number): PortPid | null {
  try {
    const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true })
    if (out.status !== 0) return null
    for (const line of out.stdout.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+([\d.]+):(\d+)\s+[\d.:*]+:\d+\s+LISTENING\s+(\d+)\s*$/)
      if (!m) continue
      const [, address, portStr, pidStr] = m
      // Loopback filter references LOOPBACK_HOST (single source, F3); wildcard
      // binds (0.0.0.0 / [::1]) still count as reachable on the same port.
      if (Number(portStr) === port && (address === LOOPBACK_HOST || address === '0.0.0.0' || address === '[::1]')) {
        return { pid: Number(pidStr), address }
      }
    }
  } catch {
    /* ignore */
  }
  return null
}

/**
 * Best-effort command line of a PID (Windows, via PowerShell CIM).
 * Cold WMI starts can exceed the default timeout; callers may extend it.
 */
export function processCommandLine(pid: number, timeoutMs = 10_000): string | null {
  try {
    const out = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`],
      { encoding: 'utf8', windowsHide: true, timeout: timeoutMs },
    )
    if (out.status !== 0) return null
    const line = out.stdout.trim()
    return line.length > 0 ? line : null
  } catch {
    return null
  }
}

/** Loose heuristic: is this process command line plausibly a `dsh` web process? */
export function looksLikeDsh(cmdline: string | null): boolean {
  if (!cmdline) return false
  return cmdline.includes('@deepseek-ai/dsh') || cmdline.includes('--profile web') || /dsh[\\/](lib[\\/])?bin\.(js|mjs)/.test(cmdline)
}
