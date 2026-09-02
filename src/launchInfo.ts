// launchInfo — DshLaunchInfo data model + pure assembly (ADR-22, 0.1.9 §4.7).
//
// One data model feeds the three-layer visibility UI (status bar segment ->
// panel toolbar button -> dsh.details view) from EXISTING outputs only:
//   - dsh self-reported version: first line of the managed-launch log
//     (best-effort — E-VER-1 proved it appears intermittently; absent = null,
//     never guessed/fabricated);
//   - resolver hit: SpawnedInfo.resolved transparency (bin dir / binJs /
//     version / mode) + the channel-level meta file (lastCheckAt);
//   - registry record: pid / port / managedBy / startedAt / launchMode;
//   - runtime state surface: port / pid / managedBy / externalCommandLine.
//
// The module is PURE NODE (no 'vscode' import — QA C2 layering audit item):
// assembly, the version cross-check, the stopped-copy split and the status
// bar text are all direct-tested headlessly (sim PU-1..PU-8).
//
// Semantics pinned by the design (§4.7.2):
//   - self-reported version  = the RUNNING process fact (primary source);
//   - resolver version       = the on-disk bin fact = what the NEXT launch
//     will run (auxiliary source) — two meanings of "version", presented
//     separately, cross-checked in five tiers;
//   - degraded snapshots (re-adopt / external / user-stop / disconnect) null
//     out the version/bin fields honestly — never "v未知"-style placeholder.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { logFile, runtimeLogFile } from './paths'

/** Version-token regex for the self-report line (named constant; anchored). */
const SELF_VERSION_RE = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/
/** externalCommandLine hard cap (§4.7.2: 截断 ≤300 字符，排障辅助). */
export const EXTERNAL_CMDLINE_MAX = 300

/** Runtime state mirror (structurally identical to runtime.RuntimeState; a
 *  separate type keeps launchInfo free of any runtime.ts import cycle). */
export type LaunchInfoState = 'idle' | 'starting' | 'ready' | 'error' | 'stopped'

/** Five-tier version cross-check conclusion (derived, §4.7.2). */
export type VersionCrossCheck =
  | 'match'
  | 'mismatch'
  | 'self-only'
  | 'resolver-only'
  | 'unknown'

/** One launch-log/runtime-log entry offered to the details card (existence-filtered). */
export interface LaunchLogFileEntry {
  label: string
  path: string
}

/**
 * The 15-field launch information model (§4.7.2: 14 task fields + the
 * cross-check derived field). Every nullable field is HONESTLY null when the
 * fact is unavailable for this session — degraded cards render a note, never
 * a misleading placeholder.
 */
export interface DshLaunchInfo {
  /** dsh self-reported version (managed-launch log first line; best-effort → null). */
  dshVersion: string | null
  /**
   * resolver version (bin-dir package.json). 0.1.14 E-VR-6 语义修订：本字段
   * 升级为**契约档位判定主源**（judgeContractByVersion 的判定输入 =
   * SpawnedInfo.resolved.version —— 与运行中进程双端同源的单真源）；其
   * 「next-launch 辅助源」旧语义由本轮实施同步废弃（判定看版本）。
   */
  resolverVersion: string | null
  /** Five-tier cross-check conclusion derived from the two sources. */
  versionCrossCheck: VersionCrossCheck
  /** npx hit dir (= DshBinInfo.dir, the ADR-12 single source); unresolved → null. */
  binDir: string | null
  /** dsh bin script full path (= DshBinInfo.binJs); unresolved → null. */
  dshBin: string | null
  /** Version channel (config passthrough: 'latest' | 'preview' | exact). */
  channel: string
  /** Resolver mode for this session; unresolved → null. */
  resolverMode: 'steady' | 'refreshed' | 'established' | null
  /** Latest channel-level update check (meta file lastCheckAt); meta missing → null. */
  lastCheckAt: string | null
  /** How this dsh was launched (ADR-21): 'start' | 'direct'; external/old records → null. */
  launchMode: 'start' | 'direct' | null
  port: number | null
  pid: number | null
  managedBy: 'extension' | 'external' | 'managed-own' | null
  startedAt: string | null
  /** Existing-files-only log inventory (launch log + runtime.log + dsh.log). */
  logFiles: LaunchLogFileEntry[]
  /** external takeover command-line fragment (≤300 chars); non-adopted → null. */
  externalCommandLine: string | null
  /**
   * 0.1.14 第 16 个可选字段（design §0.5/§3.6）：token 契约档（T 路径）下
   * openInBrowser 外发的带 token banner URL；null = 旧契约（直连裸 URL 原样）
   * 或降级快照。既有 15 字段消费者零破坏；D3：该值仅存内存快照，registry
   * （instance.json）零新增字段、零 token 落盘；状态栏/详情卡不渲染本字段。
   */
  externalUrl?: string | null
  /**
   * 0.1.16 第 17 个可选字段（#16 externalUrl 同型 additive 先例，既有 16 字段
   * 消费者零破坏）：dsh 进程真实创建时刻（OS 报告，ISO-8601 UTC 存储；registry
   * processStartedAt 透传）。与 startedAt（接管/记录时刻）语义分离（ADR-39）：
   * null = 查询失败 / 超时 / 非 win32 / 旧记录无字段 → 详情卡「启动时间」显示
   * 「未知」，**绝不回退显示 startedAt**（ADR-40④：两种语义不得再搅进一个格子）。
   * 降级快照随 rec 保留——进程事实与会话降级正交（degrade 不清除本字段）。
   */
  processStartedAt?: string | null
}

