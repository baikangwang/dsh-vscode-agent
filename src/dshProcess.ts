// Managed-launch of a detached dsh web process (detached 基线, P0-B / P0-C).
//
// The plugin spawns a detached, unref'd process with stdio redirected into a
// logs/dsh-<ts>.log file, then resolves the real port from that same file
// (random-port path) or probes the fixed port directly (fixed-port path), all
// within a total startup budget (F-PORT, ADR-9). It no longer owns the child:
// no `exit` listener, no kept handle — liveness is the runtime's external
// probe concern (P0-C). Pure Node (no vscode dependency).
//
// 0.1.9 ADR-21 start-launch (§4.6, P-CONSOLE): with `launchMode: 'start'`
// (chosen by the runtime when consoleVisible=true) the launch is wrapped as
// `cmd.exe /d /s /c start "<TITLE>" /d "<CWD>" /wait cmd /d /c "<payload>"`
// with windowsVerbatimArguments — `start` forces CREATE_NEW_CONSOLE, giving dsh
// a SELF-HELD, visible, resident console that every tool subprocess shares
// (structurally zero popup flashes).
// 0.1.9.1 ADR-23 (§4.8, P-RESIDENT): (1) `/wait` turns the outer cmd from a
// ~0.1s transient wrapper into the HOLDER of the inner chain's lifetime
// (E6c: outer alive ⟸ inner alive), which restores a fast failure signal:
// ANY outer-cmd exit BEFORE readiness = launch failure (E6a: /wait does NOT
// propagate the inner exit code — the code value is diagnostic only, code 0 is
// equally a failure). After readiness the listeners are removed: a service-era
// outer exit is a no-op (probe/user-stop paths own that case, §4.8.1). (2) The
// readiness budget is TIERED per launch mode: start/conhost family =
// STARTUP_TIMEOUT_MS_START (30s), direct = STARTUP_TIMEOUT_MS (90s, ADR-9
// untouched) — §4.8.3. (3) The resident-console launcher is dual-track
// (§4.8.5): `START_LAUNCH_STRATEGY` ('start' = start /wait, the mainline;
// 'conhost' = conhost.exe direct launch, the E5-proven backup) is a BUILD-TIME
// single-point constant — no runtime auto-degradation chain. dsh.pid = the
// PORT HOLDER pid (ADR-14 contract preserved); the wrapper/conhost pid stays
// as a diagnostic value.
// direct mode keeps the pre-0.1.9 shape byte-identically (incl. the crash
// backoff semantics owned by the runtime).
// 0.1.11 ADR-24 + ADR-24补充 (§4.9.1/§4.9.8, user three-way ruling = plan A):
// (1) THREE-STAGE MARKER instrumentation is PERMANENT on the start-launch
// path (§4.9.1): the inner payload is wrapped as
// `echo inner-cmd-start >> "<LOG>.cmd-start" & echo node-start >> "<LOG>.node-start" & <production payload> & (if errorlevel 1 (echo node-exit-nonzero >> "<LOG>.node-exit") else (echo node-exit-0 >> "<LOG>.node-exit"))`
// — arm-1..4/4b timeline = file existence + mtime + append order (NEVER
// %DATE%/%TIME%: parse-time expansion would freeze wrong timestamps). Under
// the npx arm arm-2's semantic = the npx process layer (§4.9.8 judge matrix,
// same marker shape both arms). direct / custom-command paths are untouched.
// (2) The start-wait window payload variant is a BUILD-TIME single-point
// constant `START_PAYLOAD_VARIANT` ('node-bin' = the pre-0.1.11 payload,
// byte-identical; 'npx' = the fallback-chain npx payload shape, L539-556
// verbatim — the 0.1.11 experimental package ships 'npx'). The node-bin arm
// is NOT removed: it stays the direct-mode payload and the flip-back track.
// (3) Readiness budget gains a THIRD tier: start+npx = 60s
// (STARTUP_TIMEOUT_MS_START_NPX), start+node-bin = 30s, direct = 90s (ADR-9).
// The registry dsh.pid stays the PORT HOLDER pid (resolvePortPid is agnostic
// to who holds the port — for an npx tree the holder is the final node
// process, §4.9.8-2).
// 0.1.12 ADR-25 + ADR-26 (§4.10, P-RESIDENT-R3): (1) ADR-25 observability —
// the runtime port decision becomes the named single point resolveLaunchPort()
// (source = configured / fallback-random / retry-degraded, rlog-traced), the
// resident-console arms emit `payload port = <N>` at the SHARED marker-trace
// point (launch-mode layer, both arms), and resolver child output moves to the
// `<log>.resolver` sibling file (per-launch log head stays dsh-only output).
// (2) ADR-26 conhost strategy switch: START_LAUNCH_STRATEGY ships 'conhost'
// (basis = user experiment ② B2 ALIVE, E-R3-7; the RV-9-5 in-plan switch, not
// a new loopback) — the R3 killer keys on the start-launch FORM chain itself;
// the death cause stays UNDECIDED (we routed around it, we did not solve it).
// Flip back by restoring 'start' (the sim start-wait assertions moved to the
// flip-back track accordingly).
import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { EventEmitter } from 'node:events'
import {
  managedDshLogFile, LOOPBACK_HOST, appendDecisionLog,
  MARKER_SUFFIX_CMD_START, MARKER_SUFFIX_NODE_START, MARKER_SUFFIX_NODE_EXIT, dshLogMarkerFile,
} from './paths'
import { resolveDshBin, resolveNodeAndNpm, DSH_PKG, type DshBinInfo } from './dshResolver'
import { resolvePortPid } from './instance'

export interface SpawnOptions {
  /** Port to request (0 = OS assigned; random-port path). */
  port: number
  /** npm spec: 'latest' | 'preview' | exact version. */
  channel: string
  /** Custom launch command (e.g. 'dsh web --port 3080'); empty = npx path. */
  command: string
  /** DSH_HOME override (empty = inherit / default). */
  dshHome: string
  /**
   * P-POPUP 方案 B (ADR-20, user ruling 2026-08-29): when true the managed dsh
   * runs on a VISIBLE console (its tool subprocesses share that console
   * instead of popping a new window per call, and the dsh sandbox subsystem
   * regains its "child shares the host console" design premise); when
   * false/absent dsh is fully hidden (the accepted 0.1.7 shape). In DIRECT
   * mode this still flips ONLY the windowsHide flag (detached / stdio fd
   * redirect / unref() stay byte-identical in both states, PP-1). In START
   * mode the outer cmd is spawned windowsHide:true (the visible console comes
   * from `start` itself). Custom `command` keeps its legacy boundary (the cmd
   * chain may still flash windows) regardless of this flag.
   */
  consoleVisible?: boolean
  /**
   * ADR-21 (0.1.9 §4.6): 'start' = the RESIDENT-CONSOLE family (start-wait or
   * conhost launcher, §4.8.5 — registry/UI semantics stay binary);
   * 'direct' = the pre-0.1.9 direct spawn. Default 'direct'; FORCED 'direct'
   * regardless of the requested value when the platform is not win32 or a
   * custom `command` is set (§4.6.4 / 实施清单 #20 — the single resolution
   * point is effectiveLaunchMode()).
   */
  launchMode?: 'start' | 'direct'
  /**
   * Test seam for the port-holder pid resolution (PP-2-3): defaults to the
   * real `resolvePortPid` (netstat). Headless tests inject a mock.
   */
  resolvePortPidFn?: (port: number) => { pid: number; address: string } | null
}

