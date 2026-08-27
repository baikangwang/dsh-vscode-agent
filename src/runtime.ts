// Runtime orchestration for the detached lifecycle model (根因分析 v2):
//
//   dsh = shared resident service (discover / adopt / attach / record — never
//   kill, except last-window managed stop and the explicit updateRuntime
//   force-relaunch), plugin = lightweight client.
//
// Startup path: reuse registry -> re-adopt a still-resident detached dsh (F1) ->
// probe configured port -> adopt external -> else managed launch (detached) ->
// resolve/probe ready (F-PORT) -> record. Liveness of the detached dsh is an
// external periodic probe (P0-C); disconnect/reconnect never kill (P0-D).
// Pure Node (no vscode dependency).
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as net from 'node:net'
import {
  acquireStartupLock, dshAlive, isAlive, looksLikeDsh, processCommandLine,
  readInstance, registerWindow, releaseStartupLock, resolvePortPid, unregisterWindow,
  writeInstance,
} from './instance'
import { DshProcess, probe as dshProbe, treeKill } from './dshProcess'
import { runtimeLogFile, LOOPBACK_HOST } from './paths'

export type ManagedBy = 'extension' | 'external' | 'managed-own'

// ---- configurable-but-not-scattered constants (去硬编码) --------------------
const DEFAULT_PROBE_INTERVAL_SEC = 30
const LIVENESS_FAIL_THRESHOLD = 3
const MAX_RESTARTS = 6
const BACKOFFS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000]

/** Append a decision-trace line to logs/runtime.log (diagnostics only; never throws). */
function rlog(msg: string): void {
  try {
    const file = runtimeLogFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `[${new Date().toISOString()}] [win ${process.pid}] ${msg}\n`, 'utf8')
  } catch {
    /* diagnostics must never break the runtime */
  }
}

/**
 * Can `port` be bound on the loopback host? Determines "is the port occupied by
 * any process (HTTP or not)" using the same real TCP bind the dsh server uses
 * (ADR-1), eliminating the old HTTP-only false-negative that caused EADDRINUSE
 * crash loops. Bind address references LOOPBACK_HOST (F3, single source).
 */
export function portBindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => srv.close(() => resolve(false)))
    srv.listen({ host: LOOPBACK_HOST, port }, () => srv.close(() => resolve(true)))
  })
}

export type RuntimeState =
  | 'idle'
  | 'starting'
  | 'ready'        // connected to a dsh web instance (managed-own, extension or external)
  | 'error'
  | 'stopped'

export interface RuntimeOptions {
  app: string
  windowPid: number
  port: number
  channel: string
  command: string
  dshHome: string
  /** Liveness probe cadence in seconds (P0-C); <=0 disables probing. */
  probeIntervalSec?: number
}

export class DshRuntime extends EventEmitter {
  readonly options: RuntimeOptions
  state: RuntimeState = 'idle'
  url: string | null = null
  port: number | null = null
  managedBy: ManagedBy | null = null
  errorMessage: string | null = null
  /** PID of the dsh we are connected to (adopted or managed-launch wrapper). */
  private dshPid: number | null = null
  private attached = false
  private stopRequested = false
  private launchAttempts = 0
  private probeTimer: ReturnType<typeof setInterval> | null = null
  private probeFailures = 0

  constructor(options: RuntimeOptions) {
    super()
    this.options = {
      probeIntervalSec: DEFAULT_PROBE_INTERVAL_SEC,
      ...options,
    }
  }

  private setState(s: RuntimeState): void {
    if (this.state === s) return
    const prev = this.state
    this.state = s
    rlog(`state: ${prev} -> ${s}${this.errorMessage ? ` (error: ${this.errorMessage})` : ''}`)
    this.emit('state', s)
  }

  // ------------------------------------------------------------ lifecycle

