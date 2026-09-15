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
  PROCESS_START_QUERY_TIMEOUT_MS, queryProcessStartTimeSync, readInstance, registerWindow,
  releaseStartupLock, resolvePortPid, scrubDeadWindowsSync, scrubWindowsWithIdentitySync,
  unregisterWindow, writeInstance,
  type DshRecord, type IdentityVerdict,
} from './instance'
import { DshProcess, START_LAUNCHER_LABEL, judgeContractByVersion, probeDetail, resolveBannerFromLog, treeKill, type ContractTier, type ProbeKind, type SpawnOptions, type SpawnedInfo } from './dshProcess'
import { readRuntimeMeta, resolveDshBin, scanNpxCacheReadonly, DSH_PKG } from './dshResolver'
import { buildExternalVersionNote, buildLaunchInfo, extractVersionFromCommandLine, parseSelfVersion, type DshLaunchInfo } from './launchInfo'
import { appendDecisionLog, LOOPBACK_HOST } from './paths'
import { DSH_CHANNELS, resolveChannelRestartAction } from './channelSelect'
import {
  buildChannelSpecIndex, recoverChannelFromCmdline,
  type ChannelFact, type ChannelSource,
} from './channelProbe'
import { mintSessionCookie, readCredentialsSecret, startAuthProxy, type AuthProxyHandle } from './authProxy'

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
/**
 * 0.1.14 §3.5: the INDEPENDENT 401 counter threshold — consecutive
 * unauthorized probe outcomes (after the ONE session re-establishment) that
 * end in the error state with the restart guidance. Deliberately isolated
 * from LIVENESS_FAIL_THRESHOLD (crash backoff) and from the ADR-21 user-stop
 * arbitration: a 401 means the process is ALIVE but the session is stale.
 */
const AUTH_FAIL_THRESHOLD = 3
/** Error-state guidance copy (§3.5: 「会话失效——请重启服务」). */
const SESSION_EXPIRED_MESSAGE = 'dsh 会话失效——请重启服务（面板 ⟳ 或命令「DSH: Restart Runtime」；dsh 进程未停止）'
/**
 * 0.1.15 #82: the honest-degradation guidance for an adopt session whose C
 * path is unavailable (credentials unreadable / mint failed / live-verification
 * rejected). The panel and the details card render it verbatim via the error
 * state — no proxy, no URL, no pretending the session works.
 */