export interface SpawnedInfo {
  /**
   * The DIRECT child pid — a DIAGNOSTIC value only (ADR-21: in start mode this
   * is the transient outer cmd; the authoritative service pid is servicePid).
   */
  pid: number
  port: number
  url: string
  /** The logs/dsh-<ts>.log file the detached dsh wrote to (F-PORT data source). */
  logFile: string
  /**
   * ADR-21: the real dsh service pid. direct mode = child.pid 恒等; start mode
   * = the port holder pid resolved after readiness (bounded retries; null =
   * degraded state — forceRelaunch 'no-managed', shutdown safe-side no-kill,
   * probeTick death → user-stop branch, §4.6.4).
   */
  servicePid: number | null
  /**
   * ADR-22 #29 transparency: the resolver hit consumed by THIS launch
   * (bin dir / binJs / version / mode); null on the 0.1.6 fallback chain or
   * the custom-command path (no resolver involvement).
   */
  resolved: { version: string; dir: string; binJs: string; mode: 'steady' | 'refreshed' | 'established' } | null
  /**
   * 0.1.14 ADR-30-1: the launch token captured from this launch's banner
   * (`dsh web: http://127.0.0.1:<port>/?token=<t>`) — the T-path session
   * source for authProxy (design §3.4 R10). `null` = the banner carried no
   * `?token=` (the legacy contract shape, ≤0.1.1-rc.2) or the token was
   * malformed → zero-regression for the old contract (PP-8-1/PP-8-5).
   * NEVER persisted (D3: registry stores no token — memory-only).
   */
  authToken: string | null
}

// ---------------------------------------------------------------------------
// ADR-21 constants (集中管理，去硬编码; §4.6.2/§4.6.4)
// ---------------------------------------------------------------------------

/** The resident-console window title (RV-7 identifiability anchor; ASCII). */
export const START_WINDOW_TITLE = 'dsh service console (DSH Panel)'
/** Bounded retries for the post-readiness port-holder pid resolution. */
export const PORT_PID_RESOLVE_ATTEMPTS = 3
/** Delay between port-holder pid resolution attempts (ms). */
export const PORT_PID_RESOLVE_RETRY_MS = 500

// ---------------------------------------------------------------------------
// ADR-23 constants (集中管理，去硬编码; §4.8.3/§4.8.5)
// ---------------------------------------------------------------------------

/**
 * Readiness budget for the resident-console launch family (start-wait AND
 * conhost, §4.8.3): 30s ≈ 2× the hot-cache direct readiness (12-14s). The
 * direct-mode budget stays STARTUP_TIMEOUT_MS (90s, ADR-9) untouched.
 * Accepted-risk boundary (v2.10 W-02): a cold start (first install / cold npx
 * cache / AV scan) may exceed 30s in start mode -> ×2 counted failures ->
 * direct fallback (usability kept, resident window lost once); the two
 * failure trajectories stay textually distinguishable in rlog (fast-fail
 * "exited before readiness" vs budget "within <ms>").
 */
export const STARTUP_TIMEOUT_MS_START = 30_000

/**
 * ADR-23 §4.8.5 resident-console launcher strategy — a BUILD-TIME single-point
 * constant, NOT a runtime decision: 'start' = the start /wait mainline;
 * 'conhost' = the conhost.exe direct launch backup (E5-proven shape). A real
 * machine verdict (RV-9-1) switches it by editing this constant and
 * repacking — deliberately NO runtime start→conhost→direct degradation chain.
 *
 * 0.1.12 ADR-26 (§4.10.7; RV-9-5 in-plan switch, not a new loopback): ships
 * 'conhost' — basis = user experiment ② B2 ALIVE (E-R3-7: the conhost form
 * survives in the SAME VSCode/exthost context that killed the start-wait chain
 * in R3; §4.9.2 matrix row "conhost alive → C1 refuted + conhost arm
 * re-enlisted"). The R3 killer keys on the start-launch FORM chain itself (C2
 * first-rank; death cause UNDECIDED — routed around, not solved). The conhost
 * code path is pre-existing (the conhost spawn branch + buildConhostLaunchArgv)
 * — the switch is THIS constant plus the reversed sim assertion baseline
 * (#58-⑤: conhost form = production baseline, start-wait form = flip-back
 * track). FLIP-BACK: restore 'start' and repack.
 */
export type StartLaunchStrategy = 'start' | 'conhost'
// The `as` widening keeps the DECLARED union at every read site: a plain
// literal initializer would CFA-narrow the const to 'conhost' and falsely
// reject the 'start' comparisons below (the switch point must stay
// two-way comparable for the build-time flip).
export const START_LAUNCH_STRATEGY = 'conhost' as StartLaunchStrategy

/**
 * rlog-facing launcher label (§4.8.5: the 'start' strategy IS the /wait
 * variant, recorded as `launcher=start-wait`; conhost records
 * `launcher=conhost`). launchMode stays binary in the registry/UI — the
 * launcher variant is rlog-trace-only.
 */
export const START_LAUNCHER_LABEL: 'start-wait' | 'conhost' =
  START_LAUNCH_STRATEGY === 'conhost' ? 'conhost' : 'start-wait'

// ---------------------------------------------------------------------------
// 0.1.11 constants (ADR-24 #45 + ADR-24补充 #51/#52; §4.9.1/§4.9.8 集中管理)
// ---------------------------------------------------------------------------

/** Marker TEXT written into each sibling file (§4.9.1 verbatim stage names;
 *  the timeline itself is file existence + mtime + append order — deliberately
 *  NO %DATE%/%TIME% anywhere in the payload). arm-3 = files absent, arm-4/4b =
 *  the exit marker's text classifies node-self-exit nonzero/0. */
export const MARKER_TEXT_CMD_START = 'inner-cmd-start'
export const MARKER_TEXT_NODE_START = 'node-start'
export const MARKER_TEXT_NODE_EXIT_NONZERO = 'node-exit-nonzero'
export const MARKER_TEXT_NODE_EXIT_ZERO = 'node-exit-0'

/**
 * ADR-24补充 #52 (§4.9.8-4-①): readiness budget for the start family WHEN the
 * npx payload arm is active — 60s covers the warm-cache estimate (12-22s ≈ 3×
 * margin) and most cold-cache runs; the OTHER two tiers stay untouched:
 * start+node-bin = STARTUP_TIMEOUT_MS_START (30s), direct = STARTUP_TIMEOUT_MS
 * (90s, ADR-9). Three independently named constants, never aliased (PP-5-2).
 */
export const STARTUP_TIMEOUT_MS_START_NPX = 60_000

/**
 * ADR-24补充 #51 (§4.9.8-5): BUILD-TIME single-point payload variant for the
 * start-wait window — 'node-bin' = the pre-0.1.11 production payload
 * (`"<NODE>" "<BINJS>" web …`, byte-identical, also the DIRECT-mode payload);
 * 'npx' = the fallback-chain npx payload shape verbatim
 * (`npx --yes --prefer-offline @deepseek-ai/dsh@<channel> web …`). The 0.1.11
 * experimental package (user ruling = plan A) ships 'npx'; flipping this ONE
 * constant and repacking restores the pre-0.1.11 behavior bit-for-bit. The
 * variant NEVER touches the direct path (always node-bin, PP-5-4) and never
 * touches the custom-command boundary. The `as` widening keeps the DECLARED
 * union two-way comparable at the switch seam (same discipline as
 * START_LAUNCH_STRATEGY above).
 */
export type StartPayloadVariant = 'node-bin' | 'npx'
export const START_PAYLOAD_VARIANT = 'npx' as StartPayloadVariant

/**
 * Payload SELECTION seam (#51: the single switch point — the variant constant
 * flows in as an argument, both arms are pure builders). Unit-assertable
 * headlessly (PP-5-1/PP-5-3) without spawning.
 */
