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
// 0.1.9 ADR-21: consoleVisible=true picks the resident-console launch family
// (start-wait launcher); its failures fall back to the direct spawn after
// START_LAUNCH_FAIL_LIMIT consecutive session failures, and a resident-family
// dsh death (indistinguishable from a console-window close) is treated as
// USER STOP — never auto-relaunched (§4.6.5).
// 0.1.9.1 ADR-23: the readiness budget is tiered per launch mode inside
// DshProcess (start family 30s / direct 90s), and the start-wait outer cmd
// /wait + exit-before-readiness fast signal makes inner-chain early death a
// seconds-scale failure instead of a full-budget timeout (§4.8).
// 0.1.9 ADR-22: the runtime assembles the DshLaunchInfo snapshot at the
// EXISTING state landing points (launchManaged success / adopt / user-stop /
// disconnect) and exposes it via getLaunchInfo() — no new events, emit('state')
// timing and payload shape unchanged.
// Pure Node (no vscode dependency).
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as net from 'node:net'
import {
  acquireStartupLock, dshAlive, isAlive, looksLikeDsh, processCommandLine,
  readInstance, registerWindow, releaseStartupLock, resolvePortPid, scrubDeadWindowsSync,
  scrubWindowsWithIdentitySync, unregisterWindow, writeInstance,
  type DshRecord, type IdentityVerdict,
} from './instance'
import { DshProcess, START_LAUNCHER_LABEL, probe as dshProbe, treeKill, type SpawnedInfo } from './dshProcess'
import { readRuntimeMeta, resolveDshBin } from './dshResolver'
import { buildLaunchInfo, parseSelfVersion, type DshLaunchInfo } from './launchInfo'
import { appendDecisionLog, LOOPBACK_HOST } from './paths'

export type ManagedBy = 'extension' | 'external' | 'managed-own'

/**
 * ADR-25-① (#54, 0.1.12): source enum of the named launch-port decision.
 *  - 'configured'      : the configured port passed the bind precheck → used as-is;
 *  - 'fallback-random' : the configured port was not bindable → 0 (OS-assigned);
 *  - 'retry-degraded'  : a failed attempt froze the port at 0 for the retry
 *    (never re-prechecked — the L408-411 frozen-degradation semantics, made
 *    explicit by #54).
 */
export type LaunchPortSource = 'configured' | 'fallback-random' | 'retry-degraded'

export interface LaunchPortDecision {
  port: number
  source: LaunchPortSource
}

/**
 * ADR-25-① (#54, 0.1.12): the NAMED single decision point for the managed
 * launch port — the former inline three-line precheck at the launchManaged
 * entry, behavior BIT-IDENTICAL (configured port > 0 and not bindable → 0 +
 * the ADR-1 rlog anchor). The rlog line keeps the
 * `not bindable; falling back to random (ADR-1)` judgment anchor and appends
 * the source triad `(source=…, configured=…, effective=…)` so the R3-type
 * "configured ≠ effective port" misreading is trace-retrievable. direct and
 * the resident-console family consume THIS ONE decision (single-source
 * invariant, PP-6-1); the retry loop's degradation switches the source to
 * 'retry-degraded' WITHOUT re-prechecking (frozen state, §4.10.1-①).
 */
export async function resolveLaunchPort(configuredPort: number): Promise<LaunchPortDecision> {
  const configured = configuredPort > 0 ? configuredPort : 0
  if (configured > 0 && !(await portBindable(configured))) {
    rlog(`launchManaged: port ${configured} not bindable; falling back to random (ADR-1) (source=fallback-random, configured=${configured}, effective=0)`)
    return { port: 0, source: 'fallback-random' }
  }
  return { port: configured, source: 'configured' }
}

