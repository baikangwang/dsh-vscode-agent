// dshResolver — resolve the dsh runtime bin from the npx cache (0.1.7, ADR-11/12/13).
//
// Single runtime source of truth = the dsh install the user already has inside
// the npx cache (`<npxRoot>\<hash-dir>\node_modules\@deepseek-ai\dsh`, ADR-12
// v2.1: zero duplicate install). The hash directory name is an npm-internal
// derivation (a sha-512 digest of the requested spec, evidence E9) — this
// module NEVER computes or hardcodes it: candidates are found by globbing the
// cache root and matching the package name/version CONTENT of each package.json.
//
// Layered fallback (all best-effort, worst case = the 0.1.6 `cmd.exe + npx`
// path driven by dshProcess when this resolver returns null, §4.1.7):
//   scan (zero network) -> freshness (meta TTL / bounded `npm view`)
//   -> in-place refresh (`npm install --prefix <hit dir>`, the same reify
//      operation npx itself performs on that dir, E9)
//   -> npx chain establishment (`node npx-cli.js --yes --prefer-offline spec --version`,
//      same behavior/cost as the 0.1.6 first install)
//   -> null (caller falls back to the 0.1.6 path).
//
// Pure Node (no vscode dependency) so it can be exercised headlessly.
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { appendDecisionLog, dshLogMarkerFile, MARKER_SUFFIX_RESOLVER, runtimeMetaFile } from './paths'
import { normalizeChannel, normalizeChannelLogLine } from './channelSelect'

/** Package identity — single source; dshProcess.ts imports this (去散字面量). */
export const DSH_PKG = '@deepseek-ai/dsh'
/** `npm view` deadline (F-03: async spawn, bounded, kill on timeout). */
export const VIEW_TIMEOUT_MS = 8_000
/** Freshness window of the runtime meta file in hours (ADR-13). */
export const FRESHNESS_TTL_H = 24
/** Budget for in-place refresh / npx chain establishment (§4.1.2 ⑤⑥). */
export const INSTALL_TIMEOUT_MS = 90_000
/** npm flags that keep the refresh deterministic (no scripts -> no children). */
const INSTALL_FLAGS = ['--ignore-scripts', '--no-audit', '--no-fund'] as const

export interface DshBinInfo {
  /** Absolute path of the dsh bin inside the npx cache hit dir (lib/bin.js). */
  binJs: string
  /** Version read from that dir's package.json. */
  version: string
  /** The npx-cache hit directory (refresh target identity). */
  dir: string
  /** steady = cache hit; refreshed = in-place refresh; established = npx chain. */
  mode: 'steady' | 'refreshed' | 'established'
}

