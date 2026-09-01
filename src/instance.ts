// Application-level lifecycle arbitration: the instance registry (who owns the
// dsh runtime and which VSCode windows are attached), the atomic startup lock
// (first-window arbitration), process liveness and port/PID helpers.
// Pure Node (no vscode dependency) so it can be exercised headlessly.
import * as fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { appendDecisionLog, ensureDataDir, instanceFile, startupLockFile, LOOPBACK_HOST } from './paths'

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
  /**
   * ADR-21 (#22, 0.1.9): HOW this dsh was launched — the discriminator
   * carrier for the user-stop ruling (§4.6.5: a closed resident console
   * window is indistinguishable from a crash; launchMode='start' + probe
   * death ×3 = USER STOP, no auto-relaunch). OPTIONAL for backward
   * compatibility: records written before 0.1.9, external records and
   * §4.3.1 migration adopts omit the field (= direct semantics = the
   * pre-0.1.9 behavior; JSON readers ignore unknown fields). Written by
   * runtime.writeRegistry: managed launches record the ACTUAL attempt mode;
   * re-adopt keeps the recorded value (§4.6.4).
   */
  launchMode?: 'start' | 'direct'
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
 * Identity verdict for a (live) window pid, ADR-18 (P-IDENT, design §4.4.2).
 * The 'foreign' verdict is POSITIVE-EVIDENCE ONLY (three conditions conjoint);
 * signatures are no longer a clearing gate — they only carry the 'exthost'
 * positive-verdict tier (keep / flip baseline / diagnostics):
 * - 'exthost'  : CommandLine (case-insensitive) hits any EXTHOST_SIGNATURES
 *                entry -> KEEP (flip baseline + diagnostics, never a gate).
 * - 'foreign'  : POSITIVE EVIDENCE the pid is no VSCode process at all —
 *                ExecutablePath non-empty AND basename(ExecutablePath) is
 *                OUTSIDE VSCODE_EXE_FAMILY (case-insensitive) AND CommandLine
 *                carries no EXTHOST_SIGNATURES entry -> and only then CLEAR.
 * - 'unknown'  : everything else — query failed / timed out / empty output /
 *                JSON failure / empty CommandLine / empty ExecutablePath /
 *                family exe with signature miss (the H2a landing) / the flip
 *                guard fired -> KEEP (safe-side 宁留勿误清; same direction as
 *                the shutdown triple-gate; never clear on unknown).
 */
export type IdentityVerdict = 'exthost' | 'foreign' | 'unknown'

/**
 * Extension-host command-line signatures (ADR-18; INITIAL draft until the
 * R-P2 real-machine marker corpus finalizes them — data-driven, change the
 * data not the logic). Case-insensitive `includes` matching. Under G2 these
 * signatures carry ONLY the 'exthost' positive-verdict tier (keep / flip
 * baseline / diagnostics); they are NOT a clearing gate.
 */
export const EXTHOST_SIGNATURES: readonly string[] = [
  '--type=extensionHost',
  'utility-sub-type=extensionHost',
  'extensionHostProcess',
]

/**
 * VSCode executable family basenames (ADR-18; version-stable surface — exe
 * file names change far less across versions than command-line argument
 * shapes). Case-insensitive basename comparison; G2's foreign verdict
 * requires the queried ExecutablePath basename to be OUTSIDE this family.
 */
export const VSCODE_EXE_FAMILY: readonly string[] = [
  'code.exe',
  'code - insiders.exe',
  'vscodium.exe',
  'code-oss.exe',
]

/**
 * G4 grace period (§4.4.5): entries FIRST-attached within this window are
 * exempt from identity clearing (liveness is unaffected — dead entries are
 * still scrubbed). Structurally rules out the observed "freshly registered
 * entry identity-cleared 1.55s later" defect class.
 */
export const IDENTITY_GRACE_MS = 60_000