/** Minimal resolver-hit shape (= dshResolver.DshBinInfo, duplicated structurally
 *  to keep launchInfo free of a dshResolver import; TS structural typing bridges). */
export interface ResolvedBinFacts {
  version: string
  dir: string
  binJs: string
  mode: 'steady' | 'refreshed' | 'established'
}

/** Assembly input (all optional; the caller passes what it has — see §4.7.2
 *  落点表: launchManaged success / adopt / user-stop / disconnect). */
export interface LaunchInfoInput {
  /** Self-reported version ALREADY parsed by the caller (parseSelfVersion). */
  selfVersion?: string | null
  /** Resolver hit for this session (SpawnedInfo.resolved transparency). */
  resolved?: ResolvedBinFacts | null
  /** Channel-level meta file content ({ lastCheckAt, knownVersion } | null). */
  meta?: { lastCheckAt?: string; knownVersion?: string } | null
  /** Registry dsh record (pass the PRE-CLEAR record for degraded snapshots). */
  rec?: {
    pid: number | null
    port: number
    managedBy: 'extension' | 'external' | 'managed-own'
    startedAt: string
    launchMode?: 'start' | 'direct'
    /** 0.1.16: process creation instant (ISO-8601 UTC) — pass-through, #98. */
    processStartedAt?: string | null
  } | null
  /** Runtime state surface (fallbacks when rec is absent). */
  port?: number | null
  pid?: number | null
  managedBy?: 'extension' | 'external' | 'managed-own' | null
  channel?: string
  /** External takeover command line (truncated to 300 here, defensively). */
  externalCommandLine?: string | null
  /** 0.1.14: token-contract (T path) external URL; degraded snapshots force null. */
  externalUrl?: string | null
  /** THIS launch's managed log (existence-filtered into logFiles). */
  launchLogFile?: string | null
  /** Degradation switch: clears version/bin fields (user-stop / disconnect /
   *  re-adopt honest degradation). external managedBy forces it, too. */
  degraded?: boolean
  /** launchMode carrier for degraded snapshots: 'start' KEPT (user-stop
   *  branch, ADR-21) / null (disconnect clears) / 'direct'. Undefined =
   *  derive from rec (adopt carries the record's value; external → null). */
  degradedLaunchMode?: 'start' | 'direct' | null
  /** Session-actual launch mode (fallback when rec carries none). */
  launchMode?: 'start' | 'direct' | null
}

/** Best-effort parse of the self-reported version from the log head chunk:
 *  first non-empty line must be a bare version token (E-VER-1 shape:
 *  `0.1.1-rc.2`); anything else → null (never guessed). */
export function parseSelfVersion(logHeadChunk: string): string | null {
  if (typeof logHeadChunk !== 'string') return null
  const first = logHeadChunk
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0)
  if (first === undefined) return null
  const m = SELF_VERSION_RE.exec(first)
  return m !== null ? m[1] : null
}

/**
 * Pure assembly: buildLaunchInfo(input) → DshLaunchInfo. No vscode import,
 * no throw; single-file existence stats only (µs级 per §4.7.10).
 *
 * Degradation rules (§4.7.2):
 *   - managedBy === 'external' (or explicit degraded flag) → version/bin
 *     fields honestly null, crossCheck 'unknown', available fields retained;
 *   - launchMode priority (§4.7.8): explicit degradedLaunchMode (user-stop
 *     keeps 'start' / disconnect forces null) > rec.launchMode (adopt carries
 *     the record) > session-actual launchMode.
 */