/** Decision trace (runtime.log; diagnostics only, never throws). */
function rlog(msg: string): void {
  appendDecisionLog(`[dshResolver] ${msg}`)
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

// ------------------------------------------------------------- env / PATH seams

/**
 * npx cache root. Test seam `DSH_NPX_ROOT` wins (headless mock layout);
 * default = the npx default cache location derived from the LOCALAPPDATA env
 * (npm-cache\_npx) — no machine-specific path is ever hardcoded.
 */
function npxRoot(): string {
  const seam = process.env.DSH_NPX_ROOT
  if (seam && seam.trim().length > 0) return seam.trim()
  const local = process.env.LOCALAPPDATA
  if (!local || local.trim().length === 0) return ''
  return path.join(local, 'npm-cache', '_npx')
}

/** PATH entries (Windows ';' separated), trimmed, non-empty. */
function pathDirs(): string[] {
  const raw = process.env.PATH ?? process.env.Path ?? ''
  return raw
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** First PATH directory containing `name` (used for npx.cmd / node.exe). */
function findDirOnPath(name: string): string {
  for (const dir of pathDirs()) {
    if (isFile(path.join(dir, name))) return dir
  }
  return ''
}

export interface NodeNpmTools {
  nodeExe: string
  npmCliJs: string
  /** Sibling of npm-cli.js in the same bin dir; may be '' when absent (⑥ skipped). */
  npxCliJs: string
}

/**
 * Resolve node.exe + npm-cli.js + npx-cli.js (design §4.1.2):
 * - nodeExe: (1) <npmPrefixDir>/node.exe (mirrors npx.cmd's first branch),
 *   (2) PATH scan fallback. npmPrefixDir = first PATH dir containing npx.cmd.
 * - npmCliJs: (1) <npmPrefixDir>/node_modules/npm/bin/npm-cli.js (primary),
 *   (2) <nodeDir>/node_modules/npm/bin/npm-cli.js (standard node tree, F-04).
 * - Test seams DSH_NODE_EXE / DSH_NPM_CLI take priority; an explicitly set but
 *   missing seam is a HARD failure (deterministic override — PV-2: node
 *   resolution failure beats everything, never falls through to PATH).
 * Returns null when node/npm cannot be resolved (caller -> 0.1.6 fallback).
 */
export function resolveNodeAndNpm(): NodeNpmTools | null {
  const envNode = process.env.DSH_NODE_EXE
  const envNpmCli = process.env.DSH_NPM_CLI
  if (envNode !== undefined && envNode.trim().length > 0 && !isFile(envNode.trim())) {
    rlog(`resolveNodeAndNpm: DSH_NODE_EXE seam set but file missing -> hard fail (${envNode.trim()})`)
    return null
  }
  if (envNpmCli !== undefined && envNpmCli.trim().length > 0 && !isFile(envNpmCli.trim())) {
    rlog(`resolveNodeAndNpm: DSH_NPM_CLI seam set but file missing -> hard fail (${envNpmCli.trim()})`)
    return null
  }

  const npmPrefixDir = findDirOnPath('npx.cmd')

  let nodeExe = envNode !== undefined && envNode.trim().length > 0 ? envNode.trim() : ''
  if (nodeExe === '') {
    if (npmPrefixDir !== '') {
      const cand = path.join(npmPrefixDir, 'node.exe')
      if (isFile(cand)) nodeExe = cand
    }
    if (nodeExe === '') nodeExe = path.join(findDirOnPath('node.exe'), 'node.exe')
    if (!isFile(nodeExe)) nodeExe = ''
  }
  if (nodeExe === '') {
    rlog('resolveNodeAndNpm: node.exe not found (npm-prefix branch + PATH scan)')
    return null
  }

  let npmCliJs = envNpmCli !== undefined && envNpmCli.trim().length > 0 ? envNpmCli.trim() : ''
  if (npmCliJs === '') {
    if (npmPrefixDir !== '') {
      const cand = path.join(npmPrefixDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      if (isFile(cand)) npmCliJs = cand
    }
    if (npmCliJs === '') {
      // F-04: standard node install tree keeps npm at <nodeDir>/node_modules/npm.
      const cand = path.join(path.dirname(nodeExe), 'node_modules', 'npm', 'bin', 'npm-cli.js')
      if (isFile(cand)) npmCliJs = cand
    }
  }
  if (npmCliJs === '') {
    rlog('resolveNodeAndNpm: npm-cli.js not found (npm-prefix branch + node tree branch)')
    return null
  }

  const npxCli = path.join(path.dirname(npmCliJs), 'npx-cli.js')
  const npxCliJs = isFile(npxCli) ? npxCli : ''
  if (npxCliJs === '') rlog('resolveNodeAndNpm: npx-cli.js sibling missing; npx chain establishment (⑥) will be skipped')
  return { nodeExe, npmCliJs, npxCliJs }
}

// ------------------------------------------------------------- candidate scan

interface Candidate {
  /** npx-cache hit directory. */
  dir: string
  /** Version from the dir's package.json (name-matched). */
  version: string
  /** Directory mtime (tiebreak: newest first, then dir name ascending). */
  mtimeMs: number
  /** lib/bin.js path, or '' when missing (= corrupted candidate, refreshable). */
  binJs: string
}

/**
 * Content scan of the npx cache: enumerate `<npxRoot>\*` directories and match
 * `<dir>\node_modules\@deepseek-ai\dsh\package.json` by package NAME + version.
 * Glob-only: no hash computation, no hash literal (PV-4 / ADR-12 v2.1).
 * A candidate whose bin.js is missing stays in the set as "corrupted" (⑤ can
 * repair it in place).
 */
function scanCandidates(): Candidate[] {
  const root = npxRoot()
  if (root === '' || !fs.existsSync(root)) return []
  let dirs: string[] = []
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
  const out: Candidate[] = []
  for (const name of dirs) {
    const dir = path.join(root, name)
    const pkgFile = path.join(dir, 'node_modules', ...DSH_PKG.split('/'), 'package.json')
    const binJs = path.join(dir, 'node_modules', ...DSH_PKG.split('/'), 'lib', 'bin.js')
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as { name?: unknown; version?: unknown }
      if (pkg === null || typeof pkg !== 'object') continue
      if (pkg.name !== DSH_PKG || typeof pkg.version !== 'string' || pkg.version.length === 0) continue
      let mtimeMs = 0
      try {
        mtimeMs = fs.statSync(dir).mtimeMs
      } catch {
        /* keep 0 */
      }
      out.push({ dir, version: pkg.version, mtimeMs, binJs: isFile(binJs) ? binJs : '' })
    } catch {
      continue // unreadable / not our package -> not a candidate
    }
  }
  return out
}

/** Deterministic ordering: mtime desc, then dir name asc (design ④ tiebreak). */
function byNewest(a: Candidate, b: Candidate): number {
  if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs
  return a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0
}

function pickNewest(list: Candidate[]): Candidate | null {
  if (list.length === 0) return null
  return [...list].sort(byNewest)[0]
}

// ------------------------------------------------- read-only cache scan (0.1.18)

/** Result shape of scanNpxCacheReadonly (design 0.1.18 §7.1). */
export interface NpxCacheScan {
  /** Newest candidate's package.json version. */
  version: string
  /** The newest candidate's npx-cache directory. */
  dir: string
  /** Total dsh candidates found under the whole npxRoot (multi-candidate is the norm). */
  candidateCount: number
}

/**
 * 0.1.18 ADR-48 (#1, design §7.1): READ-ONLY scan of the npx cache for the
 * external-takeover version display. Reuses scanCandidates() — the same
 * whole-root glob (`<npxRoot>\*`; the DSH_NPX_ROOT seam wins exactly as in
 * resolveDshBin) and the package.json name+version content match — and picks
 * the newest-mtime candidate (byNewest: mtime desc, then dir name asc).
 * bin.js absence does NOT affect the version report: the read-only scan
 * deliberately omits the resolver's binJs integrity semantics.
 *
 * 契约红线（R3；PU-13-4 断言）：本函数只读 —— 不调用 npm view / npm install、
 * 不写任何 meta 文件、不产生网络请求；无候选 / 目录不可读 → null（诚实降级，
 * 调用方透传 null + 留痕）。既有 resolveDshBin 行为零变化：本函数只新增一个
 * 读侧出口，不触碰任何写入路径。
 */
export function scanNpxCacheReadonly(): NpxCacheScan | null {
  const cands = scanCandidates()
  const newest = pickNewest(cands)
  if (newest === null) return null
  return { version: newest.version, dir: newest.dir, candidateCount: cands.length }
}

// ------------------------------------------------------------- meta (ADR-13)

interface RuntimeMeta {
  lastCheckAt?: string
  knownVersion?: string
}

function readMeta(channel: string): RuntimeMeta {
  try {
    const parsed = JSON.parse(fs.readFileSync(runtimeMetaFile(channel), 'utf8')) as RuntimeMeta
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Read-only reuse of the internal meta reader (ADR-22 #29, 0.1.9): the
 * channel-level freshness meta ({ lastCheckAt, knownVersion }) is a programmatic
 * source for the launchInfo snapshot (§4.7.2 — lastCheckAt 的程序化读取点 = meta
 * 文件，runtime.log 仅为诊断轨迹). No write path is exposed; channel-level data
 * is instance-independent (readable even for re-adopt / external snapshots).
 */
export function readRuntimeMeta(channel: string): { lastCheckAt?: string; knownVersion?: string } {
  return readMeta(channel)
}

/** Write ONLY { lastCheckAt, knownVersion } — metadata, never a package install. */
function writeMeta(channel: string, knownVersion: string): void {
  try {
    const file = runtimeMetaFile(channel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      JSON.stringify({ lastCheckAt: new Date().toISOString(), knownVersion } satisfies RuntimeMeta, null, 2),
      'utf8',
    )
  } catch {
    /* best-effort */
  }
}

function metaFresh(meta: RuntimeMeta): boolean {
  if (typeof meta.lastCheckAt !== 'string') return false
  const t = Date.parse(meta.lastCheckAt)
  if (!Number.isFinite(t)) return false
  return Date.now() - t < FRESHNESS_TTL_H * 3_600_000
}

// ------------------------------------------------------------- bounded runners

function appendToLog(logFile: string | undefined, text: string): void {
  if (!logFile || logFile.length === 0) return
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    fs.appendFileSync(logFile, text)
  } catch {
    /* diagnostics only */
  }
}

interface RunResult {
  code: number | null
  stdout: string
}

/**
 * ADR-25-③ (#55-②③, 0.1.12): resolver child-process output goes to the
 * SIBLING file `<logFile>.resolver` — NEVER into the per-launch dsh log.
 * R3 evidence: the npm view version token landed in the dsh log HEAD and was
 * misread as the dsh self-reported version (the 11B false clue +
 * parseSelfVersion's first-line bare-version-token misread surface — both
 * structurally eliminated here). The `.resolver` suffix joins
 * DSH_LOG_MARKER_SUFFIXES (paths.ts), so the sibling shares the marker
 * family's rotate-same-batch lifecycle (no independent growth surface).
 * Resolver evidence stays queryable (headless debugging reads the sibling).
 */
function appendToResolverLog(logFile: string | undefined, text: string): void {
  if (!logFile || logFile.length === 0) return
  appendToLog(dshLogMarkerFile(logFile, MARKER_SUFFIX_RESOLVER), text)
}

/**
 * Run one bounded child process (windowsHide; stdout/stderr -> the
 * `<logFile>.resolver` sibling, ADR-25-③). Async spawn (F-03 — never blocks
 * the event loop); hard timeout kills the child and resolves { code: null }.
 * Never throws.
 */
function runBounded(exec: string, args: string[], timeoutMs: number, logFile: string | undefined, label: string): Promise<RunResult> {
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    let child: ReturnType<typeof spawn> | null = null
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout: out })
    }
    const timer = setTimeout(() => {
      rlog(`${label}: timed out after ${timeoutMs}ms; killing child`)
      try {
        child?.kill()
      } catch {
        /* ignore */
      }
      finish(null)
    }, timeoutMs)
    try {
      child = spawn(exec, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      rlog(`${label}: spawn failed: ${(err as Error).message}`)
      finish(null)
      return
    }
    // Mock-spawn tolerance (headless tests may return plain objects): if the
    // child cannot be observed, settle immediately as a failed run.
    const observable = child !== null && typeof (child as { on?: unknown }).on === 'function'
    if (!observable) {
      rlog(`${label}: child not observable (no event emitter); treating as failed run`)
      finish(null)
      return
    }
    child.stdout?.on('data', (d: Buffer) => {
      const text = String(d)
      out += text
      appendToResolverLog(logFile, text)
    })
    child.stderr?.on('data', (d: Buffer) => appendToResolverLog(logFile, String(d)))
    child.on('error', (err: Error) => {
      rlog(`${label}: spawn error: ${err.message}`)
      finish(null)
    })
    child.on('close', (code: number | null) => finish(code))
  })
}