/**
 * G3 hardened identity query (§4.4.4): a compile-time script CONSTANT — the
 * pid NEVER enters this text (zero interpolation, zero double quotes, so the
 * Node argv quote round-trip cannot corrupt it). The pid is carried via the
 * DSH_IDENTITY_PID environment variable and the WQL filter uses the bare
 * (unquoted, spaceless) token `ProcessId=$env:DSH_IDENTITY_PID`, which
 * PowerShell expands into `ProcessId=<pid>`.
 */
export const IDENTITY_QUERY_SCRIPT =
  '$p = Get-CimInstance Win32_Process -Filter ProcessId=$env:DSH_IDENTITY_PID ' +
  '| Select-Object -First 1 -Property Name, ExecutablePath, CommandLine; if ($p) { $p | ConvertTo-Json -Compress }'

/** One CIM identity query per pid per TTL (WMI cold start 0.5-3s; ADR-15 cache). */
export const IDENTITY_CACHE_TTL_MS = 60_000
const identityCache = new Map<number, { at: number; verdict: IdentityVerdict }>()

/**
 * Cached identity verdict (module-level Map<pid, {at, verdict}>, TTL-bounded;
 * TTL only decides FRESHNESS — entries are never deleted, an expired entry's
 * verdict still serves as the "previous verdict" for the G4 flip guard).
 * G4 flip guard (§4.4.5): when a FRESH query says 'foreign' while the
 * previous cached verdict (regardless of expiry) was 'exthost', the result is
 * downgraded to 'unknown' (keep) + the flip decision is logged via
 * appendDecisionLog; the cache entry becomes 'unknown', so a STILL-foreign
 * query after the next TTL window clears normally (one flip absorbed per
 * short window — systemic churn is held one beat, real pid reuse still
 * clears within one cache cycle).
 */
export function processIdentitySync(pid: number, timeoutMs: number): IdentityVerdict {
  const now = Date.now()
  const hit = identityCache.get(pid)
  if (hit !== undefined && now - hit.at < IDENTITY_CACHE_TTL_MS) return hit.verdict
  const fresh = queryIdentitySync(pid, timeoutMs)
  let verdict = fresh
  if (fresh === 'foreign' && hit !== undefined && hit.verdict === 'exthost') {
    verdict = 'unknown'
    appendDecisionLog(`identity flip exthost→foreign for pid ${pid}; downgraded to unknown`)
  }
  identityCache.set(pid, { at: now, verdict })
  return verdict
}

/**
 * One CIM query fetching Name + ExecutablePath + CommandLine in a single
 * call (bounded powershell spawnSync; G3: script = IDENTITY_QUERY_SCRIPT
 * constant, pid only via the DSH_IDENTITY_PID env var — zero quotes, zero
 * interpolation, nothing to corrupt on the argv round-trip).
 * `spawnFn` is the injection seam (default the real `spawnSync`); headless
 * tests capture the call args and/or preset stdout (PI-3 / PI-4).
 */
