// Runtime orchestration: the startup path (reuse probe -> external adopt ->
// first-window managed spawn with atomic lock arbitration) and the lifecycle
// bookkeeping shared by every window. Pure Node (no vscode dependency).
import { EventEmitter } from 'node:events'
import {
  acquireStartupLock, dshAlive, emptyInstance, isAlive, looksLikeDsh, processCommandLine,
  readInstance, registerWindow, releaseStartupLock, resolvePortPid, unregisterWindow,
  writeInstance, InstanceState,
} from './instance'
import { DshProcess, treeKill } from './dshProcess'

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
  private attached = false
  private stopRequested = false

  constructor(options: RuntimeOptions) {
    super()
    this.options = options
  }

  private setState(s: RuntimeState): void {
    if (this.state === s) return
    this.state = s
    this.emit('state', s)
  }

  // ------------------------------------------------------------ lifecycle

  /** Called once per extension activation: adopt existing dsh or start one. */
  async start(): Promise<void> {
    if (this.attached || this.state === 'ready') return
    this.attached = true
    this.stopRequested = false
    this.setState('starting')
    this.emit('log', `[runtime] window ${this.options.windowPid} starting`)

    // 1. Registry: a live managed/external dsh we already know about?
    const inst = readInstance()
    if (dshAlive(inst) && inst.dsh && await this.probe(inst.dsh.port)) {
      this.adopt(inst.dsh.port, inst.dsh.pid, inst.dsh.managedBy)
      this.writeRegistry()
      return
    }

    // 2. Probe the configured port for an external instance.
    const probePort = this.options.port > 0 ? this.options.port : 0
    if (probePort > 0 && await this.probe(probePort)) {
      const holder = resolvePortPid(probePort)
      const pid = holder && looksLikeDsh(processCommandLine(holder.pid)) ? holder.pid : null
      this.adopt(probePort, pid, 'external')
      this.writeRegistry()
      return
    }

    // 3. First-window path: atomic lock arbitration, then spawn.
    const lock = acquireStartupLock(this.options.app)
    if (lock) {
      await this.spawnManaged()
      releaseStartupLock()
      return
    }

    // 4. Another window is starting dsh: wait for it, then adopt.
    this.emit('log', '[runtime] another window is starting dsh; waiting…')
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
      this.emit('log', `[runtime] port ${usePort} busy by a non-DSH process; falling back to random port`)
      usePort = 0
    }
    this.process = new DshProcess({ port: usePort, channel, command, dshHome })
    this.process.on('port', (info: { pid: number; port: number; url: string }) => {
      this.port = info.port
      this.url = info.url
      this.managedBy = 'extension'
      this.writeRegistry()
      this.emit('log', `[runtime] dsh ready at ${info.url} (pid ${info.pid})`)
    })
    this.process.on('crashed', ({ attempt }) => {
      this.emit('log', `[runtime] dsh crashed, restart #${attempt}`)
      this.setState('starting')
    })
    this.process.on('failed', (msg: string) => {
      this.errorMessage = msg
      this.setState('error')
      this.emit('error', msg)
    })
    this.process.on('port', async (info) => {
      const ok = await DshProcess.waitReady(info.url)
      if (!ok) {
        this.errorMessage = 'dsh started but did not become ready in time'
        this.setState('error')
        this.emit('error', this.errorMessage)
        return
      }
      this.setState('ready')
    })
    this.process.start()
  }

  private adopt(port: number, pid: number | null, managedBy: 'extension' | 'external'): void {
    this.port = port
    this.url = `http://127.0.0.1:${port}`
    this.managedBy = managedBy
    this.setState('ready')
    this.emit('log', `[runtime] adopted ${managedBy} dsh at ${this.url} (pid ${pid ?? 'unknown'})`)
  }

  private writeRegistry(): void {
    const inst = readInstance()
    inst.dsh = {
      pid: this.process?.pid ?? null,
      port: this.port ?? this.options.port,
      managedBy: this.managedBy ?? 'extension',
      startedAt: new Date().toISOString(),
    }
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
    const inst = readInstance()
    const next = unregisterWindow(inst, this.options.windowPid)
    writeInstance(next)
    if (next.windows.length > 0 || !next.dsh || next.dsh.pid === null) return false
    if (!isAlive(next.dsh.pid)) return false
    const holder = resolvePortPid(next.dsh.port)
    if (!holder || holder.pid !== next.dsh.pid) return false // PID reused or no longer serving
    this.emit('log', `[runtime] last window closed; stopping dsh pid ${next.dsh.pid}`)
    treeKill(next.dsh.pid)
    const cleared = readInstance()
    if (cleared.dsh?.pid === next.dsh.pid) {
      cleared.dsh = null
      writeInstance(cleared)
    }
    return true
  }

  /** Stop a managed dsh and clear the registry dsh record (command dsh.stop). */
  stopManaged(): void {
    this.stopRequested = true
    this.process?.dispose()
    this.process = null
    const inst = readInstance()
    if (inst.dsh) {
      inst.dsh = null
      writeInstance(inst)
    }
    this.setState('stopped')
  }

  /** Restart: kill current (managed or external, when PID known) and re-run start path. */
  async restart(): Promise<void> {
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