export function startPayloadForVariant(
  variant: StartPayloadVariant,
  nodeBinPayload: string,
  npxPayload: string,
): string {
  return variant === 'npx' ? npxPayload : nodeBinPayload
}

/**
 * Readiness-budget SELECTION seam (#52: the single tiering point, consumed by
 * start() at the one readiness-wait site). direct = 90s regardless of the
 * variant; the start family tiers on the variant (npx 60s / node-bin 30s).
 */
export function startBudgetMsFor(variant: StartPayloadVariant, mode: 'start' | 'direct'): number {
  if (mode !== 'start') return STARTUP_TIMEOUT_MS
  return variant === 'npx' ? STARTUP_TIMEOUT_MS_START_NPX : STARTUP_TIMEOUT_MS_START
}

/**
 * §4.9.1 marker PREFIX (verbatim shape; `payload` keeps its own
 * `>> "<LOG>" 2>&1` tail). Two echo segments append the arm-1/arm-2 markers
 * BEFORE the production payload; quoting is unconditional (same discipline as
 * buildStartLaunchCommand). Files are siblings of the per-launch log.
 */
export function markerPrefix(logFile: string): string {
  return (
    `echo ${MARKER_TEXT_CMD_START} >> "${dshLogMarkerFile(logFile, MARKER_SUFFIX_CMD_START)}"` +
    ` & echo ${MARKER_TEXT_NODE_START} >> "${dshLogMarkerFile(logFile, MARKER_SUFFIX_NODE_START)}"`
  )
}

/**
 * §4.9.1 marker SUFFIX: the conditional group AFTER the payload —
 * `if errorlevel 1` classifies the inner chain's exit code as propagated by
 * the launcher (under the npx arm npx propagates the child's code, §4.9.8-3),
 * writing the arm-4 (nonzero) or arm-4b (0) marker text.
 */
export function markerSuffix(logFile: string): string {
  const exitFile = `"${dshLogMarkerFile(logFile, MARKER_SUFFIX_NODE_EXIT)}"`
  return (
    ` & (if errorlevel 1 (echo ${MARKER_TEXT_NODE_EXIT_NONZERO} >> ${exitFile})` +
    ` else (echo ${MARKER_TEXT_NODE_EXIT_ZERO} >> ${exitFile}))`
  )
}

/**
 * §4.9.1 three-stage marker wrap (0.1.11, PERMANENT on the start-launch path):
 * `<prefix> & <production payload><suffix>`. Applied ONCE, where the start
 * payload is consumed (start-launch family only — direct/custom paths never
 * see it). echo-level cost: two appends + one conditional group, no new
 * process/IPC/config (zero readiness-latency impact).
 */
export function wrapStartPayloadWithMarkers(payload: string, logFile: string): string {
  return `${markerPrefix(logFile)} & ${payload}${markerSuffix(logFile)}`
}

// ---------------------------------------------------------------------------
// ADR-27 (0.1.13, design §4.11): resident-console static info header — a PURE
// observation overlay composed INSIDE the marker wrap, BEFORE the production
// payload. Bare `echo` segments only: NO redirection (the per-launch log data
// source stays byte-pure for parseSelfVersion/resolvePortFromLog), NO new
// process, NO new quotes (cmd /c quote pairing shape unchanged), zero marker
// machine changes (the greedy group 3 of MARKER_WRAP_RE absorbs the compound
// string; peelLaunchMarkers/conhostInnerCmd semantics untouched).
// ---------------------------------------------------------------------------

/**
 * echoSafe (§4.11.2-(4)): neutralize every cmd chain/redirect/escape/expansion
 * character `[&|<>^"%!]` into `?` — display-level degradation, chain-safe.
 * Parens are EXEMPT (probe ⑤-a: top-level echo segments keep `()` literal);
 * `"` is force-neutralized so the command adds ZERO new double quotes.
 */
