// dsh web child-process supervision: spawn (npx-managed or custom command),
// parse the printed port, poll HTTP readiness, crash-restart with backoff, and
// tree-kill on stop. Pure Node (no vscode dependency).
import { spawn, spawnSync, ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { logFile } from './paths'

export interface SpawnOptions {
  /** Port to request (0 = OS assigned). */
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
}

const URL_RE = /dsh web:\s+(http:\/\/127\.0\.0\.1:(\d+))/i
const READY_TIMEOUT_MS = 60_000
const BACKOFFS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000]
const MAX_RESTARTS = 6

export class DshProcess extends EventEmitter {
  private child: ChildProcess | null = null
  private wantedPort: number
  private options: SpawnOptions
  private restarts = 0
  private stopping = false
  private timer: NodeJS.Timeout | null = null
  private logFd: fs.WriteStream | null = null

  constructor(options: SpawnOptions) {
    super()
    this.options = options
    this.wantedPort = options.port
    this.openLog()
  }

  private openLog(): void {
    try {
      const { mkdirSync } = fs
      mkdirSync(require('node:path').dirname(logFile()), { recursive: true })
      this.logFd = fs.createWriteStream(logFile(), { flags: 'a' })
    } catch {
      this.logFd = null
    }
  }

  private writeLog(line: string): void {
    if (this.logFd) this.logFd.write(`[${new Date().toISOString()}] ${line}\n`)
  }

  /** True while a dsh process is running. */
  get running(): boolean {
    return this.child !== null && this.child.exitCode === null
  }

  get pid(): number | null {
    return this.running && this.child ? this.child.pid ?? null : null
  }

  start(): void {
    if (this.running || this.stopping) return
    this.writeLog(`starting: port=${this.options.port} channel=${this.options.channel}`)
    const args = this.buildArgs()
    this.writeLog(`cmd: ${args.display}`)
    this.child = spawn(args.exec, args.argv, {
      windowsHide: true,
      env: this.buildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const child = this.child
    let portResolved = false

    child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk, (port) => {
      if (portResolved) return
      portResolved = true
      this.emit('port', { pid: child.pid, port, url: `http://127.0.0.1:${port}` } as SpawnedInfo)
    }))
    child.stderr?.on('data', (chunk: Buffer) => this.writeLog(`stderr: ${chunk.toString()}`))
    child.on('error', (err) => {
      this.writeLog(`spawn error: ${err.message}`)
      this.emit('failed', err.message)
      this.child = null
    })
    child.on('exit', (code, signal) => {
      this.writeLog(`exited: code=${code} signal=${signal}`)
      this.child = null
      if (this.stopping) return
      if (this.restarts < MAX_RESTARTS) {
        const delay = BACKOFFS_MS[this.restarts] ?? BACKOFFS_MS[BACKOFFS_MS.length - 1]
        this.restarts += 1
        this.writeLog(`crash detected, restart #${this.restarts} in ${delay}ms`)
        this.emit('crashed', { attempt: this.restarts, delay })
        this.timer = setTimeout(() => this.start(), delay)
      } else {
        this.emit('failed', `dsh exited repeatedly (${MAX_RESTARTS} restarts); giving up`)
      }
    })
  }

  private buildArgs(): { exec: string; argv: string[]; display: string } {
    const { command, channel } = this.options
    if (command.trim().length > 0) {
      // Custom command: run through cmd.exe for shell semantics.
      return { exec: 'cmd.exe', argv: ['/d', '/s', '/c', command], display: command }
    }
    // channel may be 'latest' | 'preview' | exact version; all pass through verbatim.
    const spec = channel
    const npxArgs = [
      'npx',
      '--yes',
      '--prefer-offline',
      `@deepseek-ai/dsh@${spec}`,
      'web',
      '--host', '127.0.0.1',
      '--port', String(this.wantedPort),
      '--no-open',
    ]
    return { exec: 'cmd.exe', argv: ['/d', '/s', '/c', npxArgs.join(' ')], display: npxArgs.join(' ') }
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    if (this.options.dshHome.trim().length > 0) env.DSH_HOME = this.options.dshHome.trim()
    return env
  }

  private onStdout(chunk: Buffer, onPort: (port: number) => void): void {
    const text = chunk.toString()
    this.writeLog(text.replace(/\r?\n$/, ''))
    const m = text.match(URL_RE)
    if (m) onPort(Number(m[2]))
  }

  /** Resolve the actual port once the child reports it (call after 'port'). */
  static async waitReady(url: string, timeoutMs = READY_TIMEOUT_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3_000) })
        if (res.ok) return true
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    return false
  }

  stop(): void {
    this.stopping = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const pid = this.child?.pid
    if (pid !== undefined && pid !== null) {
      treeKill(pid)
    }
    this.child = null
    this.writeLog('stopped')
  }

  dispose(): void {
    this.stop()
    this.logFd?.end()
    this.logFd = null
  }
}

/** Kill a process tree on Windows (taskkill /T /F). */
export function treeKill(pid: number): void {
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  } catch {
    /* ignore */
  }
}