/** `node <npmCli> view @deepseek-ai/dsh@<channel> version` -> version | null. */
async function npmViewVersion(nodeExe: string, npmCliJs: string, channel: string, logFile: string | undefined): Promise<string | null> {
  const res = await runBounded(
    nodeExe,
    [npmCliJs, 'view', `${DSH_PKG}@${channel}`, 'version'],
    VIEW_TIMEOUT_MS,
    logFile,
    'npm view',
  )
  const last = res.stdout.trim().split(/\r?\n/).filter((s) => s.length > 0).pop() ?? ''
  if (res.code === 0 && /^[\w.+-]+$/.test(last)) return last
  return null
}

/** In-place refresh: `node <npmCli> install --prefix <hit dir> --ignore-scripts ... spec` (⑤). */
async function npmInstallInto(nodeExe: string, npmCliJs: string, prefixDir: string, channel: string, logFile: string | undefined): Promise<boolean> {
  const args = [npmCliJs, 'install', '--prefix', prefixDir, ...INSTALL_FLAGS, `${DSH_PKG}@${channel}`]
  const res = await runBounded(nodeExe, args, INSTALL_TIMEOUT_MS, logFile, 'npm install (in-place refresh)')
  return res.code === 0
}

/** npx chain establishment: `node <npxCli> --yes --prefer-offline spec --version` (⑥). */
async function npxChainEstablish(nodeExe: string, npxCliJs: string, channel: string, logFile: string | undefined): Promise<boolean> {
  const args = [npxCliJs, '--yes', '--prefer-offline', `${DSH_PKG}@${channel}`, '--version']
  const res = await runBounded(nodeExe, args, INSTALL_TIMEOUT_MS, logFile, 'npx chain establish')
  return res.code === 0
}

