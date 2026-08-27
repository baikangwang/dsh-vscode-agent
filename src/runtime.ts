// Runtime orchestration: the startup path (reuse probe -> external adopt ->
// first-window managed spawn with atomic lock arbitration) and the lifecycle
// bookkeeping shared by every window. Pure Node (no vscode dependency).
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  acquireStartupLock, dshAlive, emptyInstance, isAlive, looksLikeDsh, processCommandLine,
  readInstance, registerWindow, releaseStartupLock, resolvePortPid, unregisterWindow,
  writeInstance, InstanceState,
} from './instance'
import { DshProcess, treeKill } from './dshProcess'
import { runtimeLogFile } from './paths'

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

export type RuntimeState =
  | 'idle'
  | 'starting'
  | 'ready'        // connected to a dsh web instance (managed or external)
  | 'error'
  | 'stopped'

export interface RuntimeOptions {
  app: string
  windowPid: number
  port: number
  channel: string
  command: string
  dshHome: string
}

export class DshRuntime extends EventEmitter {
  readonly options: RuntimeOptions
  state: RuntimeState = 'idle'
  url: string | null = null
  port: number | null = null
  managedBy: 'extension' | 'external' | null = null
  errorMessage: string | null = null
  private process: DshProcess | null = null
  /** PID captured when adopting an existing (external or pre-registered) instance. */
  private adoptedPid: number | null = null
  private attached = false
  private stopRequested = false

  constructor(options: RuntimeOptions) {
    super()
    this.options = options
  }

  private setState(s: RuntimeState): void {
    if (this.state === s) return
    const prev = this.state
    this.state = s
    rlog(`state: ${prev} -> ${s}${this.errorMessage ? ` (error: ${this.errorMessage})` : ''}`)
    this.emit('state', s)
  }

  // ------------------------------------------------------------ lifecycle

  /** Called once per extension activation: adopt existing dsh or start one. */
  async start(): Promise<void> {
    if (this.attached || this.state === 'ready') return
    this.attached = true
    this.stopRequested = false
    this.adoptedPid = null
    this.setState('starting')
    rlog(`start: window ${this.options.windowPid} (port=${this.options.port} channel=${this.options.channel} command=${this.options.command || '<npx>'})`)

    // 1. Registry: a live managed/external dsh we already know about?
    const inst = readInstance()
    const registryAlive = dshAlive(inst)
    const registryProbed = registryAlive && inst.dsh ? await this.probe(inst.dsh.port) : false
    rlog(`step1 registry: dsh=${JSON.stringify(inst.dsh)} alive=${registryAlive} probe=${registryProbed}`)
    if (registryAlive && registryProbed && inst.dsh) {
      this.adopt(inst.dsh.port, inst.dsh.pid, inst.dsh.managedBy)
      this.writeRegistry()
      return
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
        // Cold WMI starts can be slow; give it a generous budget.
        const cmdline = processCommandLine(holder.pid, 15_000)
        rlog(`step2 processCommandLine(${holder.pid})=${cmdline ? cmdline.slice(0, 300) : 'null (CIM failed/empty)'}`)
        if (cmdline !== null) {
          const like = looksLikeDsh(cmdline)
          rlog(`step2 looksLikeDsh=${like}`)
          pid = like ? holder.pid : null
        } else {
          // CIM unavailable in this host: the page probe already verified the
          // __DSH_BOOT__ signature on this port, so record the holder PID.
          // The last-window kill gate still re-verifies pid + port + page
          // before killing, so this does not weaken mis-kill protection.
          pid = holder.pid
          rlog('step2 CIM unavailable; recording holder pid on page-signature basis')
        }
      }
      this.adopt(probePort, pid, 'external')
      this.writeRegistry()
      return
    }

    // 3. First-window path: atomic lock arbitration, then spawn.
    const lock = acquireStartupLock(this.options.app)
    rlog(`step3 startup lock acquired=${lock !== null}`)
    if (lock) {
      await this.spawnManaged()
      releaseStartupLock()
      return
    }