export function echoSafeText(s: string): string {
  return s.replace(/[&|<>^"%!]/g, '?')
}

/**
 * The 9-line static info header (§4.11.2-(3) 定稿, verbatim; Chinese copy per
 * the user's approved wording). Compile-time constants + the single runtime
 * variable `logFile` (no tail process, no polling, no env probing — ADR-23
 * fast signals and the budget tiers are structurally untouched). Static lines
 * are built to contain none of the echoSafe characters (full-width punctuation
 * instead); echoSafe is the runtime backstop for the dynamic log path.
 */
export function consoleInfoHeader(logFile: string): string {
  const lines = [
    '='.repeat(64),
    'DSH 服务常驻控制台（DSH Panel 托管）',
    '本窗口是 dsh web 服务的宿主进程，由 DSH Panel 扩展创建。',
    '关闭本窗口 = 停止 dsh 服务（面板将显示「已停止」）——不需要时可直接关闭。',
    '本窗口不回显服务实时日志：全部输出已重定向到下方日志文件（取证与排障用）。',
    `本次启动日志: ${logFile}`,
    '误关后的恢复：在 DSH Panel 面板点「重启服务」即可重新拉起（新窗口）。',
    '服务状态请看 VSCode 内的 DSH Panel 面板。',
    '='.repeat(64),
  ]
  return lines.map((l) => `echo ${echoSafeText(l)}`).join(' & ') + ' & echo.'
}

/**
 * Compose the info header BEFORE the production payload (§4.11.2-(5)):
 * `<header> & <payload>`. Consumed at the ONE payload-consumption point in
 * start() so the header lands inside the marker wrap (marker prefix → header →
 * payload → marker suffix). Only the conhost-arm-resident launch family
 * reaches it: startPayload = null (direct path and the custom-command
 * boundary) never composes the header.
 */
export function withConsoleInfoHeader(payload: string, logFile: string): string {
  return `${consoleInfoHeader(logFile)} & ${payload}`
}

/**
 * The node-bin production payload (pre-0.1.11 L530-531 shape verbatim, now a
 * named arm): quoted node + quoted binJs + fixed dsh args + quoted log
 * redirect. The DIRECT mode exec/argv contract is unchanged; this builder is
 * the start-window payload for the 'node-bin' variant (the flip-back track).
 */
export function buildNodeBinStartPayload(nodeExe: string, binJs: string, port: number, logFile: string): string {
  return `"${nodeExe}" "${binJs}" web --host ${LOOPBACK_HOST} --port ${String(port)} --no-open >> "${logFile}" 2>&1`
}

/**
 * The npx chain command (0.1.6 fallback-chain shape verbatim, now also the
 * 'npx' payload arm's production payload, §4.9.8-3: "接缝已在现码" — this is
 * the SAME construction as the resolver-failure fallback below). Single
 * source for both consumers so the two stay byte-identical by construction.
 * spec = the channel variable (zero version literals, 去硬编码纪律).
 */
export function buildNpxArgs(channel: string, port: number): string {
  return `npx --yes --prefer-offline ${DSH_PKG}@${channel} web --host ${LOOPBACK_HOST} --port ${String(port)} --no-open`
}

/** The npx production payload = the chain + the quoted log redirect tail. */
export function buildNpxStartPayload(channel: string, port: number, logFile: string): string {
  return `${buildNpxArgs(channel, port)} >> "${logFile}" 2>&1`
}

/**
 * Build the verbatim `start` command line (RAW, §4.6.2 + §4.8.2). `payload` is
 * the INNER cmd /c command INCLUDING the `>> "<LOG>" 2>&1` redirect tail. Every
 * path-bearing segment is quoted UNCONDITIONALLY (no "no-space → no-quote"
 * branch: paths come from resolver/env at runtime, spaces are unpredictable;
 * unconditional quoting keeps this builder single-point and headless-assertable).
 *
 * ADR-23 (#38): `/wait` is injected between `/d "<CWD>"` and the inner `cmd`
 * (start option order is insensitive, §4.8.2) — the outer cmd then CO-HOLDS
 * the inner chain's lifetime (E6c), which is the physical carrier of the
 * exit-before-readiness fast signal (§4.8.3). All quoting rules stay
 * byte-identical to 0.1.9 (E2: the quote structure was proven correct).
 *
 * Combined with `windowsVerbatimArguments: true` on the outer spawn this gives
 * the extension full control of the raw command line (bypassing Node's MSVCRT
 * escaping, which cmd does not understand).
 */
export function buildStartLaunchCommand(payload: string): string {
  return `start "${START_WINDOW_TITLE}" /d "${process.cwd()}" /wait cmd /d /c "${payload}"`
}

/**
 * ADR-23 §4.8.5 backup track (E5-proven shape, v2.10 W-01): build the
 * conhost.exe direct-launch argv. `payload` is the same inner cmd /c payload
 * as the start-wait track. The window title is set by the INNER `title`
 * command (takes the rest of the line verbatim — UNQUOTED, quoting would put
 * literal quote characters into the title); the payload keeps its own quoting
 * and the `>> "<LOG>" 2>&1` redirect (the outer layer needs no fd — stdio is
 * 'ignore'×3, the log data source is untouched).
 */
export function buildConhostLaunchArgv(payload: string): string[] {
  return ['--', 'cmd', '/d', '/c', `title ${START_WINDOW_TITLE} && ${payload}`]
}

/** Single-port banner regex. Pre-existing (F4): the inner 127.0.0.1 literal is
 *  exempted from the LOOPBACK_HOST de-literalization and left unchanged.
 *  0.1.14 ADR-30-1: this regex stays PORT-ONLY and byte-identical (token-blind
 *  compatibility, PP-8-1/PP-8-5) — token capture lives in TOKEN_RE below. */
const URL_RE = /dsh web:\s+(http:\/\/127\.0\.0\.1:(\d+))/i

/**
 * 0.1.14 ADR-30-1: banner `?token=` capture (the token VALUE data source —
 * the contract tier itself is judged by VERSION, see judgeContractByVersion;
 * 「判定看版本、取值看 banner」). Charset class `[A-Za-z0-9_-]+` (base64url
 * family) with NO length anchor (an upstream length change must not shatter
 * the capture) plus a BOUNDARY check: the token must be followed by
 * whitespace or end-of-line. `?token=` with nothing after it, or a value
 * cut short by `&` (a second query param = URL-shape violation for the dsh
 * banner, which emits exactly one token param), does NOT match → null +
 * no throw (honest degradation, PP-8-1 malformed cases).
 */
const TOKEN_RE = /\?token=([A-Za-z0-9_-]+)(?=\s|$)/

/**
 * Total budget for one managed launch to reach `__DSH_BOOT__` ready (§6.5).
 * ADR-23 §4.8.3: this is the DIRECT-mode budget (ADR-9, value untouched); the
 * start/conhost family uses STARTUP_TIMEOUT_MS_START instead (tiered in
 * start(), the single readiness-wait site).
 */
export const STARTUP_TIMEOUT_MS = 90_000
/** Poll cadence while tailing the log / probing readiness. */
export const PROBE_POLL_MS = 500
/** Single HTTP probe deadline. */
const HTTP_TIMEOUT_MS = 3_000

// ---------------------------------------------------------------------------
// 0.1.14 ADR-30 (v1.1 user ruling): VERSION-THRESHOLD contract judgement.
// The proxy/probe/externalUrl tier is decided by the RUNNING dsh version
// compared against TOKEN_AUTH_MIN_VERSION — the channel name and the banner
// shape are BOTH out of the judgement layer (通道名与 banner 特征均不参与判定;
// banner capture stays the token-VALUE data source only). Semver ordering is
// prerelease-aware per §3.3: same-patch prerelease identifiers compare
// numerically then lexically, `rc` > `alpha`, stable > any prerelease — so a
// future 0.1.2-rc.x / 0.1.2 stable / 0.1.3+ on latest/next AUTO-COVERS the
// threshold with zero design change (user-ruled future compatibility).
// ---------------------------------------------------------------------------

/**
 * The first PUBLISHED npm version carrying the mandatory token auth
 * (browser-auth). Three-source verdict (EVIDENCE E-VER): git commit 3e24087bfa
 * (2026-08-25) is first contained by tag dsh-v0.1.2-alpha.1 which was NEVER
 * published to npm; npm versions line jumps 0.1.1-rc.2 → 0.1.2-alpha.2 with no
 * unclassified intermediate; alpha.2 behavior evidence (auth sources present).
 * Single-point constant (去硬编码; PP-8-6 pins it).
 */
export const TOKEN_AUTH_MIN_VERSION = '0.1.2-alpha.2'

/**
 * 0.1.17 #1 (design §九 v3): the ZERO-FLASH floor of the HIDDEN launch form
 * (consoleVisible=false). dsh 0.1.3-alpha.1 carries the upstream flash-window
 * fix (PR #3516) — but that version was NEVER published to npm, so it is
 * unreachable via npm installs. Single-point constant (TOKEN_AUTH_MIN_VERSION
 * 同址同模式; 去硬编码).
 */
export const WINDOWSAFE_MIN_VERSION = '0.1.3-alpha.1'

/**
 * 0.1.17 #1 (design §九 v3): the START of the hidden-form popup-REGRESSION
 * band. dsh ≥ 0.1.3-alpha.2 native runner reintroduced the upstream popup
 * flash (PR #2825; upstream master unfixed at the time of writing). 上界常量
 * 的改置由用户评审裁决：待上游修复版正式发布后，由用户评审决定上调（或按
 * 裁决移除门控）——开发侧不自作主张改置。Single-point constant (去硬编码).
 */
export const WINDOWSAFE_REGRESSION_MIN_VERSION = '0.1.3-alpha.2'

/** Contract tier of the RUNNING dsh (§3.3 判定表; pure — version only). */
export type ContractTier = 'token' | 'legacy' | 'unknown'

interface ParsedSemver {
  major: number
  minor: number
  patch: number
  /** Prerelease identifiers; null = stable release (sorts ABOVE any prerelease). */
  pre: string[] | null
}

/** Strict semver parse (`v` prefix tolerated); build metadata ignored; null = malformed. */
function parseSemver(v: string): ParsedSemver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v)
  if (m === null) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] !== undefined ? m[4].split('.') : null,
  }
}

function comparePreIdentifiers(a: string, b: string): number {
  const aNum = /^\d+$/.test(a)
  const bNum = /^\d+$/.test(b)
  if (aNum && bNum) {
    const an = Number(a)
    const bn = Number(b)
    return an === bn ? 0 : an < bn ? -1 : 1
  }
  if (aNum) return -1 // numeric identifiers sort below alphanumeric (semver §11)
  if (bNum) return 1
  return a === b ? 0 : a < b ? -1 : 1
}

/**
 * Prerelease-aware semver comparison (zero npm deps). Returns -1/0/1, or null
 * when either input is malformed (caller decides the degradation — the judge
 * maps null → 'unknown', never throws, PP-8-6①).
 */
export function compareDshVersions(a: string, b: string): number | null {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (pa === null || pb === null) return null
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1
  }
  // Same core: stable > prerelease; both prerelease → identifier-wise compare.
  if (pa.pre === null && pb.pre === null) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  const len = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < len; i++) {
    const ai = pa.pre[i]
    const bi = pb.pre[i]
    if (ai === undefined) return -1 // shorter prerelease set sorts lower
    if (bi === undefined) return 1
    const c = comparePreIdentifiers(ai, bi)
    if (c !== 0) return c
  }
  return 0
}

