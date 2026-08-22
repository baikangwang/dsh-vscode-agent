// Application-level lifecycle arbitration: the instance registry (who owns the
// dsh runtime and which VSCode windows are attached), the atomic startup lock
// (first-window arbitration), process liveness and port/PID helpers.
// Pure Node (no vscode dependency) so it can be exercised headlessly.
import * as fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { ensureDataDir, instanceFile, startupLockFile } from './paths'

export interface DshRecord {
  /** PID of the dsh web process (null when an external instance's PID could not be resolved). */
  pid: number | null
  /** Port the dsh web server listens on. */
  port: number
  /** 'extension' = spawned/managed by this extension (stopped on last window); 'external' = adopted (also stopped on last window when PID known). */
  managedBy: 'extension' | 'external'
  startedAt: string
}

export interface WindowRecord {
  /** VSCode app name (e.g. 'Visual Studio Code' / 'Visual Studio Code - Insiders'). */
  app: string
  /** Extension host process PID (unique per window). */
  pid: number
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
  const rec: WindowRecord = { app, pid, startedAt: new Date().toISOString() }
  if (idx >= 0) next.windows[idx] = rec
  else next.windows.push(rec)
  return next
}

export function unregisterWindow(inst: InstanceState, pid: number): InstanceState {
  return { ...inst, windows: inst.windows.filter((w) => w.pid !== pid) }
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
      if (Number(portStr) === port && (address === '127.0.0.1' || address === '0.0.0.0' || address === '[::1]')) {
        return { pid: Number(pidStr), address }
      }
    }
  } catch {
    /* ignore */
  }
  return null
}

/** Best-effort command line of a PID (Windows, via PowerShell CIM). */
export function processCommandLine(pid: number): string | null {
  try {
    const out = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`],
      { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
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