    // 4. Another window is starting dsh: wait for it, then adopt.
    rlog('step4 another window is starting dsh; waiting…')
    const adopted = await this.waitForExternalStartup(probePort > 0 ? probePort : 0)
    if (adopted) return
    this.setState('error')
    this.errorMessage = 'another VSCode window is starting dsh but it never became ready'
    this.emit('error', this.errorMessage)
  }

  private async spawnManaged(): Promise<void> {
    const { port, channel, command, dshHome } = this.options
    // Pre-flight: if the configured port is occupied by a non-DSH process, fall back to 0.
    let usePort = port > 0 ? port : 0
    if (usePort > 0 && await this.portBusyByNonDsh(usePort)) {
      rlog(`spawnManaged: port ${usePort} busy by a non-DSH process; falling back to random port`)
      usePort = 0
    }
    rlog(`spawnManaged: starting DshProcess (port=${usePort})`)
    this.process = new DshProcess({ port: usePort, channel, command, dshHome })
    this.process.on('port', (info: { pid: number; port: number; url: string }) => {
      this.port = info.port
      this.url = info.url
      this.managedBy = 'extension'
      this.writeRegistry()
      rlog(`spawnManaged: dsh reported port ${info.url} (pid ${info.pid})`)
      void this.markReadyWhenServing(info.url)
    })
    this.process.on('crashed', ({ attempt }) => {
      rlog(`spawnManaged: dsh crashed, restart #${attempt}`)
      this.setState('starting')
    })
    this.process.on('failed', (msg: string) => {
      this.errorMessage = msg
      this.setState('error')
      rlog(`spawnManaged: failed: ${msg}`)
      this.emit('error', msg)
    })
    this.process.start()
  }

  /** Wait for the dsh HTTP endpoint to actually serve, then flip state to ready. */
  private async markReadyWhenServing(url: string): Promise<void> {
    const ok = await DshProcess.waitReady(url)
    if (!ok) {
      this.errorMessage = 'dsh started but did not become ready in time'
      this.setState('error')
      this.emit('error', this.errorMessage)
      return
    }
    this.setState('ready')
  }

  private adopt(port: number, pid: number | null, managedBy: 'extension' | 'external'): void {
    this.port = port
    this.url = `http://127.0.0.1:${port}`
    this.managedBy = managedBy
    this.adoptedPid = pid
    this.setState('ready')
    rlog(`adopt: ${managedBy} dsh at ${this.url} (pid ${pid ?? 'null'})`)
  }

  private writeRegistry(): void {
    const inst = readInstance()
    const pid = this.process?.pid ?? this.adoptedPid ?? null
    inst.dsh = {
      pid,
      port: this.port ?? this.options.port,
      managedBy: this.managedBy ?? 'extension',
      startedAt: new Date().toISOString(),
    }
    rlog(`writeRegistry: dsh=${JSON.stringify(inst.dsh)} +window ${this.options.windowPid}`)
    writeInstance(registerWindow(inst, this.options.app, this.options.windowPid))
  }

  private async waitForExternalStartup(probePort: number): Promise<boolean> {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const inst = readInstance()
      // Registry may carry the real port (managed spawn used --port 0).
      const port = inst.dsh?.port ?? probePort
      if (inst.dsh && port > 0 && await this.probe(port)) {
        this.adopt(port, inst.dsh.pid, inst.dsh.managedBy)
        this.writeRegistry()
        return true
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    return false
  }

  // ------------------------------------------------------------ probes

  /** True when GET / on the port returns the DSH bootstrap page. */
  async probe(port: number): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3_000) })
      if (!res.ok) return false
      const text = await res.text()
      return text.includes('__DSH_BOOT__')
    } catch {
      return false
    }
  }

  /** True when something else (not DSH) responds on the port. */
  private async portBusyByNonDsh(port: number): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_500) })
      return res.status !== 0 // reachable HTTP responder
    } catch {
      return false
    }
  }

  // ------------------------------------------------------------ shutdown bookkeeping

  /**
   * Synchronous exit path (process.on('exit')): unregister this window; when it
   * was the last one and we hold a dsh PID, verify the PID still serves our port
   * and tree-kill it. Returns whether dsh was stopped.
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
    if (!next.dsh || next.dsh.pid === null) {
      rlog('shutdown: dsh record missing or pid null; NOT killing (safe side)')
      return false
    }
    if (!isAlive(next.dsh.pid)) {
      rlog(`shutdown: dsh pid ${next.dsh.pid} not alive; skip kill`)
      return false
    }
    const holder = resolvePortPid(next.dsh.port)
    rlog(`shutdown: verify holder=${JSON.stringify(holder)} expected pid=${next.dsh.pid}`)
    if (!holder || holder.pid !== next.dsh.pid) {
      rlog('shutdown: pid/port mismatch; NOT killing (safe side)')
      return false // PID reused or no longer serving
    }
    rlog(`shutdown: last window closed; stopping dsh pid ${next.dsh.pid}`)
    treeKill(next.dsh.pid)
    const cleared = readInstance()
    if (cleared.dsh?.pid === next.dsh.pid) {
      cleared.dsh = null
      writeInstance(cleared)
      rlog('shutdown: dsh record cleared')
    }
    return true
  }

  /** Stop a managed dsh and clear the registry dsh record (command dsh.stop). */
  stopManaged(): void {
    rlog(`stopManaged: process=${this.process ? 'yes' : 'no'} adoptedPid=${this.adoptedPid}`)
    this.stopRequested = true
    this.process?.dispose()
    this.process = null
    this.adoptedPid = null
    const inst = readInstance()
    if (inst.dsh) {
      inst.dsh = null
      writeInstance(inst)
    }
    this.setState('stopped')
  }

  /** Restart: kill current (managed or external, when PID known) and re-run start path. */
  async restart(): Promise<void> {
    rlog('restart: requested')
    this.stopManaged()
    this.attached = false
    await this.start()
  }

  dispose(): void {
    this.process?.dispose()
    this.process = null
    this.removeAllListeners()
  }
}