/**
 * 0.1.14 ADR-30-2 (v1.1): the contract-tier judgement — pure, version-only
 * input (the TYPE guarantees no channel name can enter the decision). §3.3
 * 判定表: ≥ V* → 'token' (#1); < V* → 'legacy' (#2); unreadable/malformed/null
 * → 'unknown' (#3 — the caller starts direct and relies on the existing 401
 * diversion + C path; never fabricates a version fact).
 */
export function judgeContractByVersion(version: string | null): ContractTier {
  if (version === null) return 'unknown'
  const cmp = compareDshVersions(version, TOKEN_AUTH_MIN_VERSION)
  if (cmp === null) return 'unknown'
  return cmp >= 0 ? 'token' : 'legacy'
}

/**
 * Hidden-form (consoleVisible=false) window-flash contract tier of the RUNNING
 * dsh (0.1.17 #1, design §九 v3): pure, version-only input — SAME judgement
 * discipline as judgeContractByVersion, REUSING compareDshVersions (不得另写
 * 一套比较器). Three MUTUALLY-EXCLUSIVE, EXHAUSTIVE bands + the unknown safe
 * side:
 *  - 'flashing'   : < WINDOWSAFE_MIN_VERSION — upstream flash trade-off kept;
 *  - 'zeroFlash'  : [WINDOWSAFE_MIN_VERSION, WINDOWSAFE_REGRESSION_MIN_VERSION)
 *                   — the zero-flash promise band (floor version never
 *                   published to npm);
 *  - 'regression' : ≥ WINDOWSAFE_REGRESSION_MIN_VERSION — upstream popup
 *                   regression (PR #2825, master unfixed);
 *  - 'unknown'    : version null/unparseable → the caller stays SILENT
 *                   (no warning, no promise — never fabricates a version
 *                   fact, judgeContractByVersion's PP-8-6① degradation).
 */
export type WindowSafeTier = 'flashing' | 'zeroFlash' | 'regression' | 'unknown'

export function judgeWindowSafeByVersion(version: string | null): WindowSafeTier {
  if (version === null) return 'unknown'
  const cmpFloor = compareDshVersions(version, WINDOWSAFE_MIN_VERSION)
  if (cmpFloor === null) return 'unknown'
  if (cmpFloor < 0) return 'flashing'
  const cmpRegression = compareDshVersions(version, WINDOWSAFE_REGRESSION_MIN_VERSION)
  if (cmpRegression === null) return 'unknown'
  return cmpRegression < 0 ? 'zeroFlash' : 'regression'
}

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
 * 0.1.14: behavior UNCHANGED (token-blind compatibility, PP-8-1/PP-8-5) —
 * URL_RE stays port-only.
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

/**
 * 0.1.14 ADR-30-1: banner facts (port + token) from the managed-launch log in
 * ONE read. `token` is null on the legacy banner shape (no `?token=`) and on
 * malformed tokens (empty / cut by `&` — TOKEN_RE boundary check). Never
 * throws; the file is read-only (the managed log keeps dsh's own output
 * verbatim — PP-8-4 asserts the plugin never rewrites it).
 */
export interface DshBanner {
  port: number
  token: string | null
}

