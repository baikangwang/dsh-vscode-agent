// Managed-launch of a detached dsh web process (detached 基线, P0-B / P0-C).
//
// The plugin spawns a detached, unref'd process with stdio redirected into a
// logs/dsh-<ts>.log file, then resolves the real port from that same file
// (random-port path) or probes the fixed port directly (fixed-port path), all
// within a total startup budget (F-PORT, ADR-9). It no longer owns the child:
// no `exit` listener, no kept handle — liveness is the runtime's external
// probe concern (P0-C). Pure Node (no vscode dependency).
import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { managedDshLogFile, LOOPBACK_HOST } from './paths'

export interface SpawnOptions {
  /** Port to request (0 = OS assigned; random-port path). */
  port: number
  /** npm spec: 'latest' | 'preview' | exact version. */
  channel: string
  /** Custom launch command (e.g. 'dsh web --port 3080'); empty = npx path. */
  command: string
  /** DSH_HOME override (empty = inherit / default). */
  dshHome: string
}

export interface SpawnedInfo {
  pid: number
  port: number
  url: string
  /** The logs/dsh-<ts>.log file the detached dsh wrote to (F-PORT data source). */
  logFile: string
}

/** Single-port banner regex. Pre-existing (F4): the inner 127.0.0.1 literal is
 *  exempted from the LOOPBACK_HOST de-literalization and left unchanged. */
const URL_RE = /dsh web:\s+(http:\/\/127\.0\.0\.1:(\d+))/i

/** Total budget for one managed launch to reach `__DSH_BOOT__` ready (§6.5). */
export const STARTUP_TIMEOUT_MS = 90_000
/** Poll cadence while tailing the log / probing readiness. */
export const PROBE_POLL_MS = 500
/** Single HTTP probe deadline. */
const HTTP_TIMEOUT_MS = 3_000

/** Thrown by DshProcess.start() when a launch fails to become ready in time. */
export class LaunchFailure extends Error {
  readonly logFile: string
  constructor(message: string, logFile: string) {
    super(message)
    this.name = 'LaunchFailure'
    this.logFile = logFile
  }
}

/**
 * Pure port resolver (F-PORT, ADR-9): read a managed-launch log file and return
 * the dsh port parsed from its `dsh web: http://127.0.0.1:<port>` banner, or
 * null when the banner has not appeared yet. Data source = file, not stdout
 * (detached + stdio redirect makes the old stdout stream unavailable).
 */
export function resolvePortFromLog(logFile: string): number | null {
  try {
    const text = fs.readFileSync(logFile, 'utf8')
    const m = text.match(URL_RE)
    return m ? Number(m[2]) : null
  } catch {
    return null
  }
}

export class DshProcess extends EventEmitter {
  readonly options: SpawnOptions

  constructor(options: SpawnOptions) {
    super()
    this.options = options
  }

  get wantedPort(): number {
    return this.options.port
  }

  /** True when the configured (fixed) port should be probed directly without
   *  log parsing (F-PORT fixed-port path). Random (`--port 0`) uses log tailing. */
  private get fixedPortPath(): boolean {
    return this.options.port > 0 && this.options.command.trim().length === 0
  }

  /**
   * Launch a detached dsh (single attempt) and wait (within STARTUP_TIMEOUT_MS)
   * for it to become `__DSH_BOOT__`-ready. Resolves with the resolved
   * port/url/pid/logFile; rejects with LaunchFailure(logFile) on timeout.
   */
  async start(): Promise<SpawnedInfo> {
    const logFile = managedDshLogFile()
    const args = this.buildArgs()
    // Redirect both stdout and stderr into the managed log file (P0-B). Open
    // an append fd, hand it to the child, then release it on our side so the
    // detached process owns the file independently.
    let fd: number
    try {
      fd = fs.openSync(logFile, 'a')
    } catch (err) {
      throw new LaunchFailure(`cannot open managed log ${logFile}: ${(err as Error).message}`, logFile)
    }
    let child: ReturnType<typeof spawn> | null = null
    try {
      child = spawn(args.exec, args.argv, {
        detached: true,
        windowsHide: true,
        stdio: ['ignore', fd, fd] as const,
        env: this.buildEnv(),
      })
    } finally {
      fs.closeSync(fd) // child inherited a copy; parent may close its own
    }
    if (!child.pid) {
      throw new LaunchFailure('spawn returned no pid', logFile)
    }
    const pid = child.pid ?? 0
    // Detached independence: the extension host neither waits on nor holds the
    // child after launch. Backoff/restart and liveness are handled by the
    // runtime (P0-C), not by an `exit` listener here.
    child.unref()

    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    if (this.fixedPortPath) {
      // Fixed-port path: probe the configured port directly (no log parsing).
      const ok = await waitReadyProbe(this.options.port, deadline)
      if (!ok) {
        throw new LaunchFailure(`dsh did not become ready on fixed port ${this.options.port} within ${STARTUP_TIMEOUT_MS}ms; log: ${logFile}`, logFile)
      }
      return { pid, port: this.options.port, url: `http://${LOOPBACK_HOST}:${this.options.port}`, logFile }
    }

    // Random-port path: tail the managed log for the banner, then probe confirm.
    while (Date.now() < deadline) {
      const port = resolvePortFromLog(logFile)
      if (port !== null && port > 0) {
        if (await probe(port)) {
          return { pid, port, url: `http://${LOOPBACK_HOST}:${port}`, logFile }
        }
      }
      await sleep(PROBE_POLL_MS)
    }
    throw new LaunchFailure(`dsh did not expose a ready port within ${STARTUP_TIMEOUT_MS}ms; log: ${logFile}`, logFile)
  }

  private buildArgs(): { exec: string; argv: string[]; display: string } {
    const { command, channel } = this.options
    if (command.trim().length > 0) {
      // Custom command: run through cmd.exe for shell semantics.
      return { exec: 'cmd.exe', argv: ['/d', '/s', '/c', command], display: command }
    }
    const spec = channel
    const npxArgs = [
      'npx',
      '--yes',
      '--prefer-offline',
      `@deepseek-ai/dsh@${spec}`,
      'web',
      '--host', LOOPBACK_HOST, // single source (F3)
      '--port', String(this.options.port),
      '--no-open',
    ]
    return { exec: 'cmd.exe', argv: ['/d', '/s', '/c', npxArgs.join(' ')], display: npxArgs.join(' ') }
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    if (this.options.dshHome.trim().length > 0) env.DSH_HOME = this.options.dshHome.trim()
    return env
  }
}

/** Single `__DSH_BOOT__` probe on a port (the one adoption/readiness gate). */
export async function probe(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${LOOPBACK_HOST}:${port}/`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
    if (!res.ok) return false
    const text = await res.text()
    return text.includes('__DSH_BOOT__')
  } catch {
    return false
  }
}

/** Poll `probe(port)` until true or the absolute deadline passes. */
export async function waitReadyProbe(port: number, deadlineMs: number): Promise<boolean> {
  while (Date.now() < deadlineMs) {
    if (await probe(port)) return true
    await sleep(PROBE_POLL_MS)
  }
  return false
}

/** Generic HTTP readiness poll for a URL (legacy external/`markReadyWhenServing`). */
export async function waitReady(url: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
      if (res.ok) return true
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Kill a process tree on Windows (taskkill /T /F). Used only for the
 *  last-window managed stop and the explicit updateRuntime force-relaunch. */
export function treeKill(pid: number): void {
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  } catch {
    /* ignore */
  }
}