const ADOPT_SESSION_UNAVAILABLE_MESSAGE =
  '该 dsh 实例无法建立面板会话（无 banner token 且凭证不可用）——请重启该 dsh 后由面板接管首启（可自动获取 token）；并请核对 dsh.dshHome 配置与该实例实际的 DSH_HOME 是否一致。'

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
  | 'awaitingChannel' // 0.1.15 #83 (ADR-31): parked for the panel channel-pick card; start() runs only after the pick
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
  /**
   * 0.1.16 #97 (ADR-40) injection seam (identityCheck / resolvePortPidFn
   * same shape): the process start-time query used by writeRegistry's fresh
   * branch. Default = the real `queryProcessStartTimeSync` (Get-Process
   * StartTime, G3 shape); headless tests inject a mock (PP-12-4).
   */
  processStartQuery?: (pid: number) => string | null
  /**
   * 0.1.21（实施清单第 8 项，v5 QA H-3 自测试任务拆出）：可注入的 DshProcess
   * 进程工厂（identityCheck / resolvePortPidFn / processStartQuery 同型注入
   * seam 先例）。提供时 launchManaged 经本工厂构造进程实例（代替
   * `new DshProcess(...)`），无头测试可包装/计数 start() 调用以断言 spawn 次数
   * （PU-21-1 多窗口同时手动重连收敛 = 恰 1 次拉起；PU-21-5 external 死亡 =
   * 0 次拉起）。纯 Node 层生产面（不 import vscode）；缺省 = 既有
   * `new DshProcess(...)` 行为逐字节不变。
   */
  dshProcessFactory?: (opts: SpawnOptions) => Pick<DshProcess, 'start'>
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
  /**
   * 0.1.21 改动点 3（设计 §3.4 D-1 / §7.1；出处 B）：本窗口当前附着实例的
   * launchMode 记忆。作用面（如实说明，三项）：
   *  1. probeTick 死亡分支三分流的形态判定兜底——注册表记录可能已被其他窗口
   *     先一步清掉（rec === null），此时只能凭本窗口记忆判定形态；
   *  2. start 模式跨窗口防复活：窗口 A 判定用户停止并清掉记录后，窗口 B 凭
   *     自己的 'start' 记忆同样不复活用户刚关掉的实例（ADR-21 旧裁定
   *     L1124-1148 的判定依据从「仅共享注册表」扩为「共享注册表 ∨ 本窗口
   *     附着记忆」，单窗口语义零回退）；
   *  3. 记录缺失时防误拉：曾认领 external 实例（记忆 null）的窗口在记录被清
   *     后落入死亡分支③不拉起（现状该场景落 bounded relaunch，是 D-1 根因
   *     的伴生重拉路径之一）。
   * 赋值：launchManaged 成功 = 本次实际 mode（与 lastLaunchMode 同点）；adopt
   * 认领 = rec.launchMode ?? null（记录缺失显式置 null，不是保持原值——v5 QA
   * H-5 消歧）。清理：disconnect / shutdown 记账 / 死亡分支清记录 /
   * forceRelaunchManaged 清记录时置 null（记录生命周期终点）+ start() 的
   * per-attach 重置（沿用既有 per-attach 纪律，防前一次附着的记忆泄漏）。
   */
  private attachedLaunchMode: 'start' | 'direct' | null = null
  /**
   * 0.1.21 改动点 5（设计 §3.4 D-2 改动点 5 / §7.1；出处 B + 出处 C §4.4，CR-8）：
   * 本窗口当前附着实例的真实启动通道记忆 —— 快照 channel 的唯一真值来源
   * （快照从此只陈述运行实例的事实，不再配置直通回显）。赋值：launchManaged
   * 成功 = this.options.channel（拉起时配置值即实际启动通道）；adopt 认领 =
   * rec.channel ?? null——**不回退配置值**（回退会在「用户改配置后重连 adopt
   * 活着的旧通道实例」场景把快照刷新为新值、待生效提示被抹掉，而外部进程仍跑
   * 旧通道，正是 §3.2 第三层失效形态）。null = external 接管 / 旧记录缺省 /
   * 尚未附着（诚实缺省：详情卡渲染「未知」、待生效判定恒真）。清理点与
   * attachedLaunchMode 同点（记录生命周期终点 + per-attach 重置）。
   */
  private attachedChannel: string | null = null
  /**
   * 0.1.23（设计 §5.2.1 第 2c 步 / §5.9；QA-D23-01）：attachedChannel 的**来源
   * 标注**——「这个通道值是怎么得来的」与值成对携带（语义分离纪律：UI 层不得把
   * 间接事实说成直接事实）。
   * 赋值落点与 attachedChannel 同点：launchManaged 成功 = 'launch-option'
   * （拉起时配置值即实际启动通道）；adopt 认领 = 记录含 channel 时 'registry'，
   * 否则 external 恢复成功时 'cmdline'、恢复失败时 null（诚实降级）。
   * 清理点与 attachedChannel 同点（记录生命周期终点 + per-attach 重置）。
   * 快照透传见 refreshLaunchInfo；配对不变式（channel === null ⟺ source === null）
   * 由 launchInfo.buildLaunchInfo 单向防御兜底。
   */
  private attachedChannelSource: ChannelSource = null
  /** ADR-22: resolver hit transparency from the most recent managed launch. */
  private lastResolved: SpawnedInfo['resolved'] = null
  /** ADR-22: managed log of the most recent managed launch (self-version source). */
  private lastLaunchLogFile: string | null = null
  /** ADR-22: step2 external-takeover command line (≤300 chars), for the degraded card. */
  private externalCommandLine: string | null = null
  /**
   * 0.1.18 ADR-48: external 接管会话的间接版本事实（adopt 落点装配，§3.3）。
   * memory-only —— 与 externalCommandLine 同类，注册表（instance.json）不落盘；
   * per-attach 重置，前一次接管的版本事实绝不泄漏进本次快照。null = 非
   * external 会话 / 尚未装配。
   */
  private externalVersionFacts: {
    /** npx 缓存整根只读扫描的 newest 候选版本（扫描失败/无候选 → null）。 */
    dirVersion: string | null
    /** dirVersion 的来源标注（buildExternalVersionNote 文案单点；无版本 → null）。 */
    note: string | null
    /** externalCommandLine 原文 semver 版本（step1 re-adopt 无命令行 → 恒 null）。 */
    cmdlineVersion: string | null
  } | null = null
  /** ADR-22: the last assembled DshLaunchInfo snapshot (null = never assembled). */
  private launchInfoSnapshot: DshLaunchInfo | null = null
  // ---- 0.1.14 ADR-30 state (all memory-only; D3: NOTHING here is persisted) ----
  /** Contract tier of the RUNNING dsh, judged from the resolver version (§3.3). */
  private contract: ContractTier = 'unknown'
  /** T-path session source: the banner token of the current launch (or null). */
  private authToken: string | null = null
  /** The banner-authenticated URL (token contract, T path) for openInBrowser; null = legacy/degraded. */
  // Public: extension.ts openInBrowser sends the banner-authenticated URL
  // (token contract) or the bare url (legacy) — same redaction at the log seam.
  externalUrl: string | null = null
  /** The local authProxy handle (token contract sessions); null = direct. */
  private proxy: AuthProxyHandle | null = null
  /** C-path self-minted session cookie (`dsh-auth-…=v1.…`), memory-only. */
  private sessionCookie: string | null = null
  /** §3.5: the ONE session re-establishment already spent for this attachment. */
  private sessionRetried = false
  /** §3.5: the independent 401 counter (isolated from probeFailures / ADR-21). */
  private authFailures = 0
  /**
   * 0.1.22 改动点 3（设计 §4.2）：停止态发现探活器——stopped 态专属的低频发现
   * 定时器。生命周期严格绑定 stopped 态（setState 挂钩：进入即武装、离开即
   * 拆除，DR-22-3——停止态进入点多，逐落点手工武装必然漏挂）；周期沿用
   * dsh.probeIntervalSec（O-22-c 已裁决沿用，=0 时一并关闭、配置语义单一）。
   * 认领路径只到达 adopt()，结构性不含 launchManaged()（零 spawn 红线，§4.2
   * 第 4 条，PU-22-4 静态断言钉住）。与既有存活探活器（probeTimer）语义分离
   * （DR-2）：发现探测 = 发现即认领，无失败计数、无判死阈值。
   */
  private discoveryTimer: ReturnType<typeof setInterval> | null = null
  /** 防重入标志：discoveryTick 的认领是异步链，在途时不重复发起（§4.2 第 3 条）。 */
  private discoveryInFlight = false

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
    // 0.1.22（设计 §4.2 第 1 条 / DR-22-3）：发现探活器生命周期严格绑定 stopped
    // 态——进入即武装、离开即拆除（状态机单点挂钩，防逐落点手工武装漏挂）。
    if (s === 'stopped') this.startDiscoveryProbe()
    else this.stopDiscoveryProbe()
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
        // 0.1.21 改动点 5（CR-8）: 快照 channel 的真值来源 = attachedChannel
        // （运行实例的真实启动通道），不再配置直通回显。null = 外部接管实例的
        // 通道确实无法核实（0.1.23 起：external 恢复失败 / 旧记录缺省 / 尚未附着）
        // → 详情卡渲染「未知」，**0.1.23 起不再作待生效断言**（渲染侧三态分支
        // 见 webviewHtml.channelSwitcherHtml）。绝不回退配置值——见字段注释。
        // readRuntimeMeta 仍按配置通道取通道级 meta（lastCheckAt 是配置侧事实，
        // 两种语义分离）。
        channel: this.attachedChannel,
        // 0.1.23（设计 §六 改动点 9 / §5.9）：来源标注随值成对入快照，
        // 与 channel 走同一条数据路径（不存在两个源失同步的可能）。
        channelSource: this.attachedChannelSource,
        externalCommandLine: this.externalCommandLine,
        // 0.1.14 第 16 个可选字段：token 契约档（T 路径）的带 token 直达 URL；
        // legacy/降级快照恒 null（null = 旧契约，不会破坏既有 15 字段消费者）。
        externalUrl: managed ? this.externalUrl : null,
        // 0.1.18 ADR-48：external 接管会话的间接版本事实（adopt 落点装配，
        // memory-only 与 externalCommandLine 同类）。仅 adopt 落点透传——
        // user-stop / disconnect / managed 落点恒 null（§7.2 矩阵第 4 行，
        // 放宽不外溢；external 会话中途断开同样不携带版本事实）。
        // buildLaunchInfo 内部以 degradedLaunchMode 再做同语义把关（双保险，
        // 纯函数直测面）。
        externalDshVersion: args.kind === 'adopt' ? (this.externalVersionFacts?.dirVersion ?? null) : null,
        externalDshVersionNote: args.kind === 'adopt' ? (this.externalVersionFacts?.note ?? null) : null,
        externalCmdlineVersion: args.kind === 'adopt' ? (this.externalVersionFacts?.cmdlineVersion ?? null) : null,
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

  /**
   * 0.1.15 #83 (ADR-31): park this runtime in the awaitingChannel state — the
   * panel renders the channel-pick card and start() runs ONLY after the pick
   * writes `dsh.channel` + `dsh.channelSelected` (先选择通道、后启动dsh: start strictly
   * AFTER the writes; the runtime instance is constructed beforehand — the
   * QuickPick-before-construction ordering premise was disproven).
   */
  enterAwaitingChannel(): void {
    rlog('channel: awaiting the panel channel pick (dsh.channelSelected=false); start() deferred (#83 ADR-31)')
    this.setState('awaitingChannel')
  }

  /**
   * 0.1.15 #83/#84: apply a channel selection to this runtime instance. The
   * next start()/reconnect() launches with it. Without this the config write
   * alone would NOT reach the launch chain (options.channel is the
   * construction-time snapshot — the 0.1.14 「重启生效」 hint was structurally
   * untruthful; minimal correctness completion, see the #86 note).
   */
  setChannel(channel: string): void {
    this.options.channel = channel
    rlog(`channel: runtime channel updated to '${channel}' (panel flow; takes effect on the next start/restart)`)
  }

  /** 0.1.15 #87: the judged contract tier of the running dsh (openInBrowser gate). */
  get contractTier(): ContractTier {
    return this.contract
  }

  /**
   * 0.1.22 改动点 1（设计 §4.1 第 2 条）：per-attach 重置段（原 start() 开头）
   * 抽取共用——start() 与 attachExisting() 的附着起点执行同一份重置（附着记忆
   * 防泄漏纪律：0.1.21 改动点 3/5 的 per-attach 规则对新路径同等生效）。
   * 逐字搬移，行为零变化；startLaunchFailures 仍不在此重置（session-scoped
   * fallback，§4.6.6）。
   */
  private beginAttachment(): void {
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
    // 0.1.18 ADR-48: the previous attachment's external version facts must
    // never leak into this one's snapshots (same per-attach rule as
    // externalCommandLine — memory-only, registry-unpersisted).
    this.externalVersionFacts = null
    // 0.1.21 改动点 3/5: the previous attachment's launch-mode / channel
    // memories must never leak either (same per-attach rule) — the adopt /
    // managed landing re-assigns both before any ready emit.
    this.attachedLaunchMode = null
    this.attachedChannel = null
    // 0.1.23（设计 §5.2.2 末段）：来源标注与 attachedChannel 同步重置，防跨附着泄漏。
    this.attachedChannelSource = null
    // 0.1.14 ADR-30 per-attach reset: the previous attachment's proxy/session
    // facts must never leak (a fresh managed launch re-judges the contract).
    this.contract = 'unknown'
    this.authToken = null
    this.externalUrl = null
    this.sessionCookie = null
    this.sessionRetried = false
    this.authFailures = 0
    this.stopProxy()
  }

  /**
   * 0.1.22 改动点 1（设计 §4.1 第 1 条）：start() 的 step1（注册表复用认领）+
   * step2（配置端口探测认领）逐字抽取为共享私有方法——start() 与
   * attachExisting() 消费同一发现判定（DR-22-1：认领链只此一份）。返回是否
   * 完成认领（true = 已认领且存活探活器已武装；false = 无实例可认领）。
   * 逻辑与全部 rlog 锚逐字保留，start() 行为零变化（纯结构抽取）。
   */
  private async tryAdoptExisting(): Promise<boolean> {
    // 1. Registry: a live managed-own/extension/external dsh we already know?
    const inst = readInstance()
    const registryAlive = dshAlive(inst)
    // 0.1.14 判定表 #3 行: an unauthorized answer is still PROOF the service
    // is alive (401 = runtime auth fact) — the record stays adoptable and the
    // probeTick 401 diversion (C path) establishes the session afterwards.
    // `down` keeps the pre-0.1.14 not-adoptable verdict (zero regression).
    const registryProbeKind = registryAlive && inst.dsh ? (await this.probeState(inst.dsh.port)).kind : 'down'
    const registryProbed = registryProbeKind !== 'down'
    rlog(`step1 registry: dsh=${JSON.stringify(inst.dsh)} alive=${registryAlive} probe=${registryProbed}${registryProbeKind === 'unauthorized' ? ' (401: alive, session required — adopting, C path will follow)' : ''}`)
    if (registryAlive && registryProbed && inst.dsh) {
      // Re-adopt the still-resident detached dsh (F1 / P0-H): no spawn.
      // 0.1.15 #81: the step1 probe result rides along — the session settles
      // inside adopt() (C path front-load / legacy direct) BEFORE ready.
      // 0.1.21: the record rides along too (attachedLaunchMode/attachedChannel
      // memory source, 改动点 3/5).
      await this.adopt(inst.dsh.port, inst.dsh.pid, inst.dsh.managedBy, registryProbeKind, inst.dsh)
      await this.writeRegistry()
      this.startProbe()
      return true
    }
    if (inst.dsh && inst.dsh.pid !== null && isAlive(inst.dsh.pid) && !registryProbed) {
      rlog(`step1: 疑似上轮残留 detached dsh pid=${inst.dsh.pid} port=${inst.dsh.port}（probe 失败但 pid 存活）；按注册表引导排查`)
    }

    // 2. Probe the configured port for an external instance.
    const probePort = this.options.port > 0 ? this.options.port : 0
    // 0.1.14: 401-aware like step1 — an external token-contract instance
    // answers 401 to the bare probe (RV-15-4 C path); alive ≠ dead.
    const probeKind = probePort > 0 ? await this.probeState(probePort) : null
    const probeOk = probeKind !== null && probeKind.kind !== 'down'
    rlog(`step2 probe(port=${probePort})=${probeOk}${probeKind?.kind === 'unauthorized' ? ' (401: alive, session required)' : ''}`)
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
            // 0.1.15 #81: probeKind rides along (QA r1 MINOR-1 — all 4 call sites).
            // 0.1.21: the (stale) record rides along too — its pid differs from
            // the adopted holder pid, so the memory source rejects its fields
            // (honest null; 改动点 3/5).
            await this.adopt(probePort, holder.pid, 'managed-own', probeKind?.kind ?? null, rec)
            await this.writeRegistry()
            this.startProbe()
            return true
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
      // 0.1.15 #81: probeKind rides along — the session settles inside adopt().
      // 0.1.21: the record rides along too (same-pid re-adoption of a previous
      // external record trusts nothing extra — its fields are absent by
      // contract; 改动点 3/5).
      await this.adopt(probePort, pid, 'external', probeKind?.kind ?? null, inst.dsh)
      await this.writeRegistry()
      this.startProbe()
      return true
    }
    return false
  }

  /**
   * 0.1.22 改动点 2（设计 §4.1 第 3 条）：只附着、不拉起——激活链（dsh.autoStart
   * 语义收敛）与面板选通道流程 / dsh.reconnect 命令的 runtime 落点。复用
   * beginAttachment() 的 per-attach 重置（附着记忆防泄漏纪律对新路径同等生效）
   * 与 tryAdoptExisting() 的发现判定（DR-22-1：认领链只此一份）。无实例可认领
   * 时如实进入停止态（零 spawn，结构性不调用 launchManaged），由停止态发现
   * 探活器（§4.2）接力自动重连。返回是否已处于附着/就绪。
   */
  async attachExisting(): Promise<boolean> {
    if (this.attached || this.state === 'ready') return true
    this.beginAttachment()
    this.setState('starting')
    rlog(`attachExisting: window ${this.options.windowPid} (port=${this.options.port} channel=${this.options.channel}) — attach-only, no launch`)
    const adopted = await this.tryAdoptExisting()
    if (adopted) return true
    // 无实例可认领：如实进入停止态（不 spawn），由停止态发现探活接力（§4.2）。
    // V3-1/DR-22-10（落点 #1）：失败路径必须复位 attached（beginAttachment 已置
    // true）——与 start() step4 失败先例（先复位后落态）同型；不复位则本方法
    // 残留 attached=true，▶ dsh.start 被 start() 入口守卫拦截、⟳ 重连被本方法
    // 守卫谎报成功，双向失效（QA v3-r1 V3-1）。
    this.stopProxy()
    this.attached = false
    this.setState('stopped')
    rlog('attachExisting: no running dsh found; entering stopped (no auto-launch per user policy 2026-09-10)')
    return false
  }

  /** Called once per extension activation: re-adopt / adopt / managed-launch.
   *  0.1.22：per-attach 重置与 step1/step2 已抽取为 beginAttachment() /
   *  tryAdoptExisting()（设计 §4.1 第 1/2 条，纯结构抽取，行为零变化）。 */
  async start(): Promise<void> {
    if (this.attached || this.state === 'ready') return
    this.beginAttachment()
    this.setState('starting')
    rlog(`start: window ${this.options.windowPid} (port=${this.options.port} channel=${this.options.channel} command=${this.options.command || '<npx>'})`)
    if (await this.tryAdoptExisting()) return

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
    // 0.1.22 结构抽取注：原代码引用 step2 局部变量 probePort（= options.port
    // 归一化），step2 已抽取进 tryAdoptExisting——此处从 options 等价重算
    //（probePort > 0 ? probePort : 0 ≡ probePort ≡ 本表达式），零行为偏离。
    const cfgPort = this.options.port > 0 ? this.options.port : 0
    const adopted = await this.waitForExternalStartup(cfgPort)
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
      // 0.1.21（实施清单第 8 项）: the DshProcess instance comes from the
      // injectable factory when one is provided (spawn-count seam for the
      // PU-21-1/5 headless tests); absent = the byte-identical default path.
      const proc = this.options.dshProcessFactory
        ? this.options.dshProcessFactory({
            port: usePort,
            channel: this.options.channel,
            command: this.options.command,
            dshHome: this.options.dshHome,
            consoleVisible: this.options.consoleVisible,
            launchMode: mode,
            resolvePortPidFn: this.options.resolvePortPidFn,
          })
        : new DshProcess({
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
        // 0.1.21 改动点 3/5: the landing assignment of BOTH attachment memories
        // — attachedLaunchMode = the ACTUAL attempt mode (death-branch form
        // discriminator), attachedChannel = the channel this instance was
        // actually launched with (= this.options.channel at launch time; the
        // snapshot / registry channel truth source).
        this.attachedLaunchMode = mode
        this.attachedChannel = this.options.channel
        // 0.1.23（设计 §5.2.1 第 4 步 / §六 改动点 6）：来源标注 = 'launch-option'
        // ——受管拉起时 options.channel 就是本次实例实际启动所用的通道，属直接
        // 事实（「据启动配置」）。
        this.attachedChannelSource = 'launch-option'
        this.lastResolved = info.resolved
        this.lastLaunchLogFile = info.logFile
        this.port = info.port
        // 0.1.15 #80①: `this.url` is assigned ONLY at the session settle point
        // (applyContractOnLaunch below: proxy URL for token sessions, the bare
        // URL for the legacy/unknown direct tier). Starting holds with url=null
        // — the ready first frame is always the FINAL url (no mid-flight
        // address updates; user ruling v1.3).
        this.managedBy = 'managed-own'
        this.launchAttempts = 0
        this.startLaunchFailures = 0 // §4.6.3: any success resets the fallback counter
        // 0.1.14 ADR-30 (§3.3 判定链): version-threshold contract judgement on
        // the RUNNING version (SpawnedInfo.resolved.version — the dual-end
        // single source; banner capture stays the token-VALUE source only),
        // then the tier's surface (proxy / externalUrl / token rlog trace).
        // Runs BEFORE writeRegistry/setState so the first ready snapshot and
        // the registry-era launchInfo already carry the final url shape.
        this.contract = judgeContractByVersion(info.resolved?.version ?? null)
        this.authToken = info.authToken
        this.externalUrl = null
        rlog(
          `launchManaged: contract judged '${this.contract}' ` +
            `(running version = ${info.resolved?.version ?? 'unavailable'}, threshold = version-anchored; banner token ${info.authToken !== null ? 'captured (token=<REDACTED>)' : 'absent'})`,
        )
        await this.applyContractOnLaunch()
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
            rlog('start-launch repeatedly failed; falling back to direct spawn (0.1.8 behavior) — direct = 无常驻窗口降级态 (violates the ADR-20 resident-console ruling; NOT an acceptance shape)')
          }
        } else {
          rlog(`launchManaged: attempt #${this.launchAttempts} failed: ${msg}`)
        }
        if (this.launchAttempts >= MAX_RESTARTS) {
          this.errorMessage = `dsh failed to start after ${MAX_RESTARTS} attempts (detached); last: ${msg}`
          // 0.1.22 DR-22-10/V3-1（落点 #5）：进入 error 前 attached 复位（先复位
          // 后落态，与 step4 失败先例同型）。
          this.attached = false
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

  // ------------------------------------------------ 0.1.14 ADR-30 surface

  /**
   * Apply the judged contract tier on a successful managed launch (§3.3 判定表;
   * all state changes happen BEFORE the caller writes the registry). This is
   * ALSO the managed-side URL settle point (#80① — the former L464 eager
   * `this.url = info.url` moved here):
   *  #1 token    : banner token in hand → T-path proxy + externalUrl; the
   *                 panel url becomes the proxy URL (iframe 语义 §3.4).
   *  #2 legacy   : bare URL, direct — 0.1.13 behavior BIT-IDENTICAL (#2 行).
   *  #4 矛盾态 A : banner has a token but version < V* → defensively align to
   *                 the token contract (start the proxy) + WARN BOTH FACTS.
   *  #5 矛盾态 B : version ≥ V* but no banner token → keep the version-side
   *                 verdict, fall back to the C path (self-minted cookie) with
   *                 the ADR-32 ONE live verification; on any C failure the
   *                 surface stays URL-less (no proxy, no fake session) and the
   *                 existing 401 diversion owns the retry (#82).
   *  #3 unknown  : direct start (latest takeover zero-regression); the
   *                 probeTick 401 diversion upgrades to a C-path proxy later.
   */
  private async applyContractOnLaunch(): Promise<void> {
    if (this.port === null) return
    if (this.contract === 'token') {
      if (this.authToken !== null) {
        // #1 行 (and #4 行 handles itself below when the token exists).
        this.externalUrl = `http://${LOOPBACK_HOST}:${this.port}/?token=${this.authToken}`
        await this.establishProxy({ token: this.authToken })
        return
      }
      // #5 行 (矛盾态 B): version ≥ V* but no banner token.
      rlog(
        `WARN contract: contradictory facts — version ${this.lastResolved?.version ?? 'n/a'} ≥ threshold but the banner carries NO token ` +
          `(judgement table #5): keeping the version-side token contract, C-path session fallback (rlog both facts)`,
      )
      const cookie = this.mintCookieFromCredentials()
      if (cookie !== null) {
        this.sessionCookie = cookie
        // ADR-32: ONE live verification before any proxy surface (#81 判据).
        if (await this.liveVerifySession()) {
          rlog('C path: minted cookie live-verified')
          if (await this.establishProxy({ cookie })) return
          rlog('contract: proxy start failed after a live-verified cookie; no URL — the 401 diversion owns the retry')
          return
        }
        rlog('C path: minted cookie rejected by live upstream; no proxy, no URL — the 401 diversion owns the retry')
        this.sessionCookie = null
        return
      }
      rlog('contract: C-path session unavailable (credentials unreadable or mint failed); no URL — the 401 diversion owns the retry')
      return
    }
    if (this.contract === 'legacy' && this.authToken !== null) {
      // #4 行 (矛盾态 A): token banner on a sub-threshold version.
      rlog(
        `WARN contract: contradictory facts — banner HAS a token but version ${this.lastResolved?.version ?? 'n/a'} < threshold ` +
          `(judgement table #4): defensively aligning to the token contract (proxy up), rlog both facts`,
      )
      this.externalUrl = `http://${LOOPBACK_HOST}:${this.port}/?token=${this.authToken}`
      await this.establishProxy({ token: this.authToken })
      return
    }
    // #2 legacy direct / #3 unknown direct — the URL settles at the bare value
    // here (managed-side #80①; the sim PP-8-6④ bare-URL equality holds).
    this.url = `http://${LOOPBACK_HOST}:${this.port}`
  }

  /**
   * Start (or restart) the local authProxy for the current port. The panel
   * url becomes the proxy URL on success (bakedUrl re-bake machinery in the
   * webview picks the new same-shaped URL up). Previous proxy is stopped
   * first (R9 lifecycle; token rotation = new proxy with the new session).
   */
  private async establishProxy(session: { token?: string | null; cookie?: string | null }): Promise<boolean> {
    this.stopProxy()
    if (this.port === null) return false
    try {
      const handle = await startAuthProxy(this.port, { token: session.token ?? null, cookie: session.cookie ?? null }, { log: rlog })
      this.proxy = handle
      this.url = `http://${LOOPBACK_HOST}:${handle.port}`
      rlog(`authProxy: panel url switched to ${this.url} (upstream ${LOOPBACK_HOST}:${this.port}; iframe CSP unchanged — same ${LOOPBACK_HOST}:* host-source)`)
      return true
    } catch (err) {
      rlog(`authProxy: start failed (${(err as Error).message}); keeping the direct surface`)
      return false
    }
  }

  /** C path (§3.7): self-mint the session cookie from the dsh credentials file. */
  private mintCookieFromCredentials(): string | null {
    const secret = readCredentialsSecret(this.options.dshHome)
    if (secret === null) {
      rlog('C path: `<DSH_HOME>/.credentials.yaml` secret unreadable (file missing or record malformed)')
      return null
    }
    if (this.port === null) return null
    const cookie = mintSessionCookie(secret, `${LOOPBACK_HOST}:${this.port}`)
    if (cookie === null) {
      rlog('C path: session cookie mint failed (secret/authority malformed)')
      return null
    }
    rlog('C path: session cookie self-minted from the persistent secret (memory-only; file read-only, never written back)')
    return cookie
  }

  /** R9: stop and drop the proxy handle (idempotent; every state landing calls this). */
  private stopProxy(): void {
    if (this.proxy !== null) {
      try {
        this.proxy.stop()
      } catch {
        /* best-effort */
      }
      this.proxy = null
    }
  }

  /**
   * §3.5: the single session re-establishment for this attachment — re-capture
   * the banner token (managed log) and rebuild the proxy; with no usable
   * banner token fall back to the C path. Returns whether a NEW session
   * surface was established (the next probe tick verifies it).
   */
  private async reestablishSession(): Promise<boolean> {
    if (this.lastLaunchLogFile !== null) {
      const banner = resolveBannerFromLog(this.lastLaunchLogFile)
      if (banner !== null && banner.token !== null && banner.token !== this.authToken && this.port === banner.port) {
        rlog('session re-establishment: NEW banner token captured (token=<REDACTED>); rebuilding the proxy (token rotation)')
        this.authToken = banner.token
        this.externalUrl = `http://${LOOPBACK_HOST}:${this.port}/?token=${this.authToken}`
        return this.establishProxy({ token: this.authToken })
      }
    }
    rlog('session re-establishment: no fresh banner token; falling back to the C path (self-minted session)')
    const cookie = this.mintCookieFromCredentials()
    if (cookie === null) return false
    this.sessionCookie = cookie
    return this.establishProxy({ cookie })
  }

  /**
   * The single probe SOURCE with tri-state semantics (§3.5): form selection —
   * token tier + banner token → token-303; a HELD C-path session (token-tier
   * #5 fallback OR the post-diversion #3/#4 C-path upgrade) → cookie probe;
   * otherwise bare GET (legacy/unknown before any session; a 401 answer still
   * surfaces as 'unauthorized' so the diversion can act). The cookie form
   * applies ACROSS tiers once a session is held: after the diversion upgrades
   * a legacy/unknown attachment to a C-path proxy, the bare form would 401
   * forever (panel usable while the runtime falsely errors) — the cookie probe
   * verifies the session the panel actually uses.
   */
  private async probeState(port: number): Promise<{ kind: ProbeKind }> {
    if (this.contract === 'token' && this.authToken !== null) return probeDetail(port, { token: this.authToken })
    if (this.sessionCookie !== null) return probeDetail(port, { cookie: this.sessionCookie })
    return probeDetail(port)
  }

  /**
   * 0.1.15 #80①/#81 (judgement table #6; ADR-32/33): the adopt landing point
   * now SETTLES THE SESSION before any ready emit — `this.url` stays null
   * during `starting` and is assigned only here, once:
   *  - probe 401 ('unauthorized') = live auth fact → token contract (ADR-33,
   *    never a guessed version) → C path front-loaded: mint from credentials →
   *    ONE live verification GET → 200: establishProxy BEFORE setState('ready')
   *    (the ready first frame IS the final proxy URL — no 401 flash, no re-bake
   *    race) + rlog `C path: minted cookie live-verified`;
   *    401/verification rejected: NO proxy, NO url + rlog `C path: minted
   *    cookie rejected by live upstream` → setState('error') with the #82
   *    guidance (honest degradation — never pretend a session works);
   *  - probe 200 → legacy direct (the settled url = the bare URL) — zero
   *    regression for the pre-0.1.14 contract;
   *  - defensive null/down (unreachable via the step1/2/4 gates) → direct +
   *    rlog, contract stays 'unknown'.
   * The former bare-URL eager assignment + eager `setState('ready')` (0.1.14
   * L691/L699) are GONE — starting holds until the session settles (#80①).
   *
   * 0.1.21 改动点 3/5：`rec`（认领落点的注册表记录，可缺省）是
   * attachedLaunchMode / attachedChannel 两条附着记忆的赋值源——
   *  - attachedLaunchMode = rec.launchMode ?? null（记录缺失 / external 记录
   *    显式置 null，不是保持原值——v5 QA H-5）；
   *  - attachedChannel = rec.channel ?? null（不回退配置值，CR-8）。
   *    记录的 pid 与被认领 pid 不一致（stale 记录描述的不是本进程）时不采信
   *    记录字段，同归 null（快照只陈述运行实例的事实）。
   *
   * 0.1.23（设计 §5.2.1，QA-D23-r2-01 方案 A）：`attachedChannel` 不再对
   * external 恒为 null——恢复成功即填真值、来源标注成对写 `attachedChannelSource`。
   * 新增**可选**第 6 参 `knownCommandLine`：调用方本 tick / 本步已取到的运行
   * 进程命令行原文（未截断）。仅 discovery-port 路径（经 discoveryAdopt 透传）
   * 传值；其余 4 个调用点（step1 / step2 残余迁移 / step2 / step4）不传、行为
   * 不变（向后兼容由设计 §四探针 8 的调用点枚举 + CH-23-7⑤ 运行时断言双重支撑）。
   * 之所以走显式传参而不是复用实例字段：discoveryAdopt 首句 beginAttachment()
   * 会在 adopt 之前把 this.externalCommandLine 置 null，字段复用在该路径上永假。
   */
  private async adopt(
    port: number, pid: number | null, managedBy: ManagedBy, probeKind: ProbeKind | null,
    rec?: DshRecord | null,
    knownCommandLine?: string | null,
  ): Promise<void> {
    this.port = port
    this.managedBy = managedBy
    this.dshPid = pid
    // 0.1.21 改动点 3/5: 认领落点赋值两条附着记忆（见上方方法注释；记录缺失
    // / pid 不一致 → 双双显式置 null，per-attach 记忆绝不泄漏）。
    const adoptedRec = rec !== undefined && rec !== null && pid !== null && rec.pid === pid ? rec : null
    this.attachedLaunchMode = adoptedRec?.launchMode ?? null
    this.attachedChannel = adoptedRec?.channel ?? null
    // 0.1.23（设计 §5.2.1 第 1 / 2 / 3 步 / §六 改动点 7）：通道恢复判定序列。
    //  - 第 1 步（跳过判据，QA-D23-11）：old record 已带 channel（记录即缓存）
    //    → 直接用记录值，source = 'registry'，零新增查询——同 pid 重复认领、
    //    跨窗口重连全部走此分支；
    //  - 第 2 步（仅 external 且第 1 步未命中）：按 2a-(i) knownCommandLine 优先 →
    //    2a-(ii) this.externalCommandLine → 2b 补一次 processCommandLine 的顺序
    //    取命令行，再经纯函数 recoverChannelFromCmdline 反查；成功 → source =
    //    'cmdline'，失败 → 双双 null（诚实降级，rlog 留痕）；
    //  - 第 3 步（managed-own / extension 记录含 channel）：由第 1 步覆盖。
    if (adoptedRec?.channel !== undefined) {
      this.attachedChannel = adoptedRec.channel
      this.attachedChannelSource = 'registry'
    } else {
      this.attachedChannelSource = null
      if (managedBy === 'external') this.recoverChannelFromKnownCmdline(pid, knownCommandLine)
    }
    // 0.1.18 ADR-48 (§3.3): external 接管路径在快照装配前完成只读版本扫描 +
    // 命令行版本提取。step1 re-adopt 场景 externalCommandLine 为 null（start()
    // 开头 per-attach 重置且注册表不落盘）→ 命令行版本恒 null，目录版本仍可得
    // （扫描不依赖命令行）；step4 等待后接管的 adopt 无命令行 → 仅目录版本。
    // managed-own / extension 接管不装配（三字段维持 null，语义分离）。
    if (managedBy === 'external') this.assembleExternalVersionFacts()
    // ADR-22: assemble the snapshot BEFORE the ready-state emit so subscribers
    // never observe a stale snapshot; writeRegistry (right after, at every
    // call site) re-assembles with the authoritative fresh record. rec = null:
    // the pre-write record would be stale (external/migration adopts).
    this.refreshLaunchInfo({ kind: 'adopt', rec: null })
    rlog(`adopt: ${managedBy} dsh at http://${LOOPBACK_HOST}:${port} (pid ${pid ?? 'null'}; probe=${probeKind ?? 'null'}) — url withheld until the session settles (#80: starting holds; ready first frame = final URL)`)
    if (probeKind === 'unauthorized') {
      // 401 = the process is alive and demands a session → token contract by
      // the LIVE auth fact (judgement table #6; ADR-33).
      this.contract = 'token'
      const cookie = this.mintCookieFromCredentials()
      if (cookie === null) {
        rlog('adopt C path: credentials unreadable or mint failed (#82 honest degradation: no proxy, no URL)')
        this.enterSessionUnavailable()
        return
      }
      this.sessionCookie = cookie
      // ADR-32: ONE live verification of the self-minted cookie BEFORE any
      // proxy/ready surface (single read-only GET, same permission face as the
      // existing probe).
      if (!(await this.liveVerifySession())) {
        rlog('C path: minted cookie rejected by live upstream (#82 honest degradation: no proxy, no URL)')
        this.sessionCookie = null
        this.enterSessionUnavailable()
        return
      }
      rlog('C path: minted cookie live-verified')
      if (!(await this.establishProxy({ cookie }))) {
        rlog('adopt C path: proxy start failed after a live-verified cookie (#82 honest degradation: no URL)')
        this.sessionCookie = null
        this.enterSessionUnavailable()
        return
      }
      // ready first frame = final proxy URL (establishProxy already assigned
      // this.url; PP-10-2 order: probe → mint → live GET → establishProxy → ready).
      this.setState('ready')
      return
    }
    // probe 200 → legacy direct (judgement table #6: bare probe 200 = legacy
    // contract; the settled url = the bare URL — pre-0.1.14 behavior, zero
    // regression). Defensive null/down keeps the direct surface + honest log.
    if (probeKind !== 'ok') {
      rlog(`adopt: probe=${probeKind ?? 'null'} reached the settle point (unreachable via the step gates); direct surface as the safe side`)
    } else {
      this.contract = 'legacy'
    }
    this.url = `http://${LOOPBACK_HOST}:${port}`
    this.setState('ready')
    rlog(`adopt: direct legacy surface settled at ${this.url} (probe=${probeKind ?? 'null'})`)
  }

  /**
   * 0.1.23（设计 §5.2.1 第 2 步 / §5.8 成本模型）：external 认领路径的通道恢复。
   *
   * 复用优先顺序（决定新增查询次数的唯一地方）：
   *  2a-(i)  `knownCommandLine` 非空（discovery-port 经 discoveryAdopt 显式传参）
   *          → 直接喂 recoverChannelFromCmdline，零新增查询；
   *  2a-(ii) 否则 `this.externalCommandLine` 非空（step2 在 adopt 前写入的 300
   *          截断值，adopt 时未被清空）→ 同样零新增查询。截断安全性见设计 §四
   *          探针 7：截断只会让 token 缺席（提不出 → 诚实降级），不会造出假值；
   *  2b     两者皆空且 pid 非 null → 补一次 processCommandLine(pid, 15_000)
   *          （与 step2 的既有调用同函数同预算）。这条路径只在「记录缺 channel
   *          且调用方未传命令行且本窗口无字段」时发生——step1 / step4 /
   *          discovery-registry 三条，且因成功后会写回注册表，频率上限是
   *          「每个外部 dsh 进程生命周期一次」。
   *
   * 恢复结果赋值（2c）：成功 → attachedChannel = 恢复值 + source = 'cmdline'；
   * 失败 → 双双保持 null（诚实降级），并写 rlog 留痕（含命令行片段与提取到的
   * 目录名），使上游 npm 算法漂移可被观测而不是静默失效（设计 §5.7 R-7）。
   * 本方法不抛错——processCommandLine 自身 never-throw（失败/超时/非 win32 → null）。
   */
  private recoverChannelFromKnownCmdline(pid: number | null, knownCommandLine?: string | null): void {
    const index = buildChannelSpecIndex(DSH_PKG, DSH_CHANNELS)
    const known = typeof knownCommandLine === 'string' && knownCommandLine.length > 0 ? knownCommandLine : null
    const field = typeof this.externalCommandLine === 'string' && this.externalCommandLine.length > 0
      ? this.externalCommandLine
      : null
    const reusedFrom = known !== null
      ? 'knownCommandLine (discovery-port 显式传参)'
      : field !== null
        ? 'externalCommandLine (step2 字段复用，300 截断值)'
        : null
    let cmdline: string | null
    if (known !== null) {
      cmdline = known
    } else if (field !== null) {
      cmdline = field
    } else if (pid !== null) {
      cmdline = processCommandLine(pid, 15_000)
      rlog(`adopt channel recovery: no known command line on hand; queried processCommandLine(${pid}, 15000)=${cmdline ? cmdline.slice(0, 300) : 'null (CIM failed/empty)'}`)
    } else {
      cmdline = null
    }
    const fact: ChannelFact = recoverChannelFromCmdline(cmdline, index)
    if (fact.channel !== null && fact.source !== null) {
      this.attachedChannel = fact.channel
      this.attachedChannelSource = fact.source
      rlog(`adopt channel recovery: recovered channel '${fact.channel}' from npx cache dir ${fact.npxDirName ?? '<none>'} (evidence=${reusedFrom ?? 'processCommandLine'})`)
      return
    }
    // 诚实降级：值与其来源一并保持 null（配对不变式），并留痕说明为何没恢复出来。
    this.attachedChannel = null
    this.attachedChannelSource = null
    rlog(
      `adopt channel recovery: no channel fact (honest degradation; config value is NOT used as a fallback) — ` +
        `cmdline=${cmdline === null ? 'null (unavailable)' : `'${cmdline.slice(0, 200)}'`} ` +
        `npxDirName=${fact.npxDirName ?? 'null (not an npx cache form or truncated away)'} evidence=${reusedFrom ?? 'processCommandLine'}`,
    )
  }

  /**
   * 0.1.15 #82: the one-shot honest-degradation landing — no proxy, no URL
   * (the panel renders no address), error state with the restart guidance
   * copy. The subsequent reconnect() re-runs the full adopt settle.
   */
  private enterSessionUnavailable(): void {
    this.stopProxy()
    this.errorMessage = ADOPT_SESSION_UNAVAILABLE_MESSAGE
    // 0.1.22 DR-22-10/V3-1（落点 #6）：进入 error 前 attached 复位（adopt 会话
    // 失败共用落点；与 step4 失败先例同型）。
    this.attached = false
    this.setState('error')
    this.emit('error', this.errorMessage)
  }

  /**
   * 0.1.18 ADR-48 (§3.3): assemble the external-takeover version facts at the
   * adopt landing point (before the snapshot assembly):
   *  - S2 主源 = scanNpxCacheReadonly()（npxRoot() 整根只读扫描，µs 级；无网络、
   *    无安装、无 meta 写入——dshResolver 只读契约）。无候选/目录不可读 →
   *    dirVersion=null + note=null（诚实降级，详情卡维持「版本未知」）。
   *  - S1 = extractVersionFromCommandLine(this.externalCommandLine)（条件可得：
   *    用户启动 spec 含精确版本时命中；step1 re-adopt / step4 无命令行 → null）。
   * 扫描失败（异常，契约外防御分支）→ 三字段 null + rlog 留痕（非阻塞，不抛
   * 出——launchInfo 装配失败绝不破坏生命周期）。仅命令行可得（仅命令行象限，
   * §7.2 矩阵第 3 行）→ externalDshVersion/Note 为 null、cmdlineVersion 透传。
   */
  private assembleExternalVersionFacts(): void {
    try {
      const scan = scanNpxCacheReadonly()
      const cmdlineVersion = extractVersionFromCommandLine(this.externalCommandLine)
      const dirVersion = scan?.version ?? null
      this.externalVersionFacts = {
        dirVersion,
        note: buildExternalVersionNote(dirVersion, scan?.candidateCount ?? 0),
        cmdlineVersion,
      }
      rlog(
        `adopt external version facts (0.1.18 ADR-48, readonly scan): dir=${dirVersion ?? 'null'} ` +
          `(candidates=${scan?.candidateCount ?? 0}), cmdline=${cmdlineVersion ?? 'null'}` +
          (dirVersion !== null && cmdlineVersion !== null && dirVersion !== cmdlineVersion
            ? ' (MISMATCH: the display layer renders the ADR-48 warning line)'
            : ''),
      )
    } catch (err) {
      // 扫描/提取失败非阻塞：三字段 null + rlog 留痕（诚实降级，不抛出）。
      this.externalVersionFacts = null
      rlog(`adopt external version facts failed (ignored, three fields -> null): ${(err as Error).message}`)
    }
  }

  /**
   * ADR-32 (#80③/#81): ONE live verification of the currently held session
   * facts (token-303 form when a banner token is in hand, cookie form when a
   * C-path session is held — probeState picks the form). Read-only GET, same
   * permission face as the existing probe.
   */
  private async liveVerifySession(): Promise<boolean> {
    if (this.port === null) return false
    const outcome = await this.probeState(this.port)
    return outcome.kind === 'ok'
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
    // 0.1.16 #97 (ADR-40): processStartedAt — keep semantics shared with
    // startedAt/launchMode: the process creation instant is IMMUTABLE, so a
    // same-pid re-write reuses the recorded value with ZERO queries. A record
    // without the field (pre-0.1.16) re-queries once (self-healing, §3.5-5);
    // a fresh pid queries exactly once (bounded 5s cap). A null query result
    // (failure / timeout / non-win32 / no resolved pid) OMITS the field — the
    // flow never breaks and the card shows 未知 (never falls back to
    // startedAt, ADR-40④: two semantics must not re-mix in one cell).
    // Default seam = the real query with its DESIGN BUDGET (5s cap, §3.5-2);
    // the one-arg processStartQuery contract stays the injection surface.
    const processStartQuery = this.options.processStartQuery ??
      ((pid: number) => queryProcessStartTimeSync(pid, PROCESS_START_QUERY_TIMEOUT_MS))
    let processStartedAt: string | undefined
    if (keepDshStartedAt && prev !== null && typeof prev.processStartedAt === 'string') {
      processStartedAt = prev.processStartedAt
    } else if (this.dshPid !== null) {
      const queried = processStartQuery(this.dshPid)
      if (queried !== null) processStartedAt = queried
      else rlog(`writeRegistry: processStartedAt query failed (pid ${this.dshPid}) — record omits the field (card shows 未知; ADR-40)`)
    }
    inst.dsh = {
      pid: this.dshPid ?? null,
      port: this.port ?? this.options.port,
      managedBy: this.managedBy ?? 'managed-own',
      startedAt: keepDshStartedAt && prev !== null ? prev.startedAt : new Date().toISOString(),
      // ADR-21 #22: actual attempt mode on a fresh launch; the record's value
      // on re-adopt; absent (JSON-dropped undefined) for external/old records
      // (= direct semantics, backward compatible).
      launchMode: keepDshStartedAt && prev !== null ? prev.launchMode : (this.lastLaunchMode ?? undefined),
      // 0.1.21 改动点 5（设计 §3.4 D-2 改动点 5 / §7.1），0.1.23 重写（设计 §5.2.2，
      // QA-D23-10）：可选 channel 字段，launchMode / processStartedAt 同型的
      // keep-reuse 先例，但 keep 条件多一个「旧记录确实带 channel」。三分支：
      //  ① 新 pid（keepDshStartedAt 假）→ 取 attachedChannel：managed 拉起写
      //     options.channel；external 恢复失败写 undefined（被 JSON 丢弃，维持
      //     0.1.21 的诚实缺省边界）。
      //  ② 同 pid 重新认领且旧记录**有** channel → 保留记录原值（注册表真值不因
      //     认领窗口漂移；一次恢复失败不得擦掉已记录的真值）。
      //  ③ 同 pid 重新认领且旧记录**无** channel → 取本次的 attachedChannel：
      //     本次恢复成功即写入。**这正是打破「不写 → 读不到 → 显示未知 → 仍然不写」
      //     这个自我延续闭环的那一步**（0.1.21 的旧表达式在此分支恒取
      //     prev.channel = undefined → 永远补不上通道）。
      // 0.1.23 修订（原注释理由已失效）：旧写法保留「external 认领不写」的理由是
      // 「插件无法核实外部进程真实通道」，该前提已被本机实测证伪（运行进程命令行
      // 里的 npx 缓存目录名可精确反查出启动 spec，见 channelProbe）；现在的规则是
      // 「核实成功则写、核实失败仍不写」。
      channel: keepDshStartedAt && prev !== null && prev.channel !== undefined
        ? prev.channel
        : (this.attachedChannel ?? undefined),
      // 0.1.16 #97 (ADR-40): see the block above — keep-reuse / fresh
      // query-once / failure omits the field (undefined is JSON-dropped).
      processStartedAt,
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
      // 0.1.14: 401-aware (alive verdict) — same rationale as step1/step2.
      const state = port > 0 ? await this.probeState(port) : null
      if (inst.dsh && state !== null && state.kind !== 'down') {
        // 0.1.15 #81: the step4 probe result rides along (waiting scenario).
        // 0.1.21: the record rides along too (winner-written launch facts;
        // 改动点 3/5).
        await this.adopt(port, inst.dsh.pid, inst.dsh.managedBy, state.kind, inst.dsh)
        await this.writeRegistry()
        this.startProbe()
        return true
      }
      await sleep(500)
    }
    return false
  }

  // ------------------------------------------------------------ probes

  /**
   * GET / on the port answers with the DSH bootstrap page (boolean view of the
   * tri-state probe source; kept for existing callers/readability).
   */
  async probe(port: number): Promise<boolean> {
    return (await this.probeState(port)).kind === 'ok'
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

  /**
   * 0.1.22 改动点 3（设计 §4.2 第 1/2 条）：发现探活器武装/拆除——形态与
   * startProbe()/stopProbe() 同构。武装点统一在 setState('stopped') 挂钩
   * （DR-22-3）；probeIntervalSec=0（既有「关闭探活」语义）时一并关闭。
   */
  private startDiscoveryProbe(): void {
    this.stopDiscoveryProbe()
    if (this.probeIntervalMs() <= 0 || this.state !== 'stopped') return
    rlog(`discovery: armed every ${this.probeIntervalMs()}ms (stopped-state discovery; adopt-only, no launch)`)
    this.discoveryTimer = setInterval(() => { void this.discoveryTick() }, this.probeIntervalMs())
  }

  private stopDiscoveryProbe(): void {
    if (this.discoveryTimer !== null) {
      clearInterval(this.discoveryTimer)
      this.discoveryTimer = null
    }
  }

  /**
   * 0.1.22 改动点 3（设计 §4.2 第 3 条）：停止态发现探活 tick——候选发现与
   * start() step1/step2 同源判定（顺序：注册表优先、端口探测兜底），命中后经
   * discoveryAdopt 认领（零 spawn，结构性不触达 launchManaged）。用户停止守卫
   * （F-1/M-8）：本窗口主动断开（stopRequested=true）且候选就是刚断开的那个
   * pid 时跳过认领（不自动连回用户刚停止的实例，rlog 留痕）；记录换成其他
   * pid（实例换了）或端口上出现新实例时正常认领。
   */
  private async discoveryTick(): Promise<void> {
    if (this.state !== 'stopped' || this.discoveryInFlight) return
    this.discoveryInFlight = true
    try {
      // 候选发现 a)：注册表活记录优先（与 start() step1 同型判定，401-aware——
      // unauthorized 仍是「服务存活」的认证事实，记录可认领；down 才落空）。
      const inst = readInstance()
      const rec = inst.dsh
      if (dshAlive(inst) && rec !== null) {
        const registryProbeKind = (await this.probeState(rec.port)).kind
        rlog(`discovery: registry candidate dsh=${JSON.stringify(rec)} probe=${registryProbeKind !== 'down'}${registryProbeKind === 'unauthorized' ? ' (401: alive, session required)' : ''}`)
        if (registryProbeKind !== 'down') {
          if (this.stopRequested && rec.pid !== null && rec.pid === this.dshPid) {
            rlog('discovery: skip re-adopting the manually detached instance (same pid); reconnect manually')
            return
          }
          await this.discoveryAdopt(rec.port, rec.pid, rec.managedBy, registryProbeKind, rec)
          return
        }
      }
      // 候选发现 b)：配置端口探测兜底（与 start() step2 同型判定——身份判定复用
      // resolvePortPid + processCommandLine + looksLikeDsh；CIM 不可用时按页面
      // 签名记录 holder pid，既有兜底同型）。
      const probePort = this.options.port > 0 ? this.options.port : 0
      if (probePort > 0) {
        const probeKind = (await this.probeState(probePort)).kind
        if (probeKind !== 'down') {
          const holder = resolvePortPid(probePort)
          rlog(`discovery: port candidate probe(port=${probePort})=${probeKind} holder=${JSON.stringify(holder)}`)
          let pid: number | null = null
          // 0.1.23（设计 §5.2.1 方案 A）：本 tick 取到的**完整未截断**命令行在此
          // 暂存，认领时经 discoveryAdopt 第 6 参显式传给 adopt 做通道恢复复用。
          // 取**未截断**的完整局部值而不是 this.externalCommandLine（那是 300 截断
          // 值）——beginAttachment() 会在 adopt 之前清掉该实例字段，用字段等于回到
          // v2 的失效形态。
          let tickCmdline: string | null = null
          if (holder) {
            const cmdline = processCommandLine(holder.pid, 15_000)
            if (cmdline !== null) {
              // ADR-22: keep the fragment (≤300 chars) for the external degraded card.
              this.externalCommandLine = cmdline.slice(0, 300)
              tickCmdline = cmdline
              pid = looksLikeDsh(cmdline) ? holder.pid : null
            } else {
              // CIM unavailable: the page probe already verified the __DSH_BOOT__
              // signature; record the holder PID (step2 同型兜底).
              pid = holder.pid
              rlog('discovery: CIM unavailable; recording holder pid on page-signature basis')
            }
          }
          if (pid === null) {
            rlog('discovery: port holder identity check failed; not adopting (next tick re-judges)')
            return
          }
          if (this.stopRequested && pid === this.dshPid) {
            rlog('discovery: skip re-adopting the manually detached instance (same pid); reconnect manually')
            return
          }
          await this.discoveryAdopt(probePort, pid, 'external', probeKind, rec, tickCmdline)
          return
        }
      }
      // c) 都未命中：保持停止态，等下一周期（静默，无日志噪声）。
    } finally {
      this.discoveryInFlight = false
    }
  }

  /**
   * discoveryTick 的认领落点（§4.2 第 3 条）：beginAttachment（per-attach 重置）
   * → setState('starting')（可见过渡）→ adopt（会话建立/快照装配/ready 落点，
   * 与 start() step1/step4 的认领完全同一条落点链）→ writeRegistry → startProbe
   * （存活探活武装；setState('ready') 已由挂钩自动拆除发现探活器）。认领失败
   * （会话不可用）由 adopt 内部 enterSessionUnavailable 落 error 态（error 落点
   * attached 复位，DR-22-10 落点 #6；发现探活器已随离开 stopped 拆除、不再自动
   * 重试——恢复由用户手动 ▶/⟳ 接管）。零 spawn 红线：本方法结构性不含
   * launchManaged 调用（PU-22-4 静态断言）。
   *
   * 0.1.23（设计 §5.2.1 / §六 改动点 5，QA-D23-r2-01 方案 A）：新增**可选**第 6 参
   * `knownCommandLine` 并透传给 adopt。理由：本方法首句 beginAttachment() 会把
   * this.externalCommandLine 置 null（在 adopt 之前），discovery-port 路径若靠
   * 实例字段复用命令行则永假、必然对同一 pid 重复查询一次（最坏 15 s 同步阻塞）。
   * 改为调用方局部值显式传参后，复用与重置顺序彻底解耦，顺带消除「跨 tick 读到
   * 陈旧命令行」的隐患。discovery-registry 调用点（L1291）上游本无命令行，不传，
   * 维持该路径新增 1 次查询。
   */
  private async discoveryAdopt(
    port: number, pid: number | null, managedBy: ManagedBy, probeKind: ProbeKind,
    rec: DshRecord | null,
    knownCommandLine?: string | null,
  ): Promise<void> {
    this.beginAttachment()
    this.setState('starting')
    await this.adopt(port, pid, managedBy, probeKind, rec, knownCommandLine)
    await this.writeRegistry()
    this.startProbe()
  }

  private async probeTick(): Promise<void> {
    if (this.state !== 'ready' || this.port === null) return
    const outcome = await this.probeState(this.port)
    if (outcome.kind === 'ok') {
      this.probeFailures = 0
      this.authFailures = 0
      return
    }
    if (outcome.kind === 'unauthorized') {
      // 0.1.14 §3.5 401 diversion: 401 = the process is ALIVE but the session
      // is stale (token rotation / external instance). This is deliberately
      // ISOLATED from the crash-backoff counter (probeFailures) AND from the
      // ADR-21 user-stop arbitration — the false user-stop misfire risk of
      // probing a token contract with a bare GET is structurally eliminated.
      // ONE re-establishment per attachment; afterwards each 401 counts in the
      // independent authFailures; ×3 → error state with the restart guidance
      // (NO auto relaunch, NO loop).
      // 0.1.15 #80③: the re-establishment is now a VISIBLE transition —
      // ready → setState('starting') (the panel returns to the neutral page;
      // no URL render) → rebuild + ONE live verification (ADR-32, same
      // criteria as #81) → ready ONCE (first frame = the new URL) +
      // startProbe() re-armed; verification rejected / rebuild failed →
      // setState('error') with the #82 guidance. No mid-flight address
      // updates — the final info renders exactly once per conversion.
      if (!this.sessionRetried) {
        this.sessionRetried = true
        rlog('probe: 401 (service alive, session invalid); single session re-establishment (banner re-capture → C path) — visible transition ready->starting (#80③)')
        this.setState('starting')
        const rebuilt = await this.reestablishSession()
        if (!rebuilt) {
          rlog('probe: session re-establishment failed → error with the #82 guidance')
          this.enterSessionUnavailable()
          return
        }
        if (await this.liveVerifySession()) {
          this.setState('ready') // new-URL first frame
          this.startProbe()      // re-arm the liveness probe
          return
        }
        rlog('probe: re-established session rejected by live upstream → error with the #82 guidance')
        this.sessionCookie = null
        this.enterSessionUnavailable()
        return
      }
      this.authFailures += 1
      rlog(`probe: 401 persists after re-establishment (auth failure ${this.authFailures}/${AUTH_FAIL_THRESHOLD}; crash backoff and user-stop arbitration NOT involved)`)
      if (this.authFailures >= AUTH_FAIL_THRESHOLD && this.state === 'ready') {
        this.errorMessage = SESSION_EXPIRED_MESSAGE
        this.stopProxy()
        this.stopProbe()
        // 0.1.22 DR-22-10/V3-1（落点 #7）：进入 error 前 attached 复位（401 判死
        // 落点；0.1.21 已验收的「401 → error 态面板 ⟳ 恢复」路径在拆分后依赖本
        // 复位，否则 attachExisting 守卫谎报成功）。
        this.attached = false
        this.setState('error')
        this.emit('error', this.errorMessage)
      }
      return
    }
    this.probeFailures += 1
    const rec = readInstance().dsh
    const pidDead = rec === null || rec.pid === null || !isAlive(rec.pid)
    if (this.probeFailures >= LIVENESS_FAIL_THRESHOLD && pidDead && this.state === 'ready') {
      // 0.1.21 死亡分支按形态三分流（设计 §3.4 D-1 改动点 1；用户裁决 O-21-1
      // 2026-09-10：external 形态死亡不自动拉起，各窗口如实进入停止态、由用户
      // 手动重连）。形态判定依据 = 共享注册表记录 ∨ 本窗口附着记忆
      // （attachedLaunchMode，改动点 3）：注册表记录可能已被其他窗口先一步清掉
      // （rec === null），此时只能凭本窗口记忆判定形态。
      // ADR-21 原裁定（§4.6.5，原 L1124-1148 单窗口语义）逐字保留在分支①：
      // start 形态（常驻控制台）的死亡与用户关窗不可区分 → 判用户停止、不自动
      // 拉起；本补丁把判定依据从「仅共享注册表」扩为「共享注册表 ∨ 本窗口
      // 附着记忆」，使窗口 A 判定用户停止清掉记录后，窗口 B 凭自己的 'start'
      // 记忆同样不复活用户刚关掉的实例（ADR-21 跨窗口防复活，出处 B）。
      // 各分支共用 pid 匹配守卫（改动点 2，与 forceRelaunchManaged /
      // shutdownBookkeeping 的既有同型守卫一致）：仅当注册表现记录仍是本窗口
      // 判死所依据的 rec 时才清除，防止极端时序下误清其他窗口刚写入的新记录。
      const recLaunchMode = rec?.launchMode ?? null
      const clearDeadRecordGuarded = (): boolean => {
        // 0.1.21 改动点 2: pid 匹配守卫（rec === null = 本窗口判死时无记录可
        // 对账，不清理——注册表若有记录必属其他窗口，绝不清它）。
        if (rec === null) return false
        const inst = readInstance()
        if (inst.dsh === null || inst.dsh.pid !== rec.pid) return false
        inst.dsh = null
        writeInstance(inst)
        return true
      }
      if (recLaunchMode === 'start' || this.attachedLaunchMode === 'start') {
        // ① start 形态 → ADR-21 用户停止（现状逐字保留；判定依据扩为
        //    记录 ∨ 记忆，跨窗口防复活）。
        rlog('probe: dsh died or console window closed (indistinguishable); treated as user stop per ADR-21; reconnect to restart')
        this.refreshLaunchInfo({ kind: 'user-stop', rec })
        if (clearDeadRecordGuarded()) {
          rlog('probe: ADR-21 user-stop branch cleared the dsh record')
        } else {
          rlog('probe: ADR-21 user-stop branch left the dsh record untouched (pid-mismatch guard, 改动点 2 — another window already rewrote it)')
        }
        this.dshPid = null
        this.port = null
        this.url = null
        this.stopProxy()
        this.stopProbe()
        // 0.1.21 改动点 3（H-5）: 记录生命周期终点 → 附着记忆置 null。
        this.attachedLaunchMode = null
        this.attachedChannel = null
        // 0.1.23：来源标注与值同步清理（同上）。
        this.attachedChannelSource = null
        // 0.1.22 DR-22-10/V3-1（落点 #2）：进入 stopped 前 attached 复位（清理链
        // 完整性修复，与 step4 失败先例同型；ADR-21 判定与行为零变化）。
        this.attached = false
        this.setState('stopped')
        return
      }
      if (recLaunchMode === 'direct' || (rec === null && this.attachedLaunchMode === 'direct')) {
        // ② 受管直启形态 → 0.1.22 取消自动重拉（2026-09-10 用户终审 O-22-a：
        //    「崩溃不自动拉起，改为手动拉起；自动的只有重连」）。清记录（pid
        //    守卫共用）+ 与分支③同构清理链（补 stopProbe() 与 attached 复位，
        //    DR-22-10/V3-1）+ setState('stopped')，spawn 次数为 0；进入停止态后
        //    由发现探活器接力（自动认领新实例）或用户手动 ▶ 启动 / ⟳ 重连恢复。
        rlog('probe: direct-mode dsh died; not auto-relaunching (user policy 2026-09-10); reconnect manually')
        this.refreshLaunchInfo({ kind: 'disconnect', rec: rec ?? null })
        if (clearDeadRecordGuarded()) {
          rlog('probe: direct-death branch cleared the dsh record')
        } else {
          rlog('probe: direct-death branch left the dsh record untouched (pid-mismatch guard, 改动点 2)')
        }
        this.dshPid = null
        this.port = null
        this.url = null
        this.stopProxy()
        this.stopProbe()
        // 0.1.21 改动点 3（H-5）: 记录生命周期终点 → 附着记忆置 null。
        this.attachedLaunchMode = null
        this.attachedChannel = null
        // 0.1.23：来源标注与值同步清理（同上）。
        this.attachedChannelSource = null
        // 0.1.22 DR-22-10/V3-1（落点 #3）：进入 stopped 前 attached 复位（死亡后
        // ▶ 启动 / ⟳ 重连恢复入口真实可达的前提，与 step4 失败先例同型）。
        this.attached = false
        this.setState('stopped')
        return
      }
      // ③ external 记录（无 launchMode）/ 记录已清且本窗口记忆非 direct →
      //    用户裁决新分支：清记录（pid 守卫）+ 如实进入停止态、不自动拉起
      //    （O-21-1）。行为与 ADR-21 用户停止分支同构（清记录 + stopped +
      //    不拉起，复用其清理链），但语义区分：这不是用户停止（实例是自己死的），
      //    快照走 disconnect 降级档（launchMode=null → 「已断开/异常退出」文案
      //    + 重连动作），日志行与判定依据（用户裁决）独立注明。
      rlog('probe: external dsh died; not auto-relaunching (user ruling O-21-1, 2026-09-10); reconnect manually')
      this.refreshLaunchInfo({ kind: 'disconnect', rec: rec ?? null })
      if (clearDeadRecordGuarded()) {
        rlog('probe: external-death branch cleared the dsh record')
      } else {
        rlog('probe: external-death branch left the dsh record untouched (pid-mismatch guard, 改动点 2)')
      }
      this.dshPid = null
      this.port = null
      this.url = null
      this.stopProxy()
      this.stopProbe()
      // 0.1.21 改动点 3（H-5）: 记录生命周期终点 → 附着记忆置 null。
      this.attachedLaunchMode = null
      this.attachedChannel = null
      // 0.1.23：来源标注与值同步清理（同上）。
      this.attachedChannelSource = null
      // 0.1.22 DR-22-10/V3-1（落点 #4）：进入 stopped 前 attached 复位（与
      // step4 失败先例同型）。
      this.attached = false
      this.setState('stopped')
      return
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
    this.stopProxy()
    const inst = readInstance()
    writeInstance(unregisterWindow(inst, this.options.windowPid))
    // ADR-22: degraded snapshot BEFORE the stopped emit — port/pid/managedBy
    // retained, version/bin cleared, launchMode FORCED null (disconnect keeps
    // the process alive → the UI's "已断开" copy, not the user-stop one).
    this.refreshLaunchInfo({ kind: 'disconnect' })
    // 0.1.21 改动点 3（H-5）: 本窗口的附着随断开结束 → 附着记忆置 null
    // （下次 start() 的认领/拉起落点会重新赋值；per-attach 重置亦兜底）。
    this.attachedLaunchMode = null
    this.attachedChannel = null
    // 0.1.23：来源标注与值同步清理（同上）。
    this.attachedChannelSource = null
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
    this.stopProxy()
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
    // 0.1.21 改动点 3（H-5）: 记录已清（受控杀）→ 附着记忆置 null；重拉成功
    // 后由 launchManaged 落点重新赋值（新实例的实际 mode / 实际通道）。
    this.attachedLaunchMode = null
    this.attachedChannel = null
    // 0.1.23：来源标注与值同步清理（同上）。
    this.attachedChannelSource = null
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

  /**
   * 0.1.21 D-2 改动点 2（设计 §3.4 / §7.1）：「以新通道重启 dsh」专用入口 ——
   * 与 dsh.restart 的重连语义（永不杀 dsh，P0-D/ADR-2）语义分离（DR-2）。
   * 执行判定源 = this.options.channel（纯 Node 层不读 vscode 配置；与
   * `dsh.channel` 设置的同步由 extension.ts 的 onDidChangeConfiguration 接线
   * 保证——v5 QA H-4 判定源声明：不实现「从配置读取」）。三分流：
   *  - 非 ready（idle/awaitingChannel/starting/error/stopped）：实例未在运行
   *    → 转走 dsh.restart 语义（reconnect → start() 四步仲裁以当前配置通道
   *    拉起；starting 过渡期重复点击的同窗口重入形态由启动锁互斥 + step1/2
   *    重查兜底，残余窗口与 R-8 同构，设计如实披露、不新增防护）；
   *  - managed-own（ready）：复用 forceRelaunchManaged 的「受控杀 + 清记录
   *    （pid 守卫）+ 重新拉起」骨架（K-3：经骨架的直接调用面如实保留）——
   *    拉起链直接消费 this.options.channel（执行判定源已在手，无需重复
   *    setChannel），新通道生效后 attachedChannel/快照更新、待生效提示消失；
   *  - external（或无运行快照）：不代杀（外部实例不代杀红线 P0-D/ADR-2），
   *    返回 'external-hint' 由 vscode 层给出手动路径指引。
   */
  async applyChannelRestart(): Promise<'relaunched' | 'external-hint' | 'noop'> {
    if (this.state !== 'ready') {
      rlog(`applyChannelRestart: state=${this.state} (not ready); deferring to the reconnect semantics — the four-step arbitration relaunches with the current channel (dsh.restart 语义)`)
      await this.reconnect()
      return 'relaunched'
    }
    const configChannel = this.options.channel
    const runningChannel = this.attachedChannel
    const action = resolveChannelRestartAction(configChannel, runningChannel, this.managedBy)
    if (action === 'noop') {
      // noop 双保险（按钮本就不该渲染）+ 判定源失同步追查锚点（v5 QA H-4）：
      // 渲染判定源 = vscode 配置直读（webviewDetails），执行判定源 =
      // this.options.channel——两源失同步的表现是「按钮渲染 pending 但执行
      // noop」，本行日志含两值供追查。
      rlog(`applyChannelRestart: noop (configChannel='${configChannel}', runningChannel=${runningChannel === null ? 'null' : `'${runningChannel}'`}) — channels already一致, nothing to do`)
      return 'noop'
    }
    if (action === 'external-hint') {
      rlog(`applyChannelRestart: external-hint (managedBy=${this.managedBy ?? 'null'}, runningChannel=${runningChannel === null ? 'null' : `'${runningChannel}'`}) — 外部实例不代杀（P0-D/ADR-2）；vscode 层提示手动路径`)
      return 'external-hint'
    }
    // kill-relaunch：受管实例受控杀后以新通道重拉。复用 forceRelaunchManaged
    // 骨架 —— 其注册表守卫（managed-own + pid 非空）在极端时序下（记录已被
    // 其他窗口改写）会落 'no-managed' 不杀不拉，如实映射为 noop + rlog 留痕。
    rlog(`applyChannelRestart: kill-relaunch (configChannel='${configChannel}', runningChannel=${runningChannel === null ? 'null' : `'${runningChannel}'`}) — controlled kill + relaunch with the new channel`)
    const relaunch = await this.forceRelaunchManaged()
    if (relaunch === 'no-managed') {
      rlog('applyChannelRestart: registry guard fired (no managed-own record to kill); nothing done')
      return 'noop'
    }
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
    // 0.1.21 改动点 3（H-5）: 窗口退出 = 本窗口全部附着生命周期的终点 →
    // 附着记忆置 null（唯一有效记账轮执行一次即可）。
    this.attachedLaunchMode = null
    this.attachedChannel = null
    // 0.1.23：来源标注与值同步清理（同上）。
    this.attachedChannelSource = null
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
    this.stopProxy()
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
    this.stopDiscoveryProbe()
    this.stopProxy()
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