export function resolveBannerFromLog(logFile: string): DshBanner | null {
  try {
    const text = fs.readFileSync(logFile, 'utf8')
    const pm = text.match(URL_RE)
    if (pm === null) return null
    const port = Number(pm[2])
    if (!Number.isInteger(port) || port <= 0) return null
    const tm = text.match(TOKEN_RE)
    return { port, token: tm !== null ? tm[1] : null }
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
   * ADR-21 single mode-resolution point (§4.6.4 / #20): the requested
   * launchMode is honored ONLY on win32 with an empty custom command;
   * otherwise the pre-0.1.9 direct shape applies. Public so headless tests
   * can assert the forcing rules (PP-2-7) without spawning.
   */
  effectiveLaunchMode(): 'start' | 'direct' {
    if (process.platform !== 'win32') return 'direct'
    if (this.options.command.trim().length > 0) return 'direct'
    return this.options.launchMode === 'start' ? 'start' : 'direct'
  }

  /**
   * Launch a detached dsh (single attempt) and wait (within the MODE-TIERED
   * budget: STARTUP_TIMEOUT_MS_START for the start/conhost family,
   * STARTUP_TIMEOUT_MS for direct — §4.8.3) for it to become
   * `__DSH_BOOT__`-ready. Resolves with the resolved port/url/pid/logFile/
   * servicePid/resolved; rejects with LaunchFailure(logFile) on timeout — or
   * immediately in the resident-console family when the launcher exits before
   * readiness (ANY exit code, §4.8.3 layer 2; the start-wait outer cmd /wait
   * and the conhost host both co-live with the inner chain, so an early exit
   * ⟹ the inner chain died).
   */
  async start(): Promise<SpawnedInfo> {
    const logFile = managedDshLogFile()
    const built = await this.buildLaunch(logFile)
    const mode = this.effectiveLaunchMode()
    // ADR-23 §4.8.3 + 0.1.11 #52: readiness budget tiering at the ONE
    // readiness-wait site — start family tiers on the payload variant (npx
    // 60s / node-bin 30s), direct stays 90s (ADR-9 untouched).
    const startupBudgetMs = startBudgetMsFor(START_PAYLOAD_VARIANT, mode)
    // 0.1.11 #45 (§4.9.1): the three-stage marker wrap is PERMANENT on the
    // start-launch path. 0.1.13 ADR-27 (§4.11): the static info header is
    // composed BEFORE the wrap at this same point — the single payload-
    // consumption point — so the wrap order stays marker prefix → header →
    // payload → marker suffix, and direct mode (never consumes startPayload)
    // and the custom-command boundary (startPayload = null) stay byte-identical.
    const markedStartPayload = built.startPayload !== null ? wrapStartPayloadWithMarkers(withConsoleInfoHeader(built.startPayload, logFile), logFile) : null
    // Redirect both stdout and stderr into the managed log file (P0-B). Open
    // an append fd, hand it to the child, then release it on our side so the
    // detached process owns the file independently. In the start-wait strategy
    // the same fd additionally captures the OUTER cmd's start-layer error text
    // (diagnostic gain, §4.6.1); the inner cmd performs the actual
    // `>> "<LOG>" 2>&1`. The conhost strategy uses stdio 'ignore'×3 (E5/W-01:
    // the redirect is done by the inner payload; the outer layer needs no fd).
    let fd: number | null = null
    const residentLauncher = mode === 'start' ? START_LAUNCH_STRATEGY : null
    const launchStartedAtMs = Date.now() // fast-fail diagnostics: elapsed-to-exit
    if (residentLauncher !== 'conhost') {
      try {
        fd = fs.openSync(logFile, 'a')
      } catch (err) {
        throw new LaunchFailure(`cannot open managed log ${logFile}: ${(err as Error).message}`, logFile)
      }
    }
    let child: ReturnType<typeof spawn> | null = null
    // #58-④ (ADR-26) + #55-① (ADR-25-②): the §4.9.1 marker traceability line
    // and the payload-port trace are a LAUNCH-MODE-LAYER emission SHARED by
    // both resident arms (start-wait AND conhost) — emitted ONCE here, before
    // the launcher branch, with the launcher label adapted per arm
    // (`launcher=conhost` on the conhost arm). W-01 calibration: #55-①'s
    // payload-port trace was planned at the start branch (L470-475 pre-#58);
    // its implementation site is the SAME point as this marker line, and the
    // conhost arm must emit the same-shape lines or RV-12 evidence ③
    // (`payload port = 0`) would be structurally absent in conhost form.
    if (mode === 'start' && markedStartPayload !== null) {
      appendDecisionLog(`[dshProcess] start-launch markers (§4.9.1, permanent): launcher=${START_LAUNCHER_LABEL}; three-stage wrap active; marker files = ${logFile}${MARKER_SUFFIX_CMD_START} | ${MARKER_SUFFIX_NODE_START} | ${MARKER_SUFFIX_NODE_EXIT} siblings; arm-2 semantic = ${START_PAYLOAD_VARIANT === 'npx' ? 'npx process start layer (§4.9.8)' : 'node process start'}; payload variant = ${START_PAYLOAD_VARIANT}`)
      // ADR-25-② payload-port trace: N = the port value the payload actually
      // carries (= DshProcess.options.port, i.e. the launchManaged-prechecked
      // usePort; 0 = OS-assigned random). Cross-check triad: `start: window
      // …(port=CONFIGURED)` (runtime, configured port) + `launchManaged:
      // detached launch (port=EFFECTIVE, source=…)` (runtime) + THIS line —
      // the R3 misreading (configured ≠ payload port) is structurally
      // unreadable after 0.1.12. Recorded for BOTH resident arms (start-wait
      // and conhost); the direct path's effective port stays on the runtime's
      // `detached launch` line (§4.10.4 blast table).
      appendDecisionLog(`[dshProcess] payload port = ${this.options.port} (ADR-25-②: the port value the ${START_LAUNCHER_LABEL} payload actually carries = DshProcess.options.port after the launchManaged precheck; 0 = OS-assigned random)`)
    }
    try {
      if (residentLauncher === 'conhost') {
        // ADR-23 §4.8.5 backup track (E5-proven shape, v2.10 W-01): conhost.exe
        // IS the resident console host — windowsHide:false (hiding it would
        // defeat the backup's purpose), verbatim argv, stdio 'ignore'×3.
        // 0.1.11 #45: the payload carries the same marker wrap (PP-4-1:
        // conhost reuses the one payload construction).
        appendDecisionLog(`[dshProcess] conhost-launch (strategy=conhost): conhost.exe -- cmd /d /c "title ${START_WINDOW_TITLE} && <payload+markers>"; payload redirect -> ${logFile}`)
        child = spawn('conhost.exe', buildConhostLaunchArgv(markedStartPayload ?? ''), {
          detached: true,
          windowsHide: false,
          windowsVerbatimArguments: true,
          stdio: ['ignore', 'ignore', 'ignore'] as const,
          env: this.buildEnv(),
        })
      } else if (residentLauncher === 'start') {
        // ADR-21/23 start-launch mainline: outer cmd is a HIDDEN supervisor
        // handle (the visible resident console is created by `start` itself,
        // NOT by this outer process). `/wait` makes it hold the inner chain's
        // lifetime (E6c) — the physical carrier of the fast-fail signal below.
        // verbatim arguments keep the RAW command line under our full control.
        const raw = buildStartLaunchCommand(markedStartPayload ?? '')
        appendDecisionLog(`[dshProcess] start-launch (launcher=start-wait): cmd.exe /d /s /c start (title="${START_WINDOW_TITLE}", cwd="${process.cwd()}", /wait); payload redirect -> ${logFile}`)
        // (the §4.9.1 marker traceability line + the ADR-25-② payload-port
        // trace moved UP to the shared launch-mode-layer emission point above
        // — #58-④: both resident arms emit the same-shape lines)
        child = spawn('cmd.exe', ['/d', '/s', '/c', raw], {
          detached: true,
          windowsHide: true,
          windowsVerbatimArguments: true,
          stdio: ['ignore', fd, fd] as const,
          env: this.buildEnv(),
        })
      } else {
        // DIRECT mode (pre-0.1.9 shape, byte-identical): consoleVisible flips
        // ONLY windowsHide (PP-1); detached/stdio fd redirect/unref identical.
        child = spawn(built.exec, built.argv, {
          detached: true,
          windowsHide: !this.options.consoleVisible,
          stdio: ['ignore', fd, fd] as const,
          env: this.buildEnv(),
        })
      }
    } finally {
      if (fd !== null) fs.closeSync(fd) // child inherited a copy; parent may close its own
    }
    if (!child.pid) {
      throw new LaunchFailure('spawn returned no pid', logFile)
    }
    const pid = child.pid ?? 0
    // Detached independence: the extension host neither waits on nor holds the
    // child after launch. Backoff/restart and liveness are handled by the
    // runtime (P0-C), not by a kept handle here. In the resident-console
    // family two ONE-SHOT listeners additionally fast-fail the launch
    // (§4.8.3 layer 2); they are removed once readiness settled and never hold
    // the event loop (the /wait outer cmd exits when the inner chain dies —
    // after readiness that is the probe/user-stop paths' concern, §4.8.1).
    child.unref()

    // ---- resident-console fast-fail plumbing (§4.8.3: exit-before-readiness
    // = failure, ANY code; launcher spawn error = failure) --------------------
    let cancelled = false
    let fastFailMessage = ''
    let fastFailReject: ((err: LaunchFailure) => void) | null = null
    const fastFail = new Promise<never>((_resolve, reject) => {
      fastFailReject = (err: LaunchFailure) => {
        cancelled = true
        fastFailMessage = err.message
        reject(err)
      }
    })
    fastFail.catch(() => {
      /* suppressed: a rejection landing after readiness settled is a no-op */
    })
    if (mode === 'start') {
      // #58-② (ADR-26-② hook verification conclusion, no implementation gap):
      // the fast-fail plumbing keys on the LAUNCH MODE (mode === 'start'), NOT
      // on the launcher strategy — the conhost arm (mode='start',
      // residentLauncher='conhost') inherits the exit/error one-shot listeners
      // + the readiness-removal + servicePid=port-holder resolution verbatim.
      // The direct child = conhost co-dies with the inner chain (E5 @6543ms +
      // B2 30s dual evidence), so "exit before readiness = failure" stays
      // semantically isomorphic. (Diagnostic copy note: on the conhost arm the
      // "outer" in these messages is the conhost host — cosmetic only.)
      child.once('exit', (code: number | null) => {
        // ADR-23 §4.8.3: ANY outer exit before readiness = failure. E6a: /wait
        // does NOT propagate the inner exit code (inner exit 3 -> outer 0), so
        // the code value is diagnostic only and code 0 is EQUALLY a failure
        // (an outer cmd that dies early is itself the anomaly signal). The
        // holding semantics (E6c) make this the "inner chain died early"
        // trajectory — textually distinct from the budget-timeout one (W-02).
        if (cancelled) return
        const elapsedMs = Date.now() - launchStartedAtMs
        appendDecisionLog(`[dshProcess] start-launch fast-fail: outer cmd exited before readiness (code=${code}, elapsed ${elapsedMs}ms — inner chain early-death or start-layer failure; code diagnostic only per E6a); log: ${logFile}`)
        fastFailReject?.(
          new LaunchFailure(`start-launch inner chain exited before readiness (code=${code}); log: ${logFile}`, logFile),
        )
      })
      child.once('error', (err: Error) => {
        if (cancelled) return
        appendDecisionLog(`[dshProcess] start-launch fast-fail: launcher spawn error: ${err.message}`)
        fastFailReject?.(new LaunchFailure(`start-launch launcher spawn error: ${err.message}; log: ${logFile}`, logFile))
      })
    }

    const readyPort = await this.waitReadyPort(logFile, () => cancelled, fastFail, startupBudgetMs)
    if (readyPort === null) {
      if (cancelled) {
        // fast-fail already logged; surface the immediate failure (not the budget one)
        throw new LaunchFailure(fastFailMessage !== '' ? fastFailMessage : 'start-launch launcher failed before readiness', logFile)
      }
      if (this.fixedPortPath) {
        throw new LaunchFailure(`dsh did not become ready on fixed port ${this.options.port} within ${startupBudgetMs}ms; log: ${logFile}`, logFile)
      }
      throw new LaunchFailure(`dsh did not expose a ready port within ${startupBudgetMs}ms; log: ${logFile}`, logFile)
    }
    if (mode === 'start') {
      child.removeAllListeners('exit')
      child.removeAllListeners('error')
    }

    // ADR-21: registry dsh.pid = the PORT HOLDER pid (ADR-14 contract
    // preserved, mechanism generalized). direct mode: the spawned child IS the
    // service process (pid 恒等). resident-console family: the direct child is
    // the launcher (start-wait outer cmd / conhost host, diagnostic pid) —
    // resolve the real holder from the now-LISTENING port with bounded
    // retries; null = degraded semantics (§4.6.4).
    let servicePid: number | null
    if (mode === 'start') {
      servicePid = await this.resolveServicePid(readyPort)
      appendDecisionLog(
        servicePid !== null
          ? `[dshProcess] start-launch: service pid (port holder) resolved = ${servicePid} (wrapper pid ${pid}, diagnostic)`
          : `[dshProcess] start-launch: service pid resolve failed after ${PORT_PID_RESOLVE_ATTEMPTS} attempts; servicePid = null (degraded: forceRelaunch no-managed / shutdown safe-side / probeTick user-stop)`,
      )
    } else {
      servicePid = pid
    }
    // 0.1.14 ADR-30-1: capture the banner token from THIS launch's log (the
    // T-path session source). Legacy banners yield null (zero regression).
    const banner = resolveBannerFromLog(logFile)
    // 0.1.17 #1 (design §九 v3): hidden-form (consoleVisible=false) window
    // facts are VERSION-RANGED. Judgement site = the START() SUCCESS PATH ONLY
    // — readiness settled (spawn form fixed), running version resolved
    // (built.resolved, dual-end single source). Idempotence: one successful
    // launch emits AT MOST one line (failure paths throw before this point,
    // so retry/backoff attempts never emit; the probe/reconnect cycles never
    // reach here); it never blocks the launch. consoleVisible=true (resident
    // form) produces NO such line. Unknown/unresolvable version → silent skip
    // (no warning, no promise — safe side). The gating key follows the spawn
    // form (DIRECT arm: `windowsHide: !consoleVisible`): the hidden shape is
    // exactly `consoleVisible !== true`.
    if (this.options.consoleVisible !== true) {
      const windowSafe = judgeWindowSafeByVersion(built.resolved?.version ?? null)
      if (windowSafe === 'flashing') {
        appendDecisionLog('[dshProcess] 运行时 < 0.1.3-alpha.1，隐藏形态存在上游闪窗取舍')
      } else if (windowSafe === 'zeroFlash') {
        appendDecisionLog(`[dshProcess] 运行时 ${built.resolved?.version ?? ''}，隐藏形态零闪窗（零闪窗承诺区 [0.1.3-alpha.1, 0.1.3-alpha.2)，上游 PR #3516）`)
      } else if (windowSafe === 'regression') {
        appendDecisionLog('[dshProcess] WARN: dsh ≥ 0.1.3-alpha.2 native runner 在隐藏形态存在上游弹窗回归（PR #2825 引入，上游 master 未修）；零闪窗仅对 0.1.3-alpha.1 成立，该版本未发布 npm、不可经 npm 安装，建议等待上游修复版')
      }
      // windowSafe === 'unknown' → silent skip (version unresolvable/empty).
    }
    return {
      pid,
      port: readyPort,
      url: `http://${LOOPBACK_HOST}:${readyPort}`,
      logFile,
      servicePid,
      resolved: built.resolved,
      authToken: banner !== null && banner.port === readyPort ? banner.token : null,
    }
  }

  /**
   * Readiness wait (both paths), cancellation-aware. `budgetMs` is the
   * MODE-TIERED readiness budget (§4.8.3: STARTUP_TIMEOUT_MS_START for the
   * resident-console family, STARTUP_TIMEOUT_MS for direct). `isCancelled`
   * aborts the poll loop when a resident-console fast-fail already settled
   * the launch; in that case `fastFail` (when provided) resolves the race
   * immediately instead of waiting for the next poll tick.
   *
   * 0.1.14 §3.5: banner-AWARE readiness — each tick first resolves the banner
   * (port + token). A banner WITH a token (the token-auth contract) gates
   * readiness via the token-303 probe (a bare GET would 401 forever); a
   * tokenless banner keeps the bare `__DSH_BOOT__` probe BIT-IDENTICALLY
   * (legacy tier zero-regression, PP-8-5). The fixed-port path also consults
   * the banner for the token only (its port verdict stays the configured
   * port, pre-0.1.14 semantics); with no banner/token the shape is unchanged.
   */
  private async waitReadyPort(
    logFile: string,
    isCancelled: () => boolean,
    fastFail?: Promise<never>,
    budgetMs: number = STARTUP_TIMEOUT_MS,
  ): Promise<number | null> {
    const deadline = Date.now() + budgetMs
    const work = async (): Promise<number | null> => {
      if (this.fixedPortPath) {
        // Fixed-port path: probe the configured port directly; the banner is
        // consulted ONLY for a token (token-303 form when present).
        while (Date.now() < deadline && !isCancelled()) {
          const banner = resolveBannerFromLog(logFile)
          if (banner !== null && banner.token !== null) {
            if ((await probeDetail(banner.port, { token: banner.token })).kind === 'ok') return this.options.port
          } else if (await probe(this.options.port)) {
            return this.options.port
          }
          await sleep(PROBE_POLL_MS)
        }
        return null
      }
      // Random-port path: tail the managed log for the banner, then probe
      // confirm (token-303 when the banner carries a token, bare otherwise).
      while (Date.now() < deadline && !isCancelled()) {
        const banner = resolveBannerFromLog(logFile)
        if (banner !== null && banner.port > 0) {
          if (banner.token !== null) {
            if ((await probeDetail(banner.port, { token: banner.token })).kind === 'ok') return banner.port
          } else if (await probe(banner.port)) {
            return banner.port
          }
        }
        await sleep(PROBE_POLL_MS)
      }
      return null
    }
    if (fastFail === undefined) return work()
    return Promise.race([
      work(),
      fastFail.then(
        () => null,
        () => null,
      ),
    ])
  }

  /** Bounded port-holder pid resolution (§4.6.4: 3 × 500ms; null = degraded). */
  private async resolveServicePid(port: number): Promise<number | null> {
    const fn = this.options.resolvePortPidFn ?? resolvePortPid
    for (let attempt = 1; attempt <= PORT_PID_RESOLVE_ATTEMPTS; attempt++) {
      try {
        const holder = fn(port)
        if (holder !== null && Number.isInteger(holder.pid) && holder.pid > 0) return holder.pid
      } catch {
        /* treat as unresolved; bounded retries continue */
      }
      if (attempt < PORT_PID_RESOLVE_ATTEMPTS) await sleep(PORT_PID_RESOLVE_RETRY_MS)
    }
    return null
  }

  /**
   * Build the launch exec/argv + start-launch payload (0.1.7, ADR-11/12/14;
   * 0.1.9 ADR-21 adds the start-launch payload variant; 0.1.11 §4.9.8 adds the
   * payload-variant seam):
   * - custom `command` path: 0.1.6 behavior UNCHANGED (legacy boundary §4.1.7);
   *   NEVER wrapped into a start-launch payload (startPayload = null);
   * - npx path: resolve the dsh bin inside the npx cache (single runtime source,
   *   ADR-12 v2.1) and launch it DIRECTLY via node — the cmd/npx/.cmd shim chain
   *   (the visible-console root cause, §3.1) is removed. The spawn flags stay
   *   byte-identical to 0.1.6 (`detached/windowsHide/stdio fd/unref`); only
   *   exec/argv change, so the recorded pid = the real dsh service process
   *   (ADR-14, P-PIDREC closed structurally).
   * - resolver null -> untouched 0.1.6 `cmd.exe /d /s /c npx …` fallback + rlog
   *   (safety net: worst case = 0.1.6 behavior/pid shape, §4.1.7). In start
   *   mode the SAME npx payload is wrapped into the resident console (the shim
   *   layer's transient console is absorbed by it, §4.6.2).
   * - 0.1.11 #51 (§4.9.8-5): the START-WINDOW payload is selected by the
   *   build-time `START_PAYLOAD_VARIANT` at the SINGLE seam
   *   `startPayloadForVariant` — 'node-bin' = the resolver-hit node payload
   *   (pre-0.1.11, byte-identical), 'npx' = the fallback-chain npx payload
   *   REGARDLESS of the resolver outcome (the resolver still runs in parallel
   *   and `resolved` stays transparent for launchInfo: the self-only/mismatch
   *   tiers already cover this shape, §4.9.8-4-④). The DIRECT exec/argv and
   *   the custom-command boundary NEVER take the variant (direct 回退恒
   *   node-bin, PP-5-4).
   */
  private async buildLaunch(logFile: string): Promise<{
    exec: string
    argv: string[]
    display: string
    /** Resolver hit transparency for launchInfo (null on fallback/custom paths). */
    resolved: DshBinInfo | null
    /** Inner cmd /c payload WITH the `>> "<LOG>" 2>&1` tail; null = start-ineligible. */
    startPayload: string | null
  }> {
    const { command, channel } = this.options
    if (command.trim().length > 0) {
      // Custom command: run through cmd.exe for shell semantics (unchanged).
      return { exec: 'cmd.exe', argv: ['/d', '/s', '/c', command], display: command, resolved: null, startPayload: null }
    }
    let bin: DshBinInfo | null = null
    try {
      bin = await resolveDshBin(channel, { logFile })
    } catch (err) {
      // resolveDshBin is contractually null-on-failure; belt-and-suspenders only.
      bin = null
      appendDecisionLog(`[dshProcess] resolveDshBin threw (contract violation) -> fallback: ${(err as Error).message}`)
    }
    if (bin !== null) {
      const tools = resolveNodeAndNpm()
      if (tools !== null) {
        appendDecisionLog(`[dshProcess] direct-node launch via resolver (mode=${bin.mode}, v${bin.version}, dir=${bin.dir})`)
        const argv = [bin.binJs, 'web', '--host', LOOPBACK_HOST, '--port', String(this.options.port), '--no-open']
        // #51: the two ARMS are pure builders; the variant constant picks one
        // at the single seam below. direct exec/argv stay node-bin either way.
        const nodeBinStartPayload = buildNodeBinStartPayload(tools.nodeExe, bin.binJs, this.options.port, logFile)
        const npxStartPayload = buildNpxStartPayload(channel, this.options.port, logFile)
        const startPayload = startPayloadForVariant(START_PAYLOAD_VARIANT, nodeBinStartPayload, npxStartPayload)
        appendDecisionLog(`[dshProcess] start payload variant=${START_PAYLOAD_VARIANT} (§4.9.8: npx = registry-latest npx chain for the start window; direct/fallback stay node-bin; resolver hit still resolved for launchInfo)`)
        return { exec: tools.nodeExe, argv, display: `${tools.nodeExe} ${argv.join(' ')}`, resolved: bin, startPayload }
      }
      appendDecisionLog('[dshProcess] node resolution vanished after resolveDshBin -> 0.1.6 cmd+npx fallback')
    } else {
      appendDecisionLog('[dshProcess] resolveDshBin -> null (npx cache unresolvable); 0.1.6 cmd.exe+npx fallback path (safety net)')
    }
    const joined = buildNpxArgs(channel, this.options.port)
    return {
      exec: 'cmd.exe',
      argv: ['/d', '/s', '/c', joined],
      display: joined,
      resolved: null,
      startPayload: buildNpxStartPayload(channel, this.options.port, logFile),
    }
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    if (this.options.dshHome.trim().length > 0) env.DSH_HOME = this.options.dshHome.trim()
    return env
  }
}

/**
 * Single `__DSH_BOOT__` probe on a port (the one adoption/readiness gate).
 * 0.1.14: behavior is BIT-IDENTICAL to the pre-0.1.14 bare-GET form (legacy
 * contract readiness, PP-8-5 zero-regression) — implemented as the bare form
 * of probeDetail.
 */
export async function probe(port: number): Promise<boolean> {
  return (await probeDetail(port)).kind === 'ok'
}

/**
 * 0.1.14 §3.5: tri-state probe outcome — `ok` = the service answers and (for
 * index shapes) the boot signature is present; `unauthorized` = the service is
 * ALIVE but demands a session (the token-auth contract's 401 — a DIRECT
 * runtime fact that drives the 401 diversion, never a crash signal);
 * `down` = unreachable / other failure.
 *
 * Forms (§3.5 档位选择 = 版本判定结果):
 *  - no opts      : bare `GET /` expecting 200 + `__DSH_BOOT__` (legacy tier;
 *                   a 401 answer still classifies as 'unauthorized' so the
 *                   unknown-tier 401 diversion can observe it, 判定表 #3 行).
 *  - opts.token   : token-303 liveness — `GET /?token=<t>` with
 *                   `redirect: 'manual'`, expecting 303 WITHOUT following the
 *                   redirect (no cookie jar needed; 303 = alive + token valid).
 *  - opts.cookie  : C-path session probe — `GET /` + Cookie header expecting
 *                   200 + `__DSH_BOOT__` (the self-minted session).
 */
export type ProbeKind = 'ok' | 'unauthorized' | 'down'
export interface ProbeOutcome {
  kind: ProbeKind
}

export async function probeDetail(
  port: number,
  opts?: { token?: string | null; cookie?: string | null },
): Promise<ProbeOutcome> {
  try {
    const url = `http://${LOOPBACK_HOST}:${port}/${opts?.token != null && opts.token.length > 0 ? `?token=${opts.token}` : ''}`
    const headers: Record<string, string> = {}
    if (opts?.cookie != null && opts.cookie.length > 0) headers.cookie = opts.cookie
    const res = await fetch(url, {
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    if (opts?.token != null && opts.token.length > 0) {
      // token-303 form: 303 = alive + token accepted; 401 = alive + session
      // rejected (→ diversion); anything else = down. The redirect is NOT
      // followed (redirect:'manual'), PP-8-3①.
      if (res.status === 303) return { kind: 'ok' }
      if (res.status === 401) return { kind: 'unauthorized' }
      return { kind: 'down' }
    }
    if (!res.ok) return { kind: res.status === 401 ? 'unauthorized' : 'down' }
    const text = await res.text()
    return { kind: text.includes('__DSH_BOOT__') ? 'ok' : 'down' }
  } catch {
    return { kind: 'down' }
  }
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