// ------------------------------------------------------------- main entry

/**
 * Resolve the dsh bin (design §4.1.2 ①-⑦). Contract: NEVER throws; null means
 * "unresolvable" and the caller (DshProcess) falls back to the untouched 0.1.6
 * `cmd.exe + npx` path (safety net, worst case = 0.1.6 behavior).
 *
 * 0.1.14 ADR-29-② 双重防护（第二归一点）：extension readConfig 之外，本入口
 * 再做一次 legacy/非法通道值归一（防绕过 extension 的无头测试路径直用非法
 * 值）；`preview`（E404 dist-tag）等非法值 → 'latest' + rlog 留痕；不写回
 * 任何配置。
 */
export async function resolveDshBin(channel: string, opts: { force?: boolean; logFile?: string } = {}): Promise<DshBinInfo | null> {
  const norm = normalizeChannel(channel)
  if (norm.normalized) {
    rlog(`resolveDshBin: ${normalizeChannelLogLine(channel, norm.channel)} (entry dual guard)`)
  }
  try {
    return await resolveInternal(norm.channel, opts)
  } catch (err) {
    rlog(`resolveDshBin: unexpected error -> null (0.1.6 cmd+npx fallback): ${(err as Error).message}`)
    return null
  }
}

async function resolveInternal(channel: string, opts: { force?: boolean; logFile?: string }): Promise<DshBinInfo | null> {
  // ① node/npm/npx resolution (failure -> null -> 0.1.6 fallback)
  const tools = resolveNodeAndNpm()
  if (tools === null) {
    rlog('resolveDshBin: node/npm resolution failed -> null (0.1.6 cmd+npx fallback)')
    return null
  }
  const { nodeExe, npmCliJs, npxCliJs } = tools
  const spec = `${DSH_PKG}@${channel}`

  // ② content scan of the npx cache (glob the hash dirs; no hash compute/hardcode)
  let cands = scanCandidates()
  rlog(
    `resolveDshBin: scan(${npxRoot()}) -> ${cands.length} candidate(s) ` +
      `[${cands.map((c) => `${path.basename(c.dir)}@${c.version}${c.binJs === '' ? ' (bin.js missing)' : ''}`).join(', ')}]`,
  )

  // ③ freshness reference version V (ADR-13): fresh meta -> zero network;
  //    otherwise best-effort bounded `npm view` (async, F-03) + meta write.
  const meta = readMeta(channel)
  let V: string | null = null
  if (opts.force !== true && metaFresh(meta) && typeof meta.knownVersion === 'string' && meta.knownVersion.length > 0) {
    V = meta.knownVersion
    rlog(`resolveDshBin: meta fresh (lastCheckAt=${meta.lastCheckAt}) -> V=${V} (offline steady, zero network)`)
  } else {
    V = await npmViewVersion(nodeExe, npmCliJs, channel, opts.logFile)
    if (V !== null) {
      writeMeta(channel, V)
      rlog(`resolveDshBin: npm view -> V=${V}; meta written`)
    } else {
      rlog('resolveDshBin: npm view unavailable/failed -> V=null (offline edge)')
    }
  }

  // ④ multi-candidate disambiguation
  if (V !== null) {
    const matching = cands.filter((c) => c.version === V && c.binJs !== '')
    if (matching.length > 0) {
      const chosen = pickNewest(matching)
      if (chosen !== null) {
        rlog(`resolveDshBin: version match V=${V} -> selected ${chosen.dir} (mode=steady)`)
        return { binJs: chosen.binJs, version: chosen.version, dir: chosen.dir, mode: 'steady' }
      }
    }
  } else {
    const chosen = pickNewest(cands)
    if (chosen !== null && chosen.binJs !== '') {
      // Offline edge: declare the selected directory explicitly (rlog trail).
      rlog(`resolveDshBin: OFFLINE EDGE (V=null) -> declaring selected dir: ${chosen.dir} @${chosen.version} (mode=steady)`)
      return { binJs: chosen.binJs, version: chosen.version, dir: chosen.dir, mode: 'steady' }
    }
  }

  // ⑤ in-place refresh: V≠null with no matching candidate, or the offline-selected
  //    candidate is corrupted. Target = sticky (version === meta.knownVersion,
  //    the previously selected dir) else newest. Same reify op npx performs (E9).
  const newest = pickNewest(cands)
  let refreshTarget: Candidate | null = null
  if (cands.length > 0) {
    if (V !== null) {
      const sticky = typeof meta.knownVersion === 'string' ? cands.find((c) => c.version === meta.knownVersion) : undefined
      refreshTarget = sticky ?? newest
    } else if (newest !== null && newest.binJs === '') {
      refreshTarget = newest
    }
  }
  if (refreshTarget !== null) {
    rlog(
      `resolveDshBin: in-place refresh target=${refreshTarget.dir} ` +
        `(sticky=${refreshTarget.version === meta.knownVersion ? 'knownVersion' : 'newest-mtime'}; spec=${spec}; flags=${INSTALL_FLAGS.join(' ')})`,
    )
    const ok = await npmInstallInto(nodeExe, npmCliJs, refreshTarget.dir, channel, opts.logFile)
    cands = scanCandidates()
    const after = cands.find((c) => c.dir === refreshTarget?.dir)
    const verified = ok && after !== undefined && after.binJs !== '' && (V === null || after.version === V)
    if (verified && after !== undefined) {
      writeMeta(channel, V ?? after.version)
      rlog(`resolveDshBin: in-place refresh OK -> ${after.dir} @${after.version} (mode=refreshed)`)
      return { binJs: after.binJs, version: after.version, dir: after.dir, mode: 'refreshed' }
    }
    rlog(
      `resolveDshBin: in-place refresh failed ` +
        `(install=${ok}, after=${after === undefined ? 'gone' : `@${after.version}${after.binJs === '' ? ' no-bin' : ''}`})`,
    )
  }

  // ⑥ npx chain establishment (no candidates / refresh failed) — the SAME reify
  //    chain and download cache as the 0.1.6 first install (not a new cost).
  if (npxCliJs !== '' && isFile(npxCliJs)) {
    const ok = await npxChainEstablish(nodeExe, npxCliJs, channel, opts.logFile)
    cands = scanCandidates()
    rlog(`resolveDshBin: npx chain establish=${ok}; rescan -> ${cands.length} candidate(s)`)
    const healthy = cands.filter((c) => c.binJs !== '')
    const chosen = V !== null ? (pickNewest(healthy.filter((c) => c.version === V)) ?? pickNewest(healthy)) : pickNewest(healthy)
    if (chosen !== null) {
      if (V !== null && chosen.version !== V) {
        rlog(`resolveDshBin: establishment version drift (V=${V}, installed ${chosen.version}); using the installed version`)
      }
      writeMeta(channel, chosen.version)
      rlog(`resolveDshBin: established ${chosen.dir} @${chosen.version} (mode=established)`)
      return { binJs: chosen.binJs, version: chosen.version, dir: chosen.dir, mode: 'established' }
    }
    rlog('resolveDshBin: establishment yielded no usable candidate')
  } else {
    rlog('resolveDshBin: npx-cli.js unavailable; skipping npx chain establishment')
  }

  // ⑦ give up -> DshProcess uses the untouched 0.1.6 cmd+npx path (safety net).
  rlog('resolveDshBin: all layers failed -> null (0.1.6 cmd+npx fallback)')
  return null
}