export function buildLaunchInfo(input: LaunchInfoInput): DshLaunchInfo {
  const rec = input.rec ?? null
  const managedBy = input.managedBy ?? rec?.managedBy ?? null
  // external takeover → the extension never resolved the bin this session
  // (H1): force the honest degraded field set regardless of other inputs.
  const degrade = input.degraded === true || managedBy === 'external'
  const resolved = degrade ? null : (input.resolved ?? null)
  const dshVersion = degrade ? null : (input.selfVersion ?? null)
  const resolverVersion = resolved?.version ?? null
  const port = rec?.port ?? input.port ?? null
  const pid = rec?.pid ?? input.pid ?? null
  const launchMode = degrade
    ? input.degradedLaunchMode !== undefined
      ? input.degradedLaunchMode
      : (rec?.launchMode ?? null)
    : (rec?.launchMode ?? input.launchMode ?? null)
  const rawCmdline = input.externalCommandLine
  const externalCommandLine =
    typeof rawCmdline === 'string' && rawCmdline.length > 0 ? rawCmdline.slice(0, EXTERNAL_CMDLINE_MAX) : null
  // 0.1.14: the external URL only exists on a FULL (non-degraded) managed
  // token-contract snapshot; degrade (external takeover / user-stop /
  // disconnect) honestly nulls it alongside the version/bin fields.
  const externalUrl = degrade ? null : (typeof input.externalUrl === 'string' && input.externalUrl.length > 0 ? input.externalUrl : null)
  const candidates: LaunchLogFileEntry[] = [
    ...(input.launchLogFile !== null && input.launchLogFile !== undefined && input.launchLogFile.length > 0
      ? [{ label: path.basename(input.launchLogFile), path: input.launchLogFile }]
      : []),
    { label: 'runtime.log', path: runtimeLogFile() },
    { label: 'dsh.log', path: logFile() },
  ]
  return {
    dshVersion,
    resolverVersion,
    versionCrossCheck: crossCheckVersions(dshVersion, resolverVersion),
    binDir: resolved?.dir ?? null,
    dshBin: resolved?.binJs ?? null,
    channel: input.channel ?? '',
    resolverMode: resolved?.mode ?? null,
    lastCheckAt: typeof input.meta?.lastCheckAt === 'string' ? input.meta.lastCheckAt : null,
    launchMode,
    port,
    pid,
    managedBy,
    startedAt: rec?.startedAt ?? null,
    logFiles: candidates.filter((c) => isExistingFile(c.path)),
    externalCommandLine,
    externalUrl,
    // 0.1.16 #98: pass-through from the record (the process fact is ORTHOGONAL
    // to session degradation — degrade does NOT clear this field; a record
    // without it assembles null → the card shows 未知, never startedAt).
    processStartedAt: rec?.processStartedAt ?? null,
  }
}

/**
 * 0.1.16 #98 (§3.5-4): render an ISO-8601 timestamp in the LOCAL timezone as
 * `yyyy-MM-dd HH:mm:ss` (zero-padded). Extension-side baking only — zero page
 * script participation (#90 lesson: the display surface never depends on the
 * page script being alive). Storage stays ISO-8601 UTC, rendering is always
 * local — the store/display semantic split (§五-3). null/undefined/empty/
 * unparseable → null (the caller renders 未知; never a guessed value).
 */
export function formatLocalTimestamp(iso: string | null | undefined): string | null {
  if (typeof iso !== 'string' || iso.length === 0) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
}

/** Status-bar text, single point (§4.7.3a/§4.7.7). ready renders the port and,
 *  when a version fact exists (self OR resolver — fallback order), the
 *  `· v<version>` segment; both missing → the bare DSH item (no misleading
 *  version segment, H1). starting/error texts are byte-identical to the
 *  pre-0.1.9 ones; other states render '' (the caller hides the item). */
export function statusLine(state: LaunchInfoState, port: number | null, version: string | null): string {
  switch (state) {
    case 'ready': {
      let text = '$(circle-filled) DSH'
      if (port !== null) text += ` ${port}`
      if (version !== null && version.length > 0) text += ` · v${version}`
      return text
    }
    case 'starting':
      return '$(sync~spin) DSH starting…'
    case 'error':
      return '$(error) DSH error'
    default:
      return ''
  }
}

function crossCheckVersions(self: string | null, resolver: string | null): VersionCrossCheck {
  if (self !== null && resolver !== null) return self === resolver ? 'match' : 'mismatch'
  if (self !== null) return 'self-only'
  if (resolver !== null) return 'resolver-only'
  return 'unknown'
}

function isExistingFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}