  /** Called once per extension activation: re-adopt / adopt / managed-launch. */
  async start(): Promise<void> {
    if (this.attached || this.state === 'ready') return
    this.attached = true
    this.stopRequested = false
    this.dshPid = null
    this.setState('starting')
    rlog(`start: window ${this.options.windowPid} (port=${this.options.port} channel=${this.options.channel} command=${this.options.command || '<npx>'})`)

    // 1. Registry: a live managed-own/extension/external dsh we already know?
    const inst = readInstance()
    const registryAlive = dshAlive(inst)
    const registryProbed = registryAlive && inst.dsh ? await this.probe(inst.dsh.port) : false
    rlog(`step1 registry: dsh=${JSON.stringify(inst.dsh)} alive=${registryAlive} probe=${registryProbed}`)
    if (registryAlive && registryProbed && inst.dsh) {
      // Re-adopt the still-resident detached dsh (F1 / P0-H): no spawn.
      this.adopt(inst.dsh.port, inst.dsh.pid, inst.dsh.managedBy)
      this.writeRegistry()
      this.startProbe()
      return
    }
    if (inst.dsh && inst.dsh.pid !== null && isAlive(inst.dsh.pid) && !registryProbed) {
      rlog(`step1: 疑似上轮残留 detached dsh pid=${inst.dsh.pid} port=${inst.dsh.port}（probe 失败但 pid 存活）；按注册表引导排查`)
    }

    // 2. Probe the configured port for an external instance.
    const probePort = this.options.port > 0 ? this.options.port : 0
    const probeOk = probePort > 0 ? await this.probe(probePort) : false
    rlog(`step2 probe(port=${probePort})=${probeOk}`)
    if (probeOk) {
      const holder = resolvePortPid(probePort)
      rlog(`step2 resolvePortPid(${probePort})=${JSON.stringify(holder)}`)
      let pid: number | null = null
      if (holder) {
        const cmdline = processCommandLine(holder.pid, 15_000)
        rlog(`step2 processCommandLine(${holder.pid})=${cmdline ? cmdline.slice(0, 300) : 'null (CIM failed/empty)'}`)
        if (cmdline !== null) {
          const like = looksLikeDsh(cmdline)
          rlog(`step2 looksLikeDsh=${like}`)
          pid = like ? holder.pid : null
        } else {
          // CIM unavailable: the page probe already verified the __DSH_BOOT__
          // signature; record the holder PID. Last-window kill still re-verifies.
          pid = holder.pid
          rlog('step2 CIM unavailable; recording holder pid on page-signature basis')
        }
      }
      this.adopt(probePort, pid, 'external')
      this.writeRegistry()
      this.startProbe()
      return
    }

    // 3. First-window path: atomic lock arbitration, then managed launch.
    const lock = acquireStartupLock(this.options.app)
    rlog(`step3 startup lock acquired=${lock !== null}`)
    if (lock) {
      await this.launchManaged()
      releaseStartupLock()
      return
    }

    // 4. Another window is starting dsh: wait for it, then adopt.
    rlog('step4 another window is starting dsh; waiting…')
    const adopted = await this.waitForExternalStartup(probePort > 0 ? probePort : 0)
    if (adopted) return
    this.attached = false
    this.setState('error')
    this.errorMessage = 'another VSCode window is starting dsh but it never became ready'
    this.emit('error', this.errorMessage)
  }

  /**
   * Managed launch (detached) with port-degradation + bounded backoff (ADR-6 /
   * P0-B / P0-C). Only called when no dsh is discoverable, so it is the
   * "last resort" launcher (§6.4.3). On success records managedBy='managed-own'
   * and arms the external liveness probe.
   */
  private async launchManaged(preferredPort?: number): Promise<void> {
    let usePort = (preferredPort ?? this.options.port) > 0 ? (preferredPort ?? this.options.port) : 0
    if (usePort > 0 && !(await portBindable(usePort))) {
      rlog(`launchManaged: port ${usePort} not bindable; falling back to random (ADR-1)`)
      usePort = 0
    }
    rlog(`launchManaged: detached launch (port=${usePort}, attempts=${this.launchAttempts})`)
    while (this.launchAttempts < MAX_RESTARTS) {
      const proc = new DshProcess({
        port: usePort,
        channel: this.options.channel,
        command: this.options.command,
        dshHome: this.options.dshHome,
      })
      try {
        const info = await proc.start()
        this.dshPid = info.pid
        this.port = info.port
        this.url = info.url
        this.managedBy = 'managed-own'
        this.launchAttempts = 0
        this.writeRegistry()
        this.setState('ready')
        this.startProbe()
        rlog(`launchManaged: ready at ${info.url} (pid ${info.pid}, log ${info.logFile})`)
        return
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.launchAttempts += 1
        rlog(`launchManaged: attempt #${this.launchAttempts} failed: ${msg}`)
        if (this.launchAttempts >= MAX_RESTARTS) {
          this.errorMessage = `dsh failed to start after ${MAX_RESTARTS} attempts (detached); last: ${msg}`
          this.setState('error')
          this.emit('error', this.errorMessage)
          return
        }
        if (usePort !== 0) {
          usePort = 0
          rlog('launchManaged: degrading to random port on retry (avoid same-port loop)')
        }
        if (this.stopRequested) {
          this.setState('stopped')
          return
        }
        const delay = BACKOFFS_MS[this.launchAttempts - 1] ?? BACKOFFS_MS[BACKOFFS_MS.length - 1]
        rlog(`launchManaged: backing off ${delay}ms before retry #${this.launchAttempts + 1}`)
        await sleep(delay)
      }
    }
  }