// ---- configurable-but-not-scattered constants (去硬编码) --------------------
const DEFAULT_PROBE_INTERVAL_SEC = 30
const LIVENESS_FAIL_THRESHOLD = 3
const MAX_RESTARTS = 6
const BACKOFFS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000]
/** T1b async identity-check budget per entry (connect path, non-blocking). */
const T1B_IDENTITY_TIMEOUT_MS = 10_000
/** T2 identity-check budget per entry (sync exit hook, latency-sensitive). */
const T2_IDENTITY_TIMEOUT_MS = 2_000
/**
 * ADR-21 (§4.6.3 layer 3): consecutive START-launch failures (session-scoped,
 * never persisted) after which the next attempts use the pre-0.1.9 direct
 * spawn. On success the counter resets; there is no automatic path back to
 * start mode within the same runtime instance (§4.6.6).
 */
const START_LAUNCH_FAIL_LIMIT = 2
/** Head bytes read from the managed dsh log for the self-reported version. */
const SELF_VERSION_HEAD_BYTES = 1024

/** Append a decision-trace line to logs/runtime.log (diagnostics only; never throws). */
function rlog(msg: string): void {
  appendDecisionLog(msg)
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
  /**
   * Stale-window identity check injection seam (ADR-15, §4.2.2). Default = the
   * real CIM implementation (`processIdentitySync`); headless tests inject a
   * mock to assert the exthost/foreign/unknown branches (PW-3).
   */
  identityCheck?: (pid: number) => IdentityVerdict
  /**
   * P-POPUP 方案 B (ADR-20, user ruling 2026-08-29): when true the managed dsh
   * runs on a VISIBLE console so every tool subprocess it spawns shares that
   * console instead of popping a new window per call; when false/absent dsh is
   * fully hidden (`windowsHide:true`, the accepted 0.1.7 shape). Read from
   * `dsh.consoleVisible` in extension.ts (vscode layer) and passed down this
   * pure-Node chain.
   *
   * ADR-21 (0.1.9 §4.6.6, semantics REDEFINED): true = cmd.exe start-launch
   * (a self-held resident console — structurally zero popup windows; closing
   * that window IS the user stop). false = the fully hidden direct spawn. The
   * mode degrades to 'direct' after START_LAUNCH_FAIL_LIMIT consecutive
   * start-launch failures (session-scoped, §4.6.3 layer 3).
   */
  consoleVisible?: boolean
  /**
   * ADR-21 test seam (PP-2-3): forwarded into DshProcess's port-holder pid
   * resolution. Defaults to the real `resolvePortPid` (netstat).
   */
  resolvePortPidFn?: (port: number) => { pid: number; address: string } | null
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
  /** T2 idempotency (§4.4.6): one window close fires 3 exit hooks. */
  private shutdownDone = false
  private shutdownResult: boolean | null = null
  /**
   * ADR-21: consecutive START-launch failures (session-scoped, never
   * persisted; reset on any successful launch). ≥ START_LAUNCH_FAIL_LIMIT
   * switches the next attempts to the direct spawn (§4.6.3 layer 3); no
   * automatic path back to start mode within this instance (§4.6.6).
   */
  private startLaunchFailures = 0
  /** ADR-21: launch mode of the most recent managed attempt (null = none yet). */
  private lastLaunchMode: 'start' | 'direct' | null = null
  /** ADR-22: resolver hit transparency from the most recent managed launch. */
  private lastResolved: SpawnedInfo['resolved'] = null
  /** ADR-22: managed log of the most recent managed launch (self-version source). */
  private lastLaunchLogFile: string | null = null
  /** ADR-22: step2 external-takeover command line (≤300 chars), for the degraded card. */
  private externalCommandLine: string | null = null
  /** ADR-22: the last assembled DshLaunchInfo snapshot (null = never assembled). */
  private launchInfoSnapshot: DshLaunchInfo | null = null

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

  /**
   * ADR-22: the last assembled DshLaunchInfo snapshot (or null before the
   * first assembly). Refreshed at the EXISTING state landing points only —
   * subscribers pull via this getter on emit('state'); no new events, the
   * emit payload shape is unchanged (§4.7.1).
   */
  getLaunchInfo(): DshLaunchInfo | null {
    return this.launchInfoSnapshot
  }

  /**
   * ADR-22 assembly (never throws — a launchInfo failure must never break the
   * lifecycle). `kind` selects the degradation semantics (§4.7.2 落点表):
   *  - 'managed'   : full fields (self-version parsed from the launch log head,
   *                  resolver hit, meta, fresh registry record);
   *  - 'adopt'     : honest degradation (no bin/version for this session);
   *                  launchMode carries the record's value;
   *  - 'user-stop' : ADR-21 branch — version/bin cleared, launchMode KEPT
   *                  ('start' → the UI's user-stop copy);
   *  - 'disconnect': version/bin cleared, launchMode forced null (→ the UI's
   *                  disconnected copy).
   * `rec` omitted = read the current registry; explicit null = assemble from
   * the runtime state surface only (pre-writeRegistry call in adopt()).
   */
  private refreshLaunchInfo(args: {
    kind: 'managed' | 'adopt' | 'user-stop' | 'disconnect'
    rec?: DshRecord | null
    resolved?: SpawnedInfo['resolved']
    logFile?: string
  }): void {
    try {
      const rec = args.rec !== undefined ? args.rec : readInstance().dsh
      const managed = args.kind === 'managed'
      const logFile = args.logFile ?? this.lastLaunchLogFile
      this.launchInfoSnapshot = buildLaunchInfo({
        selfVersion: managed && logFile !== null ? parseSelfVersion(readLogHead(logFile)) : null,
        resolved: managed ? (args.resolved ?? this.lastResolved ?? null) : null,
        meta: readRuntimeMeta(this.options.channel),
        rec: rec ?? null,
        port: this.port,
        pid: this.dshPid,
        managedBy: this.managedBy,
        channel: this.options.channel,
        externalCommandLine: this.externalCommandLine,
        launchLogFile: managed ? logFile : null,
        degraded: !managed,
        degradedLaunchMode: args.kind === 'user-stop' ? 'start' : args.kind === 'disconnect' ? null : undefined,
        launchMode: this.lastLaunchMode,
      })
    } catch (err) {
      rlog(`launchInfo: snapshot assembly failed (ignored): ${(err as Error).message}`)
    }
  }

  // ------------------------------------------------------------ lifecycle

  /** Called once per extension activation: re-adopt / adopt / managed-launch. */
  async start(): Promise<void> {
    if (this.attached || this.state === 'ready') return
    this.attached = true
    this.stopRequested = false
    this.dshPid = null
    // T2 idempotency reset (§4.4.6): under a disable->re-enable cycle in the
    // same process, bookkeeping is scoped to the ATTACHMENT epoch, not the
    // process epoch — a re-activation must be able to re-book.
    this.shutdownDone = false
    this.shutdownResult = null
    // ADR-21/22 per-attach reset: the launch metadata describing the PREVIOUS
    // attachment must never leak into this one's snapshots. startLaunchFailures
    // is deliberately NOT reset (session-scoped fallback, §4.6.6).
    this.lastLaunchMode = null
    this.lastResolved = null
    this.lastLaunchLogFile = null
    this.externalCommandLine = null
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
      await this.writeRegistry()
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
          // ADR-22: keep the fragment (≤300 chars) for the external degraded card.
          this.externalCommandLine = cmdline.slice(0, 300)
          const like = looksLikeDsh(cmdline)
          rlog(`step2 looksLikeDsh=${like}`)
          pid = like ? holder.pid : null
          // §4.3.1 residual migration (0.1.6 -> 0.1.7 upgrade path): a stale
          // managed-own registry record whose recorded (wrapper) pid is dead
          // while a LIVE dsh holder still serves the REGISTERED port with a dsh
          // signature -> adopt as managed-own with dsh.pid refreshed to the
          // holder (ADR-14). Four-condition gate; ANY unmet condition falls
          // through to the existing external adopt (safe side, never kills).
          const rec = inst.dsh
          if (
            like && rec !== null && rec.managedBy === 'managed-own' && rec.port === probePort &&
            (rec.pid === null || !isAlive(rec.pid))
          ) {
            rlog(
              `step2 residual migration: adopted 0.1.6 residual as managed-own ` +
                `(registered pid ${rec.pid ?? 'null'} dead, live dsh holder ${holder.pid} on registered port ${probePort}, dsh signature matched)`,
            )
            this.adopt(probePort, holder.pid, 'managed-own')
            await this.writeRegistry()
            this.startProbe()
            return
          }
        } else {
          // CIM unavailable: the page probe already verified the __DSH_BOOT__
          // signature; record the holder PID. Last-window kill still re-verifies.
          // (Residual migration is NOT applied: the dsh signature is unverifiable
          // -> safe side keeps the external path, §4.3.1.)
          pid = holder.pid
          rlog('step2 CIM unavailable; recording holder pid on page-signature basis')
        }
      }
      this.adopt(probePort, pid, 'external')
      await this.writeRegistry()
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
    // ADR-25-① (#54): the port decision is the named single point; the source
    // rides the rlog trace (launchInfo/registry untouched, §4.10.4 blast
    // table). Behavior bit-identical to the former inline precheck.
    const decision = await resolveLaunchPort(preferredPort ?? this.options.port)
    let usePort = decision.port
    let portSource: LaunchPortSource = decision.source
    rlog(`launchManaged: detached launch (port=${usePort}, source=${portSource}, attempts=${this.launchAttempts})`)
    while (this.launchAttempts < MAX_RESTARTS) {
      // ADR-21: per-attempt mode (resident-console family unless hidden/non-win32/2×failed).
      const mode = this.effectiveLaunchMode()
      // ADR-23 #39: the launcher VARIANT is rlog-trace-only (`launcher=start-wait|
      // conhost`); launchMode stays binary in the registry/UI (§4.8.5).
      rlog(
        `launchManaged: launch mode = ${mode}` +
          (mode === 'start' ? ` (launcher=${START_LAUNCHER_LABEL}, self-held resident console)` : ' (direct node, pre-0.1.9 shape)'),
      )
      const proc = new DshProcess({
        port: usePort,
        channel: this.options.channel,
        command: this.options.command,
        dshHome: this.options.dshHome,
        consoleVisible: this.options.consoleVisible,
        launchMode: mode,
        resolvePortPidFn: this.options.resolvePortPidFn,
      })
      try {
        const info = await proc.start()
        // ADR-21: the connected pid IS the service pid (direct: the spawned
        // child; start: the resolved port holder — registry pid semantics,
        // ADR-14, preserved). The wrapper pid stays in the log only.
        this.dshPid = info.servicePid
        this.lastLaunchMode = mode
        this.lastResolved = info.resolved
        this.lastLaunchLogFile = info.logFile
        this.port = info.port
        this.url = info.url
        this.managedBy = 'managed-own'
        this.launchAttempts = 0
        this.startLaunchFailures = 0 // §4.6.3: any success resets the fallback counter
        await this.writeRegistry('managed')
        this.setState('ready')
        this.startProbe()
        rlog(`launchManaged: ready at ${info.url} (service pid ${info.servicePid ?? 'null'}, wrapper pid ${info.pid}, log ${info.logFile})`)
        return
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.launchAttempts += 1
        if (mode === 'start') {
          this.startLaunchFailures += 1
          rlog(`launchManaged: start-launch failure #${this.startLaunchFailures} (attempt #${this.launchAttempts}): ${msg}`)
          if (this.startLaunchFailures >= START_LAUNCH_FAIL_LIMIT) {
            // ADR-23 #39: the fallback is a SAFETY NET, not the design goal —
            // rlog must state the degradation explicitly (§4.8.2/§4.8.5).
            rlog('start-launch repeatedly failed; falling back to direct spawn (0.1.8 behavior) — direct = 无常驻窗降级态 (violates the ADR-20 resident-console ruling; NOT an acceptance shape)')
          }
        } else {
          rlog(`launchManaged: attempt #${this.launchAttempts} failed: ${msg}`)
        }
        if (this.launchAttempts >= MAX_RESTARTS) {
          this.errorMessage = `dsh failed to start after ${MAX_RESTARTS} attempts (detached); last: ${msg}`
          this.setState('error')
          this.emit('error', this.errorMessage)
          return
        }
        if (usePort !== 0) {
          usePort = 0
          // ADR-25-① (#54): the retry degradation is a FROZEN state — the
          // precheck is NOT re-run for the retry (no return to 'configured');
          // the source annotation makes the degraded retry trace-retrievable.
          portSource = 'retry-degraded'
          rlog('launchManaged: degrading to random port on retry (avoid same-port loop) (source=retry-degraded)')
        }
        if (this.stopRequested) {
          // ADR-22: user disconnect during the backoff — degraded snapshot
          // (launchMode null → disconnected copy), then stop (no relaunch).
          this.refreshLaunchInfo({ kind: 'disconnect' })
          this.setState('stopped')
          return
        }
        const delay = BACKOFFS_MS[this.launchAttempts - 1] ?? BACKOFFS_MS[BACKOFFS_MS.length - 1]
        rlog(`launchManaged: backing off ${delay}ms before retry #${this.launchAttempts + 1}`)
        await sleep(delay)
      }
    }
  }

  /**
   * ADR-21: effective launch mode for the NEXT managed attempt (§4.6.3-3 /
   * §4.6.6). start-launch requires consoleVisible=true AND win32 AND fewer
   * than START_LAUNCH_FAIL_LIMIT consecutive session failures; everything
   * else (hidden console, non-win32, exhausted budget) = direct. The custom
   * `command` boundary is enforced inside DshProcess (forced direct).
   */
  private effectiveLaunchMode(): 'start' | 'direct' {
    return (
      this.options.consoleVisible === true &&
      process.platform === 'win32' &&
      this.startLaunchFailures < START_LAUNCH_FAIL_LIMIT
    )
      ? 'start'
      : 'direct'
  }

  private adopt(port: number, pid: number | null, managedBy: ManagedBy): void {
    this.port = port
    this.url = `http://${LOOPBACK_HOST}:${port}`
    this.managedBy = managedBy
    this.dshPid = pid
    // ADR-22: assemble the snapshot BEFORE the ready-state emit so subscribers
    // never observe a stale snapshot; writeRegistry (right after, at every
    // call site) re-assembles with the authoritative fresh record. rec = null:
    // the pre-write record would be stale (external/migration adopts).
    this.refreshLaunchInfo({ kind: 'adopt', rec: null })
    this.setState('ready')
    rlog(`adopt: ${managedBy} dsh at ${this.url} (pid ${pid ?? 'null'})`)
  }

  /**
   * Persist the dsh record + this window's registration (0.1.7, ADR-15/16):
   *  - T1 sync: liveness scrub of dead window entries (microsecond process.kill,
   *    covers the force-killed-host scenario, P-STALEWIN);
   *  - register this window (same-pid re-registration keeps its startedAt);
   *  - dsh.startedAt is PRESERVED when re-adopting the same dsh pid (ADR-16);
   *    the F-05 guard `this.dshPid !== null` prevents the external case
   *    (dshPid === null) from wrongly keeping a stale value via null===null;
   *  - T1b async: bounded identity scrub of the surviving entries
   *    (fire-and-forget, never blocks startup); verified-foreign entries are
   *    removed with a guarded surgical rewrite.
   *
   * ADR-21 #22: the record gains the OPTIONAL launchMode carrier — managed
   * launches write the ACTUAL attempt mode; re-adopt keeps the recorded value
   * (sameDsh guard, shared with the startedAt preservation). ADR-22: the
   * launchInfo snapshot is re-assembled at the end of this authoritative
   * registry landing point (`launchKind` selects the degradation semantics).
   */
  private async writeRegistry(launchKind: 'managed' | 'adopt' = 'adopt'): Promise<void> {
    const scrubbed = scrubDeadWindowsSync(readInstance())
    if (scrubbed.removed > 0) {
      rlog(`writeRegistry T1: scrubbed ${scrubbed.removed} dead window(s): [${scrubbed.removedPids.join(', ')}]`)
    }
    const inst = scrubbed.inst
    const prev = inst.dsh
    const keepDshStartedAt = prev !== null && this.dshPid !== null && prev.pid === this.dshPid
    inst.dsh = {
      pid: this.dshPid ?? null,
      port: this.port ?? this.options.port,
      managedBy: this.managedBy ?? 'managed-own',
      startedAt: keepDshStartedAt && prev !== null ? prev.startedAt : new Date().toISOString(),
      // ADR-21 #22: actual attempt mode on a fresh launch; the record's value
      // on re-adopt; absent (JSON-dropped undefined) for external/old records
      // (= direct semantics, backward compatible).
      launchMode: keepDshStartedAt && prev !== null ? prev.launchMode : (this.lastLaunchMode ?? undefined),
    }
    writeInstance(registerWindow(inst, this.options.app, this.options.windowPid))
    rlog(`writeRegistry: dsh=${JSON.stringify(inst.dsh)} +window ${this.options.windowPid}`)
    // T1b (fire-and-forget): bounded identity scrub of surviving window entries.
    void this.scrubIdentityAsync()
    // ADR-22: re-assemble with the authoritative fresh record.
    this.refreshLaunchInfo({ kind: launchKind })
  }

  /** T1b: identity scrub (10s/entry cap, 60s cache) with a guarded rewrite.
   *  G1 (ADR-18): selfPid is passed so the identity layer never scrubs the
   *  window running this runtime. */
  private async scrubIdentityAsync(): Promise<void> {
    try {
      const snapshot = readInstance()
      const res = scrubWindowsWithIdentitySync(snapshot, T1B_IDENTITY_TIMEOUT_MS, this.options.identityCheck, {
        selfPid: this.options.windowPid,
      })
      if (res.removed === 0) return
      // Guarded rewrite: re-read the fresh registry and remove ONLY the
      // verified-foreign pids (never clobber concurrent registrations).
      const fresh = readInstance()
      const before = fresh.windows.length
      fresh.windows = fresh.windows.filter((w) => !res.removedPids.includes(w.pid))
      if (fresh.windows.length !== before) {
        writeInstance(fresh)
        rlog(`writeRegistry T1b: identity scrub removed ${before - fresh.windows.length} window(s): [${res.removedPids.join(', ')}]`)
      }
    } catch (err) {
      rlog(`writeRegistry T1b: identity scrub failed (ignored): ${(err as Error).message}`)
    }
  }

  private async waitForExternalStartup(probePort: number): Promise<boolean> {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const inst = readInstance()
      const port = inst.dsh?.port ?? probePort
      if (inst.dsh && port > 0 && await this.probe(port)) {
        this.adopt(port, inst.dsh.pid, inst.dsh.managedBy)
        await this.writeRegistry()
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
      // ADR-21 core ruling (§4.6.5): a start-launched dsh CANNOT be
      // probed apart from its console window — a crash and a user window
      // close look identical. Relaunching on death would create an infinite
      // zombie loop (window closes -> relaunch succeeds -> window pops
      // again). So: treat it as USER STOP — clear the record, surface
      // 'stopped' (degraded snapshot keeps launchMode='start' → the UI's
      // user-stop copy), never auto-relaunch. reconnect() starts a fresh
      // start-launch on demand. Direct/legacy records keep the pre-0.1.9
      // bounded relaunch below, byte-identically.
      if (rec !== null && rec.launchMode === 'start') {
        rlog('probe: dsh died or console window closed (indistinguishable); treated as user stop per ADR-21; reconnect to restart')
        this.refreshLaunchInfo({ kind: 'user-stop', rec })
        const stopped = readInstance()
        if (stopped.dsh !== null) {
          stopped.dsh = null
          writeInstance(stopped)
          rlog('probe: ADR-21 user-stop branch cleared the dsh record')
        }
        this.dshPid = null
        this.port = null
        this.url = null
        this.stopProbe()
        this.setState('stopped')
        return
      }
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
    // ADR-22: degraded snapshot BEFORE the stopped emit — port/pid/managedBy
    // retained, version/bin cleared, launchMode FORCED null (disconnect keeps
    // the process alive → the UI's "已断开" copy, not the user-stop one).
    this.refreshLaunchInfo({ kind: 'disconnect' })
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
    // ADR-13 (0.1.7): explicit update = FORCED freshness check + in-place
    // refresh of the npx-cached install (best-effort; runs AFTER the old process
    // was killed so the refresh never touches files still in use). On failure
    // the launch itself falls back to the 0.1.6 npx chain (DshProcess safety net).
    try {
      const bin = await resolveDshBin(this.options.channel, { force: true })
      rlog(
        `forceRelaunchManaged: forced runtime refresh -> ` +
          `${bin !== null ? `v${bin.version} (${bin.mode}) at ${bin.dir}` : 'unresolved; launch will use the 0.1.6 cmd+npx fallback'}`,
      )
    } catch (err) {
      rlog(`forceRelaunchManaged: forced refresh error (best-effort, continuing): ${(err as Error).message}`)
    }
    await this.launchManaged()
    return 'relaunched'
  }

  // ------------------------------------------------------------ shutdown bookkeeping

  /**
   * Synchronous last-window stop arbitration (P0-F), idempotent (§4.4.6):
   * one window close fires THREE exit hooks (process 'exit', subscription
   * dispose, deactivate) — only the FIRST call performs the full bookkeeping;
   * calls 2/3 log an idempotent skip and return the first result (zero CIM
   * queries, zero registry writes). `start()` resets the flags (attachment
   * epoch). Unregisters this window, then:
   *  - managed-own / extension: triple safe-gate (pid alive + port holder match,
   *    plus the runtime's separate __DSH_BOOT__ liveness) -> tree-kill + clear.
   *  - external: never kill; PRESERVE the known-external record (only cleared
   *    when stale — pid no longer alive), so the next window can re-adopt (F2).
   * PID source is the registry record only (pure `next.dsh.pid`).
   * @returns whether a managed dsh was stopped.
   */
  shutdownBookkeeping(): boolean {
    if (this.shutdownDone) {
      rlog('shutdownBookkeeping: idempotent skip (already finalized)')
      return this.shutdownResult ?? false
    }
    this.shutdownDone = true
    this.shutdownResult = this.shutdownBookkeepingOnce()
    return this.shutdownResult
  }

  /** The one effective bookkeeping pass (see shutdownBookkeeping). */
  private shutdownBookkeepingOnce(): boolean {
    rlog(`shutdownBookkeeping: window ${this.options.windowPid}`)
    const inst = readInstance()
    const afterUnregister = unregisterWindow(inst, this.options.windowPid)
    // T2 (ADR-15/18): full stale-window scrub BEFORE the last-window verdict —
    // synchronous (exit hook), identity check bounded at 2s/entry (usually a
    // 60s-cache hit from T1b), unknown -> keep (safe-side). Dead entries from a
    // force-killed host can no longer block the "last window" arbitration.
    // selfPid is passed defensively: self was already unregistered above and is
    // no longer in windows[], but the parameter documents and enforces that the
    // identity layer can never act on our own window (G1, §4.4.3).
    const scrubbed = scrubWindowsWithIdentitySync(afterUnregister, T2_IDENTITY_TIMEOUT_MS, this.options.identityCheck, {
      selfPid: this.options.windowPid,
    })
    if (scrubbed.removed > 0) {
      rlog(`shutdown T2: scrubbed ${scrubbed.removed} stale window(s): [${scrubbed.removedPids.join(', ')}]`)
    }
    const next = scrubbed.inst
    writeInstance(next)
    rlog(`shutdown: after unregister+scrub windows=${next.windows.length} dsh=${JSON.stringify(next.dsh)}`)
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

/**
 * Read the first ≤1KB of a text file (the dsh self-reported version source,
 * E-VER-1). Never throws — best-effort by contract.
 */
function readLogHead(logFile: string): string {
  try {
    const fd = fs.openSync(logFile, 'r')
    try {
      const buf = Buffer.alloc(SELF_VERSION_HEAD_BYTES)
      const n = fs.readSync(fd, buf, 0, SELF_VERSION_HEAD_BYTES, 0)
      return buf.toString('utf8', 0, n)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}