export function queryIdentitySync(
  pid: number,
  timeoutMs: number,
  spawnFn: typeof spawnSync = spawnSync,
): IdentityVerdict {
  try {
    const out = spawnFn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', IDENTITY_QUERY_SCRIPT],
      { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, env: { ...process.env, DSH_IDENTITY_PID: String(pid) } },
    )
    if (out.status !== 0) return 'unknown'
    const text = out.stdout.trim()
    if (text.length === 0) return 'unknown' // no match / no output -> safe-side
    let parsed: unknown = null
    try {
      parsed = JSON.parse(text)
    } catch {
      return 'unknown'
    }
    // ConvertTo-Json of a single record is an object; be defensive and accept
    // a one-element array as well (take the first).
    const rec = (Array.isArray(parsed) ? parsed[0] : parsed) as { Name?: unknown; ExecutablePath?: unknown; CommandLine?: unknown } | undefined
    if (!rec || typeof rec !== 'object') return 'unknown'
    const cl = typeof rec.CommandLine === 'string' ? rec.CommandLine : ''
    // §4.4.2 unknown tier: empty CommandLine -> unknown (explicitly listed).
    if (cl.length === 0) return 'unknown'
    // 'exthost' positive verdict: signature hit (case-insensitive) -> keep.
    const clLower = cl.toLowerCase()
    if (EXTHOST_SIGNATURES.some((sig) => clLower.includes(sig.toLowerCase()))) return 'exthost'
    // 'foreign' positive evidence: ExecutablePath present AND its basename is
    // OUTSIDE the VSCode exe family (CommandLine carries no signature here —
    // a hit would have returned 'exthost' above). Only this tier clears.
    const exePath = typeof rec.ExecutablePath === 'string' ? rec.ExecutablePath : ''
    if (exePath.length > 0) {
      const parts = exePath.split(/[\\/]/)
      const base = (parts[parts.length - 1] ?? '').toLowerCase()
      if (!VSCODE_EXE_FAMILY.includes(base)) return 'foreign'
    }
    // Everything else (family exe + signature miss = H2a landing, empty
    // ExecutablePath) -> unknown: keep, safe-side.
    return 'unknown'
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
 * Full stale-window scrub (ADR-15 + ADR-18): liveness first, then a bounded
 * identity check for the SURVIVING pids (pid-reuse guard). Only the G2
 * positive-evidence 'foreign' verdict removes an entry; 'exthost' and
 * 'unknown' are always kept (safe-side). Callers pass `timeoutMs` per identity
 * query (T1b async: 10s; T2 exit path: 2s) and may inject `identityCheck` for
 * headless tests (PW-3).
 *
 * ADR-18 guards (design §4.4.3/§4.4.5), via `opts`:
 * - `selfPid` (G1 self-guard): entries whose pid equals it are never scrub
 *   candidates at all — the process is running, which proves it alive, and an
 *   identity check on ourselves is meaningless and dangerous (this is the
 *   single guard point covering both the liveness pass and the identity pass;
 *   the guarded rewrite in runtime.ts filters by removedPids, which can never
 *   contain selfPid as a consequence).
 * - `nowMs` (grace-period seam, PI-5): entries FIRST-attached within
 *   IDENTITY_GRACE_MS of it are exempt from identity clearing (liveness above
 *   is unaffected — dead entries are still scrubbed). Defaults to Date.now().
 */
export function scrubWindowsWithIdentitySync(
  inst: InstanceState,
  timeoutMs: number,
  identityCheck?: (pid: number) => IdentityVerdict,
  opts?: { selfPid?: number; nowMs?: number },
): ScrubResult {
  const selfPid = opts?.selfPid
  const nowMs = opts?.nowMs ?? Date.now()
  const isSelf = (pid: number): boolean => selfPid !== undefined && pid === selfPid
  // Liveness pass (G1: self is never a candidate — running proves alive).
  const dead: number[] = []
  let kept = inst.windows.filter((w) => {
    if (isSelf(w.pid)) return true
    if (isAlive(w.pid)) return true
    dead.push(w.pid)
    return false
  })
  const check = identityCheck ?? ((pid: number) => processIdentitySync(pid, timeoutMs))
  const foreign: number[] = []
  kept = kept.filter((w) => {
    if (isSelf(w.pid)) return true // G1: identity checks never apply to self
    // G4 grace period: a freshly-first-attached entry is exempt from identity
    // clearing (the observed 1.55s self-clear becomes structurally impossible;
    // dead entries above were already removed by liveness regardless of age).
    const startedMs = Date.parse(w.startedAt)
    if (Number.isFinite(startedMs) && nowMs - startedMs < IDENTITY_GRACE_MS) return true
    const verdict = check(w.pid)
    if (verdict === 'foreign') {
      foreign.push(w.pid)
      return false
    }
    return true // 'exthost' keep (flip baseline); 'unknown' keep (safe-side, never clear)
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