  private adopt(port: number, pid: number | null, managedBy: ManagedBy): void {
    this.port = port
    this.url = `http://${LOOPBACK_HOST}:${port}`
    this.managedBy = managedBy
    this.dshPid = pid
    this.setState('ready')
    rlog(`adopt: ${managedBy} dsh at ${this.url} (pid ${pid ?? 'null'})`)
  }

  private writeRegistry(): void {
    const inst = readInstance()
    inst.dsh = {
      pid: this.dshPid ?? null,
      port: this.port ?? this.options.port,
      managedBy: this.managedBy ?? 'managed-own',
      startedAt: new Date().toISOString(),
    }
    rlog(`writeRegistry: dsh=${JSON.stringify(inst.dsh)} +window ${this.options.windowPid}`)
    writeInstance(registerWindow(inst, this.options.app, this.options.windowPid))
  }

  private async waitForExternalStartup(probePort: number): Promise<boolean> {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const inst = readInstance()
      const port = inst.dsh?.port ?? probePort
      if (inst.dsh && port > 0 && await this.probe(port)) {
        this.adopt(port, inst.dsh.pid, inst.dsh.managedBy)
        this.writeRegistry()
        this.startProbe()
        return true
      }
      await sleep(500)
    }
    return false
  }

  // ------------------------------------------------------------ probes

  /** GET / on the port returns the DSH bootstrap page (single probe source). */
  async probe(port: number): Promise<boolean> {
    return dshProbe(port)
  }

  // ------------------------------------------------------------ liveness (P0-C)

  private probeIntervalMs(): number {
    const sec = this.options.probeIntervalSec ?? 0
    return sec > 0 ? sec * 1000 : 0
  }

  private startProbe(): void {
    this.stopProbe()
    if (this.probeIntervalMs() <= 0 || this.state !== 'ready') return
    this.probeFailures = 0
    rlog(`probe: armed every ${this.probeIntervalMs()}ms on port ${this.port} (threshold ${LIVENESS_FAIL_THRESHOLD})`)
    this.probeTimer = setInterval(() => { void this.probeTick() }, this.probeIntervalMs())
  }

  private stopProbe(): void {
    if (this.probeTimer !== null) {
      clearInterval(this.probeTimer)
      this.probeTimer = null
    }
  }

  private async probeTick(): Promise<void> {
    if (this.state !== 'ready' || this.port === null) return
    const alive = await this.probe(this.port)
    if (alive) {
      this.probeFailures = 0
      return
    }
    this.probeFailures += 1
    const rec = readInstance().dsh
    const pidDead = rec === null || rec.pid === null || !isAlive(rec.pid)
    if (this.probeFailures >= LIVENESS_FAIL_THRESHOLD && pidDead && this.state === 'ready') {
      rlog(`probe: dsh dead after ${this.probeFailures} consecutive failures (pid dead=${pidDead}); clearing record + bounded relaunch`)
      const inst = readInstance()
      if (inst.dsh) {
        inst.dsh = null
        writeInstance(inst)
      }
      this.dshPid = null
      this.port = null
      this.url = null
      this.setState('starting')
      void this.launchManaged()
    }
  }

  // ------------------------------------------------------------ client semantics (P0-D)

  /**
   * Disconnect this window/extensions from dsh WITHOUT killing it (P0-D, ADR-2).
   * Only unregisters our window connection and sets state 'stopped'; the dsh
   * record is kept for reuse by other windows/tools. Never tree-kills.
   */
  disconnect(): void {
    rlog(`disconnect: window ${this.options.windowPid} detaching; dsh NOT killed`)
    this.stopRequested = true
    this.attached = false
    this.stopProbe()
    const inst = readInstance()
    writeInstance(unregisterWindow(inst, this.options.windowPid))
    this.setState('stopped')
  }

  /** Backward-compatible alias for disconnect() (previous stopManaged). */
  stopManaged(): void {
    this.disconnect()
  }

  /**
   * Reconnect (restart): re-run the discover/adopt/launch path WITHOUT killing dsh
   * (P0-D / ADR-2). If the external dsh is gone it is re-launched as managed.
   */
  async reconnect(): Promise<void> {
    rlog('reconnect: requested (never kills dsh)')
    this.attached = false
    this.stopRequested = false
    this.stopProbe()
    await this.start()
  }

  /** Backward-compatible alias for reconnect() (previous restart). */
  async restart(): Promise<void> {
    await this.reconnect()
  }

  /**
   * Explicit force-relaunch for managed-own dsh (F-UPDATE / ADR-10). This is an
   * INDEPENDENT code path — it deliberately does NOT reuse stopManaged()/
   * disconnect(). It controlled-kills the managed-own dsh and re-launches it
   * managed (npx resolves latest). For non-managed dsh it does nothing (caller
   * decides the manual-update prompt).
   */
  async forceRelaunchManaged(): Promise<'relaunched' | 'no-managed'> {
    const inst = readInstance()
    const rec = inst.dsh
    if (!rec || rec.managedBy !== 'managed-own' || rec.pid === null) {
      rlog('forceRelaunchManaged: no managed-own dsh to relaunch (external/manual case); not killing')
      return 'no-managed'
    }
    rlog(`forceRelaunchManaged: explicit relaunch of managed-own dsh pid ${rec.pid}`)
    this.stopProbe()
    this.attached = false
    this.stopRequested = false
    this.launchAttempts = 0
    treeKill(rec.pid)
    const cleared = readInstance()
    if (cleared.dsh?.pid === rec.pid) {
      cleared.dsh = null
      writeInstance(cleared)
    }
    this.port = null
    this.url = null
    this.dshPid = null
    this.managedBy = null
    this.setState('starting')
    await this.launchManaged()
    return 'relaunched'
  }

  // ------------------------------------------------------------ shutdown bookkeeping

  /**
   * Synchronous last-window stop arbitration (P0-F). Unregisters this window.
   * When it is the last one:
   *  - managed-own / extension: triple safe-gate (pid alive + port holder match,
   *    plus the runtime's separate __DSH_BOOT__ liveness) -> tree-kill + clear.
   *  - external: never kill; PRESERVE the known-external record (only cleared
   *    when stale — pid no longer alive), so the next window can re-adopt (F2).
   * PID source is the registry record only (pure `next.dsh.pid`).
   * @returns whether a managed dsh was stopped.
   */
  shutdownBookkeeping(): boolean {
    rlog(`shutdownBookkeeping: window ${this.options.windowPid}`)
    const inst = readInstance()
    const next = unregisterWindow(inst, this.options.windowPid)
    writeInstance(next)
    rlog(`shutdown: after unregister windows=${next.windows.length} dsh=${JSON.stringify(next.dsh)}`)
    if (next.windows.length > 0) {
      rlog('shutdown: not the last window; keeping dsh')
      return false
    }
    const rec = next.dsh
    if (!rec || rec.pid === null) {
      rlog('shutdown: dsh record missing or pid null; NOT killing (safe side)')
      return false
    }
    if (rec.managedBy === 'external') {
      if (!isAlive(rec.pid)) {
        rlog(`shutdown: external pid ${rec.pid} stale (dead); clearing known-external record (F2)`)
        const c = readInstance()
        if (c.dsh?.pid === rec.pid) {
          c.dsh = null
          writeInstance(c)
        }
      } else {
        rlog(`shutdown: external dsh pid ${rec.pid} preserved for re-adopt (known-external, F2)`)
      }
      return false
    }
    // managed-own / extension: last window + safe gate -> stop.
    if (!isAlive(rec.pid)) {
      rlog(`shutdown: dsh pid ${rec.pid} not alive; skip kill`)
      return false
    }
    const holder = resolvePortPid(rec.port)
    rlog(`shutdown: verify holder=${JSON.stringify(holder)} expected pid=${rec.pid}`)
    if (!holder || holder.pid !== rec.pid) {
      rlog('shutdown: pid/port mismatch; NOT killing (safe side)')
      return false // PID reused or no longer serving
    }
    rlog(`shutdown: last window closed; stopping managed dsh pid ${rec.pid}`)
    treeKill(rec.pid)
    const cleared = readInstance()
    if (cleared.dsh?.pid === rec.pid) {
      cleared.dsh = null
      writeInstance(cleared)
      rlog('shutdown: dsh record cleared')
    }
    return true
  }

  dispose(): void {
    this.stopProbe()
    this.removeAllListeners()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
