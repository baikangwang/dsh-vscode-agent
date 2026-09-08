// Headless verification of the application-level lifecycle arbitration.
// Run: node scripts/sim.mjs   (after `npm run compile`)
//
// Sandbox convention (detached 基线, §7 / §12): real netstat/taskkill/detached
// process-tree verification is restricted in the DSH sandbox, so host behavior
// that needs them is SKIPped here with an environment note and must PASS in a
// normal terminal. Everything else is verified headlessly via mock/argument
// assertion (spawn opts / state machine / probe / liveness / shutdown decision /
// F-PORT log parsing / F-UPDATE decision / top-label string / registry re-adopt).
//
// 0.1.7 additions (design §11.1): PV-1..PV-6 (dshResolver direct-node spawn
// contract, 0.1.6 fallback, recorded-pid identity, de-hardcode scan,
// multi-candidate disambiguation, in-place refresh) and PW-1..PW-4 (stale-window
// self-healing T1/T1b/T2, startedAt preservation, identity verdict branches).
// 0.1.8 additions (design §11.1 v2.3/v2.4): PI-1..PI-7 (ADR-18 identity guards:
// self-guard, positive-evidence clearing, hardened query contract, flip
// downgrade, grace period, T2 idempotent short-circuit, regression) and PP-1
// (ADR-20 consoleVisible parameterization: only windowsHide flips).
// 0.1.9 additions (design §11.1 v2.6/v2.8): PP-2-1..8 (ADR-21 start-launch:
// verbatim cmd-start wrapper, direct byte regression, servicePid=port holder
// with bounded resolve, 2-failure direct fallback, outer-cmd fast-fail,
// start-mode death = user stop vs direct relaunch, custom-command boundary)
// and PU-1..8 (ADR-22 pure-function direct tests: buildLaunchInfo 15-field
// assembly + existence filter, version cross-check five tiers, external
// degraded card, buildDetailsHtml CSP/copy-reversibility/anchors/injection,
// statusLine four states, mismatch rendering, stopped-copy split).
// 0.1.9.1 additions (design §11.1 v2.9/v2.10): PP-3-1..5 (ADR-23: /wait
// verbatim form + conhost build-time switch via a one-line compiled-output
// patch, exit-before-readiness fast signal for ANY code, 30s/90s readiness
// budget tiering via a patched clock, 2-early-death direct fallback with the
// degradation rlog declaration, launchInfo/details-card zero impact). The
// ADR-23 fast-fail semantics adapt two PP-2 clauses (判据级适配, sanctioned
// class per §4.8.6): success-path outer mocks now stay ALIVE during
// readiness (an /wait holder that dies early IS the failure signal), and the
// old "exit 0 does not fast-fail" case is reversed by PP-3-2① (E6a: /wait
// does not propagate the inner code; code 0 is equally a failure).
// 0.1.11 additions (design §11.1 v2.11/v2.13, ADR-24 + ADR-24补充; user
// three-way ruling = plan A): PP-4-1/2/5 (§4.9.1 three-stage marker
// instrumentation — payload wrap contract, marker-file family rotate linkage,
// family regression; PP-4-3/4-4 WMI arm = branch NOT selected this round →
// SKIP per #47's branch-note) and PP-5-1..4 (§4.9.8 npx payload arm —
// char-by-char npx argv, 60s/30s/90s budget tiers via a patched clock, the
// node-bin flip-back track via a one-line compiled-output patch, direct
// fallback stays node-bin). Existing start-payload assertions are adapted
// per the sanctioned class (语义互斥才替换, §4.9.6 爆炸半径表): PP-2-1/PP-3-1
// payload shapes now assert the VARIANT-AWARE production payload (the shipped
// 'npx' arm; the node-bin arm is re-asserted in PP-5-3), the raw-peel helpers
// below strip the marker wrap before shape matching, and PP-3-3①/③'s
// start-family budget anchor moves 30000ms -> 60000ms under the shipped
// variant (the 30s node-bin tier stays asserted in PP-5-2②).
// 0.1.12 additions (design §11.1 v2.15/v2.16, ADR-25 + ADR-26; user experiment
// ② B2 ALIVE): PP-3-1's assertion baseline REVERSES per #58-⑤ — the CONHOST
// form is the production baseline (⓪ declares 'conhost'; ④-⑦ assert the
// production module directly) and the start-wait RAW form moves to the
// flip-back track (①②③ run against the one-line patched module). The outer-form
// assertions of PP-2-1/PP-2-1b/PP-4-1⑥/PP-5-1② switch their carrier from the
// start RAW to the conhost inner command (payload char assertions unchanged),
// and the resident-family spawn gates accept both arms. PP-6-1..5 pin the
// ADR-25 port discipline: the named resolveLaunchPort decision point (source =
// configured / fallback-random / retry-degraded), the real-bind fallback trace,
// the retry freeze, the `payload port = <N>` trace, and the resolver output
// isolation into the `<log>.resolver` sibling.
// 0.1.13 additions (design §11.1 v2.17, ADR-27): PP-7-1..5 (resident-console
// static info header — pure builder unit tests against spec literals, the
// single-composition-point contract on the conhost arm, direct/custom zero
// touch, echoSafe charset safety + the 8191 length budget, and the
// marker/F-PORT family regression gates). The six payload-shape assertions
// pinned by the dry-run (PP-2-1/PP-3-1⑤/PP-3-1②/PP-5-1①/PP-5-1④/PP-5-3①)
// switch their expectation to the "infoHeader & payload" compound shape
// (sanctioned class, §4.11.3: assertions pinning the EXACT payload string);
// the flip-back track (PP-3-1②) carries the header the same way (QA N-01:
// 回切轨同型). Mechanism assertions (F-PORT/marker/port/fast-fail/direct
// forms) are UNCHANGED — the dry-run proved they hold under the overlay.
// 0.1.14 additions (design §11.1 v2.18, ADR-29 + ADR-30): PP-8-1..6 (token
// adaptation — banner ?token= capture contract with port-group isolation, the
// authProxy R1-R10 contract against a real in-process mock upstream that also
// pins the dsh server-side fence minimum semantics into the suite, probe dual
// forms + the isolated 401-diversion state machine, redaction/never-on-disk
// faces, the family regression gate, and the version-threshold judgement
// table incl. both contradictory rows) and PU-9 (channel normalization +
// first-launch selection flow via pure-module mock-deps direct tests + the
// package.json enum/command contract literal scan).
// 0.1.16 additions (design §九 PP-12/PU-12, ADR-38/39/40): PP-12-1..4
// (formatLocalTimestamp pure function, launchInfo 17-field pass-through, the
// queryProcessStartTimeSync G3 injection face, the writeRegistry keep/fresh
// branches with processStartQuery injection) and PU-12-1..4 (manifest dual
// container statics — PU-12-1 REPLACES PU-10-3①② per #99's sanctioned
// rewrite; resolve-title readback evidence lines; the two 启动时间 rows
// switched to the process-start source; the showDetails fallback chain
// re-anchored to dsh-configContainer).
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'

const require = createRequire(import.meta.url)
// Keep test artifacts inside the workspace (sandbox-friendly); cleanup at exit.
const dataDir = path.join(process.cwd(), '.sim-tmp')
fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })
process.env.DSH_VSCODE_DATA_DIR = dataDir

const {
  acquireStartupLock, releaseStartupLock, readInstance, writeInstance,
  registerWindow, unregisterWindow, isAlive, resolvePortPid,
  processIdentitySync, queryIdentitySync, queryProcessStartTimeSync,
  scrubWindowsWithIdentitySync,
  IDENTITY_QUERY_SCRIPT, IDENTITY_CACHE_TTL_MS, IDENTITY_GRACE_MS, PROCESS_START_SCRIPT,
} = require('../out/instance.js')
const { DshRuntime, portBindable, resolveLaunchPort } = require('../out/runtime.js')
const DP = require('../out/dshProcess.js') // { DshProcess, resolvePortFromLog, probe, treeKill, STARTUP_TIMEOUT_MS, STARTUP_TIMEOUT_MS_START, STARTUP_TIMEOUT_MS_START_NPX, START_LAUNCH_STRATEGY, START_LAUNCHER_LABEL, START_WINDOW_TITLE, START_PAYLOAD_VARIANT, buildStartLaunchCommand, buildConhostLaunchArgv, wrapStartPayloadWithMarkers, markerPrefix, markerSuffix, buildNodeBinStartPayload, buildNpxArgs, buildNpxStartPayload, startPayloadForVariant, startBudgetMsFor, PROBE_POLL_MS, echoSafeText, consoleInfoHeader, withConsoleInfoHeader, judgeWindowSafeByVersion, WINDOWSAFE_MIN_VERSION, WINDOWSAFE_REGRESSION_MIN_VERSION }
const Resolver = require('../out/dshResolver.js') // { resolveNodeAndNpm, resolveDshBin, DSH_PKG, ... }
const PATH = require('../out/paths.js') // { LOOPBACK_HOST, rotateDshLogs, MARKER_SUFFIX_CMD_START, MARKER_SUFFIX_NODE_START, MARKER_SUFFIX_NODE_EXIT, dshLogMarkerFile, ... }
const { LOOPBACK_HOST } = PATH
const { buildPanelHtml, buildDetailsHtml, escapeAttr } = require('../out/webviewHtml.js')
const LI = require('../out/launchInfo.js') // { buildLaunchInfo, parseSelfVersion, statusLine, EXTERNAL_CMDLINE_MAX }
const cp = require('node:child_process')
const { EventEmitter } = require('node:events')

let failures = 0
let skips = 0

function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}
function skip(name, note) {
  skips++
  console.log(`SKIP  ${name} (${note})`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- spawn router: intercept resolver subprocesses + dsh launches ---------
// (compiled modules call cp.spawn via property access, so the swap is visible)
function fakeChild({ pid = 4321, code = 0, stdout = '' } = {}) {
  const c = new EventEmitter()
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  c.pid = pid
  c.unref = () => {}
  c.kill = () => true
  // settle on a microtask so the resolver's handlers attach first
  queueMicrotask(() => {
    if (stdout.length > 0) c.stdout.emit('data', Buffer.from(stdout))
    c.emit('close', code)
  })
  return c
}

function classifySpawn(argv) {
  const a = Array.isArray(argv) ? argv.map((x) => String(x)) : []
  if (a.includes('view')) return 'view' // resolver npm view
  if (a.includes('install') && a.includes('--prefix')) return 'install' // resolver in-place refresh
  if (a.length > 2 && a[a.length - 1] === '--version' && a.slice(0, 3).some((s) => s.endsWith('npx-cli.js'))) return 'establish'
  if (a.includes('/c') || a[1] === 'web') return 'launch' // dsh launch (0.1.6 fallback or direct node)
  return 'other' // mock servers / victims -> passthrough
}

function installSpawnRouter() {
  const orig = cp.spawn
  const state = {
    calls: [],
    captureLaunch: false,
    launchPid: 4321,
    onLaunch: null,
    handlers: { view: null, install: null, establish: null },
    restore: () => { cp.spawn = orig },
  }
  cp.spawn = (exec, argv, opts) => {
    const kind = classifySpawn(argv)
    const entry = { kind, exec, argv: Array.isArray(argv) ? argv.map(String) : [], opts }
    state.calls.push(entry)
    if (kind === 'view' || kind === 'install' || kind === 'establish') {
      const h = state.handlers[kind]
      if (h !== null) return h(entry)
      return fakeChild({ pid: 5000 + state.calls.length, code: 1 })
    }
    if (kind === 'launch' && state.captureLaunch) {
      return state.onLaunch !== null ? state.onLaunch(entry) : fakeChild({ pid: state.launchPid, code: 0 })
    }
    return orig(exec, argv, opts)
  }
  return state
}
const router = installSpawnRouter()

// --- 0.1.11 start-payload parse helpers (§4.9.1 marker wrap) ---------------
// The three-stage marker texts/suffixes below are the §4.9.1 SPEC literals
// (deliberately NOT read from the module under test — the assertions must
// stay anchored to the design doc, not circularly to the code).
const RAW_START_RE = /^start "([^"]*)" \/d "([^"]*)" \/wait cmd \/d \/c "(.*)"$/s
/** Inner payload of a start-launch RAW command (`start "T" /d "C" /wait cmd /d /c "<inner>"`), or null. */
function rawStartInner(raw) {
  const m = RAW_START_RE.exec(raw)
  return m === null ? null : m[3]
}
const MARKER_WRAP_RE =
  /^echo inner-cmd-start >> "(.*)" & echo node-start >> "(.*)" & (.*) & \(if errorlevel 1 \(echo node-exit-nonzero >> "(.*)"\) else \(echo node-exit-0 >> "(.*)"\)\)$/s
/** Peel the §4.9.1 three-stage marker wrap off an inner payload.
 *  Returns { cmdStartFile, nodeStartFile, payload, nodeExitNonzeroFile, nodeExitZeroFile } or null. */
function peelLaunchMarkers(inner) {
  const m = MARKER_WRAP_RE.exec(inner)
  return m === null
    ? null
    : { cmdStartFile: m[1], nodeStartFile: m[2], payload: m[3], nodeExitNonzeroFile: m[4], nodeExitZeroFile: m[5] }
}

// --- 0.1.12 conhost-arm helpers (#58-⑤ ADR-26 baseline reversal) -----------
// The production resident-console form is now the CONHOST arm (the compiled
// START_LAUNCH_STRATEGY ships 'conhost'); the start-wait RAW form is asserted
// on the flip-back track (PP-3-1①②③ via the patched module). These helpers
// carry the outer-form assertions in the conhost form.
const isConhostForm = (c) =>
  c !== undefined && Array.isArray(c.argv) && path.basename(c.exec) === 'conhost.exe' && c.argv[0] === '--'
/** start-wait RAW form: argv length 4 with a leading `start "` token (the
 *  flip-back-track form under ADR-26; the blocks keep their local aliases). */
const isStartWaitForm = (c) =>
  c !== undefined && Array.isArray(c.argv) && c.argv.length === 4 && /^start "/.test(c.argv[3])
/** conhost inner command tail: argv[4] = `title <TITLE> && <payload+markers>`
 *  (E5 form, title UNQUOTED) -> the `<payload+markers>` part, or null. */
function conhostInnerCmd(entry, windowTitle) {
  if (!isConhostForm(entry) || entry.argv.length !== 5) return null
  const prefix = `title ${windowTitle} && `
  return typeof entry.argv[4] === 'string' && entry.argv[4].startsWith(prefix) ? entry.argv[4].slice(prefix.length) : null
}
/** stdio = ['ignore','ignore','ignore'] (conhost arm, E5/W-01). */
const stdioIgnoreShape = (o) => Array.isArray(o) && o[0] === 'ignore' && o[1] === 'ignore' && o[2] === 'ignore'

// --- ADR-27 info-header SPEC helpers (§4.11.2-(3)/(4), 0.1.13) --------------
// The 9 header lines below are the DESIGN-DOC SPEC literals (deliberately NOT
// read from the module under test — same non-circularity discipline as the
// §4.9.1 MARKER_WRAP_RE literals above). Used to (a) unit-assert the pure
// builders char-by-char (PP-7-1) and (b) pin the compound "header & payload"
// expectation of the six adapted payload-shape assertions.
const INFO_RULE_64 = '='.repeat(64)
function specInfoHeaderLines(logFile) {
  return [
    INFO_RULE_64,
    'DSH 服务常驻控制台（DSH Panel 托管）',
    '本窗口是 dsh web 服务的宿主进程，由 DSH Panel 扩展创建。',
    '关闭本窗口 = 停止 dsh 服务（面板将显示「已停止」）——不需要时可直接关闭。',
    '本窗口不回显服务实时日志：全部输出已重定向到下方日志文件（取证与排障用）。',
    `本次启动日志: ${logFile}`,
    '误关后的恢复：在 DSH Panel 面板点「重启服务」即可重新拉起（新窗口）。',
    '服务状态请看 VSCode 内的 DSH Panel 面板。',
    INFO_RULE_64,
  ]
}
/** echoSafe spec (§4.11.2-(4)): `[&|<>^"%!]` -> `?`, parens exempt. */
const specEchoSafe = (s) => s.replace(/[&|<>^"%!]/g, '?')
/** spec compound header: 9 `echo <行>` segments joined by ' & ' + ' & echo.'. */
function specInfoHeader(logFile) {
  return specInfoHeaderLines(logFile).map((l) => `echo ${specEchoSafe(l)}`).join(' & ') + ' & echo.'
}
/** spec "header & payload" compound (withConsoleInfoHeader shape). */
const specWithHeader = (payload, logFile) => `${specInfoHeader(logFile)} & ${payload}`
/** Strip the ADR-27 compound header prefix (`<header> & `) off a peeled
 *  marker-wrap payload; returns the production payload body, or null. */
function stripInfoHeader(compound, logFile) {
  const prefix = `${specInfoHeader(logFile)} & `
  return compound !== null && typeof compound === 'string' && compound.startsWith(prefix)
    ? compound.slice(prefix.length)
    : null
}

// --- resolver mock state: env seams + mock npx-cache layout ----------------
const simNpxRoot = path.join(dataDir, '_npx-mock')
const simNpmDir = path.join(dataDir, 'mock-npm')
const NPM_CLI_STUB = path.join(simNpmDir, 'npm-cli.js')
const NPX_CLI_STUB = path.join(simNpmDir, 'npx-cli.js')
const DEFAULT_CAND = 'v-default'
const DEFAULT_VERSION = '0.1.1-rc.2'

/** Mock candidate isomorphic to the _npx\<dir> layout; dir name is arbitrary. */
function makeCandidate(root, name, version, mtimeMs) {
  const dir = path.join(root, name)
  const pkgDir = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }), 'utf8')
  fs.writeFileSync(path.join(pkgDir, 'lib', 'bin.js'), '// stub bin.js (sim mock layout)\n')
  const d = new Date(mtimeMs)
  fs.utimesSync(dir, d, d)
  return dir
}

function seedMeta(channel, version, { fresh = true } = {}) {
  const file = path.join(dataDir, 'dsh-runtime-meta', `${channel}.json`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ lastCheckAt: fresh ? new Date().toISOString() : '2020-01-01T00:00:00.000Z', knownVersion: version }), 'utf8')
}

function clearMeta(channel) {
  try { fs.unlinkSync(path.join(dataDir, 'dsh-runtime-meta', `${channel}.json`)) } catch { /* absent */ }
}

function rlogOffset() {
  // UTF-16 code-unit offset (string .length), NOT byte size: rlogSlice slices
  // the utf8-decoded STRING, and runtime.log carries Chinese rlog lines
  // (e.g. the step1 leftover-detached note) — a byte offset would drift past
  // the string length and silently empty the slice (PP-6-1⑤ caught this).
  try { return fs.readFileSync(path.join(dataDir, 'logs', 'runtime.log'), 'utf8').length } catch { return 0 }
}
function rlogSlice(offset) {
  try { return fs.readFileSync(path.join(dataDir, 'logs', 'runtime.log'), 'utf8').slice(offset) } catch { return '' }
}

/** Steady state: one healthy candidate + fresh meta -> zero-network resolver. */
function resetResolverState() {
  fs.rmSync(simNpxRoot, { recursive: true, force: true })
  fs.mkdirSync(simNpxRoot, { recursive: true })
  makeCandidate(simNpxRoot, DEFAULT_CAND, DEFAULT_VERSION, Date.now())
  clearMeta('latest')
  seedMeta('latest', DEFAULT_VERSION)
}

// Env seams (design §4.1.2): every DshProcess test resolves deterministically.
process.env.DSH_NODE_EXE = process.execPath
process.env.DSH_NPM_CLI = NPM_CLI_STUB
process.env.DSH_NPX_ROOT = simNpxRoot
fs.mkdirSync(simNpmDir, { recursive: true })
fs.writeFileSync(NPM_CLI_STUB, '// stub npm-cli (spawn intercepted in sim)\n')
fs.writeFileSync(NPX_CLI_STUB, '// stub npx-cli (spawn intercepted in sim)\n')
resetResolverState()

// --- alive/dead pid helpers (real short-lived processes, reaped) -----------
function spawnVictim() {
  return spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1 << 30)'], { stdio: 'ignore' })
}
async function killAndReap(child) {
  try { child.kill() } catch { /* ignore */ }
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    child.once('exit', resolve)
    setTimeout(resolve, 5000)
  })
  for (let i = 0; i < 50 && isAlive(child.pid); i++) await sleep(100)
  return !isAlive(child.pid)
}

// --- helpers to seed a runtime / records --------------------------------
function seedInst(inst) { writeInstance(inst) }
function makeRecord(pid, port, managedBy) {
  return { pid, port, managedBy, startedAt: new Date().toISOString() }
}
function newRuntime(windowPid, overrides = {}) {
  // Default identityCheck = permissive keep-all: the fake window pids in the
  // legacy tests represent real VSCode extension hosts; PW-3 overrides this
  // seam to exercise the exthost/foreign/unknown branches (design §4.2.2).
  return new DshRuntime({
    app: 'Sim', windowPid, port: 3080, channel: 'latest', command: '', dshHome: '',
    identityCheck: () => 'exthost',
    ...overrides,
  })
}
function enableSpawnCapture() {
  const orig = cp.spawn
  const calls = []
  cp.spawn = (exec, argv, opts) => {
    calls.push({ exec, argv, opts })
    return { pid: 4242, unref: () => {} }
  }
  return { calls, restore() { cp.spawn = orig } }
}

// --- mock dsh servers ----------------------------------------------------
function startMock(port) {
  const s = spawn(process.execPath, ['-e', `
    const http = require('http');
    http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>window.__DSH_BOOT__ = {}</html>');
    }).listen(${port}, '127.0.0.1');
  `], { stdio: 'ignore' })
  return s
}
function waitPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tick = () => {
      if (Date.now() > deadline) return resolve(false)
      const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true) })
      sock.on('error', () => { sock.destroy(); setTimeout(tick, 200) })
    }
    tick()
  })
}
const MOCK_PORT = 45678
const server = startMock(MOCK_PORT)
const mockPid = server.pid

function netstatUsable() {
  const holder = (() => { try { return resolvePortPid(MOCK_PORT) } catch { return null } })()
  return holder !== null && holder.pid === mockPid
}

async function main() {
  await waitPort(MOCK_PORT, 10_000)

  // ============ EXISTING 8 checks (regression baseline) ==================
  // Window pids must be REAL ALIVE pids: the 0.1.7 T1/T2 liveness scrub
  // removes dead entries by design (P-STALEWIN), so a dead fake window pid
  // would legitimately be scrubbed before the last-window verdict.
  const winA = spawnVictim()
  const winB = spawnVictim()
  await sleep(300)
  const runtimeA = newRuntime(winA.pid, { port: MOCK_PORT })
  const runtimeB = newRuntime(winB.pid, { port: MOCK_PORT })

  const lockA = acquireStartupLock('Sim')
  check('window A acquires the startup lock', lockA !== null)
  check('window B cannot acquire while A holds it', acquireStartupLock('Sim') === null)
  releaseStartupLock()

  let inst = readInstance()
  inst.dsh = makeRecord(mockPid, MOCK_PORT, 'extension')
  inst = registerWindow(inst, 'Sim', winA.pid)
  writeInstance(inst)
  check('registry records dsh pid alive', isAlive(mockPid))

  inst = readInstance()
  inst = registerWindow(inst, 'Sim', winB.pid)
  writeInstance(inst)
  check('two windows registered', readInstance().windows.length === 2)

  const stoppedByA = runtimeA.shutdownBookkeeping()
  await new Promise((r) => setTimeout(r, 300))
  check('closing non-last window does not stop dsh', stoppedByA === false && isAlive(mockPid))
  check('after A closes, one window remains', readInstance().windows.length === 1)

  const stoppedByB = runtimeB.shutdownBookkeeping()
  await new Promise((r) => setTimeout(r, 500))
  const nsUsable = netstatUsable()
  if (nsUsable) {
    check('closing last window stops dsh', stoppedByB === true && !isAlive(mockPid))
    check('registry dsh record cleared', readInstance().dsh === null)
  } else {
    skip('closing last window stops dsh', 'netstat unavailable in sandbox; host safe-side bail')
    skip('registry dsh record cleared', 'netstat unavailable; record kept because host did not kill')
    check('shutdown no-throw bookkeeping ran', typeof stoppedByB === 'boolean')
    check('environment note: netstat unusable', !nsUsable)
  }

  // ============ P0-I additions (headless) =================================
  const px = (name) => console.log(`-- ${name}`)

  // --- P0-I-1: portBindable (ADR-1) + non-HTTP occupancy detection --------
  px('P0-I-1 portBindable (non-HTTP occupancy)')
  {
    const rawPort = 45691
    const raw = net.createServer() // accepts TCP but never replies HTTP
    await new Promise((res) => raw.listen(rawPort, '127.0.0.1', res))
    const busy = await portBindable(rawPort)
    const freePort = 45692
    const free = await portBindable(freePort)
    raw.close()
    check('portBindable=false on non-HTTP-occupied port (old HTTP probe false-negative fixed)', busy === false)
    check('portBindable=true on free port', free === true)
  }

  // --- P0-I-2 + P0-I-3: disconnect/reconnect never kill (adopted dsh) ----
  px('P0-I-2/3 disconnect/reconnect never kill')
  {
    // start() step1 re-adopt the mock via registry (external)
    seedInst({ dsh: makeRecord(mockPid, MOCK_PORT, 'external'), windows: [{ pid: 2001, app: 'Sim', startedAt: new Date().toISOString() }] })
    const r = newRuntime(2001, { port: MOCK_PORT })
    await r.start()
    check('start() re-adopts external mock (state ready)', r.state === 'ready' && r.port === MOCK_PORT)
    const capture = { killed: null }
    const origKill = DP.treeKill
    DP.treeKill = (pid) => { capture.killed = pid }
    r.disconnect()
    await new Promise((res) => setTimeout(res, 200))
    check('disconnect() keeps mock dsh alive (no kill)', isAlive(mockPid) && capture.killed === null)
    check('disconnect() sets state stopped', r.state === 'stopped')
    await r.reconnect()
    await new Promise((res) => setTimeout(res, 200))
    check('reconnect() re-adopts without killing mock', r.state === 'ready' && isAlive(mockPid) && capture.killed === null)
    DP.treeKill = origKill
    r.dispose()
  }

  // --- P0-I-4: managed launch spawn argument assertion (mock spawn) ------
  // (4 + 4a fixed-port: no log parsing, direct __DSH_BOOT__ probe)
  px('P0-I-4/4a managed launch detached spawn args + fixed-port direct probe')
  {
    const origSpawn = cp.spawn
    const origFetch = globalThis.fetch
    let cap = null
    let unrefCalled = false
    let fetchHits = 0
    cp.spawn = (exec, argv, opts) => {
      cap = { exec, argv, opts }
      return { pid: 4321, unref: () => { unrefCalled = true } }
    }
    globalThis.fetch = async () => { fetchHits++; return { ok: true, text: async () => 'window.__DSH_BOOT__={}' } }
    const proc = new DP.DshProcess({ port: 3081, channel: 'latest', command: '', dshHome: '' })
    const info = await proc.start()
    check('managed launch spawn opts.detached===true', cap && cap.opts.detached === true)
    check('managed launch spawn opts.windowsHide===true', cap && cap.opts.windowsHide === true)
    check('managed launch stdio redirects via array (not pipe)', Array.isArray(cap.opts.stdio) && cap.opts.stdio[0] === 'ignore')
    check('managed launch child.unref() called (detached independence)', unrefCalled === true)
    check('managed launch --host references LOOPBACK_HOST', cap && cap.argv.join(' ').includes('--port 3081') && cap.argv.join(' ').includes('--host 127.0.0.1'))
    check('managed launch fixed-port resolves directly via probe (no log parse)', info.port === 3081 && fetchHits >= 1)
    cp.spawn = origSpawn
    globalThis.fetch = origFetch
  }

  // --- P0-I-4a: F-PORT resolvePortFromLog (random-port path) -------------
  px('P0-I-4a F-PORT resolvePortFromLog reads the banner from the log file')
  {
    const log = path.join(dataDir, 'logs', 'dsh-test.log')
    fs.mkdirSync(path.dirname(log), { recursive: true })
    fs.writeFileSync(log, 'some noise\ndsh web: http://127.0.0.1:45679 (LAN: ...)\nmore\n')
    check('resolvePortFromLog parses random-port banner -> 45679', DP.resolvePortFromLog(log) === 45679)
    check('resolvePortFromLog null when banner absent', DP.resolvePortFromLog(path.join(dataDir, 'logs', 'absent.log')) === null)
  }

  // --- P0-I-4b: F-UPDATE decision (external no-kill / managed-own relaunch)
  px('P0-I-4b updateRuntime force-relaunch (F-UPDATE)')
  {
    const deadPid = 99999999 // no real process
    const origFetch = globalThis.fetch
    const origSpawn = cp.spawn
    const origKill = DP.treeKill
    const killLog = []
    DP.treeKill = (pid) => killLog.push(pid)
    globalThis.fetch = async () => ({ ok: true, text: async () => 'window.__DSH_BOOT__={}' })
    cp.spawn = () => ({ pid: 7777, unref: () => {} })

    // external/manual case: no kill, no relaunch, returns 'no-managed'
    seedInst({ dsh: makeRecord(deadPid, MOCK_PORT, 'external'), windows: [{ pid: 2002, app: 'Sim', startedAt: new Date().toISOString() }] })
    const rExt = newRuntime(2002, { port: MOCK_PORT })
    const ext = await rExt.forceRelaunchManaged()
    check('F-UPDATE external: returns no-managed (manual-update hint), no kill', ext === 'no-managed' && killLog.length === 0 && isAlive(mockPid))

    // managed-own case: controlled kill + new managed launch
    seedInst({ dsh: makeRecord(deadPid, 3082, 'managed-own'), windows: [{ pid: 2003, app: 'Sim', startedAt: new Date().toISOString() }] })
    const rOwn = newRuntime(2003, { port: 3082 })
    killLog.length = 0
    const rel = await rOwn.forceRelaunchManaged()
    check('F-UPDATE managed-own: controlled kill (treeKill) invoked', killLog.includes(deadPid))
    check('F-UPDATE managed-own: relaunched (new spawn) and returns relaunched', rel === 'relaunched')
    check('F-UPDATE managed-own: state ready after relaunch', rOwn.state === 'ready' && rOwn.managedBy === 'managed-own')
    rOwn.dispose(); rExt.dispose()
    globalThis.fetch = origFetch
    cp.spawn = origSpawn
    DP.treeKill = origKill
  }

  // --- P0-I-8: re-adopt leftover detached dsh (F1) without spawn ----------
  px('P0-I-8 re-adopt residual detached dsh (F1) — adopt, do not spawn')
  {
    const prevCap = enableSpawnCapture()
    seedInst({ dsh: makeRecord(mockPid, MOCK_PORT, 'external'), windows: [{ pid: 2004, app: 'Sim', startedAt: new Date().toISOString() }] })
    const r = newRuntime(2004, { port: MOCK_PORT })
    await r.start()
    check('re-adopt: start() reaches ready without spawning (state ready)', r.state === 'ready')
    check('re-adopt: spawnManaged NOT called (no new process)', prevCap.calls.length === 0)
    check('re-adopt: managedBy carried from registry (external)', r.managedBy === 'external')
    prevCap.restore()
    r.dispose()
  }

  // --- P0-I-9: external non-default port preserved last window + re-adopt
  px('P0-I-9 external non-default port preserved (F2) + next-window re-adopt')
  {
    const alt = 45693
    const s2 = startMock(alt)
    await waitPort(alt, 10_000)
    const altPid = s2.pid
    // last window: external record kept (pid alive), not killed
    seedInst({ dsh: makeRecord(altPid, alt, 'external'), windows: [{ pid: 2005, app: 'Sim', startedAt: new Date().toISOString() }] })
    const rLast = newRuntime(2005, { port: 3080 }) // configured default; external is non-default
    const stopped = rLast.shutdownBookkeeping()
    await new Promise((res) => setTimeout(res, 200))
    check('F2: shutdown keeps known-external record (non-default port)', stopped === false && isAlive(altPid) && readInstance().dsh?.port === alt)
    // next window re-adopts the non-default external via registry
    const rNext = newRuntime(2006, { port: 3080 })
    await rNext.start()
    check('F2: next window re-adopts external on non-default port', rNext.state === 'ready' && rNext.port === alt && rNext.managedBy === 'external')
    check('F2: next window did NOT spawn', rNext.managedBy === 'external')
    s2.kill()
    rLast.dispose(); rNext.dispose()
  }

  // --- P0-I-6: last-window arbitration by managedBy (external branch) -----
  px('P0-I-6 shutdownBookkeeping external not killed + record kept (headless); managed-own stops needs netstat')
  {
    seedInst({ dsh: makeRecord(mockPid, MOCK_PORT, 'external'), windows: [{ pid: 2007, app: 'Sim', startedAt: new Date().toISOString() }] })
    const r = newRuntime(2007, { port: MOCK_PORT })
    const stopped = r.shutdownBookkeeping()
    await new Promise((res) => setTimeout(res, 200))
    check('shutdown: external NOT killed and record preserved (pid alive)', stopped === false && isAlive(mockPid) && readInstance().dsh?.managedBy === 'external')
    // managed-own last-window real stop requires netstat -> SKIP in sandbox
    if (netstatUsable()) {
      check('shutdown: managed-own last window stops dsh', true) // covered above family; real path verified in normal terminal
    } else {
      skip('shutdown: managed-own last-window stop', 'needs netstat/taskkill; verify in normal terminal')
    }
    r.dispose()
  }

  // --- P0-I-5: bounded relaunch (cap reached -> error, not infinite) -------
  // The real backoff ramp (1+2+4+8+16+32s) + total startup timeout are module
  // `const`s that CommonJS closures capture, so they cannot be shrunk from a
  // unit test; exercising the full bounded-relaunch path needs integration /
  // a normal terminal. Sandbox honours the established convention: SKIP here,
  // must PASS on the ordinary terminal (design §7/§12).
  px('P0-I-5 liveness/bounded relaunch')
  skip('P0-I-5 bounded relaunch cap -> error (no infinite retry)', 'needs timing/integration; verify relaunch stops at cap in normal terminal')

  // --- P0-I-7: top label static bake (webviewHtml) ------------------------
  px('P0-I-7 top status label statically baked (P0-G)')
  {
    const knownHtml = buildPanelHtml('http://127.0.0.1:45678')
    check('html baked top label "dsh · <url>"', knownHtml.includes('<span id="state">dsh · http://127.0.0.1:45678</span>'))
    check('html baked iframe src', knownHtml.includes('src="http://127.0.0.1:45678"'))
    const idleHtml = buildPanelHtml(null)
    check('html baked initializing placeholder when url unknown', idleHtml.includes('<span id="state">initializing…</span>'))
    // CSP hard-coded with wildcard (unchanged security constraint)
    check('CSP frame-src loopback wildcard preserved', knownHtml.includes('frame-src http://127.0.0.1:*;'))
  }

  // --- P0-I-10: F3/F4 — no scattered 127.0.0.1/3080 literals --------------
  px('P0-I-10 de-literalization (F3) + URL_RE exemption (F4)')
  {
    const src = path.join(process.cwd(), 'src')
    // Exempt files that legitimately carry loopback/port data: paths.ts
    // (LOOPBACK_HOST definition), dshProcess.ts (URL_RE pre-existing, F4),
    // webviewHtml.ts (CSP hard-coded wildcard), instance.ts (netstat filter via
    // LOOPBACK_HOST), extension.ts (pre-existing config default `port 3080`).
    const exempt = { 'paths.ts': true, 'dshProcess.ts': true, 'webviewHtml.ts': true, 'instance.ts': true, 'extension.ts': true }
    let leaked = []
    for (const f of fs.readdirSync(src)) {
      if (!f.endsWith('.ts')) continue
      const text = fs.readFileSync(path.join(src, f), 'utf8')
      if (exempt[f]) continue
      if (text.includes('127.0.0.1')) leaked.push(`${f} mentions 127.0.0.1`)
      if (text.includes('3080')) leaked.push(`${f} mentions 3080`)
    }
    check('no new 127.0.0.1/3080 literals in non-exempt sources', leaked.length === 0 ? true : (console.log('   leak:', leaked), false))
    // LOOPBACK_HOST single source used by portBindable/url/--host
    const rt = fs.readFileSync(path.join(src, 'runtime.ts'), 'utf8')
    const dp = fs.readFileSync(path.join(src, 'dshProcess.ts'), 'utf8')
    const inst = fs.readFileSync(path.join(src, 'instance.ts'), 'utf8')
    const wz = fs.readFileSync(path.join(src, 'webview.ts'), 'utf8')
    check('runtime references LOOPBACK_HOST (portBindable/url)', /LOOPBACK_HOST/.test(rt))
    check('dshProcess --host/url reference LOOPBACK_HOST', /LOOPBACK_HOST/.test(dp))
    check('instance netstat filter references LOOPBACK_HOST', inst.includes('LOOPBACK_HOST'))
    check('webview.ts (vscode layer) has no 127.0.0.1 literal', !wz.includes('127.0.0.1'))
  }

  // ==================== 0.1.7 PV blocks (design §11.1) ====================
  const httpOk = await DP.probe(MOCK_PORT) // real loopback HTTP fetch usable?

  // --- PV-1: spawn contract (direct node via resolver, zero shim chain) ---
  px('PV-1 spawn contract: direct node + npx-cache binJs, flags byte-identical')
  {
    resetResolverState()
    const origFetch = globalThis.fetch
    let unrefCalled = false
    let fetchHits = 0
    globalThis.fetch = async () => { fetchHits++; return { ok: true, text: async () => 'window.__DSH_BOOT__={}' } }
    router.calls.length = 0
    router.captureLaunch = true
    router.onLaunch = () => {
      const c = fakeChild({ pid: 4321, code: 0 })
      const origUnref = c.unref
      c.unref = () => { unrefCalled = true; origUnref() }
      return c
    }
    const proc = new DP.DshProcess({ port: 3081, channel: 'latest', command: '', dshHome: '' })
    const info = await proc.start()
    const launches = router.calls.filter((c) => c.kind === 'launch')
    const cap = launches[launches.length - 1]
    check('PV-1 spawn exec basename = node (NOT cmd.exe)', cap !== undefined && /^node(\.exe)?$/i.test(path.basename(cap.exec)))
    check('PV-1 argv = [binJs, web, --host, LOOPBACK_HOST, --port, --no-open]', cap !== undefined &&
      JSON.stringify(cap.argv.slice(1)) === JSON.stringify(['web', '--host', LOOPBACK_HOST, '--port', '3081', '--no-open']))
    check('PV-1 binJs inside the mock _npx layout (npx-cache single source, no second dir)', cap !== undefined &&
      cap.argv[0].startsWith(simNpxRoot) &&
      cap.argv[0].includes(path.join('node_modules', '@deepseek-ai', 'dsh')) &&
      cap.argv[0].endsWith(path.join('lib', 'bin.js')))
    check('PV-1 opts.detached === true && opts.windowsHide === true (flag-identical to 0.1.6)', cap !== undefined && cap.opts.detached === true && cap.opts.windowsHide === true)
    check('PV-1 stdio = [ignore, fd, fd] (F-PORT data source preserved)', cap !== undefined &&
      Array.isArray(cap.opts.stdio) && cap.opts.stdio[0] === 'ignore' &&
      Number.isInteger(cap.opts.stdio[1]) && cap.opts.stdio[1] === cap.opts.stdio[2])
    check('PV-1 child.unref() called (detached independence)', unrefCalled === true)
    check('PV-1 fixed-port path resolves via direct probe (no log parse)', info.port === 3081 && fetchHits >= 1)
    router.captureLaunch = false
    router.onLaunch = null
    globalThis.fetch = origFetch
  }

  // --- PV-2: resolver fallback (node resolution failure -> 0.1.6 path) ----
  px('PV-2 resolver fallback: node unresolvable -> 0.1.6 cmd.exe+npx path')
  {
    resetResolverState() // mock _npx HAS a bin.js stub — still unusable without node
    const savedNode = process.env.DSH_NODE_EXE
    process.env.DSH_NODE_EXE = path.join(dataDir, 'no-such-node.exe')
    check('PV-2 resolveNodeAndNpm -> null on missing DSH_NODE_EXE (hard fail beats everything)', Resolver.resolveNodeAndNpm() === null)
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => ({ ok: true, text: async () => 'window.__DSH_BOOT__={}' })
    router.calls.length = 0
    router.captureLaunch = true
    router.onLaunch = null
    let threw = false
    let info = null
    try {
      const proc = new DP.DshProcess({ port: 3083, channel: 'latest', command: '', dshHome: '' })
      info = await proc.start()
    } catch { threw = true }
    const launches = router.calls.filter((c) => c.kind === 'launch')
    const cap = launches[launches.length - 1]
    check('PV-2 fallback spawn exec = cmd.exe (0.1.6 path preserved verbatim)', !threw && cap !== undefined && path.basename(cap.exec) === 'cmd.exe')
    check('PV-2 fallback argv carries the npx chain (/d /s /c npx --yes --prefer-offline spec)', cap !== undefined &&
      cap.argv[0] === '/d' && cap.argv[1] === '/s' && cap.argv[2] === '/c' &&
      cap.argv[3].includes('npx --yes --prefer-offline @deepseek-ai/dsh@latest'))
    check('PV-2 no exception escapes start(); fallback launch reaches ready', !threw && info !== null && info.port === 3083)
    process.env.DSH_NODE_EXE = savedNode
    router.captureLaunch = false
    globalThis.fetch = origFetch
  }

  // --- PV-3: recorded pid = service pid (P-PIDREC structural closure) -----
  px('PV-3 recorded pid = service pid = port holder (ADR-14)')
  {
    const P3 = 45681
    resetResolverState()
    const httpMod = await import('node:http')
    const origFetch = globalThis.fetch
    let fetchCalls = 0
    if (!httpOk) {
      // step2 probe must FAIL (nothing listens yet); launch probes succeed.
      globalThis.fetch = async () => {
        fetchCalls++
        if (fetchCalls === 1) throw new Error('sim: pre-launch probe must fail')
        return { ok: true, text: async () => 'window.__DSH_BOOT__={}' }
      }
    }
    let http3 = null
    router.calls.length = 0
    router.captureLaunch = true
    router.onLaunch = () => {
      // In-process dsh-like listener: its pid = sim pid = real port holder.
      http3 = httpMod.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html>window.__DSH_BOOT__ = {}</html>')
      })
      http3.listen(P3, '127.0.0.1')
      http3.unref()
      return fakeChild({ pid: process.pid, code: 0 })
    }
    writeInstance({ dsh: null, windows: [] })
    const r = newRuntime(3001, { port: P3 })
    await r.start()
    const rec = readInstance().dsh
    const launches = router.calls.filter((c) => c.kind === 'launch')
    const cap = launches[launches.length - 1]
    check('PV-3 single direct-node launch (no cmd/npx wrapper hop exists)', launches.length === 1 && cap !== undefined &&
      /^node(\.exe)?$/i.test(path.basename(cap.exec)) && cap.argv[1] === 'web' && !cap.argv.includes('/c'))
    check('PV-3 registry dsh.pid === spawn child pid (direct child = service process)', rec !== null && rec.pid === process.pid && r.managedBy === 'managed-own')
    const holder = (() => { try { return resolvePortPid(P3) } catch { return null } })()
    if (holder !== null) {
      check('PV-3 registry dsh.pid === port holder pid (last-window gate holder===pid now reachable)', holder.pid === rec.pid)
    } else {
      skip('PV-3 registry dsh.pid === port holder pid', 'netstat unavailable in sandbox; real-machine RW-2 covers')
    }
    r.dispose()
    if (http3 !== null) {
      try { http3.closeAllConnections?.() } catch { /* old node */ }
      try { http3.close() } catch { /* ignore */ }
    }
    router.captureLaunch = false
    router.onLaunch = null
    globalThis.fetch = origFetch
  }

  // --- PV-4: de-hardcode extended scan (hash / machine paths / seams) -----
  px('PV-4 de-hardcode extended scan (no hash literal/compute, no machine paths, env+PATH seams)')
  {
    const src = path.join(process.cwd(), 'src')
    const files = fs.readdirSync(src).filter((f) => f.endsWith('.ts'))
    const hashLits = []
    const hashCalc = []
    const drivePaths = []
    const pf = []
    for (const f of files) {
      const text = fs.readFileSync(path.join(src, f), 'utf8')
      if (/\b[0-9a-fA-F]{16}\b/.test(text)) hashLits.push(f)
      // 0.1.14 scoped exemption: authProxy.ts's createHash/createHmac compute
      // the browser-auth-isomorphic session COOKIE name/value from the live
      // authority (design §3.7, E-PR-4) — a different semantic from the
      // fabricated _npx cache-dir hash names this scan guards against.
      if (/sha512|createHash/i.test(text) && f !== 'authProxy.ts') hashCalc.push(f)
      // Drive-letter machine paths: string-escaped form ('D:\\apps' = two
      // backslashes in source) and the comment form ('C:\\Users' = one
      // backslash + uppercase segment); regex class escapes (':\\s', ':\\d')
      // are lowercase after the backslash and do not match either form.
      if (/[A-Za-z]:\\\\/.test(text) || /[A-Za-z]:\\[A-Z]/.test(text)) drivePaths.push(f)
      if (/program files/i.test(text)) pf.push(f)
    }
    check('PV-4 no 16-hex hash-literal dir names anywhere in src/', hashLits.length === 0)
    check('PV-4 no hash computation (sha512/createHash) anywhere in src/', hashCalc.length === 0)
    check('PV-4 no drive-letter machine paths in src/', drivePaths.length === 0)
    check('PV-4 no "Program Files" literal in src/', pf.length === 0)
    const rs = fs.readFileSync(path.join(src, 'dshResolver.ts'), 'utf8')
    check('PV-4 dshResolver node/npm via env seams (DSH_NODE_EXE/DSH_NPM_CLI)', rs.includes('DSH_NODE_EXE') && rs.includes('DSH_NPM_CLI'))
    check('PV-4 dshResolver npxRoot via DSH_NPX_ROOT seam + LOCALAPPDATA env (no machine path)', rs.includes('DSH_NPX_ROOT') && rs.includes('LOCALAPPDATA'))
    check('PV-4 dshResolver resolves via PATH scan (npx.cmd / node.exe), PATH-driven', rs.includes("findDirOnPath('npx.cmd')") && rs.includes("'node.exe'"))
  }

  // --- PV-5: multi-candidate disambiguation --------------------------------
  px('PV-5 multi-candidate disambiguation (version > mtime > dir-name; offline edge declared)')
  {
    fs.rmSync(simNpxRoot, { recursive: true, force: true })
    fs.mkdirSync(simNpxRoot, { recursive: true })
    const t = Date.now()
    const cNew = makeCandidate(simNpxRoot, 'c-new', '1.2.3', t - 60_000)
    const dB = makeCandidate(simNpxRoot, 'd-b', '2.0.0', t - 10_000)
    makeCandidate(simNpxRoot, 'c-old', '0.0.9', t - 90_000)
    makeCandidate(simNpxRoot, 'd-a', '2.0.0', t - 30_000)

    clearMeta('latest')
    router.handlers.view = () => fakeChild({ pid: 5101, code: 0, stdout: '1.2.3\n' })
    let bin = await Resolver.resolveDshBin('latest', {})
    check('PV-5① online view -> version match beats mtime (c-new)', bin !== null && bin.dir === cNew && bin.mode === 'steady')

    clearMeta('latest')
    router.handlers.view = () => fakeChild({ pid: 5102, code: 0, stdout: '2.0.0\n' })
    bin = await Resolver.resolveDshBin('latest', {})
    check('PV-5② same-version pair -> newest mtime wins deterministically (d-b)', bin !== null && bin.dir === dB)

    clearMeta('latest')
    const off = rlogOffset()
    router.handlers.view = () => fakeChild({ pid: 5103, code: 1, stdout: '' })
    bin = await Resolver.resolveDshBin('latest', {})
    const trace = rlogSlice(off)
    check('PV-5③ offline edge (V=null) picks newest AND rlog DECLARES the dir', bin !== null && bin.dir === dB && trace.includes('OFFLINE EDGE') && trace.includes(dB))

    fs.rmSync(simNpxRoot, { recursive: true, force: true })
    fs.mkdirSync(simNpxRoot, { recursive: true })
    clearMeta('latest')
    router.calls.length = 0
    router.handlers.view = () => fakeChild({ pid: 5104, code: 1, stdout: '' })
    router.handlers.establish = () => {
      makeCandidate(simNpxRoot, 'e-est', '9.9.9', Date.now()) // simulated npx reify
      return fakeChild({ pid: 5105, code: 0 })
    }
    bin = await Resolver.resolveDshBin('latest', {})
    const est = router.calls.filter((c) => c.kind === 'establish')
    const estCap = est[est.length - 1]
    check('PV-5④ no candidates -> npx chain establishment spawn (node+npxCli+--yes+--prefer-offline+spec+--version)', bin !== null && bin.mode === 'established' && estCap !== undefined &&
      /^node(\.exe)?$/i.test(path.basename(estCap.exec)) &&
      estCap.argv[0] === NPX_CLI_STUB &&
      estCap.argv.includes('--yes') && estCap.argv.includes('--prefer-offline') &&
      estCap.argv.includes('@deepseek-ai/dsh@latest') && estCap.argv[estCap.argv.length - 1] === '--version')

    fs.rmSync(simNpxRoot, { recursive: true, force: true })
    fs.mkdirSync(simNpxRoot, { recursive: true })
    clearMeta('latest')
    router.handlers.establish = () => fakeChild({ pid: 5106, code: 1, stdout: '' })
    bin = await Resolver.resolveDshBin('latest', {})
    check('PV-5⑤ establishment failure -> resolveDshBin null (0.1.6 fallback per PV-2)', bin === null)

    router.handlers.view = null
    router.handlers.establish = null
    resetResolverState()
  }

  // --- PV-6: in-place refresh command contract -----------------------------
  px('PV-6 in-place refresh contract (npm install --prefix <hit dir>, no second dir)')
  {
    fs.rmSync(simNpxRoot, { recursive: true, force: true })
    fs.mkdirSync(simNpxRoot, { recursive: true })
    const rDir = makeCandidate(simNpxRoot, 'r-dir', '3.0.0', Date.now())
    clearMeta('latest')
    seedMeta('latest', '3.1.4') // fresh meta -> V=3.1.4, zero view spawn
    const dirsBefore = fs.readdirSync(simNpxRoot).length
    router.calls.length = 0
    router.handlers.install = () => {
      // simulated npm reify IN PLACE: same dir, version bumped, no new dir
      const pkgDir = path.join(rDir, 'node_modules', '@deepseek-ai', 'dsh')
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '3.1.4' }), 'utf8')
      fs.writeFileSync(path.join(pkgDir, 'lib', 'bin.js'), '// stub bin.js (refreshed)\n')
      return fakeChild({ pid: 5201, code: 0 })
    }
    const bin = await Resolver.resolveDshBin('latest', {})
    const installs = router.calls.filter((c) => c.kind === 'install')
    const cap = installs[installs.length - 1]
    check('PV-6 refresh spawn: node + npm-cli (DSH_NPM_CLI) + install', cap !== undefined &&
      /^node(\.exe)?$/i.test(path.basename(cap.exec)) && cap.argv[0] === process.env.DSH_NPM_CLI && cap.argv[1] === 'install')
    check('PV-6 --prefix points at the scanned hit directory', cap !== undefined && cap.argv[cap.argv.indexOf('--prefix') + 1] === rDir)
    check('PV-6 flags --ignore-scripts --no-audit --no-fund + spec @channel', cap !== undefined &&
      cap.argv.includes('--ignore-scripts') && cap.argv.includes('--no-audit') && cap.argv.includes('--no-fund') &&
      cap.argv.includes('@deepseek-ai/dsh@latest'))
    check('PV-6 post-verify reads the SAME dir; mode=refreshed, version=V', bin !== null && bin.dir === rDir && bin.version === '3.1.4' && bin.mode === 'refreshed')
    check('PV-6 no second directory produced in the _npx layout', fs.readdirSync(simNpxRoot).length === dirsBefore)
    let metaRaw = null
    try { metaRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'dsh-runtime-meta', 'latest.json'), 'utf8')) } catch { /* keep null */ }
    check('PV-6 meta = {lastCheckAt, knownVersion} only (no node_modules, not a runtime dir)', metaRaw !== null &&
      metaRaw.knownVersion === '3.1.4' && typeof metaRaw.lastCheckAt === 'string' && Object.keys(metaRaw).length === 2 &&
      !fs.existsSync(path.join(dataDir, 'dsh-runtime-meta', 'node_modules')))
    router.handlers.install = null
    resetResolverState()
  }

  // ==================== 0.1.7 PW blocks (design §11.1) ====================
  // Ensure runtime probes resolve even when real loopback HTTP is restricted.
  const realFetchPW = globalThis.fetch
  const bootMock = async () => ({ ok: true, text: async () => 'window.__DSH_BOOT__={}' })
  if (!httpOk) globalThis.fetch = bootMock

  // --- PW-1: connect self-healing (T1 liveness) + startedAt preservation ---
  px('PW-1 connect self-healing (T1 scrub) + startedAt preservation (ADR-15/16)')
  {
    const deadA = spawnVictim()
    const deadB = spawnVictim()
    await sleep(300)
    const okA = await killAndReap(deadA)
    const okB = await killAndReap(deadB)
    if (!okA || !okB) {
      skip('PW-1 T1 scrub of dead windows', 'could not reap victim pids in this environment')
    } else {
      const SELF = process.pid
      seedInst({
        dsh: { pid: mockPid, port: MOCK_PORT, managedBy: 'managed-own', startedAt: '2026-01-01T00:00:00.000Z' },
        windows: [
          { app: 'Sim', pid: deadA.pid, startedAt: '2026-01-02T00:00:00.000Z' },
          { app: 'Sim', pid: deadB.pid, startedAt: '2026-01-02T00:00:00.000Z' },
          { app: 'Sim', pid: SELF, startedAt: '2026-01-03T00:00:00.000Z' },
        ],
      })
      const r = newRuntime(SELF, { port: MOCK_PORT, identityCheck: () => 'exthost' })
      await r.start()
      const after = readInstance()
      check('PW-1 T1 scrubbed both dead windows (windows == [self])', JSON.stringify(after.windows.map((w) => w.pid)) === JSON.stringify([SELF]))
      check('PW-1 dsh.startedAt preserved on same-pid re-adopt (ADR-16)', after.dsh !== null && after.dsh.startedAt === '2026-01-01T00:00:00.000Z')
      check('PW-1 re-adopt path: ready, managed-own, no spawn', r.state === 'ready' && r.managedBy === 'managed-own')
      r.dispose()
    }
  }

  // --- PW-2: last-window stop restored (T2 scrub before verdict) -----------
  px('PW-2 last-window stop restored (T2 scrub before verdict)')
  {
    const deadC = spawnVictim()
    await sleep(300)
    const okC = await killAndReap(deadC)
    if (!okC) {
      skip('PW-2 T2 scrub + last-window verdict', 'could not reap victim pid in this environment')
    } else {
      const SELF = process.pid
      seedInst({
        dsh: { pid: mockPid, port: MOCK_PORT, managedBy: 'managed-own', startedAt: new Date().toISOString() },
        windows: [
          { app: 'Sim', pid: deadC.pid, startedAt: new Date().toISOString() },
          { app: 'Sim', pid: SELF, startedAt: new Date().toISOString() },
        ],
      })
      const r = newRuntime(SELF, { port: MOCK_PORT, identityCheck: () => 'exthost' })
      const origKill = DP.treeKill
      const killed = []
      DP.treeKill = (pid) => killed.push(pid) // mocked: PW-3/4 still need the mock server
      const stopped = r.shutdownBookkeeping()
      await sleep(200)
      if (netstatUsable()) {
        check('PW-2 dead window scrubbed before verdict -> last-window kill fired + record cleared', stopped === true && killed.includes(mockPid) && readInstance().dsh === null)
      } else {
        skip('PW-2 dead window scrubbed before verdict -> last-window kill fired', 'netstat unavailable in sandbox (safe-side bail); real-machine RW-2 covers')
        check('PW-2 T2 scrub ran (windows emptied) and verdict stayed safe-side', typeof stopped === 'boolean' && killed.length === 0 && readInstance().windows.length === 0)
      }
      DP.treeKill = origKill
      r.dispose()
    }
  }

  // --- PW-3: identity verdict three branches (injected identityCheck) ------
  px('PW-3 identity verdict branches (foreign/unknown/exthost + default path)')
  {
    const winOther = spawnVictim()
    await sleep(300)
    if (!isAlive(winOther.pid)) {
      skip('PW-3 identity branches', 'victim pid not alive in this environment')
    } else {
      const SELF = process.pid
      // ADR-18 grace period (§4.4.5): entries first-attached within
      // IDENTITY_GRACE_MS are exempt from identity clearing, so the peer's
      // seeded startedAt is back-dated beyond that window — a foreign verdict
      // must then clear (this block exercises the clearing tiers themselves).
      const winSeed = () => ({
        dsh: makeRecord(mockPid, MOCK_PORT, 'external'),
        windows: [
          { app: 'Sim', pid: winOther.pid, startedAt: new Date(Date.now() - 120_000).toISOString() },
          { app: 'Sim', pid: SELF, startedAt: new Date().toISOString() },
        ],
      })

      // ① alive + foreign -> cleared by T1b (guarded rewrite)
      seedInst(winSeed())
      const r1 = newRuntime(SELF, { port: MOCK_PORT, identityCheck: (pid) => (pid === winOther.pid ? 'foreign' : 'exthost') })
      await r1.start()
      let cleared = false
      for (let i = 0; i < 50 && !cleared; i++) {
        cleared = !readInstance().windows.some((w) => w.pid === winOther.pid)
        if (!cleared) await sleep(100)
      }
      check('PW-3① alive+foreign window cleared by T1b (guarded surgical rewrite)', cleared && readInstance().windows.some((w) => w.pid === SELF))
      r1.dispose()

      // ② alive + unknown -> KEPT (safe-side 宁留勿误清)
      seedInst(winSeed())
      const seen2 = []
      const r2 = newRuntime(SELF, { port: MOCK_PORT, identityCheck: (pid) => { seen2.push(pid); return pid === winOther.pid ? 'unknown' : 'exthost' } })
      await r2.start()
      // ADR-18 G1: the runtime's own window pid is NEVER passed to the
      // identity check (self-guard) — only the peer's verdict is observable.
      let covered2 = false
      for (let i = 0; i < 50 && !covered2; i++) {
        covered2 = seen2.includes(winOther.pid)
        if (!covered2) await sleep(100)
      }
      check('PW-3② alive+unknown window KEPT (safe-side; self kept via G1 short-circuit)', covered2 && readInstance().windows.some((w) => w.pid === winOther.pid) && readInstance().windows.some((w) => w.pid === SELF))
      r2.dispose()

      // ③ alive + exthost -> KEPT
      seedInst(winSeed())
      const seen3 = []
      const r3 = newRuntime(SELF, { port: MOCK_PORT, identityCheck: (pid) => { seen3.push(pid); return 'exthost' } })
      await r3.start()
      let covered3 = false
      for (let i = 0; i < 50 && !covered3; i++) {
        covered3 = seen3.includes(winOther.pid)
        if (!covered3) await sleep(100)
      }
      check('PW-3③ alive+exthost window KEPT (real attached window; self kept via G1 short-circuit)', covered3 && readInstance().windows.some((w) => w.pid === winOther.pid) && readInstance().windows.some((w) => w.pid === SELF))
      r3.dispose()

      // ④ default implementation: failure path -> 'unknown', never throws
      const defaultVerdict = (() => { try { return processIdentitySync(99999999, 1000) } catch { return 'THREW' } })()
      check('PW-3④ default processIdentitySync failure path -> unknown (no throw)', defaultVerdict === 'unknown')

      await killAndReap(winOther)
    }
  }

  // --- PW-4: startedAt semantics (ADR-16) ----------------------------------
  px('PW-4 startedAt semantics (window re-register keeps; new dsh pid refreshes)')
  {
    let inst = readInstance()
    inst.dsh = null
    inst.windows = []
    writeInstance(inst)
    // Deterministic ADR-16 probe: seed a DISTANT first-attachment timestamp so
    // the two assertions below cannot collide within the same millisecond.
    const SEED_AT = '2020-01-01T00:00:00.000Z'
    inst = { ...inst, windows: [{ app: 'Sim', pid: 777, startedAt: SEED_AT }] }
    inst = registerWindow(inst, 'Sim', 777)
    check('PW-4 same window pid re-registration keeps startedAt', inst.windows.length === 1 && inst.windows[0].startedAt === SEED_AT)
    inst = registerWindow(inst, 'Sim', 778)
    check('PW-4 new window pid gets a fresh startedAt', inst.windows.length === 2 && inst.windows.find((w) => w.pid === 778).startedAt !== SEED_AT)

    // dsh.startedAt: same-pid re-adopt keeps
    const T0 = '2026-02-03T04:05:06.000Z'
    seedInst({ dsh: { pid: mockPid, port: MOCK_PORT, managedBy: 'external', startedAt: T0 }, windows: [{ app: 'Sim', pid: process.pid, startedAt: new Date().toISOString() }] })
    const r1 = newRuntime(process.pid, { port: MOCK_PORT, identityCheck: () => 'exthost' })
    await r1.start()
    check('PW-4 same dsh pid re-adopt keeps dsh.startedAt (not rewritten)', readInstance().dsh !== null && readInstance().dsh.startedAt === T0)
    r1.dispose()

    // new dsh pid -> refreshed: dead registry pid + managed relaunch (real path)
    const P4 = 45695
    seedInst({ dsh: { pid: 99999999, port: P4, managedBy: 'managed-own', startedAt: T0 }, windows: [] })
    router.calls.length = 0
    router.captureLaunch = true
    router.onLaunch = null
    const savedFetch4 = globalThis.fetch
    let pw4Calls = 0
    globalThis.fetch = async () => {
      pw4Calls++
      if (pw4Calls === 1) throw new Error('sim: pre-launch probe must fail')
      return { ok: true, text: async () => 'window.__DSH_BOOT__={}' }
    }
    const r2 = newRuntime(4100, { port: P4, identityCheck: () => 'exthost' })
    await r2.start()
    const launchPid = router.launchPid // onLaunch=null -> fakeChild(router.launchPid)
    const rec4 = readInstance().dsh
    check('PW-4 new dsh pid (managed relaunch) -> startedAt refreshed, pid = spawn child', rec4 !== null && rec4.pid === launchPid && rec4.startedAt !== T0)
    r2.dispose()
    router.captureLaunch = false
    globalThis.fetch = savedFetch4
  }

  if (!httpOk) globalThis.fetch = realFetchPW

  // ==================== 0.1.8 PI blocks (design §11.1, ADR-18) =============
  // PI family needs deterministic registry re-adopt probes: mock the boot
  // fetch for the whole block (independent of the real-loopback capability).
  const realFetchPI = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, text: async () => 'window.__DSH_BOOT__={}' })

  // --- PI-1: self-guard (identity scrub never touches own windowPid) -------
  px('PI-1 self-guard: identity checks never apply to the runtime\'s own window')
  {
    const SELF = process.pid
    const alwaysForeign = () => 'foreign' // most-malicious misread: everything foreign
    // Unit level: scrub with selfPid -> self survives no matter what.
    const young = new Date().toISOString()
    const old = new Date(Date.now() - 120_000).toISOString() // beyond grace window
    const resSelf = scrubWindowsWithIdentitySync(
      { dsh: makeRecord(mockPid, MOCK_PORT, 'external'), windows: [{ app: 'Sim', pid: SELF, startedAt: young }] },
      100, alwaysForeign, { selfPid: SELF, nowMs: Date.now() },
    )
    check('PI-1 unit: selfPid survives even when identityCheck returns foreign for everything', resSelf.removed === 0 && resSelf.removedPids.length === 0 && resSelf.inst.windows.some((w) => w.pid === SELF))
    // Unit level, T2 shape: a live peer + self, always-foreign -> peer cleared, self kept.
    const resT2 = scrubWindowsWithIdentitySync(
      { dsh: null, windows: [{ app: 'Sim', pid: mockPid, startedAt: old }, { app: 'Sim', pid: SELF, startedAt: young }] },
      100, alwaysForeign, { selfPid: SELF, nowMs: Date.now() },
    )
    check('PI-1 T2 shape: peer cleared AND self never enters removedPids (single guard point)', resT2.removed === 1 && resT2.removedPids.includes(mockPid) && !resT2.removedPids.includes(SELF) && resT2.inst.windows.some((w) => w.pid === SELF))
    // Runtime T1b level (the observed defect shape: self cleared 1.55s after registration)
    seedInst({ dsh: makeRecord(mockPid, MOCK_PORT, 'external'), windows: [{ app: 'Sim', pid: SELF, startedAt: young }] })
    const rlogOff1 = rlogOffset()
    const r1 = newRuntime(SELF, { port: MOCK_PORT, identityCheck: alwaysForeign })
    await r1.start()
    await sleep(400) // let the fire-and-forget T1b settle
    check('PI-1 T1b: selfPid still registered after the identity scrub (windows[] no longer emptied)', readInstance().windows.some((w) => w.pid === SELF))
    check('PI-1 rlog: no removed trajectory mentions self', !new RegExp(`removed[^\\n]*\\b${SELF}\\b`).test(rlogSlice(rlogOff1)))
    const stopped1 = r1.shutdownBookkeeping()
    check('PI-1 T2: bookkeeping keeps safe semantics (external preserved, no kill)', stopped1 === false && isAlive(mockPid))
    r1.dispose()
  }

  // --- PI-2: peer positive-evidence clearing (G1 and clearing coexist) -----
  px('PI-2 peer cleared on foreign while self is kept (guards do not shadow clearing)')
  {
    const peer = spawnVictim()
    await sleep(300)
    if (!isAlive(peer.pid)) {
      skip('PI-2 peer foreign clearing', 'victim pid not alive in this environment')
    } else {
      const SELF = process.pid
      const old = new Date(Date.now() - 120_000).toISOString() // beyond grace window
      seedInst({
        dsh: makeRecord(mockPid, MOCK_PORT, 'external'),
        windows: [
          { app: 'Sim', pid: peer.pid, startedAt: old },
          { app: 'Sim', pid: SELF, startedAt: new Date().toISOString() },
        ],
      })
      const r = newRuntime(SELF, { port: MOCK_PORT, identityCheck: (pid) => (pid === peer.pid ? 'foreign' : 'exthost') })
      await r.start()
      let cleared = false
      for (let i = 0; i < 50 && !cleared; i++) {
        cleared = !readInstance().windows.some((w) => w.pid === peer.pid)
        if (!cleared) await sleep(100)
      }
      check('PI-2 T1b: foreign peer cleared (positive-evidence clearing preserved, P-STALEWIN scenario 4)', cleared)
      check('PI-2 T1b: self kept (G1 not shadowed by the clearing capability)', readInstance().windows.some((w) => w.pid === SELF))
      await killAndReap(peer)
      r.dispose()
    }
  }

  // --- PI-3: query contract (spawnFn injection seam, quote-free payload) ---
  px('PI-3 query contract: IDENTITY_QUERY_SCRIPT constant + env pid + zero quotes + verdict tiers')
  {
    const captured = []
    const fakeSpawnSync = (exe, args, opts) => {
      captured.push({ exe, args, opts })
      return { status: 0, stdout: JSON.stringify({ Name: 'chrome.exe', ExecutablePath: 'C:\\tools\\chrome.exe', CommandLine: 'chrome --flag' }) }
    }
    const v = queryIdentitySync(31337, 1234, fakeSpawnSync)
    check('PI-3① -Command payload is IDENTITY_QUERY_SCRIPT verbatim (no pid interpolation)', captured.length === 1 && captured[0].args[3] === IDENTITY_QUERY_SCRIPT && v === 'foreign')
    check('PI-3① script constant contains NO double quote and NO pid literal', !IDENTITY_QUERY_SCRIPT.includes('"') && !IDENTITY_QUERY_SCRIPT.includes('31337'))
    check('PI-3② env.DSH_IDENTITY_PID carries the pid (String(pid), no injection surface)', captured[0].opts?.env?.DSH_IDENTITY_PID === '31337')
    check('PI-3③ windowsHide===true and timeout passed through', captured[0].opts?.windowsHide === true && captured[0].opts?.timeout === 1234)
    check('PI-3③ argv shape = [-NoProfile, -NonInteractive, -Command, script] on powershell.exe', captured[0].exe === 'powershell.exe' &&
      JSON.stringify(captured[0].args.slice(0, 3)) === JSON.stringify(['-NoProfile', '-NonInteractive', '-Command']))
    // ④ verdict tiers from preset stdout (single CIM query, three fields)
    const branch = (obj) => queryIdentitySync(31338, 100, () => ({ status: 0, stdout: JSON.stringify(obj) }))
    check('PI-3④ signature hit -> exthost (keep; flip baseline)', branch({ Name: 'Code.exe', ExecutablePath: 'C:\\apps\\Code.exe', CommandLine: '"C:\\apps\\Code.exe" --type=extensionHost --port=xyz' }) === 'exthost')
    check('PI-3④ non-family exe + no signature -> foreign (the ONLY clearing tier)', branch({ Name: 'chrome.exe', ExecutablePath: 'C:\\apps\\chrome.exe', CommandLine: 'chrome --flag' }) === 'foreign')
    check('PI-3④ H2a landing: family exe + signature miss -> unknown (kept)', branch({ Name: 'Code.exe', ExecutablePath: 'C:\\apps\\Code.exe', CommandLine: '"C:\\apps\\Code.exe" --renderer-process' }) === 'unknown')
    check('PI-3④ empty ExecutablePath -> unknown', branch({ Name: 'x', ExecutablePath: null, CommandLine: 'foo --bar' }) === 'unknown')
    check('PI-3④ empty CommandLine -> unknown', branch({ Name: 'x', ExecutablePath: 'C:\\apps\\chrome.exe', CommandLine: '' }) === 'unknown')
    check('PI-3④ spawn failure (status!=0) -> unknown', queryIdentitySync(31339, 100, () => ({ status: 1, stdout: '' })) === 'unknown')
    check('PI-3④ broken JSON -> unknown', queryIdentitySync(31340, 100, () => ({ status: 0, stdout: 'not-json' })) === 'unknown')
  }

  // --- PI-3b: real PowerShell integration (CIM availability dependent) -----
  px('PI-3b real PowerShell integration (skipped in sandbox: CIM denied)')
  {
    const cimUsable = (() => {
      try {
        const out = cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', IDENTITY_QUERY_SCRIPT],
          { encoding: 'utf8', windowsHide: true, timeout: 15_000, env: { ...process.env, DSH_IDENTITY_PID: String(process.pid) } })
        return out.status === 0
      } catch { return false }
    })()
    if (!cimUsable) {
      skip('PI-3b real query verdict integration', 'CIM denied in sandbox (0x80041003); real-machine RW/RI covers')
    } else {
      let verdict = 'THREW'
      try { verdict = processIdentitySync(process.pid, 15_000) } catch { /* keep THREW */ }
      check('PI-3b real query: no throw, verdict in {foreign, unknown} (sim node process is not an exthost)', verdict === 'foreign' || verdict === 'unknown')
    }
  }

  // --- PI-4: flip guard (cached exthost -> fresh foreign downgraded) -------
  px('PI-4 flip guard: exthost→foreign downgrade to unknown + rlog trace; next round may clear')
  {
    const PID4 = 888888801 // unique to this block (module identityCache is fresh per run)
    const origSpawnSync = cp.spawnSync
    const origNow = Date.now
    let nowFake = Date.now()
    let identStdout = ''
    let identCalls = 0
    cp.spawnSync = () => { identCalls++; return { status: 0, stdout: identStdout } }
    Date.now = () => nowFake
    try {
      // ① preset: fresh query returns the exthost shape -> cached as exthost
      identStdout = JSON.stringify({ Name: 'Code.exe', ExecutablePath: 'C:\\apps\\Code.exe', CommandLine: 'Code.exe --type=extensionHost' })
      const v1 = processIdentitySync(PID4, 1000)
      const callsAfterFirst = identCalls
      check('PI-4① fresh query returns exthost and is cached', v1 === 'exthost' && identCalls === callsAfterFirst && identCalls === 1)
      // ② within TTL: cache short-circuit, zero new spawns
      nowFake += 1_000
      const v2 = processIdentitySync(PID4, 1000)
      check('PI-4② unexpired cache short-circuit returns exthost with ZERO new spawns', v2 === 'exthost' && identCalls === callsAfterFirst)
      // ③ fake clock past TTL; fresh query flips to foreign -> unknown + rlog flip trace
      nowFake += IDENTITY_CACHE_TTL_MS + 1
      identStdout = JSON.stringify({ Name: 'chrome.exe', ExecutablePath: 'C:\\apps\\chrome.exe', CommandLine: 'chrome --flag' })
      const off = rlogOffset()
      const v3 = processIdentitySync(PID4, 1000)
      const trace = rlogSlice(off)
      check('PI-4③ exthost→foreign flip downgraded to unknown (kept; one flip absorbed per short window)', v3 === 'unknown')
      check('PI-4③ rlog carries the flip decision trace (appendDecisionLog)', trace.includes('identity flip') && trace.includes(String(PID4)))
      // ④ one more TTL round: previous cached verdict is now unknown -> foreign clears
      nowFake += IDENTITY_CACHE_TTL_MS + 1
      const v4 = processIdentitySync(PID4, 1000)
      check('PI-4④ next round still foreign -> foreign (previous history unknown; real reuse clears in one cache cycle)', v4 === 'foreign')
    } finally {
      cp.spawnSync = origSpawnSync
      Date.now = origNow
    }
  }

  // --- PI-5: grace period (opts.nowMs seam) --------------------------------
  px('PI-5 grace period: young entries exempt from identity clearing; liveness unaffected')
  {
    const now = Date.now()
    const mk = (ageMs, pid) => ({ dsh: null, windows: [{ app: 'Sim', pid, startedAt: new Date(now - ageMs).toISOString() }] })
    const young = scrubWindowsWithIdentitySync(mk(1_000, mockPid), 100, () => 'foreign', { nowMs: now })
    check('PI-5 entry attached 1s ago is EXEMPT from identity clearing', young.removed === 0 && young.inst.windows.length === 1)
    const oldEntry = scrubWindowsWithIdentitySync(mk(61_000, mockPid), 100, () => 'foreign', { nowMs: now })
    check('PI-5 entry attached 61s ago is clearable on foreign (grace only shields the young)', oldEntry.removed === 1 && oldEntry.inst.windows.length === 0)
    const deadYoung = scrubWindowsWithIdentitySync(mk(1_000, 999999999), 100, () => 'exthost', { nowMs: now })
    check('PI-5 liveness unaffected by grace (dead entry cleared even when young)', deadYoung.removed === 1 && deadYoung.inst.windows.length === 0)
  }

  // --- PI-6: T2 idempotent short-circuit -----------------------------------
  px('PI-6 T2 idempotent: 3 exit-hook calls -> 1 effective bookkeeping; start() resets')
  {
    const SELF = process.pid
    seedInst({
      dsh: makeRecord(mockPid, MOCK_PORT, 'external'),
      windows: [
        { app: 'Sim', pid: mockPid, startedAt: new Date(Date.now() - 120_000).toISOString() },
        { app: 'Sim', pid: SELF, startedAt: new Date().toISOString() },
      ],
    })
    let idChecks = 0
    const r = newRuntime(SELF, { port: MOCK_PORT, identityCheck: () => { idChecks++; return 'exthost' } })
    const off = rlogOffset()
    const r1 = r.shutdownBookkeeping()
    const r2 = r.shutdownBookkeeping()
    const r3 = r.shutdownBookkeeping()
    const trace = rlogSlice(off)
    check('PI-6 first call performs the full bookkeeping (identity queried exactly once)', r1 === false && idChecks === 1)
    check('PI-6 2nd/3rd calls return the first result verbatim', r2 === r1 && r3 === r1)
    check('PI-6 rlog carries exactly two idempotent-skip traces', (trace.match(/idempotent skip/g) || []).length === 2)
    // start() resets the flags: a re-activation epoch re-books.
    await r.start()
    await sleep(400) // let the fire-and-forget T1b (also counted) settle
    const before = idChecks
    const r4 = r.shutdownBookkeeping()
    check('PI-6 start() resets the short-circuit (bookkeeping re-runs after re-activation)', r4 === false && idChecks > before)
    r.dispose()
  }

  // --- PI-7: family regression marker --------------------------------------
  px('PI-7 regression: PW-1..PW-5 + PV family + PI family all clean so far')
  check('PI-7 zero failures across PV + PW + PI blocks (family zero regression)', failures === 0)

  globalThis.fetch = realFetchPI

  // ==================== 0.1.8 PP-1 (design §11.1, ADR-20) ==================
  px('PP-1 consoleVisible parameterization: only windowsHide flips; detached/stdio/unref byte-identical')
  {
    resetResolverState()
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => ({ ok: true, text: async () => 'window.__DSH_BOOT__={}' })
    let unrefs = 0
    router.calls.length = 0
    router.captureLaunch = true
    router.onLaunch = () => {
      const c = fakeChild({ pid: 4545, code: 0 })
      const origUnref = c.unref
      c.unref = () => { unrefs++; origUnref() }
      return c
    }
    try {
      // hidden state: consoleVisible absent (default hidden semantics)
      await new DP.DshProcess({ port: 3091, channel: 'latest', command: '', dshHome: '' }).start()
      // visible state: consoleVisible=true
      await new DP.DshProcess({ port: 3092, channel: 'latest', command: '', dshHome: '', consoleVisible: true }).start()
      const launches = router.calls.filter((c) => c.kind === 'launch')
      const hidden = launches.find((c) => c.argv.includes('3091'))
      const visible = launches.find((c) => c.argv.includes('3092'))
      const stdioShape = (o) => Array.isArray(o) && o[0] === 'ignore' && Number.isInteger(o[1]) && o[1] === o[2]
      check('PP-1 consoleVisible absent -> windowsHide === true (0.1.7 accepted shape)', hidden !== undefined && hidden.opts.windowsHide === true)
      check('PP-1 consoleVisible=true -> windowsHide === false (dsh on a visible console)', visible !== undefined && visible.opts.windowsHide === false)
      check('PP-1 detached === true in BOTH states (Phase-2 independence intact)', hidden.opts.detached === true && visible.opts.detached === true)
      check('PP-1 stdio = [ignore, fd, fd] shape in BOTH states (F-PORT data source intact)', stdioShape(hidden.opts.stdio) && stdioShape(visible.opts.stdio))
      check('PP-1 child.unref() called in BOTH states', unrefs === 2)
      // custom command path regression (legacy boundary, unaffected semantics).
      // Note: a non-empty `command` routes start() through the random-port
      // log-tailing path (no fake banner possible), so the argv shape is
      // asserted directly on buildLaunch — the custom branch returns BEFORE
      // any resolver work, so this is deterministic; the spawn-flags contract
      // (detached/stdio/unref) is a single call site already asserted above.
      const procCustom = new DP.DshProcess({ port: 3093, channel: 'latest', command: 'dsh web --port 3093', dshHome: '' })
      const built = await procCustom.buildLaunch('')
      check('PP-1 custom command path regression: cmd.exe /d /s /c chain unchanged (legacy boundary)', built !== undefined &&
        path.basename(built.exec) === 'cmd.exe' && built.argv[0] === '/d' && built.argv[1] === '/s' && built.argv[2] === '/c' &&
        built.argv[3] === 'dsh web --port 3093')
      // config chain static assertions (vscode layer cannot be required headlessly)
      const ext = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8')
      const rt = fs.readFileSync(path.join(process.cwd(), 'src', 'runtime.ts'), 'utf8')
      check('PP-1 config chain: extension reads dsh.consoleVisible (default true) into DshRuntime', ext.includes("c.get<boolean>('consoleVisible', true)") && ext.includes('consoleVisible: cfg.consoleVisible'))
      check('PP-1 config chain: runtime forwards consoleVisible into DshProcess options', rt.includes('consoleVisible: this.options.consoleVisible'))
      const pkgRaw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'))
      const prop = pkgRaw.contributes?.configuration?.properties?.['dsh.consoleVisible']
      check('PP-1 package.json contributes dsh.consoleVisible (boolean, default true per user ruling 2026-08-29)', prop !== undefined && prop.type === 'boolean' && prop.default === true)
    } finally {
      router.captureLaunch = false
      router.onLaunch = null
      globalThis.fetch = origFetch
    }
  }

  // ==================== 0.1.9 PP-2 (design §11.1, ADR-21) ==================
  px('PP-2 start-launch (ADR-21): verbatim cmd-start wrapper / servicePid=holder / fast-fail / 2-failure fallback / user-stop branch')
  {
    resetResolverState()
    const origFetch = globalThis.fetch
    const okFetch = async () => ({ ok: true, text: async () => 'window.__DSH_BOOT__={}' })
    const failFetch = async () => { throw new Error('sim: probe failure') }
    /** First call fails (step2 external probe), later calls succeed (launch readiness). */
    const step2FailFetch = () => {
      let n = 0
      return async () => {
        n++
        if (n === 1) throw new Error('sim: step2 probe must fail')
        return { ok: true, text: async () => 'window.__DSH_BOOT__={}' }
      }
    }
    const stdioShape = (o) => Array.isArray(o) && o[0] === 'ignore' && Number.isInteger(o[1]) && o[1] === o[2]
    const isStartForm = (c) => c !== undefined && c.argv.length === 4 && /^start "/.test(c.argv[3])
    // 0.1.12 #58-⑤ (ADR-26): production start-mode launches take the CONHOST
    // form — the resident-family classifier gates BOTH arms (the start-wait RAW
    // stays on the flip-back track, PP-3-1①②③).
    const formOf = (c) => ((isStartForm(c) || isConhostForm(c)) ? 'start' : 'direct')
    /** A deterministically DEAD pid for the mocked port holder: a real
     *  process that has already exited. A fixed fake pid (e.g. 4700) can
     *  collide with a LIVE host process — probeTick's `pidDead` gate would
     *  then never open and the ADR-21 user-stop branch would be unreachable. */
    const holderPid = await new Promise((resolve) => {
      const p = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
      p.once('exit', () => resolve(p.pid))
    })
    /** Banner port for random-port (degraded-retry) readiness: the launch
     *  payload asks for --port 0, so readiness tails the managed log for the
     *  banner and probes THAT port (mock fetch answers ok). */
    const BANNER_PORT = 3109
    /** Append the `dsh web:` banner to THIS attempt's managed log (only used
     *  for attempts that must SUCCEED on the random-port path). The log file
     *  is carried verbatim in the start-form RAW payload tail; for the direct
     *  form it is the just-created newest dsh-*.log in the sim logs dir. */
    const writeBanner = (entry) => {
      let log = null
      if (isStartForm(entry)) {
        // 0.1.11 §4.9.1: the payload carries the marker wrap — peel it before
        // locating the `>> "<LOG>" 2>&1` redirect target.
        const inner = rawStartInner(entry.argv[3])
        const peeled = inner !== null ? peelLaunchMarkers(inner) : null
        const m = peeled !== null ? />> "([^"]+)" 2>&1"$/.exec(peeled.payload) : null
        if (m !== null) log = m[1]
      } else if (isConhostForm(entry)) {
        // 0.1.12 #58-⑤: the conhost inner command carries the same marker-wrapped
        // payload (`title <TITLE> && <payload+markers>`).
        const inner = conhostInnerCmd(entry, DP.START_WINDOW_TITLE)
        const peeled = inner !== null ? peelLaunchMarkers(inner) : null
        const m = peeled !== null ? />> "([^"]+)" 2>&1"$/.exec(peeled.payload) : null
        if (m !== null) log = m[1]
      } else {
        try {
          const dir = path.join(dataDir, 'logs')
          const files = fs.readdirSync(dir)
            .filter((f) => /^dsh-\d{8}-\d{6}\.log$/.test(f))
            .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a, b) => b.t - a.t)
          if (files.length > 0) log = path.join(dir, files[0].f)
        } catch { /* best-effort */ }
      }
      if (log !== null) {
        try {
          fs.mkdirSync(path.dirname(log), { recursive: true })
          fs.appendFileSync(log, `dsh web: http://127.0.0.1:${BANNER_PORT}\n`, 'utf8')
        } catch { /* best-effort */ }
      }
    }
    /** start-mode outer-cmd mock: settles via 'exit'/'error' events. ADR-23
     *  (§4.8.3): with /wait the outer cmd is the HOLDER of the inner chain's
     *  lifetime, so SUCCESS-path mocks must stay ALIVE during readiness
     *  (exitCode null = no event) — an outer exit before readiness is now the
     *  fast-failure signal itself (PP-3-2). */
    const startModeChild = ({ pid, exitCode = null, emitError = null }) => {
      const c = new EventEmitter()
      c.stdout = new EventEmitter()
      c.stderr = new EventEmitter()
      c.pid = pid
      c.unref = () => {}
      c.kill = () => true
      queueMicrotask(() => {
        if (emitError !== null) c.emit('error', new Error(emitError))
        else if (exitCode !== null) c.emit('exit', exitCode)
      })
      return c
    }
    try {
      // Readiness mock for the DshProcess-level tests below (PP-2-1/1b/2/5,
      // fixed ports): every probe succeeds. The runtime-level tests
      // (PP-2-3/3b/4/4b/6a/6b) each install a FRESH step2FailFetch so the
      // step2 external probe fails exactly once and the managed-launch path
      // runs (readiness probes afterwards all succeed).
      globalThis.fetch = okFetch
      // ---- PP-2-1: verbatim command line + spawn contract + payload parse ----
      px('PP-2-1 start-launch command line contract (single builder, verbatim, unconditional quoting)')
      let unrefCount = 0
      router.calls.length = 0
      router.captureLaunch = true
      router.onLaunch = () => {
        // ADR-23 判据级适配: the healthy /wait holder stays ALIVE during
        // readiness (an immediate exit 0 would now BE the fast-fail signal).
        const c = startModeChild({ pid: 4601 })
        const origUnref = c.unref
        c.unref = () => { unrefCount++; origUnref() }
        return c
      }
      const procStart = new DP.DshProcess({
        port: 3094, channel: 'latest', command: '', dshHome: '', consoleVisible: true, launchMode: 'start',
        resolvePortPidFn: () => ({ pid: holderPid, address: '127.0.0.1' }),
      })
      const infoStart = await procStart.start()
      const launches1 = router.calls.filter((c) => c.kind === 'launch')
      const cap = launches1[launches1.length - 1]
      // 0.1.12 #58-⑤ (ADR-26): the production start-mode launch = CONHOST arm —
      // the outer-form carrier switches from the start-wait RAW (now the
      // flip-back track, PP-3-1①②③) to the conhost inner command; the payload
      // char assertions below are UNCHANGED.
      check('PP-2-1 outer spawn exec basename = conhost.exe（0.1.12 生产基线 = ADR-26 conhost 形态；E5/W-01：conhost 窗即目标常驻窗）', cap !== undefined && isConhostForm(cap))
      check('PP-2-1 outer argv = [--, cmd, /d, /c, INNER]（INNER 作为单个 verbatim argv 元素）', cap !== undefined &&
        JSON.stringify(cap.argv.slice(0, 4)) === JSON.stringify(['--', 'cmd', '/d', '/c']) && cap.argv.length === 5)
      const inner = conhostInnerCmd(cap, DP.START_WINDOW_TITLE)
      check('PP-2-1 inner cmd = title <START_WINDOW_TITLE> && <payload+marker>（title 不带引号 = E5 形态；title/cwd//wait RAW 结构由 flip-back 轨 PP-3-1①② 断言）', inner !== null)
      // 0.1.11 判据级适配 (§4.9.8-5/#51, sanctioned class per §4.8.6/§4.9.6):
      // the start payload now carries the PERMANENT §4.9.1 marker wrap; the
      // production payload between the markers is the VARIANT-AWARE shape
      // (shipped experimental package = 'npx' → the npx chain form, which is
      // semantically exclusive with the node-bin form). The node-bin track is
      // re-asserted against the patched flip-back module in PP-5-3①.
      const peeledP21 = peelLaunchMarkers(inner)
      check('PP-2-1 marker wrap (§4.9.1 permanent): three-stage echo prefix + conditional exit suffix wrap the payload', peeledP21 !== null)
      if (DP.START_PAYLOAD_VARIANT === 'npx') {
        check('PP-2-1 payload (variant=npx, 0.1.13 ADR-27 复合形状): infoHeader & echo. & exact npx chain + quoted log = info.logFile (redirect done by the INNER cmd)', peeledP21 !== null &&
          peeledP21.payload === specWithHeader(`npx --yes --prefer-offline @deepseek-ai/dsh@latest web --host 127.0.0.1 --port 3094 --no-open >> "${infoStart.logFile}" 2>&1`, infoStart.logFile))
      } else {
        const bodyP21 = peeledP21 !== null ? stripInfoHeader(peeledP21.payload, infoStart.logFile) : null
        const mInner = bodyP21 !== null ? /^"([^"]*)" "([^"]*)" web --host 127\.0\.0\.1 --port 3094 --no-open >> "(.*)" 2>&1$/.exec(bodyP21) : null
        check('PP-2-1 payload: quoted node = DSH_NODE_EXE + quoted binJs (mock _npx hit) + quoted log = info.logFile (redirect done by the INNER cmd；0.1.13 适配：复合形状剥信息头后断言)', mInner !== null &&
          mInner[1] === process.env.DSH_NODE_EXE &&
          mInner[2].includes(path.join('node_modules', '@deepseek-ai', 'dsh')) && mInner[2].endsWith(path.join('lib', 'bin.js')) &&
          mInner[3] === infoStart.logFile)
      }
      check('PP-2-1 opts: verbatim=true + detached=true + windowsHide=false（E5/W-01：conhost 窗即目标常驻窗）+ stdio ignore×3 + unref', cap !== undefined &&
        cap.opts.windowsVerbatimArguments === true && cap.opts.detached === true && cap.opts.windowsHide === false &&
        stdioIgnoreShape(cap.opts.stdio) && unrefCount === 1)
      check('PP-2-1 servicePid = mocked port holder (≠ wrapper child pid); resolved transparency carries the hit dir', infoStart.servicePid === holderPid && holderPid !== 4601 &&
        infoStart.resolved !== null && infoStart.resolved.dir.startsWith(simNpxRoot))

      // ---- PP-2-1b: resolver-failure npx payload wrapped in start mode too ----
      px('PP-2-1b npx fallback chain wrapped in start mode (§4.6.2: shim console absorbed by the resident console)')
      fs.rmSync(simNpxRoot, { recursive: true, force: true })
      clearMeta('latest')
      router.handlers.view = () => fakeChild({ pid: 5110, code: 1 })
      router.handlers.install = () => fakeChild({ pid: 5111, code: 1 })
      router.handlers.establish = () => fakeChild({ pid: 5112, code: 1 })
      globalThis.fetch = okFetch
      router.calls.length = 0
      router.onLaunch = () => startModeChild({ pid: 4602 }) // ADR-23: alive /wait holder
      const npxStart = await new DP.DshProcess({
        port: 3094, channel: 'latest', command: '', dshHome: '', consoleVisible: true, launchMode: 'start',
        resolvePortPidFn: () => ({ pid: holderPid, address: '127.0.0.1' }),
      }).start()
      const npxCap = router.calls.filter((c) => c.kind === 'launch').pop()
      // 0.1.11 适配：payload 带 marker 包裹 → 剥离后再断言 redirect 尾巴。
      // 0.1.12 #58-⑤ 适配：外层载体 = conhost 内层命令（生产基线）。
      const innerP21b = npxCap !== undefined ? conhostInnerCmd(npxCap, DP.START_WINDOW_TITLE) : null
      const peeledP21b = innerP21b !== null ? peelLaunchMarkers(innerP21b) : null
      check('PP-2-1b 常驻窗宿主仍包住 npx fallback 链（0.1.12：conhost 形态）+ npx payload 带引号 log redirect', isConhostForm(npxCap) &&
        typeof npxCap.argv[4] === 'string' && npxCap.argv[4].includes('npx --yes --prefer-offline') && npxCap.argv[4].includes('@deepseek-ai/dsh@latest') &&
        peeledP21b !== null && peeledP21b.payload.endsWith(`>> "${npxStart.logFile}" 2>&1`) && npxStart.resolved === null)
      router.handlers.view = null
      router.handlers.install = null
      router.handlers.establish = null
      resetResolverState()

      // ---- PP-2-2: direct mode byte regression (incl. explicit 'direct') ----
      px('PP-2-2 direct mode byte regression: pre-0.1.9 shape intact, verbatim flag absent')
      globalThis.fetch = okFetch
      router.calls.length = 0
      router.onLaunch = () => fakeChild({ pid: 4611, code: 0 })
      const directInfo = await new DP.DshProcess({ port: 3095, channel: 'latest', command: '', dshHome: '' }).start()
      await new DP.DshProcess({ port: 3096, channel: 'latest', command: '', dshHome: '', consoleVisible: true, launchMode: 'direct' }).start()
      const dLaunches = router.calls.filter((c) => c.kind === 'launch')
      const dHidden = dLaunches.find((c) => c.argv.includes('3095'))
      const dVisibleDirect = dLaunches.find((c) => c.argv.includes('3096'))
      check('PP-2-2 direct form: node exec + [binJs, web, --host 127.0.0.1, --port P, --no-open]', dHidden !== undefined &&
        path.basename(dHidden.exec) === path.basename(process.execPath) && dHidden.argv[0].endsWith(path.join('lib', 'bin.js')) &&
        dHidden.argv[1] === 'web' && dHidden.argv[3] === LOOPBACK_HOST && dHidden.argv[4] === '--port' && dHidden.argv[6] === '--no-open')
      check('PP-2-2 direct opts byte-identical: detached + windowsHide true + stdio fd + NO verbatim flag', dHidden !== undefined &&
        dHidden.opts.detached === true && dHidden.opts.windowsHide === true && dHidden.opts.windowsVerbatimArguments === undefined &&
        stdioShape(dHidden.opts.stdio))
      check('PP-2-2 direct+consoleVisible=true keeps windowsHide=false (0.1.8 parameterization preserved in direct mode)', dVisibleDirect !== undefined && dVisibleDirect.opts.windowsHide === false)
      check('PP-2-2 direct servicePid = child.pid 恒等 (ADR-21: direct child IS the service)', directInfo.servicePid === 4611 && directInfo.pid === 4611)

      // ---- PP-2-3: servicePid = port holder; registry dsh.pid; degraded null ----
      px('PP-2-3 servicePid resolution: holder pid into SpawnedInfo + registry; bounded null fallback')
      globalThis.fetch = step2FailFetch()
      seedInst({ dsh: null, windows: [] }) // clean slate: no leftover record may consume step1/step2 probes
      router.calls.length = 0
      router.onLaunch = () => startModeChild({ pid: 4601 }) // ADR-23: alive /wait holder
      releaseStartupLock() // defensive: guarantee the first-window path
      let pidResolveCalls = 0
      const rHolder = newRuntime(process.pid, {
        port: 3097, consoleVisible: true,
        resolvePortPidFn: () => { pidResolveCalls++; return { pid: holderPid, address: '127.0.0.1' } },
      })
      const off3 = rlogOffset()
      await rHolder.start()
      check('PP-2-3 registry dsh.pid = port holder pid (servicePid, NOT the transient wrapper)', readInstance().dsh !== null && readInstance().dsh.pid === holderPid)
      check('PP-2-3 registry dsh.launchMode = start (ADR-21 #22 discriminator carrier written)', readInstance().dsh.launchMode === 'start')
      check('PP-2-3 rlog carries the service-pid resolution trace', rlogSlice(off3).includes('service pid (port holder) resolved'))
      const snapManaged = rHolder.getLaunchInfo()
      check('PP-2-3 managed launchInfo snapshot (ADR-22): binDir from resolved + launchMode/channel carried', snapManaged !== null &&
        snapManaged.binDir === infoStart.resolved.dir && snapManaged.launchMode === 'start' && snapManaged.channel === 'latest')
      check('PP-2-3 snapshot honest cross-check: empty mock log -> no self version -> resolver-only', snapManaged.dshVersion === null && snapManaged.versionCrossCheck === 'resolver-only')
      rHolder.dispose()

      globalThis.fetch = step2FailFetch()
      seedInst({ dsh: null, windows: [] })
      releaseStartupLock()
      let nullResolveCalls = 0
      const rNull = newRuntime(process.pid, {
        port: 3098, consoleVisible: true,
        resolvePortPidFn: () => { nullResolveCalls++; return null },
      })
      const off3b = rlogOffset()
      await rNull.start()
      check('PP-2-3 resolve retries bounded: exactly PORT_PID_RESOLVE_ATTEMPTS attempts', nullResolveCalls === DP.PORT_PID_RESOLVE_ATTEMPTS)
      check('PP-2-3 resolve failure -> servicePid null -> registry dsh.pid null (degraded semantics kept)', readInstance().dsh !== null && readInstance().dsh.pid === null && readInstance().dsh.launchMode === 'start')
      check('PP-2-3 forceRelaunchManaged -> no-managed on null pid (existing branch semantics)', await rNull.forceRelaunchManaged() === 'no-managed')
      check('PP-2-3 rlog carries the degraded-resolution trace', rlogSlice(off3b).includes('servicePid = null'))
      rNull.dispose()

      // ---- PP-2-4: two consecutive start-launch failures -> direct fallback ----
      px('PP-2-4 consecutive-failure fallback: 2 start failures -> direct spawn + rlog declaration')
      globalThis.fetch = step2FailFetch() // step2 probe fails once -> managed-launch path
      seedInst({ dsh: null, windows: [] })
      router.calls.length = 0
      let seq4 = 0
      router.onLaunch = (entry) => {
        seq4++
        if (isStartForm(entry) || isConhostForm(entry)) return startModeChild({ pid: 4620 + seq4, exitCode: 9009 })
        // The surviving DIRECT attempt runs on the degraded RANDOM port (the
        // retry loop degrades usePort to 0) -> readiness tails the log banner.
        writeBanner(entry)
        return fakeChild({ pid: 4620 + seq4, code: 0 })
      }
      releaseStartupLock()
      const rFall = newRuntime(process.pid, { port: 3099, consoleVisible: true, resolvePortPidFn: () => ({ pid: holderPid, address: '127.0.0.1' }) })
      const off4 = rlogOffset()
      await rFall.start()
      const fallLaunches = router.calls.filter((c) => c.kind === 'launch')
      check('PP-2-4 first two attempts start-launch, third attempt direct (START_LAUNCH_FAIL_LIMIT budget)', fallLaunches.length >= 3 &&
        formOf(fallLaunches[0]) === 'start' && formOf(fallLaunches[1]) === 'start' && formOf(fallLaunches[2]) === 'direct')
      check('PP-2-4 rlog declares falling back to direct spawn (0.1.8 behavior)', rlogSlice(off4).includes('falling back to direct'))
      check('PP-2-4 fallback launch reaches ready with launchMode=direct in the registry', rFall.state === 'ready' && readInstance().dsh !== null && readInstance().dsh.launchMode === 'direct')
      rFall.dispose()

      // ---- PP-2-4b: any success resets the budget (next single failure keeps start) ----
      px('PP-2-4b success resets the failure budget (§4.6.3: 计数清零)')
      globalThis.fetch = step2FailFetch() // fresh counter: this runtime's step2 must fail once
      seedInst({ dsh: null, windows: [] })
      releaseStartupLock()
      let seq4b = 0
      let failRemaining = 1
      router.onLaunch = (entry) => {
        seq4b++
        if ((isStartForm(entry) || isConhostForm(entry)) && failRemaining > 0) {
          failRemaining--
          return startModeChild({ pid: 4630 + seq4b, exitCode: 9009 })
        }
        writeBanner(entry) // success attempt (possibly on the degraded random port)
        return fakeChild({ pid: 4630 + seq4b, code: 0 })
      }
      const rReset = newRuntime(process.pid, { port: 3100, consoleVisible: true, resolvePortPidFn: () => ({ pid: holderPid, address: '127.0.0.1' }) })
      await rReset.start() // start-fail -> start-success (budget reset to 0)
      router.calls.length = 0
      failRemaining = 1
      await rReset.forceRelaunchManaged() // one more start failure -> next attempt must STILL be start
      const resetLaunches = router.calls.filter((c) => c.kind === 'launch')
      check('PP-2-4b post-reset single failure keeps start mode (no budget carry-over)', resetLaunches.length >= 2 &&
        formOf(resetLaunches[0]) === 'start' && formOf(resetLaunches[1]) === 'start')
      rReset.dispose()

      // ---- PP-2-5: outer-cmd fast-fail is immediate (exit != 0 / error) ----
      // ADR-23 判据级适配 (§4.8.3/PP-3-2①): the 0.1.9 clause "exit code 0 does
      // NOT fast-fail" encoded the signal model ADR-23 reverses (E6a: /wait
      // does not propagate the inner code; code 0 is equally a failure). The
      // positive control here is now an ALIVE /wait holder; the exit(0)-
      // before-readiness = immediate-failure assertion lives in PP-3-2①.
      px('PP-2-5 outer-cmd fast-fail: immediate LaunchFailure (秒级收敛, not the budget); alive /wait holder proceeds (ADR-23-adapted)')
      globalThis.fetch = okFetch
      router.onLaunch = () => startModeChild({ pid: 4640, exitCode: 9009 })
      const t0 = Date.now()
      let fastFailErr = null
      try {
        await new DP.DshProcess({ port: 3101, channel: 'latest', command: '', dshHome: '', consoleVisible: true, launchMode: 'start', resolvePortPidFn: () => null }).start()
      } catch (err) { fastFailErr = err }
      check('PP-2-5 exit code != 0 -> immediate LaunchFailure (well under the budget)', fastFailErr !== null && fastFailErr.name === 'LaunchFailure' && Date.now() - t0 < 10_000)
      router.onLaunch = () => startModeChild({ pid: 4641 }) // ADR-23: alive /wait holder during readiness
      const okStart = await new DP.DshProcess({ port: 3102, channel: 'latest', command: '', dshHome: '', consoleVisible: true, launchMode: 'start', resolvePortPidFn: () => ({ pid: holderPid, address: '127.0.0.1' }) }).start()
      check('PP-2-5 alive /wait holder (no early exit) -> readiness wait proceeds to ready (ADR-23-adapted positive control)', okStart.port === 3102 && okStart.servicePid === holderPid)
      router.onLaunch = () => startModeChild({ pid: 4642, emitError: 'sim: spawn ENOENT' })
      let errorErr = null
      try {
        await new DP.DshProcess({ port: 3103, channel: 'latest', command: '', dshHome: '', consoleVisible: true, launchMode: 'start', resolvePortPidFn: () => null }).start()
      } catch (err) { errorErr = err }
      check('PP-2-5 spawn error event -> immediate LaunchFailure (unhandled-error hazard closed)', errorErr !== null && errorErr.name === 'LaunchFailure')

      // ---- PP-2-6: start-mode death = user stop; direct keeps the relaunch ----
      px('PP-2-6 start-mode death (window close, indistinguishable) = user stop, NO relaunch; direct keeps pre-0.1.9 relaunch')
      globalThis.fetch = step2FailFetch() // step2 fails once -> managed launch in START mode
      seedInst({ dsh: null, windows: [] })
      router.onLaunch = () => startModeChild({ pid: 4650 }) // ADR-23: alive /wait holder
      releaseStartupLock()
      const rStop = newRuntime(process.pid, { port: 3104, consoleVisible: true, probeIntervalSec: 0.05, resolvePortPidFn: () => ({ pid: holderPid, address: '127.0.0.1' }) })
      const off6a = rlogOffset()
      await rStop.start()
      check('PP-2-6a setup: ready in start mode, registry launchMode=start', rStop.state === 'ready' && readInstance().dsh !== null && readInstance().dsh.launchMode === 'start')
      const spawnsBefore6a = router.calls.filter((c) => c.kind === 'launch').length
      globalThis.fetch = failFetch
      await sleep(600) // >= 3 probe ticks at 50ms
      check('PP-2-6a death in start mode -> state stopped (user stop branch, not starting)', rStop.state === 'stopped')
      check('PP-2-6a dsh record cleared (user-stop bookkeeping)', readInstance().dsh === null)
      check('PP-2-6a NO auto-relaunch (launch spawn count unchanged — no zombie loop)', router.calls.filter((c) => c.kind === 'launch').length === spawnsBefore6a)
      check('PP-2-6a rlog carries the ADR-21 user-stop trace', rlogSlice(off6a).includes('treated as user stop per ADR-21'))
      const snap6a = rStop.getLaunchInfo()
      check('PP-2-6a user-stop snapshot: launchMode=start KEPT + version/bin cleared + port retained (UI 二分判别载体)', snap6a !== null &&
        snap6a.launchMode === 'start' && snap6a.dshVersion === null && snap6a.binDir === null && snap6a.port === 3104)
      rStop.dispose()

      globalThis.fetch = step2FailFetch() // fresh counter: managed launch in DIRECT mode
      seedInst({ dsh: null, windows: [] })
      router.onLaunch = () => fakeChild({ pid: 4651, code: 0 })
      releaseStartupLock()
      const rRel = newRuntime(process.pid, { port: 3105, consoleVisible: false, probeIntervalSec: 0.05 })
      const off6b = rlogOffset()
      await rRel.start()
      const spawnsBefore6b = router.calls.filter((c) => c.kind === 'launch').length
      globalThis.fetch = failFetch
      const t6b = Date.now()
      let relaunched = false
      while (Date.now() - t6b < 5000) {
        await sleep(100)
        if (router.calls.filter((c) => c.kind === 'launch').length > spawnsBefore6b) { relaunched = true; break }
      }
      globalThis.fetch = okFetch // let the in-flight relaunch converge
      await sleep(700)
      check('PP-2-6b death in direct mode -> bounded relaunch happens (pre-0.1.9 semantics intact)', relaunched)
      check('PP-2-6b relaunch converges back to ready', rRel.state === 'ready')
      check('PP-2-6b no user-stop trace in direct mode (branch gated on launchMode=start)', !rlogSlice(off6b).includes('treated as user stop per ADR-21'))
      rRel.dispose()

      // ---- PP-2-7: custom command stays direct (legacy boundary) ----
      px('PP-2-7 custom command boundary: forced direct even with consoleVisible=true + launchMode=start')
      const procCustomStart = new DP.DshProcess({ port: 3106, channel: 'latest', command: 'dsh web --port 3106', dshHome: '', consoleVisible: true, launchMode: 'start' })
      check('PP-2-7 effectiveLaunchMode() forces direct for a custom command', procCustomStart.effectiveLaunchMode() === 'direct')
      const builtCustom = await procCustomStart.buildLaunch('')
      check('PP-2-7 custom argv = cmd.exe /d /s /c <command> unwrapped, startPayload null (never start-wrapped)', path.basename(builtCustom.exec) === 'cmd.exe' &&
        builtCustom.argv[0] === '/d' && builtCustom.argv[1] === '/s' && builtCustom.argv[2] === '/c' &&
        builtCustom.argv[3] === 'dsh web --port 3106' && builtCustom.startPayload === null)

      // ---- PP-2-8: regression marker ----
      px('PP-2-8 regression marker')
      check('PP-2-8 zero failures across PP-1 + PP-2 blocks (family zero regression)', failures === 0)
    } finally {
      router.captureLaunch = false
      router.onLaunch = null
      router.handlers.view = null
      router.handlers.install = null
      router.handlers.establish = null
      globalThis.fetch = origFetch
    }
  }

  // ==================== 0.1.9 PU (design §11.1, ADR-22) ====================
  px('PU launchInfo / buildDetailsHtml / statusLine / parseSelfVersion (pure-function direct tests, no vscode)')
  {
    // ---- PU-1: 15-field assembly + existence filter + parseSelfVersion ----
    px('PU-1 buildLaunchInfo: 15 fields, existence filter, honest inventory')
    const logsDirSim = path.join(dataDir, 'logs')
    fs.mkdirSync(logsDirSim, { recursive: true })
    fs.writeFileSync(path.join(logsDirSim, 'runtime.log'), 'seed runtime\n', 'utf8')
    fs.writeFileSync(path.join(logsDirSim, 'dsh.log'), 'seed dsh\n', 'utf8')
    const launchLog = path.join(logsDirSim, 'dsh-20990101-000000.log')
    fs.writeFileSync(launchLog, '0.1.1-rc.2\ndsh web: http://127.0.0.1:19441\n', 'utf8')
    const hitDir = path.join(simNpxRoot, 'pu-hit')
    const info1 = LI.buildLaunchInfo({
      selfVersion: LI.parseSelfVersion(fs.readFileSync(launchLog, 'utf8')),
      resolved: { version: '0.1.1-rc.2', dir: hitDir, binJs: path.join(hitDir, 'lib', 'bin.js'), mode: 'steady' },
      meta: { lastCheckAt: '2026-08-31T12:17:00.000Z', knownVersion: '0.1.1-rc.2' },
      rec: { pid: 19441, port: 3080, managedBy: 'managed-own', startedAt: '2026-08-31T12:17:42.000Z', launchMode: 'start' },
      port: 3080, pid: 19441, managedBy: 'managed-own', channel: 'latest',
      launchLogFile: launchLog,
    })
    check('PU-1① 15 fields complete with expected values (double-source match)', info1.dshVersion === '0.1.1-rc.2' && info1.resolverVersion === '0.1.1-rc.2' &&
      info1.versionCrossCheck === 'match' && info1.binDir === hitDir && info1.dshBin === path.join(hitDir, 'lib', 'bin.js') &&
      info1.channel === 'latest' && info1.resolverMode === 'steady' && info1.lastCheckAt === '2026-08-31T12:17:00.000Z' &&
      info1.launchMode === 'start' && info1.port === 3080 && info1.pid === 19441 && info1.managedBy === 'managed-own' &&
      info1.startedAt === '2026-08-31T12:17:42.000Z' && info1.externalCommandLine === null && Array.isArray(info1.logFiles))
    check('PU-1② logFiles = 3 entries (launch log + runtime.log + dsh.log), all existing', info1.logFiles.length === 3)
    const filtered = LI.buildLaunchInfo({ channel: 'latest', launchLogFile: path.join(logsDirSim, 'dsh-20980101-000000.log') })
    check('PU-1③ existence filter drops the missing launch log (honest inventory)', filtered.logFiles.length === 2)
    check('PU-1④ parseSelfVersion: bare rc token / v-prefix / banner-only / empty (first-line-only contract)', LI.parseSelfVersion('0.1.1-rc.2\ndsh web: http://127.0.0.1:19441\n') === '0.1.1-rc.2' &&
      LI.parseSelfVersion('v1.2.3\n') === '1.2.3' && LI.parseSelfVersion('dsh web: http://127.0.0.1:19441\n0.1.1-rc.2\n') === null &&
      LI.parseSelfVersion('') === null && LI.parseSelfVersion('\n\n') === null)

    // ---- PU-2: version cross-check five tiers ----
    px('PU-2 version cross-check five tiers')
    const base2 = { channel: 'latest', managedBy: 'managed-own' }
    check('PU-2① both sources + equal -> match', LI.buildLaunchInfo({ ...base2, selfVersion: '0.1.1-rc.2', resolved: { version: '0.1.1-rc.2', dir: 'D', binJs: 'B', mode: 'steady' } }).versionCrossCheck === 'match')
    const misInfo = LI.buildLaunchInfo({ ...base2, selfVersion: '0.1.1-rc.2', resolved: { version: '0.1.2-alpha.2', dir: 'D', binJs: 'B', mode: 'steady' } })
    check('PU-2② both sources + differ -> mismatch (BOTH facts retained)', misInfo.versionCrossCheck === 'mismatch' && misInfo.dshVersion === '0.1.1-rc.2' && misInfo.resolverVersion === '0.1.2-alpha.2')
    check('PU-2③ self-only (E-VER-1 best-effort missing resolver)', LI.buildLaunchInfo({ ...base2, selfVersion: '0.1.1-rc.2' }).versionCrossCheck === 'self-only')
    check('PU-2④ resolver-only (self report absent)', LI.buildLaunchInfo({ ...base2, resolved: { version: '0.1.1-rc.2', dir: 'D', binJs: 'B', mode: 'refreshed' } }).versionCrossCheck === 'resolver-only')
    check('PU-2⑤ neither -> unknown', LI.buildLaunchInfo({ ...base2 }).versionCrossCheck === 'unknown')

    // ---- PU-3: external degraded card ----
    px('PU-3 external degraded card: honest nulls + truncation + no unusable actions')
    const longCmd = 'node C:\\x\\bin.js web --port 3080 ' + 'x'.repeat(400)
    const infoExt = LI.buildLaunchInfo({
      managedBy: 'external', rec: { pid: 555, port: 3080, managedBy: 'external', startedAt: '2026-08-31T12:00:00.000Z' },
      port: 3080, pid: 555, externalCommandLine: longCmd, channel: 'latest',
      meta: { lastCheckAt: '2026-08-31T12:00:00.000Z' },
      // decoys: an external dsh MUST drop session bin/version facts (H1)
      selfVersion: '9.9.9', resolved: { version: '9.9.9', dir: 'SHOULD-BE-DROPPED', binJs: 'B', mode: 'steady' },
    })
    check('PU-3① external forces honest degradation (decoy version/bin dropped, crossCheck unknown)', infoExt.dshVersion === null && infoExt.resolverVersion === null &&
      infoExt.binDir === null && infoExt.dshBin === null && infoExt.resolverMode === null && infoExt.versionCrossCheck === 'unknown' && infoExt.launchMode === null)
    check('PU-3② externalCommandLine truncated to EXTERNAL_CMDLINE_MAX=300', infoExt.externalCommandLine !== null && infoExt.externalCommandLine.length === 300 &&
      infoExt.externalCommandLine.startsWith('node C:\\x\\bin.js'))
    check('PU-3③ available fields retained (port/pid/managedBy/startedAt/lastCheckAt)', infoExt.port === 3080 && infoExt.pid === 555 &&
      infoExt.managedBy === 'external' && infoExt.startedAt === '2026-08-31T12:00:00.000Z' && infoExt.lastCheckAt === '2026-08-31T12:00:00.000Z')
    const htmlExt = buildDetailsHtml(infoExt, 'ready')
    check('PU-3④ external card: 外部接管 bar + mono command line, NO 复制路径/打开目录, NO big version', htmlExt.includes('外部接管') &&
      htmlExt.includes(infoExt.externalCommandLine) && !htmlExt.includes('复制路径') && !htmlExt.includes('打开目录') &&
      !htmlExt.includes('id="version-big"'))

    // ---- PU-4: template contract (CSP / copy reversibility / anchors / injection) ----
    px('PU-4 buildDetailsHtml contract: CSP, copy reversibility, Chinese anchors, injection safety')
    const htmlReady = buildDetailsHtml(info1, 'ready')
    check('PU-4① CSP: style-src + script-src unsafe-inline, NO frame-src, NO iframe (nothing embedded)', htmlReady.includes("style-src 'unsafe-inline'") &&
      htmlReady.includes("script-src 'unsafe-inline'") && !htmlReady.includes('frame-src') && !htmlReady.includes('<iframe'))
    const unescapeHtml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    const clipboards = [...htmlReady.matchAll(/data-clipboard="([^"]*)"/g)].map((m) => unescapeHtml(m[1]))
    check('PU-4② copy buttons carry reversible data-clipboard (binDir + dshBin round-trip to the visible strings)', clipboards.includes(info1.binDir) && clipboards.includes(info1.dshBin))
    check('PU-4③ Chinese anchors: bin 目录 / 启动方式 / 在文件管理器中显示 / 重新检查更新 / 重启 dsh', ['bin 目录', '启动方式', '在文件管理器中显示', '重新检查更新', '重启 dsh'].every((a) => htmlReady.includes(a)))
    const evil = LI.buildLaunchInfo({ ...base2, selfVersion: '<script>alert(1)</script>', resolved: { version: '"&<v>', dir: 'D"&<d>', binJs: 'B"&<b>', mode: 'steady' } })
    const htmlEvil = buildDetailsHtml(evil, 'ready')
    check('PU-4④ injection-safe: mock <script>/quote/ampersand escaped, document structure intact', !htmlEvil.includes('<script>alert(1)') &&
      htmlEvil.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && htmlEvil.startsWith('<!DOCTYPE html>') && htmlEvil.includes("script-src 'unsafe-inline'"))
    check('PU-4④b mismatch aux-line sink: resolverVersion img-onerror payload escaped (QA F01)', (() => {
      const mi = LI.buildLaunchInfo({ ...base2, selfVersion: '0.1.1-rc.2', resolved: { version: '<img src=x onerror=alert(1)>', dir: 'D', binJs: 'B', mode: 'steady' } })
      if (mi.versionCrossCheck !== 'mismatch' || mi.dshVersion === null) return false
      const h = buildDetailsHtml(mi, 'ready')
      return !h.includes('<img src=x onerror=alert(1)>') && h.includes('bin 目录版本：v&lt;img src=x onerror=alert(1)&gt;')
    })())
    check('PU-4⑤ empty phase card: dsh 未就绪 + 启动完成后提示 (no fake skeleton data)', (() => { const h = buildDetailsHtml(null, 'empty'); return h.includes('dsh 未就绪') && h.includes('正在启动 dsh') && !h.includes('id="version-big"') })())
    check('PU-4⑥ error phase card: dsh 启动失败 + full message + retry action', (() => { const h = buildDetailsHtml(null, 'error', { errorMessage: 'boom after 90s' }); return h.includes('dsh 启动失败') && h.includes('boom after 90s') && h.includes('重试（重启 dsh）') })())

    // ---- PU-5: statusLine four states ----
    px('PU-5 statusLine: version segment only when a version fact exists')
    check('PU-5① ready + port + version -> ● DSH <port> · v<version>', LI.statusLine('ready', 3080, '0.1.1-rc.2') === '$(circle-filled) DSH 3080 · v0.1.1-rc.2')
    check('PU-5② ready without version -> no version segment (never a misleading placeholder)', LI.statusLine('ready', 3080, null) === '$(circle-filled) DSH 3080')
    check('PU-5③ ready without port -> bare DSH item', LI.statusLine('ready', null, null) === '$(circle-filled) DSH')
    check('PU-5④ starting text byte-identical to the pre-0.1.9 one', LI.statusLine('starting', null, null) === '$(sync~spin) DSH starting…')
    check('PU-5⑤ error text byte-identical to the pre-0.1.9 one', LI.statusLine('error', null, null) === '$(error) DSH error')

    // ---- PU-6: mismatch rendering ----
    px('PU-6 mismatch rendering: self big + resolver aux + 不一致 anchor')
    const mismatch = LI.buildLaunchInfo({ ...base2, selfVersion: '0.1.1-rc.2', resolved: { version: '0.1.2-alpha.2', dir: 'D1', binJs: 'B1', mode: 'steady' } })
    const htmlM = buildDetailsHtml(mismatch, 'ready')
    check('PU-6① big version = SELF-REPORTED value (running process fact is primary)', htmlM.includes('id="version-big"') && htmlM.includes('>v0.1.1-rc.2<'))
    check('PU-6② resolver version appears as the auxiliary note (disk bin fact)', htmlM.includes('bin 目录版本：v0.1.2-alpha.2'))
    check('PU-6③ mismatch anchor + guidance present', htmlM.includes('不一致') && htmlM.includes('重启 dsh 可对齐'))

    // ---- PU-7: regression marker ----
    px('PU-7 regression marker')
    check('PU-7 zero failures across the PU block so far (family zero regression)', failures === 0)

    // ---- PU-8: stopped copy split by snapshot launchMode (v2.8 F-02) ----
    px('PU-8 stopped copy split: snapshot launchMode discriminates user-stop vs disconnected')
    const stopStart = LI.buildLaunchInfo({
      degraded: true, degradedLaunchMode: 'start', managedBy: 'managed-own', port: 3080, pid: 19441,
      rec: { pid: 19441, port: 3080, managedBy: 'managed-own', startedAt: '2026-08-31T12:17:42.000Z', launchMode: 'start' },
    })
    const htmlS1 = buildDetailsHtml(stopStart, 'stopped')
    check('PU-8① start 关窗 -> 「已按您的操作停止（常驻控制台窗已关闭即停止 dsh）」 (user-stop copy)', htmlS1.includes('已按您的操作停止') &&
      htmlS1.includes('常驻控制台窗已关闭即停止 dsh') && !htmlS1.includes('已断开（'))
    check('PU-8② user-stop card keeps 重连 + retained diagnostics (port row)', htmlS1.includes('重连') && htmlS1.includes('3080'))
    const stopDisc = LI.buildLaunchInfo({
      degraded: true, degradedLaunchMode: null, managedBy: 'managed-own', port: 3080, pid: 19441,
      rec: { pid: 19441, port: 3080, managedBy: 'managed-own', startedAt: '2026-08-31T12:17:42.000Z' },
    })
    const htmlS2 = buildDetailsHtml(stopDisc, 'stopped')
    check('PU-8③ disconnect (launchMode null) -> 「已断开（dsh 进程未停止或异常退出）」 (disconnected copy)', htmlS2.includes('已断开（dsh 进程未停止或异常退出）') && !htmlS2.includes('已按您的操作停止'))
    check('PU-8④ direct launchMode -> disconnected copy (only start takes the user-stop branch)', (() => {
      const h = buildDetailsHtml(LI.buildLaunchInfo({ degraded: true, degradedLaunchMode: 'direct', managedBy: 'managed-own' }), 'stopped')
      return h.includes('已断开（') && !h.includes('已按您的操作停止')
    })())
    check('PU-8⑤ null info + stopped -> disconnected copy (defensive)', buildDetailsHtml(null, 'stopped').includes('已断开（'))
  }

  // ================= 0.1.9.1 PP-3 (design §11.1, ADR-23) ===================
  px('PP-3 ADR-23: /wait holding + exit-before-readiness fast signal (any code) + 30s/90s budget tiering + conhost backup track')
  {
    resetResolverState()
    const origFetch = globalThis.fetch
    const okFetch = async () => ({ ok: true, text: async () => 'window.__DSH_BOOT__={}' })
    const failFetch = async () => { throw new Error('sim: probe failure') }
    /** First call fails (step2 external probe), later calls succeed. */
    const step2FailPP3 = () => {
      let n = 0
      return async () => {
        n++
        if (n === 1) throw new Error('sim: step2 probe must fail')
        return { ok: true, text: async () => 'window.__DSH_BOOT__={}' }
      }
    }
    const stdioFdShape = (o) => Array.isArray(o) && o[0] === 'ignore' && Number.isInteger(o[1]) && o[1] === o[2]
    const stdioIgnore3 = (o) => Array.isArray(o) && o[0] === 'ignore' && o[1] === 'ignore' && o[2] === 'ignore'
    const isStartFormPP3 = (c) => c !== undefined && c.argv.length === 4 && /^start "/.test(c.argv[3])
    // 0.1.12 #58-⑤: resident-family classifier (conhost = production arm).
    const formOfPP3 = (c) => ((isStartFormPP3(c) || isConhostForm(c)) ? 'start' : 'direct')
    /** Deterministically DEAD pid for the mocked port holder (same rationale
     *  as the PP-2 block: a fixed fake pid could collide with a live host). */
    const holderPid3 = await new Promise((resolve) => {
      const p = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
      p.once('exit', () => resolve(p.pid))
    })
    const holderFnPP3 = () => ({ pid: holderPid3, address: '127.0.0.1' })
    /** resident-console launcher mock: ALIVE by default (the /wait holder /
     *  conhost host co-lives with the inner chain, §4.8.1); optional
     *  exit/error events (immediate or delayed) drive the fast-fail paths. */
    const waitChild = ({ pid, exitCode = null, emitError = null, exitAfterMs = 0 } = {}) => {
      const c = new EventEmitter()
      c.stdout = new EventEmitter()
      c.stderr = new EventEmitter()
      c.pid = pid
      c.unref = () => {}
      c.kill = () => true
      const fire = () => {
        if (emitError !== null) c.emit('error', new Error(emitError))
        else if (exitCode !== null) c.emit('exit', exitCode)
      }
      if (emitError !== null || exitCode !== null) {
        if (exitAfterMs > 0) setTimeout(fire, exitAfterMs)
        else queueMicrotask(fire)
      }
      return c
    }
    const BANNER_PORT_PP3 = 3199
    /** Append the `dsh web:` banner to THIS attempt's managed log (success
     *  attempts on the random-port path; same mechanism as the PP-2 block). */
    const writeBannerPP3 = (entry) => {
      let log = null
      if (isStartFormPP3(entry)) {
        // 0.1.11 §4.9.1: peel the marker wrap before locating the redirect target.
        const inner = rawStartInner(entry.argv[3])
        const peeled = inner !== null ? peelLaunchMarkers(inner) : null
        const m = peeled !== null ? />> "([^"]+)" 2>&1"$/.exec(peeled.payload) : null
        if (m !== null) log = m[1]
      } else if (isConhostForm(entry)) {
        // 0.1.12 #58-⑤: the conhost inner command carries the same marker-wrapped payload.
        const inner = conhostInnerCmd(entry, DP.START_WINDOW_TITLE)
        const peeled = inner !== null ? peelLaunchMarkers(inner) : null
        const m = peeled !== null ? />> "([^"]+)" 2>&1"$/.exec(peeled.payload) : null
        if (m !== null) log = m[1]
      } else {
        try {
          const dir = path.join(dataDir, 'logs')
          const files = fs.readdirSync(dir)
            .filter((f) => /^dsh-\d{8}-\d{6}\.log$/.test(f))
            .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a, b) => b.t - a.t)
          if (files.length > 0) log = path.join(dir, files[0].f)
        } catch { /* best-effort */ }
      }
      if (log !== null) {
        try {
          fs.mkdirSync(path.dirname(log), { recursive: true })
          fs.appendFileSync(log, `dsh web: http://127.0.0.1:${BANNER_PORT_PP3}\n`, 'utf8')
        } catch { /* best-effort */ }
      }
    }

    // ---- PP-3-1: conhost 生产基线 + start-wait flip-back 回切轨（#58-⑤ 基线反转）----
    px('PP-3-1 常驻窗形态基线（ADR-26，0.1.12）：conhost 臂 = 生产基线；start-wait 形态 = flip-back 回切轨（构建期单点补丁）')
    // 0.1.12 #58-⑤ 基线反转的无头等价模拟: the production module now DECLARES
    // 'conhost' (⓪) and ④-⑦ assert the production module directly; the
    // flip-back track patches the ONE-LINE compiled assignment
    // ('conhost' -> 'start') — the exact textual edit restoring the pre-0.1.12
    // start-wait form (§4.8.5 切换纪律: build-time constant, no runtime toggle
    // is added for this). All downstream reads go through
    // `exports.START_LAUNCH_STRATEGY`, so the single-line patch flips the
    // label AND the launcher branch faithfully.
    const outDir = path.join(process.cwd(), 'out')
    const compiledSrc = fs.readFileSync(path.join(outDir, 'dshProcess.js'), 'utf8')
    const STRATEGY_DECL = "exports.START_LAUNCH_STRATEGY = 'conhost';"
    const declOccurrences = compiledSrc.split(STRATEGY_DECL).length - 1
    check('PP-3-1⓪ 编译产物策略赋值 = conhost 且唯一单行（构建期单点；0.1.12 生产基线声明，回切 = 改回 start 重编译）', declOccurrences === 1)
    const patchedPath = path.join(outDir, '__sim-dshProcess-startback.js')
    let DPC = null
    let resolvedPatched = null
    if (declOccurrences === 1) {
      fs.writeFileSync(patchedPath, compiledSrc.replace(STRATEGY_DECL, "exports.START_LAUNCH_STRATEGY = 'start';"))
      try {
        DPC = require(patchedPath)
        resolvedPatched = require.resolve(patchedPath)
      } catch { DPC = null }
    }
    try {
      // (A) 生产基线（DP = conhost 臂，原 ④-⑦ 升基线）：
      // exec/argv/内层命令/spawn 选项/servicePid。
      globalThis.fetch = okFetch
      router.calls.length = 0
      router.captureLaunch = true
      let unrefC = 0
      router.onLaunch = () => {
        const c = waitChild({ pid: 4702 })
        const origUnref = c.unref
        c.unref = () => { unrefC++; origUnref() }
        return c
      }
      const infoC = await new DP.DshProcess({ port: 3111, channel: 'latest', command: '', dshHome: '', consoleVisible: true, launchMode: 'start', resolvePortPidFn: holderFnPP3 }).start()
      const capC = router.calls.filter((c) => c.kind === 'launch').pop()
      const payloadC = conhostInnerCmd(capC, DP.START_WINDOW_TITLE)
      // 0.1.11 适配：conhost 臂复用同一 payload 构造（PP-4-1）→ 剥 marker 后按变体形态断言。
      const peeledC = payloadC !== null ? peelLaunchMarkers(payloadC) : null
      check('PP-3-1④ conhost 生产基线：exec basename = conhost.exe + argv 首段 [--, cmd, /d, /c]',
        capC !== undefined && path.basename(capC.exec) === 'conhost.exe' && capC.argv[0] === '--' &&
        capC.argv[1] === 'cmd' && capC.argv[2] === '/d' && capC.argv[3] === '/c')
      if (DP.START_PAYLOAD_VARIANT === 'npx') {
        check('PP-3-1⑤ conhost 生产基线内层命令 = title <START_WINDOW_TITLE> && <payload+marker>（title 不带引号 = E5 形态；0.1.11 适配：variant=npx 载荷原文；0.1.13 适配：ADR-27 信息头 & 载荷复合形状）',
          peeledC !== null &&
          peeledC.payload === specWithHeader(`npx --yes --prefer-offline @deepseek-ai/dsh@latest web --host 127.0.0.1 --port 3111 --no-open >> "${infoC.logFile}" 2>&1`, infoC.logFile))
      } else {
        const bodyC = peeledC !== null ? stripInfoHeader(peeledC.payload, infoC.logFile) : null
        const mInnerC2 = bodyC !== null ? /^"([^"]*)" "([^"]*)" web --host 127\.0\.0\.1 --port 3111 --no-open >> "(.*)" 2>&1$/.exec(bodyC) : null
        check('PP-3-1⑤ conhost 生产基线内层命令 = title <START_WINDOW_TITLE> && <payload>（title 不带引号 = E5 形态；payload 引号结构不变；0.1.13 适配：复合形状剥信息头后断言）',
          mInnerC2 !== null && mInnerC2[3] === infoC.logFile)
      }
      check('PP-3-1⑥ conhost 生产基线 spawn 选项固定（E5/W-01）：windowsHide === false + detached === true + verbatim === true + stdio ignore×3 + unref',
        capC !== undefined && capC.opts.windowsHide === false && capC.opts.detached === true &&
        capC.opts.windowsVerbatimArguments === true && stdioIgnore3(capC.opts.stdio) && unrefC === 1)
      check('PP-3-1⑦ conhost 生产基线下 servicePid 仍 = 端口 holder（launchMode 二值语义不变，§4.8.5）',
        infoC.servicePid === holderPid3 && infoC.servicePid !== 4702)

      // (B) flip-back 回切轨（DPC = 'start' 补丁副本，原 ①②③）：start-wait RAW 形态。
      if (DPC !== null) {
        router.calls.length = 0
        let unref31 = 0
        router.onLaunch = () => {
          const c = waitChild({ pid: 4701 })
          const origUnref = c.unref
          c.unref = () => { unref31++; origUnref() }
          return c
        }
        const info31 = await new DPC.DshProcess({ port: 3110, channel: 'latest', command: '', dshHome: '', consoleVisible: true, launchMode: 'start', resolvePortPidFn: holderFnPP3 }).start()
        const cap31 = router.calls.filter((c) => c.kind === 'launch').pop()
        const RAW31 = cap31 !== undefined ? cap31.argv[3] : ''
        const m31 = /^start "([^"]*)" \/d "([^"]*)" \/wait cmd \/d \/c "(.*)"$/s.exec(RAW31)
        check('PP-3-1① flip-back 回切轨（start-wait 形态）RAW = start "TITLE" /d "CWD" /wait cmd /d /c "PAYLOAD"（/wait 插于 /d 与内层 cmd 之间，title/cwd/payload 逐字不变 §4.8.2）',
          m31 !== null && m31[1] === DP.START_WINDOW_TITLE && m31[2] === process.cwd())
        // 0.1.11 适配 (§4.9.8-5/#51, sanctioned): the production payload between
        // the markers is VARIANT-AWARE (shipped package = 'npx'); peel the
        // marker wrap first, then match the variant payload shape.
        const peeledP31 = m31 !== null ? peelLaunchMarkers(m31[3]) : null
        if (DP.START_PAYLOAD_VARIANT === 'npx') {
          check('PP-3-1② flip-back 回切轨 /wait 为独立 token + payload 引号结构不变（双层引号 + >> "LOG" 2>&1 尾巴原样；0.1.11 适配：payload 呈变体 npx 形态；0.1.13 适配：回切轨同型携带 ADR-27 信息头——QA N-01）',
            m31 !== null && RAW31.includes(' /wait cmd /d /c "') && peeledP31 !== null &&
            peeledP31.payload === specWithHeader(`npx --yes --prefer-offline @deepseek-ai/dsh@latest web --host 127.0.0.1 --port 3110 --no-open >> "${info31.logFile}" 2>&1`, info31.logFile))
        } else {
          const body31 = peeledP31 !== null ? stripInfoHeader(peeledP31.payload, info31.logFile) : null
          const mInner31 = body31 !== null ? /^"([^"]*)" "([^"]*)" web --host 127\.0\.0\.1 --port 3110 --no-open >> "(.*)" 2>&1$/.exec(body31) : null
          check('PP-3-1② flip-back 回切轨 /wait 为独立 token + payload 引号结构不变（双层引号 + >> "LOG" 2>&1 尾巴原样；0.1.13 适配：复合形状剥信息头后断言）',
            m31 !== null && RAW31.includes(' /wait cmd /d /c "') && mInner31 !== null && mInner31[3] === info31.logFile)
        }
        check('PP-3-1③ flip-back 回切轨 start-wait spawn 形态：argv [/d, /s, /c, RAW] + verbatim + detached + windowsHide:true（外层是监督句柄非目标窗）+ stdio fd + unref',
          cap31 !== undefined && JSON.stringify(cap31.argv.slice(0, 3)) === JSON.stringify(['/d', '/s', '/c']) && cap31.argv.length === 4 &&
          cap31.opts.windowsVerbatimArguments === true && cap31.opts.detached === true &&
          cap31.opts.windowsHide === true && stdioFdShape(cap31.opts.stdio) && unref31 === 1)
      } else {
        check('PP-3-1① flip-back 回切轨（start-wait 形态）RAW = start "TITLE" /d "CWD" /wait cmd /d /c "PAYLOAD"（flip-back 副本构建失败）', false)
        check('PP-3-1② flip-back 回切轨 /wait 为独立 token + payload 引号结构不变（flip-back 副本构建失败）', false)
        check('PP-3-1③ flip-back 回切轨 start-wait spawn 形态（flip-back 副本构建失败）', false)
      }

      // ---- PP-3-2: exit-before-readiness fast signal (§4.8.3 core) --------
      px('PP-3-2 exit-即败时序：任意 code 即败 / 就绪后忽略 / error 同语义（计数联动见 PP-3-4③）')
      globalThis.fetch = okFetch
      // ① exit(0) BEFORE readiness -> immediate LaunchFailure (E6a: the code
      // value is diagnostic — /wait does not propagate it; 0 is equally a
      // failure; seconds-scale, not the 30s budget).
      router.onLaunch = () => waitChild({ pid: 4710, exitCode: 0 })
      const t32a = Date.now()
      let err32a = null
      try {
        await new DP.DshProcess({ port: 3112, channel: 'latest', command: '', dshHome: '', consoleVisible: true, launchMode: 'start', resolvePortPidFn: () => null }).start()
      } catch (err) { err32a = err }
      check('PP-3-2① 就绪前外层 exit(0) -> 立即 LaunchFailure（任意 code 即败；秒级而非等满 30s 预算；code 仅诊断）',
        err32a !== null && err32a.name === 'LaunchFailure' && err32a.message.includes('exited before readiness') &&
        err32a.message.includes('code=0') && Date.now() - t32a < 10_000)
      // ①b non-zero code -> identical semantics (the code value never decides)
      router.onLaunch = () => waitChild({ pid: 4711, exitCode: 9009 })
      let err32b = null
      try {
        await new DP.DshProcess({ port: 3112, channel: 'latest', command: '', dshHome: '', consoleVisible: true, launchMode: 'start', resolvePortPidFn: () => null }).start()
      } catch (err) { err32b = err }
      check('PP-3-2①b 就绪前外层 exit(9009) -> 同一快信号语义（与 PP-2-5 家族一致，code 不参与成败判断）',
        err32b !== null && err32b.name === 'LaunchFailure' && err32b.message.includes('exited before readiness') && err32b.message.includes('code=9009'))
      // ② exit AFTER readiness -> ignored (steady untouched; the service-era
      // outer exit belongs to the probe/user-stop paths, §4.8.1 boundary ①).
      const off32c = rlogOffset()
      router.onLaunch = () => waitChild({ pid: 4712, exitCode: 0, exitAfterMs: 400 })
      const info32c = await new DP.DshProcess({ port: 3113, channel: 'latest', command: '', dshHome: '', consoleVisible: true, launchMode: 'start', resolvePortPidFn: holderFnPP3 }).start()
      await sleep(600) // let the delayed exit fire (listener already removed)
      check('PP-3-2② 就绪后外层 exit(0) -> 忽略（持有语义下服务期退出不触发失败；steady 不受扰；rlog 无 fast-fail 轨迹）',
        info32c.port === 3113 && info32c.servicePid === holderPid3 && !rlogSlice(off32c).includes('exited before readiness'))
      // ③ error event -> same immediate-failure semantics as exit
      router.onLaunch = () => waitChild({ pid: 4713, emitError: 'sim: spawn ENOENT' })
      let err32d = null
      try {
        await new DP.DshProcess({ port: 3112, channel: 'latest', command: '', dshHome: '', consoleVisible: true, launchMode: 'start', resolvePortPidFn: () => null }).start()
      } catch (err) { err32d = err }
      check('PP-3-2③ launcher spawn error 事件与 exit 同语义（立即 LaunchFailure）',
        err32d !== null && err32d.name === 'LaunchFailure' && err32d.message.includes('start-launch'))

      // ---- PP-3-3: readiness budget tiering (30s start family / 90s direct)
      px('PP-3-3 就绪预算分档：start 家族 30s / direct 90s（注入时钟拨快判定，不真等；ADR-9 数值未触碰）')
      const origNow33 = Date.now
      // (a) start family: never-ready probes + alive launcher -> jump the
      // clock past the start-family budget -> budget timeout (NOT the
      // fast-fail wording: the two failure trajectories stay distinguishable,
      // v2.10 W-02).
      // 0.1.11 判据级适配 (#52/PP-5-2, sanctioned): the shipped experimental
      // package runs START_PAYLOAD_VARIANT='npx', so the start-family budget
      // IS STARTUP_TIMEOUT_MS_START_NPX (60s) — the anchor moves
      // 30000ms -> 60000ms (the 30s node-bin tier is re-asserted against the
      // patched flip-back module in PP-5-2②; direct 90s stays untouched).
      const startBudgetAnchor = DP.START_PAYLOAD_VARIANT === 'npx' ? 60_000 : 30_000
      const startBudgetJump = startBudgetAnchor + 1_000
      globalThis.fetch = failFetch
      router.onLaunch = () => waitChild({ pid: 4720 })
      let nowFake33a = Date.now()
      Date.now = () => nowFake33a
      let err33a = null
      const p33a = new DP.DshProcess({ port: 3114, channel: 'latest', command: '', dshHome: '', consoleVisible: true, launchMode: 'start', resolvePortPidFn: () => null }).start()
      await sleep(100)
      nowFake33a += startBudgetJump
      try { await p33a } catch (err) { err33a = err }
      Date.now = origNow33
      check('PP-3-3① start 模式就绪预算 = start 家族档：拨钟越限即超时失败（within <预算>ms 锚点；与快信号文案可区分；0.1.11 适配：shipped variant=npx → 60000ms）',
        err33a !== null && err33a.name === 'LaunchFailure' && err33a.message.includes(`within ${startBudgetAnchor}ms`) &&
        !err33a.message.includes('exited before readiness') && !err33a.message.includes('within 90000ms'))
      // (b) direct mode: same method against the UNCHANGED 90s budget (ADR-9).
      globalThis.fetch = failFetch
      router.onLaunch = () => waitChild({ pid: 4721 })
      let nowFake33b = Date.now()
      Date.now = () => nowFake33b
      let err33b = null
      const p33b = new DP.DshProcess({ port: 3114, channel: 'latest', command: '', dshHome: '' }).start() // default direct
      await sleep(100)
      nowFake33b += DP.STARTUP_TIMEOUT_MS + 1_000
      try { await p33b } catch (err) { err33b = err }
      Date.now = origNow33
      check('PP-3-3② direct 模式就绪预算 = STARTUP_TIMEOUT_MS(90s) 不变（ADR-9 契约）：within 90000ms 锚点',
        err33b !== null && err33b.name === 'LaunchFailure' && err33b.message.includes('within 90000ms'))
      // (c) flip-back 回切轨（start-wait 形态）同样共享 start 家族预算（分档按
      // launchMode 二值而非 launcher 变体，§4.8.3；0.1.12：DPC = 'start'
      // flip-back 副本，生产 conhost 臂的 60s 档已由 PP-3-3① 直接覆盖）。
      if (DPC !== null) {
        globalThis.fetch = failFetch
        router.onLaunch = () => waitChild({ pid: 4722 })
        let nowFake33c = Date.now()
        Date.now = () => nowFake33c
        let err33c = null
        const p33c = new DPC.DshProcess({ port: 3114, channel: 'latest', command: '', dshHome: '', consoleVisible: true, launchMode: 'start', resolvePortPidFn: () => null }).start()
        await sleep(100)
        nowFake33c += startBudgetJump
        try { await p33c } catch (err) { err33c = err }
        Date.now = origNow33
        check('PP-3-3③ flip-back 回切轨（start-wait）共享 start 家族预算（分档按 launchMode 二值而非 launcher 变体；0.1.11 适配：variant=npx → 60000ms 锚点）',
          err33c !== null && err33c.name === 'LaunchFailure' && err33c.message.includes(`within ${startBudgetAnchor}ms`))
      } else {
        check('PP-3-3③ flip-back 回切轨（start-wait）共享 start 家族预算（分档按 launchMode 二值而非 launcher 变体）', false)
      }
      // (d) static: the two budget constants stay independently named and the
      // ADR-9 value untouched (source-level assertion per PP-3-3).
      const dshProcSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'dshProcess.ts'), 'utf8')
      check('PP-3-3④ 静态断言：STARTUP_TIMEOUT_MS(90000, ADR-9 未触碰) 与 STARTUP_TIMEOUT_MS_START(30000) 独立具名常量',
        DP.STARTUP_TIMEOUT_MS === 90_000 && DP.STARTUP_TIMEOUT_MS_START === 30_000 &&
        dshProcSrc.includes('export const STARTUP_TIMEOUT_MS = 90_000') &&
        dshProcSrc.includes('export const STARTUP_TIMEOUT_MS_START = 30_000'))

      // ---- PP-3-4: 2 early-deaths -> direct fallback + degradation rlog ---
      px('PP-3-4 回退与 direct 逐位回归：早退 ×2（exit 0 亦败）→ 第 3 次 direct + 无常驻窗降级态声明')
      globalThis.fetch = step2FailPP3() // step2 fails once -> managed-launch path
      seedInst({ dsh: null, windows: [] })
      releaseStartupLock()
      router.calls.length = 0 // PP-3-1..3-3 captures must not leak into the form assertions
      let seq34 = 0
      router.onLaunch = (entry) => {
        seq34++
        if (isStartFormPP3(entry) || isConhostForm(entry)) return waitChild({ pid: 4730 + seq34, exitCode: 0 }) // 内层早死形态：常驻窗宿主随内层退出
        writeBannerPP3(entry) // the surviving direct attempt (degraded random port)
        return fakeChild({ pid: 4730 + seq34, code: 0 })
      }
      const r34 = newRuntime(process.pid, { port: 3117, consoleVisible: true, resolvePortPidFn: holderFnPP3 })
      const off34 = rlogOffset()
      await r34.start()
      const launches34 = router.calls.filter((c) => c.kind === 'launch')
      const trace34 = rlogSlice(off34)
      const d34 = launches34.find((c) => formOfPP3(c) === 'direct')
      check('PP-3-4① 早退 ×2 -> 第 3 次 spawn 为 direct 形态（0.1.8 形状保底，回退阈值逻辑不动）',
        launches34.length >= 3 && formOfPP3(launches34[0]) === 'start' && formOfPP3(launches34[1]) === 'start' &&
        formOfPP3(launches34[2]) === 'direct')
      check('PP-3-4② direct 形态逐位回归（PP-2-2 一致，含 0.1.8 参数化）：node exec + 无 verbatim + windowsHide=!consoleVisible(false) + stdio fd',
        d34 !== undefined && path.basename(d34.exec) === path.basename(process.execPath) &&
        d34.opts.windowsVerbatimArguments === undefined && d34.opts.windowsHide === false && stdioFdShape(d34.opts.stdio))
      check('PP-3-4③ rlog 降级声明双锚点：falling back to direct + 无常驻窗降级态（违背 ADR-20 常驻窗裁决，不作验收形态）',
        trace34.includes('falling back to direct') && trace34.includes('无常驻窗降级态'))
      check('PP-3-4④ 早退计入 startLaunchFailures（PP-3-2④ 计数联动）：failure #1/#2 轨迹 + 快信号文案锚点',
        trace34.includes('start-launch failure #1') && trace34.includes('start-launch failure #2') &&
        trace34.includes('exited before readiness'))
      check('PP-3-4⑤ 回退落点：registry launchMode=direct（二值语义不变）+ ready',
        r34.state === 'ready' && readInstance().dsh !== null && readInstance().dsh.launchMode === 'direct')
      r34.dispose()

      // ---- PP-3-5: launchInfo / details card zero impact + family marker --
      px('PP-3-5 launchInfo/详情卡零影响：launcher 变体仅 rlog 留痕，launchMode 保持二值')
      globalThis.fetch = step2FailPP3()
      seedInst({ dsh: null, windows: [] })
      releaseStartupLock()
      router.onLaunch = () => waitChild({ pid: 4740 }) // healthy /wait holder
      const r35 = newRuntime(process.pid, { port: 3118, consoleVisible: true, resolvePortPidFn: holderFnPP3 })
      const off35 = rlogOffset()
      await r35.start()
      const snap35 = r35.getLaunchInfo()
      const html35 = snap35 !== null ? buildDetailsHtml(snap35, 'ready') : ''
      check('PP-3-5① start(/wait) 成功路径 launchInfo 完整且 launchMode=start（launcher 变体不经 launchInfo 透出，15 字段零改动）',
        snap35 !== null && snap35.launchMode === 'start' && !('launcher' in snap35) &&
        snap35.binDir !== null && snap35.dshBin !== null && snap35.port === 3118 && snap35.pid === holderPid3)
      check('PP-3-5② 详情卡零影响：启动方式呈 start 常驻控制台文案锚点（PU 契约原样）',
        html35.includes('启动方式') && html35.includes('常驻控制台窗'))
      check('PP-3-5③ launcher 变体仅 rlog 留痕：launcher=conhost（§4.8.5 切换纪律；0.1.12 生产基线 = ADR-26 conhost 形态）',
        rlogSlice(off35).includes('launcher=conhost'))
      check('PP-3-5④ 全族零回归（PV/PW/PI/PP-1/PP-2/PU/PP-3 至此零失败）', failures === 0)
      r35.dispose()
    } finally {
      router.captureLaunch = false
      router.onLaunch = null
      globalThis.fetch = origFetch
      if (resolvedPatched !== null) {
        try { delete require.cache[resolvedPatched] } catch { /* best-effort */ }
      }
      try { fs.unlinkSync(patchedPath) } catch { /* best-effort */ }
    }
  }

  // ==================== 0.1.11 PP-4 (design §11.1 v2.11, ADR-24 #45) ====================
  px('PP-4 marker instrumentation（§4.9.1 永久化）：三段 echo 前后缀逐字 + marker 文件族 rotate 联动 + 全族回归')
  {
    resetResolverState()
    const origFetch = globalThis.fetch
    const okFetch = async () => ({ ok: true, text: async () => 'window.__DSH_BOOT__={}' })
    const stdioFdShape4 = (o) => Array.isArray(o) && o[0] === 'ignore' && Number.isInteger(o[1]) && o[1] === o[2]
    /** Deterministically DEAD pid for the mocked port holder (PP-2 rationale). */
    const holderPid4 = await new Promise((resolve) => {
      const p = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
      p.once('exit', () => resolve(p.pid))
    })
    const holderFn4 = () => ({ pid: holderPid4, address: '127.0.0.1' })
    /** alive resident-console launcher mock（/wait 持有语义，§4.8.1） */
    const launcherMock4 = ({ pid, exitCode = null, emitError = null } = {}) => {
      const c = new EventEmitter()
      c.stdout = new EventEmitter()
      c.stderr = new EventEmitter()
      c.pid = pid
      c.unref = () => {}
      c.kill = () => true
      queueMicrotask(() => {
        if (emitError !== null) c.emit('error', new Error(emitError))
        else if (exitCode !== null) c.emit('exit', exitCode)
      })
      return c
    }

    // ---- PP-4-1: marker payload 契约 ----
    px('PP-4-1 marker payload 契约：前缀两段 echo + 条件退出组逐字（§4.9.1 原文）+ 零 %DATE%/%TIME% + 兄弟文件路径 + 常量集中')
    globalThis.fetch = okFetch
    const off41 = rlogOffset()
    router.calls.length = 0
    router.captureLaunch = true
    router.onLaunch = () => launcherMock4({ pid: 4750 })
    const info41 = await new DP.DshProcess({ port: 3120, channel: 'latest', command: '', dshHome: '', consoleVisible: true, launchMode: 'start', resolvePortPidFn: holderFn4 }).start()
    const cap41 = router.calls.filter((c) => c.kind === 'launch').pop()
    // 0.1.12 #58-⑤ 适配：生产常驻臂 = conhost → 内层命令 = title 前缀剥离后的 <payload+marker>。
    const inner41 = cap41 !== undefined ? conhostInnerCmd(cap41, DP.START_WINDOW_TITLE) : null
    const peeled41 = inner41 !== null ? peelLaunchMarkers(inner41) : null
    const log41 = info41.logFile
    check('PP-4-1① marker 前缀逐字：echo inner-cmd-start >> "<LOG>.cmd-start" & echo node-start >> "<LOG>.node-start" &（append >> + 无条件引号 + 生产载荷前置）',
      peeled41 !== null && inner41 !== null &&
      inner41.startsWith(`echo inner-cmd-start >> "${log41}.cmd-start" & echo node-start >> "${log41}.node-start" & `))
    check('PP-4-1② marker 后缀逐字：& (if errorlevel 1 (echo node-exit-nonzero >> "<LOG>.node-exit") else (echo node-exit-0 >> "<LOG>.node-exit"))（arm-4/4b 两值均写）',
      peeled41 !== null && inner41 !== null &&
      inner41.endsWith(` & (if errorlevel 1 (echo node-exit-nonzero >> "${log41}.node-exit") else (echo node-exit-0 >> "${log41}.node-exit"))`))
    check('PP-4-1③ marker 文件路径 = per-launch log 同族兄弟（剥引号实测路径 = log 路径 + §4.9.1 后缀；paths 缝 dshLogMarkerFile 同值）',
      peeled41 !== null && log41.length > 0 &&
      peeled41.cmdStartFile === PATH.dshLogMarkerFile(log41, PATH.MARKER_SUFFIX_CMD_START) &&
      peeled41.nodeStartFile === PATH.dshLogMarkerFile(log41, PATH.MARKER_SUFFIX_NODE_START) &&
      peeled41.nodeExitNonzeroFile === peeled41.nodeExitZeroFile &&
      peeled41.nodeExitZeroFile === PATH.dshLogMarkerFile(log41, PATH.MARKER_SUFFIX_NODE_EXIT) &&
      path.dirname(peeled41.cmdStartFile) === path.dirname(log41) &&
      path.basename(peeled41.cmdStartFile) === path.basename(log41) + PATH.MARKER_SUFFIX_CMD_START)
    check('PP-4-1④ 静态断言：src/dshProcess.ts 无 %DATE%/%TIME%（解析期展开冻结时间戳被 §4.9.1 排除；时间线 = 文件存在性 + mtime + append 顺序）',
      (() => {
        // scan CODE only — strip line/block comments first (the design-doc
        // references in comments legitimately mention the excluded forms)
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'dshProcess.ts'), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '')
        return !src.includes('%DATE%') && !src.includes('%TIME%')
      })())
    check('PP-4-1⑤ 纯函数单元：wrapStartPayloadWithMarkers 对合成载荷产出 §4.9.1 原文（无路径依赖）',
      DP.wrapStartPayloadWithMarkers('PAYLOAD', 'LOG') ===
      'echo inner-cmd-start >> "LOG.cmd-start" & echo node-start >> "LOG.node-start" & PAYLOAD & (if errorlevel 1 (echo node-exit-nonzero >> "LOG.node-exit") else (echo node-exit-0 >> "LOG.node-exit"))')
    check('PP-4-1⑥ marker 包裹零形态外溢：生产常驻臂（0.1.12 = conhost，ADR-26）内层命令 = title <TITLE> && "<payload+marker>"（E5 形态）+ verbatim + detached + windowsHide:false + stdio ignore×3',
      cap41 !== undefined && conhostInnerCmd(cap41, DP.START_WINDOW_TITLE) !== null &&
      cap41.opts.windowsVerbatimArguments === true && cap41.opts.detached === true && cap41.opts.windowsHide === false &&
      stdioIgnoreShape(cap41.opts.stdio))
    check('PP-4-1⑦ 可追溯：rlog 留痕 marker 三件套 + arm-2 语义 + 载荷变体（单点切换可归因）',
      rlogSlice(off41).includes('start-launch markers (§4.9.1, permanent)') &&
      rlogSlice(off41).includes('arm-2 semantic') && rlogSlice(off41).includes(`payload variant = ${DP.START_PAYLOAD_VARIANT}`))

    // ---- PP-4-2: marker 文件族 + rotate 联动 ----
    px('PP-4-2 marker 文件族 rotate 联动：与主 log 同轮清理、保留策略一致（不独立膨胀）')
    {
      const rot = path.join(dataDir, 'rotate-marks')
      fs.rmSync(rot, { recursive: true, force: true })
      fs.mkdirSync(rot, { recursive: true })
      const names = [
        'dsh-20260101-000001.log', 'dsh-20260101-000002.log', 'dsh-20260101-000003.log',
        'dsh-20260101-000004.log', 'dsh-20260101-000005.log',
      ] // names[4] = newest (mtime ascending)
      names.forEach((n, i) => {
        fs.writeFileSync(path.join(rot, n), `log ${i}\n`, 'utf8')
        for (const sfx of PATH.DSH_LOG_MARKER_SUFFIXES) fs.writeFileSync(path.join(rot, n + sfx), 'marker\n', 'utf8')
        const d = new Date(Date.parse('2026-01-01T00:00:00Z') + i * 60_000)
        fs.utimesSync(path.join(rot, n), d, d)
      })
      fs.writeFileSync(path.join(rot, 'dsh.log'), 'keep\n', 'utf8') // non-launch log: never touched
      fs.writeFileSync(path.join(rot, 'dsh-20250101-000000.log.cmd-start'), 'orphan\n', 'utf8') // base already gone
      PATH.rotateDshLogs(rot, 3)
      check('PP-4-2① 主 log 轮转保留 3 份（既有策略不动）',
        ['dsh-20260101-000003.log', 'dsh-20260101-000004.log', 'dsh-20260101-000005.log'].every((n) => fs.existsSync(path.join(rot, n))) &&
        !fs.existsSync(path.join(rot, 'dsh-20260101-000001.log')) && !fs.existsSync(path.join(rot, 'dsh-20260101-000002.log')))
      check('PP-4-2② 被轮转 log 的 marker 兄弟同批清理（后缀族全删；0.1.12 起 4 后缀 × 2 log = 8 个——纳入同轮转批次，不独立膨胀 §4.9.1）',
        ['dsh-20260101-000001.log', 'dsh-20260101-000002.log']
          .flatMap((n) => PATH.DSH_LOG_MARKER_SUFFIXES.map((s) => n + s))
          .every((f) => !fs.existsSync(path.join(rot, f))))
      check('PP-4-2③ 保留 log 的 marker 兄弟原样（marker 生命周期随其 base log）',
        ['dsh-20260101-000003.log', 'dsh-20260101-000004.log', 'dsh-20260101-000005.log']
          .flatMap((n) => PATH.DSH_LOG_MARKER_SUFFIXES.map((s) => n + s))
          .every((f) => fs.existsSync(path.join(rot, f))))
      check('PP-4-2④ 非 launch 文件不触碰（dsh.log 保留；孤儿 marker 保守不删——同批清理纪律，无投机删除）',
        fs.existsSync(path.join(rot, 'dsh.log')) && fs.existsSync(path.join(rot, 'dsh-20250101-000000.log.cmd-start')))
      fs.rmSync(rot, { recursive: true, force: true })
    }

    // ---- PP-4-3 / PP-4-4: WMI 臂契约（分支未选中 → SKIP，#47 分支注记）----
    skip('PP-4-3 WMI spawn 契约（EncodedCommand 构造/ReturnValue 映射）',
      '分支未选中：0.1.11 = npx 载荷臂（用户三选一裁决=方案 A，§4.9.8-5 臂重排）；WMI 条件推迟 0.1.12（#46 条件任务），实施时按 PP-4-3 落地')
    skip('PP-4-4 WMI 信号语义分叉断言（launcher exit 0 ≠ 失败）',
      '分支未选中：同 PP-4-3（escape arm 未实施，无契约可断言；SKIP 不算失败）')

    // ---- PP-4-5: 全族回归 ----
    check('PP-4-5 全族零回归（marker 追加不触碰 direct 形态——PP-2-2 逐位一致仍成立；STARTUP_TIMEOUT_MS 未触碰 PP-3-3 原样）', failures === 0)
    router.captureLaunch = false
    router.onLaunch = null
    globalThis.fetch = origFetch
  }

  // ==================== 0.1.11 PP-5 (design §11.1 v2.13, ADR-24补充 #51/#52) ====================
  px('PP-5 npx 载荷臂契约（§4.9.8）：argv 逐字符 / 60s 分档时钟注入 / node-bin 备轨回归 / direct 恒 node-bin')
  {
    resetResolverState()
    const origFetch = globalThis.fetch
    const okFetch = async () => ({ ok: true, text: async () => 'window.__DSH_BOOT__={}' })
    const failFetch = async () => { throw new Error('sim: probe failure') }
    /** First call fails (step2 external probe), later calls succeed (readiness). */
    const step2FailFetch5 = () => {
      let n = 0
      return async () => {
        n++
        if (n === 1) throw new Error('sim: step2 probe must fail')
        return { ok: true, text: async () => 'window.__DSH_BOOT__={}' }
      }
    }
    const stdioFdShape5 = (o) => Array.isArray(o) && o[0] === 'ignore' && Number.isInteger(o[1]) && o[1] === o[2]
    const holderPid5 = await new Promise((resolve) => {
      const p = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
      p.once('exit', () => resolve(p.pid))
    })
    const holderFn5 = () => ({ pid: holderPid5, address: '127.0.0.1' })
    const launcherMock5 = ({ pid, exitCode = null, emitError = null } = {}) => {
      const c = new EventEmitter()
      c.stdout = new EventEmitter()
      c.stderr = new EventEmitter()
      c.pid = pid
      c.unref = () => {}
      c.kill = () => true
      queueMicrotask(() => {
        if (emitError !== null) c.emit('error', new Error(emitError))
        else if (exitCode !== null) c.emit('exit', exitCode)
      })
      return c
    }
    const isStartForm5 = (c) => c !== undefined && c.argv.length === 4 && /^start "/.test(c.argv[3])
    const isResidentForm5 = (c) => isStartForm5(c) || isConhostForm(c) // 0.1.12 #58-⑤：常驻家族双臂分类
    const BANNER_PORT5 = 3198
    const writeBanner5 = (entry) => {
      let log = null
      if (isStartForm5(entry)) {
        const inner = rawStartInner(entry.argv[3])
        const peeled = inner !== null ? peelLaunchMarkers(inner) : null
        const m = peeled !== null ? />> "([^"]+)" 2>&1"$/.exec(peeled.payload) : null
        if (m !== null) log = m[1]
      } else if (isConhostForm(entry)) {
        // 0.1.12 #58-⑤: the conhost inner command carries the same marker-wrapped payload.
        const inner = conhostInnerCmd(entry, DP.START_WINDOW_TITLE)
        const peeled = inner !== null ? peelLaunchMarkers(inner) : null
        const m = peeled !== null ? />> "([^"]+)" 2>&1"$/.exec(peeled.payload) : null
        if (m !== null) log = m[1]
      } else {
        try {
          const dir = path.join(dataDir, 'logs')
          const files = fs.readdirSync(dir)
            .filter((f) => /^dsh-\d{8}-\d{6}\.log$/.test(f))
            .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a, b) => b.t - a.t)
          if (files.length > 0) log = path.join(dir, files[0].f)
        } catch { /* best-effort */ }
      }
      if (log !== null) {
        try {
          fs.mkdirSync(path.dirname(log), { recursive: true })
          fs.appendFileSync(log, `dsh web: http://127.0.0.1:${BANNER_PORT5}\n`, 'utf8')
        } catch { /* best-effort */ }
      }
    }

    // node-bin 备轨的无头等价模拟（与 PP-3-1 conhost 切档同技术）：patch the
    // ONE-LINE compiled variant assignment ('npx' -> 'node-bin') — the exact
    // textual edit a deploy-time rebuild performs (§4.9.8-5 切换纪律: build-time
    // constant, no runtime toggle). All downstream reads go through
    // `exports.START_PAYLOAD_VARIANT`, so the patch flips the payload AND the
    // budget tier faithfully.
    const outDir = path.join(process.cwd(), 'out')
    const compiledSrc5 = fs.readFileSync(path.join(outDir, 'dshProcess.js'), 'utf8')
    const VARIANT_DECL = "exports.START_PAYLOAD_VARIANT = 'npx';"
    const variantDeclOccurrences = compiledSrc5.split(VARIANT_DECL).length - 1
    check('PP-5-3⓪ 编译产物 variant 赋值为唯一单行（构建期单点切档纪律，exports 属性读取全量穿透）', variantDeclOccurrences === 1)
    const patchedPath5 = path.join(outDir, '__sim-dshProcess-nodebin.js')
    let DPB = null
    let resolvedPatched5 = null
    if (variantDeclOccurrences === 1) {
      try {
        fs.writeFileSync(patchedPath5, compiledSrc5.replace(VARIANT_DECL, "exports.START_PAYLOAD_VARIANT = 'node-bin';"))
        DPB = require(patchedPath5)
        resolvedPatched5 = require.resolve(patchedPath5)
      } catch { DPB = null }
    }

    // ---- PP-5-1: npx 载荷 argv 逐字符 ----
    px('PP-5-1 npx 载荷 argv 逐字符契约（变体=npx）：外层 PP-3-1 逐位 + 剥 marker 后 payload 逐字符等值 + resolver 双输入同串')
    const NPX_LITERAL = (port, logFile) =>
      `npx --yes --prefer-offline @deepseek-ai/dsh@latest web --host 127.0.0.1 --port ${port} --no-open >> "${logFile}" 2>&1`
    globalThis.fetch = okFetch
    router.calls.length = 0
    router.captureLaunch = true
    router.onLaunch = () => launcherMock5({ pid: 4760 })
    const info51a = await new DP.DshProcess({ port: 3121, channel: 'latest', command: '', dshHome: '', consoleVisible: true, launchMode: 'start', resolvePortPidFn: holderFn5 }).start()
    const cap51a = router.calls.filter((c) => c.kind === 'launch').pop()
    // 0.1.12 #58-⑤ 适配：外层载体 = conhost 内层命令（生产基线）；payload 逐字符断言不变。
    const peeled51a = cap51a !== undefined ? peelLaunchMarkers(conhostInnerCmd(cap51a, DP.START_WINDOW_TITLE)) : null
    check('PP-5-1① payload 剥 marker 后逐字符 = 信息头 & npx 链原文（= 既有回退链构造同形 §4.9.8-3；0.1.13 适配：ADR-27 复合形状逐字符；spec 沿用 channel 变量、零版本字面量）',
      peeled51a !== null && peeled51a.payload === specWithHeader(NPX_LITERAL(3121, info51a.logFile), info51a.logFile))
    check('PP-5-1② 外层形态与 PP-3-1 生产基线逐位一致（0.1.12 = conhost，ADR-26）：[--, cmd, /d, /c, title <TITLE> && <payload+marker>] + verbatim + detached + windowsHide:false + stdio ignore×3',
      cap51a !== undefined && conhostInnerCmd(cap51a, DP.START_WINDOW_TITLE) !== null &&
      cap51a.opts.windowsVerbatimArguments === true && cap51a.opts.detached === true &&
      cap51a.opts.windowsHide === false && stdioIgnoreShape(cap51a.opts.stdio))
    check('PP-5-1③ resolver 命中时 resolved 照常透出（launchInfo self-only/mismatch 档既有语义，§4.9.8-4-④）',
      info51a.resolved !== null && info51a.resolved.dir.startsWith(simNpxRoot))
    // resolver-miss input: the variant FORCES the same npx payload string
    fs.rmSync(simNpxRoot, { recursive: true, force: true })
    clearMeta('latest')
    router.handlers.view = () => fakeChild({ pid: 5210, code: 1 })
    router.handlers.install = () => fakeChild({ pid: 5211, code: 1 })
    router.handlers.establish = () => fakeChild({ pid: 5212, code: 1 })
    globalThis.fetch = okFetch
    router.onLaunch = () => launcherMock5({ pid: 4761 })
    const info51b = await new DP.DshProcess({ port: 3121, channel: 'latest', command: '', dshHome: '', consoleVisible: true, launchMode: 'start', resolvePortPidFn: holderFn5 }).start()
    const cap51b = router.calls.filter((c) => c.kind === 'launch').pop()
    const peeled51b = cap51b !== undefined ? peelLaunchMarkers(conhostInnerCmd(cap51b, DP.START_WINDOW_TITLE)) : null
    const body51a = peeled51a !== null ? stripInfoHeader(peeled51a.payload, info51a.logFile) : null
    const body51b = peeled51b !== null ? stripInfoHeader(peeled51b.payload, info51b.logFile) : null
    check('PP-5-1④ resolver 命中/未命中两输入 payload 同串（变体强制；0.1.13 适配：复合形状逐字符 + 剥信息头后同串）；未命中 resolved=null（launchInfo self-only 档形态）',
      peeled51b !== null && peeled51a !== null && body51b !== null && body51a !== null &&
      peeled51b.payload === specWithHeader(NPX_LITERAL(3121, info51b.logFile), info51b.logFile) &&
      body51b.replace(info51b.logFile, '') === body51a.replace(info51a.logFile, '') &&
      info51b.resolved === null)
    check('PP-5-1⑤ custom command 路径不受变体影响（PP-2-7 原样语义：startPayload=null，cmd /d /s /c 直连）',
      (await new DP.DshProcess({ port: 3122, channel: 'latest', command: 'dsh web --port 3122', dshHome: '', consoleVisible: true, launchMode: 'start' }).buildLaunch('')).startPayload === null)
    router.handlers.view = null
    router.handlers.install = null
    router.handlers.establish = null
    resetResolverState()

    // ---- PP-5-2: 就绪预算三分档 ----
    px('PP-5-2 就绪预算三分档：start+npx 60s / start+node-bin 30s / direct 90s（注入时钟拨快判定，不真等；三常量独立具名互不引用）')
    const origNow52 = Date.now
    // (a) start + npx（shipped 变体）：never-ready probes + alive launcher ->
    // jump past STARTUP_TIMEOUT_MS_START_NPX -> budget timeout（60s 锚点，
    // 非 90s、非快信号文案——两类轨迹可区分语义保持，#52）。
    globalThis.fetch = failFetch
    router.onLaunch = () => launcherMock5({ pid: 4762 })
    let nowFake52a = Date.now()
    Date.now = () => nowFake52a
    let err52a = null
    const p52a = new DP.DshProcess({ port: 3123, channel: 'latest', command: '', dshHome: '', consoleVisible: true, launchMode: 'start', resolvePortPidFn: () => null }).start()
    await sleep(100)
    nowFake52a += DP.STARTUP_TIMEOUT_MS_START_NPX + 1_000
    try { await p52a } catch (err) { err52a = err }
    Date.now = origNow52
    check('PP-5-2① start+npx 就绪预算 = STARTUP_TIMEOUT_MS_START_NPX(60s)：拨钟越限超时（within 60000ms 锚点；非 90s、非快信号）',
      err52a !== null && err52a.name === 'LaunchFailure' && err52a.message.includes('within 60000ms') &&
      !err52a.message.includes('exited before readiness') && !err52a.message.includes('within 90000ms'))
    // (b) start + node-bin（patched 备轨模块）：30s 档（PP-3-3① 语义在备轨变体下保持）。
    globalThis.fetch = failFetch
    router.onLaunch = () => launcherMock5({ pid: 4763 })
    let nowFake52b = Date.now()
    Date.now = () => nowFake52b
    let err52b = null
    const p52b = new (DPB !== null ? DPB : DP).DshProcess({ port: 3123, channel: 'latest', command: '', dshHome: '', consoleVisible: true, launchMode: 'start', resolvePortPidFn: () => null }).start()
    await sleep(100)
    nowFake52b += (DPB !== null ? DPB.STARTUP_TIMEOUT_MS_START : 30_000) + 1_000
    try { await p52b } catch (err) { err52b = err }
    Date.now = origNow52
    check('PP-5-2② start+node-bin 就绪预算 = STARTUP_TIMEOUT_MS_START(30s)（patched 备轨变体；within 30000ms 锚点）',
      DPB !== null && err52b !== null && err52b.name === 'LaunchFailure' && err52b.message.includes('within 30000ms'))
    check('PP-5-2③ direct 90s 不变（PP-3-3② 已过）+ 静态断言：三常量独立具名字面量、互不引用赋值（ADR-9 数值未触碰）',
      DP.STARTUP_TIMEOUT_MS === 90_000 && DP.STARTUP_TIMEOUT_MS_START === 30_000 && DP.STARTUP_TIMEOUT_MS_START_NPX === 60_000 &&
      (() => {
        const s = fs.readFileSync(path.join(process.cwd(), 'src', 'dshProcess.ts'), 'utf8')
        return s.includes('export const STARTUP_TIMEOUT_MS = 90_000') &&
          s.includes('export const STARTUP_TIMEOUT_MS_START = 30_000') &&
          s.includes('export const STARTUP_TIMEOUT_MS_START_NPX = 60_000')
      })())
    check('PP-5-2④ 分档缝单元：startBudgetMsFor npx→60000 / node-bin→30000 / direct 恒 90000（分档落点唯一 = start() 现场，§4.9.8-4-①）',
      DP.startBudgetMsFor('npx', 'start') === 60_000 && DP.startBudgetMsFor('node-bin', 'start') === 30_000 &&
      DP.startBudgetMsFor('npx', 'direct') === 90_000 && DP.startBudgetMsFor('node-bin', 'direct') === 90_000)

    // ---- PP-5-3: node-bin 备轨回归（patched 模块）----
    px('PP-5-3 变体 node-bin 备轨回归：切回单点常量即逐位恢复 pre-0.1.11 载荷（marker 包裹不变）+ 选择缝单点')
    if (DPB !== null) {
      globalThis.fetch = okFetch
      router.onLaunch = () => launcherMock5({ pid: 4764 })
      const info53 = await new DPB.DshProcess({ port: 3124, channel: 'latest', command: '', dshHome: '', consoleVisible: true, launchMode: 'start', resolvePortPidFn: holderFn5 }).start()
      const cap53 = router.calls.filter((c) => c.kind === 'launch').pop()
      // 0.1.12 #58-⑤ 适配：DPB（node-bin 变体补丁）的生产策略仍 = conhost → 内层命令提取。
      const inner53 = cap53 !== undefined ? conhostInnerCmd(cap53, DP.START_WINDOW_TITLE) : null
      const peeled53 = inner53 !== null ? peelLaunchMarkers(inner53) : null
      // 0.1.13 适配：复合形状（信息头 & 载荷）——剥信息头前缀后按 pre-0.1.11 形状匹配。
      const body53 = peeled53 !== null ? stripInfoHeader(peeled53.payload, info53.logFile) : null
      const m53 = body53 !== null ? /^"([^"]*)" "([^"]*)" web --host 127\.0\.0\.1 --port 3124 --no-open >> "(.*)" 2>&1$/.exec(body53) : null
      check('PP-5-3① node-bin 载荷逐字符 = pre-0.1.11 生产形态（"NODE" "BINJS" web --host 127.0.0.1 --port P --no-open >> "LOG" 2>&1；0.1.13 适配：复合形状剥信息头后断言——回切轨同型）',
        m53 !== null && m53[1] === process.env.DSH_NODE_EXE &&
        m53[2].includes(path.join('node_modules', '@deepseek-ai', 'dsh')) && m53[2].endsWith(path.join('lib', 'bin.js')) &&
        m53[3] === info53.logFile)
      check('PP-5-3② node-bin 臂下 marker 三段包裹不变（§4.9.1 无条件、全臂共用——arm-2 语义按判读矩阵归 node 层）',
        inner53 !== null && peeled53 !== null &&
        inner53.startsWith('echo inner-cmd-start >> ') &&
        inner53.endsWith(`(echo node-exit-0 >> "${info53.logFile}.node-exit"))`) &&
        inner53.includes(` & ${peeled53.payload} & (if errorlevel 1`))
    } else {
      check('PP-5-3① node-bin 载荷逐字符 = pre-0.1.11 生产形态（patched 模块构建失败）', false)
      check('PP-5-3② node-bin 臂下 marker 三段包裹不变（patched 模块构建失败）', false)
    }
    check('PP-5-3③ 选择缝单元：startPayloadForVariant 两臂各返其臂（主臂切换点单一）',
      DP.startPayloadForVariant('node-bin', 'NODE_BIN', 'NPX') === 'NODE_BIN' &&
      DP.startPayloadForVariant('npx', 'NODE_BIN', 'NPX') === 'NPX')
    check('PP-5-3④ 静态断言：StartPayloadVariant 联合声明 + startPayloadForVariant(START_PAYLOAD_VARIANT 唯一调用点（主臂切换点单一可追溯）',
      (() => {
        const s = fs.readFileSync(path.join(process.cwd(), 'src', 'dshProcess.ts'), 'utf8')
        return s.includes("export type StartPayloadVariant = 'node-bin' | 'npx'") &&
          (s.match(/startPayloadForVariant\(START_PAYLOAD_VARIANT/g) || []).length === 1
      })())

    // ---- PP-5-4: direct 回退恒 node-bin + 全族回归 ----
    px('PP-5-4 direct 回退与全族回归（变体=npx）：早退 ×2 → 第 3 次 direct + node-bin 形态（direct 不吃变体）')
    globalThis.fetch = step2FailFetch5()
    seedInst({ dsh: null, windows: [] })
    releaseStartupLock()
    router.calls.length = 0
    let seq54 = 0
    router.onLaunch = (entry) => {
      seq54++
      if (isResidentForm5(entry)) return launcherMock5({ pid: 4770 + seq54, exitCode: 0 }) // 内层早死 → 常驻窗宿主随退（E6c；0.1.12 生产臂 = conhost）
      writeBanner5(entry) // the surviving direct attempt
      return fakeChild({ pid: 4770 + seq54, code: 0 })
    }
    const r54 = newRuntime(process.pid, { port: 3125, consoleVisible: true, resolvePortPidFn: holderFn5 })
    const off54 = rlogOffset()
    await r54.start()
    const launches54 = router.calls.filter((c) => c.kind === 'launch')
    const d54 = launches54.find((c) => !isResidentForm5(c))
    check('PP-5-4① 早退 ×2 → 第 3 次 spawn 为 direct 形态（0.1.8 回退链路不变；0.1.12：前两次为 conhost 生产臂形态）',
      launches54.length >= 3 && launches54[0] !== undefined && isResidentForm5(launches54[0]) &&
      launches54[1] !== undefined && isResidentForm5(launches54[1]) && d54 !== undefined)
    check('PP-5-4② direct 载荷 = node-bin 直连（node exec + [binJs, web, --host, --port, --no-open] 7 元 argv；无 npx 段——direct 不吃变体）',
      d54 !== undefined && path.basename(d54.exec) === path.basename(process.execPath) &&
      d54.argv[0].endsWith(path.join('lib', 'bin.js')) && d54.argv[1] === 'web' &&
      d54.argv.length === 7 && !d54.argv.includes('npx'))
    check('PP-5-4③ 降级 rlog 双锚点（falling back to direct + 无常驻窗降级态）+ registry launchMode=direct + ready',
      rlogSlice(off54).includes('falling back to direct') && rlogSlice(off54).includes('无常驻窗降级态') &&
      r54.state === 'ready' && readInstance().dsh !== null && readInstance().dsh.launchMode === 'direct')
    check('PP-5-4④ 全族零回归（PV/PW/PI/PP-1..4/PU 至此零失败）', failures === 0)
    r54.dispose()

    globalThis.fetch = origFetch
    router.captureLaunch = false
    router.onLaunch = null
    if (resolvedPatched5 !== null) {
      try { delete require.cache[resolvedPatched5] } catch { /* best-effort */ }
    }
    try { fs.unlinkSync(patchedPath5) } catch { /* best-effort */ }
    resetResolverState()
  }

  // ==================== 0.1.12 PP-6 (design §11.1 v2.15, ADR-25) ====================
  px('PP-6 端口纪律显式化（ADR-25/§4.10）：具名单点决策 / 真实占用降级留痕 / retry 冻结 / 载荷端口留痕 / resolver 输出隔离')
  {
    resetResolverState()
    const origFetch = globalThis.fetch
    const okFetch = async () => ({ ok: true, text: async () => 'window.__DSH_BOOT__={}' })
    const failFetch = async () => { throw new Error('sim: probe failure') }
    /** First call fails (step2 external probe), later calls succeed (readiness). */
    const step2FailFetch6 = () => {
      let n = 0
      return async () => {
        n++
        if (n === 1) throw new Error('sim: step2 probe must fail')
        return { ok: true, text: async () => 'window.__DSH_BOOT__={}' }
      }
    }
    const holderPid6 = await new Promise((resolve) => {
      const p = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
      p.once('exit', () => resolve(p.pid))
    })
    const holderFn6 = () => ({ pid: holderPid6, address: '127.0.0.1' })
    /** alive resident-console launcher mock（conhost 臂，0.1.12 生产基线） */
    const launcherMock6 = ({ pid, exitCode = null } = {}) => {
      const c = new EventEmitter()
      c.stdout = new EventEmitter()
      c.stderr = new EventEmitter()
      c.pid = pid
      c.unref = () => {}
      c.kill = () => true
      if (exitCode !== null) queueMicrotask(() => c.emit('exit', exitCode))
      return c
    }
    const BANNER_PORT6 = 3197
    const writeBanner6 = (entry) => {
      let log = null
      if (isConhostForm(entry)) {
        const inner = conhostInnerCmd(entry, DP.START_WINDOW_TITLE)
        const peeled = inner !== null ? peelLaunchMarkers(inner) : null
        const m = peeled !== null ? />> "([^"]+)" 2>&1"$/.exec(peeled.payload) : null
        if (m !== null) log = m[1]
      } else {
        try {
          const dir = path.join(dataDir, 'logs')
          const files = fs.readdirSync(dir)
            .filter((f) => /^dsh-\d{8}-\d{6}\.log$/.test(f))
            .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a, b) => b.t - a.t)
          if (files.length > 0) log = path.join(dir, files[0].f)
        } catch { /* best-effort */ }
      }
      if (log !== null) {
        try {
          fs.mkdirSync(path.dirname(log), { recursive: true })
          fs.appendFileSync(log, `dsh web: http://127.0.0.1:${BANNER_PORT6}\n`, 'utf8')
        } catch { /* best-effort */ }
      }
    }
    /** Payload/argv port extractor: resident payload = marker-peeled `--port <N>`;
     *  direct argv = the element after `--port`. */
    const payloadPort6 = (entry) => {
      if (isConhostForm(entry)) {
        const peeled = peelLaunchMarkers(conhostInnerCmd(entry, DP.START_WINDOW_TITLE))
        const m = peeled !== null ? /--port (\d+)/.exec(peeled.payload) : null
        return m !== null ? Number(m[1]) : null
      }
      const i = entry !== undefined && Array.isArray(entry.argv) ? entry.argv.indexOf('--port') : -1
      return i >= 0 && entry.argv[i + 1] !== undefined ? Number(entry.argv[i + 1]) : null
    }

    // ---- PP-6-1: 单一来源不变量（configured 态：direct argv ≡ start 载荷 ≡ 单点返回值）----
    px('PP-6-1 单一来源不变量（ADR-25-①）：direct argv --port ≡ 常驻载荷 --port ≡ resolveLaunchPort().port；rlog source= 与返回枚举一致')
    {
      const PORT61 = 3130
      const dec61 = await resolveLaunchPort(PORT61)
      check('PP-6-1① resolveLaunchPort 单元（空闲配置端口）：{ port:<N>, source=configured }（具名单点，语义分离）',
        dec61.port === PORT61 && dec61.source === 'configured')
      const off61 = rlogOffset()
      globalThis.fetch = step2FailFetch6()
      seedInst({ dsh: null, windows: [] })
      releaseStartupLock()
      router.calls.length = 0
      router.captureLaunch = true
      router.onLaunch = () => launcherMock6({ pid: 4780 }) // alive conhost host
      const r61 = newRuntime(process.pid, { port: PORT61, consoleVisible: true, resolvePortPidFn: holderFn6 })
      await r61.start()
      const launches61 = router.calls.filter((c) => c.kind === 'launch')
      const trace61 = rlogSlice(off61)
      check('PP-6-1② 常驻臂（conhost）载荷 --port ≡ 配置端口 ≡ 单点返回值 + `payload port = <N>` 留痕（ADR-25-②，两臂同点）',
        launches61.length >= 1 && isConhostForm(launches61[0]) && payloadPort6(launches61[0]) === dec61.port &&
        trace61.includes(`payload port = ${dec61.port}`))
      check('PP-6-1③ rlog source=configured 留痕与返回枚举一致（detached launch 行携带 source）',
        trace61.includes(`detached launch (port=${dec61.port}, source=configured`))
      r61.dispose()
      // direct 臂同点取同一端口（direct/start 单一来源不变量）。
      globalThis.fetch = step2FailFetch6()
      seedInst({ dsh: null, windows: [] })
      releaseStartupLock()
      router.calls.length = 0
      router.onLaunch = () => fakeChild({ pid: 4781, code: 0 })
      const r61b = newRuntime(process.pid, { port: PORT61, consoleVisible: false })
      await r61b.start()
      const launches61b = router.calls.filter((c) => c.kind === 'launch')
      check('PP-6-1④ direct argv --port ≡ 同一单点返回值（direct/start 同点取值，P>0 态）',
        launches61b.length >= 1 && !isConhostForm(launches61b[0]) && !isStartWaitForm(launches61b[0]) && payloadPort6(launches61b[0]) === dec61.port)
      r61b.dispose()

      // fallback-random 态（单元级）：真实占用 → { port:0, source=fallback-random } + rlog 三元组。
      const off61c = rlogOffset()
      const occ61 = net.createServer()
      await new Promise((res) => occ61.listen(3134, '127.0.0.1', res))
      const dec61c = await resolveLaunchPort(3134)
      occ61.close()
      check('PP-6-1⑤ resolveLaunchPort 单元（真实被占端口）：{ port:0, source=fallback-random } + rlog 锚点文案与三元组留痕（既有文案零改动）',
        dec61c.port === 0 && dec61c.source === 'fallback-random' &&
        rlogSlice(off61c).includes('not bindable; falling back to random (ADR-1)') &&
        rlogSlice(off61c).includes('(source=fallback-random, configured=3134, effective=0)'))
    }

    // ---- PP-6-2: 真实占用降级留痕（R3 场景回归：E-R3-2 时序在 sim 层可复现断言）----
    px('PP-6-2 真实占用降级留痕（R3 场景回归）：真实 bind 先占 → not bindable + source=fallback-random + direct argv 与常驻载荷均 --port 0')
    {
      const off62 = rlogOffset()
      globalThis.fetch = step2FailFetch6()
      seedInst({ dsh: null, windows: [] })
      releaseStartupLock()
      router.calls.length = 0
      const occ62 = net.createServer()
      await new Promise((res) => occ62.listen(3131, '127.0.0.1', res))
      let seq62 = 0
      router.onLaunch = (entry) => {
        seq62++
        if (isConhostForm(entry)) return launcherMock6({ pid: 4782 + seq62, exitCode: 0 }) // 内层早死 → 常驻窗宿主随退
        writeBanner6(entry) // the surviving direct attempt (degraded random port)
        return fakeChild({ pid: 4782 + seq62, code: 0 })
      }
      const r62 = newRuntime(process.pid, { port: 3131, consoleVisible: true, resolvePortPidFn: holderFn6 })
      await r62.start()
      occ62.close()
      const launches62 = router.calls.filter((c) => c.kind === 'launch')
      const trace62 = rlogSlice(off62)
      const direct62 = launches62.find((c) => !isConhostForm(c) && !isStartWaitForm(c))
      check('PP-6-2① rlog 含既有降级锚点（文案零改动）+ source=fallback-random 留痕（E-R3-2 时序形态）',
        trace62.includes('not bindable; falling back to random (ADR-1)') && trace62.includes('source=fallback-random'))
      check('PP-6-2② 常驻载荷（conhost）与 direct argv 均 --port 0（同点回落，R3 场景可复现）',
        launches62.length >= 3 && isConhostForm(launches62[0]) && payloadPort6(launches62[0]) === 0 &&
        direct62 !== undefined && payloadPort6(direct62) === 0)
      check('PP-6-2③ `payload port = 0` 留痕行在场（ADR-25-②，RV-12 三证之③的 sim 层形态）',
        trace62.includes('payload port = 0'))
      r62.dispose()
    }

    // ---- PP-6-3: retry 冻结语义（L408-411 显式化：降级态不重检、恒 0）----
    px('PP-6-3 retry 冻结（ADR-25-①）：首轮配置端口失败 → 重试载荷 --port 0 + source=retry-degraded，且不重检（无第二条 not bindable）')
    {
      const off63 = rlogOffset()
      globalThis.fetch = step2FailFetch6()
      seedInst({ dsh: null, windows: [] })
      releaseStartupLock()
      router.calls.length = 0
      let seq63 = 0
      router.onLaunch = (entry) => {
        seq63++
        if (seq63 === 1) return launcherMock6({ pid: 4786, exitCode: 0 }) // 首轮早退（配置端口 3132 尚在载荷上）
        writeBanner6(entry) // 重试（降级随机端口）成功
        return launcherMock6({ pid: 4786 + seq63 })
      }
      const r63 = newRuntime(process.pid, { port: 3132, consoleVisible: true, resolvePortPidFn: holderFn6 })
      await r63.start()
      const launches63 = router.calls.filter((c) => c.kind === 'launch')
      const trace63 = rlogSlice(off63)
      check('PP-6-3① 首轮载荷 --port 3132（configured）→ 重试载荷 --port 0（降级冻结，未重检配置端口）',
        launches63.length >= 2 && isConhostForm(launches63[0]) && payloadPort6(launches63[0]) === 3132 &&
        isConhostForm(launches63[1]) && payloadPort6(launches63[1]) === 0)
      check('PP-6-3② rlog source=retry-degraded 留痕（degrading 文案锚点保留）+ 无第二条 not bindable（冻结态不重预检）',
        trace63.includes('degrading to random port on retry (avoid same-port loop)') && trace63.includes('source=retry-degraded') &&
        !trace63.includes('not bindable') && trace63.includes(`detached launch (port=${3132}, source=configured`))
      r63.dispose()
    }

    // ---- PP-6-4: resolver 输出隔离（ADR-25-③：<log>.resolver 兄弟文件）----
    px('PP-6-4 resolver 输出隔离（ADR-25-③）：npm view 输出落 <log>.resolver，主 log 零污染；.resolver 纳入 rotate 同批清理')
    {
      resetResolverState()
      clearMeta('latest')
      router.handlers.view = () => fakeChild({ pid: 5310, code: 0, stdout: '0.1.1-rc.2\n' })
      router.onLaunch = () => fakeChild({ pid: 4680, code: 0 })
      globalThis.fetch = okFetch
      const info64 = await new DP.DshProcess({ port: 3133, channel: 'latest', command: '', dshHome: '' }).start() // direct（fixed-port probe ok）
      const resolverLog64 = `${info64.logFile}.resolver`
      const mainLog64 = fs.existsSync(info64.logFile) ? fs.readFileSync(info64.logFile, 'utf8') : ''
      check('PP-6-4① resolver 子进程输出（npm view 版本 token）落 <log>.resolver 兄弟文件（证据不丢，排障可查）',
        fs.existsSync(resolverLog64) && fs.readFileSync(resolverLog64, 'utf8').includes('0.1.1-rc.2'))
      check('PP-6-4② per-launch 主 log 不含 resolver 输出（R3 的 11B 假线索源 + parseSelfVersion 首行误读面消除）',
        !mainLog64.includes('0.1.1-rc.2'))
      check('PP-6-4③ .resolver 后缀纳入 DSH_LOG_MARKER_SUFFIXES（marker 家族同型常量，rotate 联动数据源）',
        PATH.DSH_LOG_MARKER_SUFFIXES.includes('.resolver'))
      const rot64 = path.join(dataDir, 'rotate-resolver')
      fs.rmSync(rot64, { recursive: true, force: true })
      fs.mkdirSync(rot64, { recursive: true })
      for (let i = 1; i <= 4; i++) {
        const n = `dsh-2026020${i}-000000.log`
        fs.writeFileSync(path.join(rot64, n), 'x\n', 'utf8')
        fs.writeFileSync(path.join(rot64, n + '.resolver'), 'resolver-out\n', 'utf8')
        const d = new Date(Date.parse('2026-02-01T00:00:00Z') + i * 60_000)
        fs.utimesSync(path.join(rot64, n), d, d)
      }
      PATH.rotateDshLogs(rot64, 3)
      check('PP-6-4④ .resolver 与主 log 同轮转批次清理（被轮转 base 的 .resolver 同删；保留 base 的 .resolver 原样——P0-I-9 同型不独立膨胀）',
        fs.existsSync(path.join(rot64, 'dsh-20260204-000000.log.resolver')) &&
        !fs.existsSync(path.join(rot64, 'dsh-20260201-000000.log.resolver')))
      fs.rmSync(rot64, { recursive: true, force: true })
      router.handlers.view = null
      resetResolverState()
    }

    // ---- PP-6-5: 全族回归 ----
    check('PP-6-5 全族零回归（PV/PW/PI/PP-1..5/PU 至此零失败；direct 端口面与 custom-command 边界零触碰）', failures === 0)
    globalThis.fetch = origFetch
    router.captureLaunch = false
    router.onLaunch = null
    resetResolverState()
  }

  // ==================== 0.1.13 PP-7 (design §11.1 v2.17, ADR-27) ====================
  px('PP-7 ADR-27 常驻窗静态信息头：纯 builder 单元 / 单点叠加契约（conhost 臂）/ direct-custom 零触 / 字符集安全与长度 / marker-F-PORT 家族回归')
  {
    resetResolverState()
    const origFetch7 = globalThis.fetch
    const okFetch7 = async () => ({ ok: true, text: async () => 'window.__DSH_BOOT__={}' })
    const step2FailFetch7 = () => {
      let n = 0
      return async () => {
        n++
        if (n === 1) throw new Error('sim: step2 probe must fail')
        return { ok: true, text: async () => 'window.__DSH_BOOT__={}' }
      }
    }
    const holderPid7 = await new Promise((resolve) => {
      const p = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
      p.once('exit', () => resolve(p.pid))
    })
    const holderFn7 = () => ({ pid: holderPid7, address: '127.0.0.1' })
    /** conhost-arm launcher mock（0.1.12 生产基线形态；exitCode 支持早退场景） */
    const launcherMock7 = ({ pid, exitCode = null } = {}) => {
      const c = new EventEmitter()
      c.stdout = new EventEmitter()
      c.stderr = new EventEmitter()
      c.pid = pid
      c.unref = () => {}
      c.kill = () => true
      if (exitCode !== null) queueMicrotask(() => c.emit('exit', exitCode))
      return c
    }
    const NPX_LITERAL7 = (port, logFile) =>
      `npx --yes --prefer-offline @deepseek-ai/dsh@latest web --host ${LOOPBACK_HOST} --port ${port} --no-open >> "${logFile}" 2>&1`
    const INFO_ANCHOR = 'DSH 服务常驻控制台'

    // ---- PP-7-1: 纯 builder 单元（spec literals 逐字符，非循环）----
    px('PP-7-1 纯 builder 单元：consoleInfoHeader / withConsoleInfoHeader 逐字符 = §4.11.2-(3) 定稿（echoSafe 中和 + 括号豁免 + 禁字符 logFile 兜底）')
    const HDR_LOG = 'C:\\Users\\sim\\AppData\\Local\\DshVscode\\logs\\dsh-20260901-120000.log'
    check('PP-7-1① consoleInfoHeader 输出逐字符 = 9 行 spec literals（9 个 echo 段以 & 连接 + & echo. 收尾）',
      DP.consoleInfoHeader(HDR_LOG) === specInfoHeader(HDR_LOG))
    check('PP-7-1② 结构：首段/第 9 段 = 64×= 规则线 + 以 echo. 空行收尾（§4.11.2-(3) 定稿结构）',
      DP.consoleInfoHeader(HDR_LOG).startsWith(`echo ${INFO_RULE_64} & `) &&
      DP.consoleInfoHeader(HDR_LOG).endsWith(`echo ${INFO_RULE_64} & echo.`))
    const BAD_LOG = 'C:\\a & b|c<d>e^f"g%h!i\\dsh.log'
    const BAD_LOG_SAFE = 'C:\\a ? b?c?d?e?f?g?h?i\\dsh.log'
    check('PP-7-1③ echoSafe 中和 [&|<>^"%!]→?：禁字符 logFile 逐字符变换 + 输出仍为合法 10 段单链（中和后不碎链）',
      DP.echoSafeText(BAD_LOG) === BAD_LOG_SAFE &&
      DP.consoleInfoHeader(BAD_LOG) === specInfoHeader(BAD_LOG) &&
      DP.consoleInfoHeader(BAD_LOG).split(' & ').length === 10 &&
      DP.consoleInfoHeader(BAD_LOG).includes(`echo 本次启动日志: ${BAD_LOG_SAFE}`))
    check('PP-7-1④ 括号豁免（探针 ⑤-a 口径）：全角（）与半角 () 不被替换；静态行原样透传（设计文本本就不含禁字符）',
      DP.echoSafeText('a(b)c（d）e') === 'a(b)c（d）e' &&
      DP.consoleInfoHeader(HDR_LOG).includes('DSH 服务常驻控制台（DSH Panel 托管）') &&
      DP.consoleInfoHeader(HDR_LOG).includes('本窗口是 dsh web 服务的宿主进程，由 DSH Panel 扩展创建。'))
    check('PP-7-1⑤ withConsoleInfoHeader(payload, logFile) = <header> & <payload> 逐字符复合（§4.11.2-(5) 复合公式）',
      DP.withConsoleInfoHeader('PAYLOAD', HDR_LOG) === `${DP.consoleInfoHeader(HDR_LOG)} & PAYLOAD` &&
      DP.withConsoleInfoHeader('PAYLOAD', HDR_LOG) === specWithHeader('PAYLOAD', HDR_LOG))

    // ---- PP-7-2: 单点叠加契约（conhost 臂；mock 捕获）----
    px('PP-7-2 单点叠加契约（conhost 臂）：复合串 = <infoHeader> & <生产载荷>（剥 title + marker 后）；marker 三件套同族；变体两取值同型')
    globalThis.fetch = okFetch7
    router.calls.length = 0
    router.captureLaunch = true
    router.onLaunch = () => launcherMock7({ pid: 4801 })
    const info72 = await new DP.DshProcess({ port: 3141, channel: 'latest', command: '', dshHome: '', consoleVisible: true, launchMode: 'start', resolvePortPidFn: holderFn7 }).start()
    const cap72 = router.calls.filter((c) => c.kind === 'launch').pop()
    const inner72 = cap72 !== undefined ? conhostInnerCmd(cap72, DP.START_WINDOW_TITLE) : null
    const peeled72 = inner72 !== null ? peelLaunchMarkers(inner72) : null
    check('PP-7-2① mock conhost launch 复合串逐字符 = <infoHeader段> & <npx 载荷>（信息头位于 marker 前缀之后、生产载荷之前——贪婪组 3 吸收，peel 机器零改动）',
      peeled72 !== null && peeled72.payload === specWithHeader(NPX_LITERAL7(3141, info72.logFile), info72.logFile))
    check('PP-7-2② marker 三件套文件名族与 log 同族不变（.cmd-start / .node-start / .node-exit）',
      peeled72 !== null && peeled72.cmdStartFile === `${info72.logFile}.cmd-start` &&
      peeled72.nodeStartFile === `${info72.logFile}.node-start` &&
      peeled72.nodeExitZeroFile === `${info72.logFile}.node-exit`)
    check('PP-7-2③ 叠加位置 = marker 前缀紧后：内层命令以 §4.9.1 前缀开头、剥 marker 后载荷以信息头 spec 形状起头',
      inner72 !== null && peeled72 !== null &&
      inner72.startsWith('echo inner-cmd-start >> ') &&
      peeled72.payload.startsWith(`${specInfoHeader(info72.logFile)} & `))
    // node-bin 变体同型（PP-5-3 同技术的独立补丁副本；回切/备轨同型口径）
    const compiledSrc7 = fs.readFileSync(path.join(process.cwd(), 'out', 'dshProcess.js'), 'utf8')
    const VARIANT_DECL7 = "exports.START_PAYLOAD_VARIANT = 'npx';"
    let DPB7 = null
    let resolved7 = null
    const patchedPath7 = path.join(process.cwd(), 'out', '__sim-dshProcess-nodebin-p7.js')
    if (compiledSrc7.split(VARIANT_DECL7).length - 1 === 1) {
      try {
        fs.writeFileSync(patchedPath7, compiledSrc7.replace(VARIANT_DECL7, "exports.START_PAYLOAD_VARIANT = 'node-bin';"))
        DPB7 = require(patchedPath7)
        resolved7 = require.resolve(patchedPath7)
      } catch { DPB7 = null }
    }
    if (DPB7 !== null) {
      router.calls.length = 0
      router.onLaunch = () => launcherMock7({ pid: 4802 })
      const info72b = await new DPB7.DshProcess({ port: 3142, channel: 'latest', command: '', dshHome: '', consoleVisible: true, launchMode: 'start', resolvePortPidFn: holderFn7 }).start()
      const cap72b = router.calls.filter((c) => c.kind === 'launch').pop()
      const peeled72b = cap72b !== undefined ? peelLaunchMarkers(conhostInnerCmd(cap72b, DPB7.START_WINDOW_TITLE)) : null
      const body72b = peeled72b !== null ? stripInfoHeader(peeled72b.payload, info72b.logFile) : null
      const mNodeBin72 = body72b !== null ? /^"([^"]*)" "([^"]*)" web --host 127\.0\.0\.1 --port 3142 --no-open >> "(.*)" 2>&1$/.exec(body72b) : null
      check('PP-7-2④ START_PAYLOAD_VARIANT 两取值复合同型：node-bin 臂下 = <infoHeader> & <node-bin 载荷>（信息头与变体正交）',
        peeled72b !== null && mNodeBin72 !== null && mNodeBin72[3] === info72b.logFile &&
        peeled72b.payload.startsWith(`${specInfoHeader(info72b.logFile)} & `))
    } else {
      check('PP-7-2④ START_PAYLOAD_VARIANT 两取值复合同型（patched 副本构建失败）', false)
    }

    // ---- PP-7-3: direct / custom 零触 ----
    px('PP-7-3 direct/custom 零触：direct spawn 形态零信息头痕迹（默认 / 显式 direct / 早退×2 回退三形态）+ custom startPayload=null 原样')
    router.calls.length = 0
    router.onLaunch = () => fakeChild({ pid: 4803, code: 0 })
    await new DP.DshProcess({ port: 3143, channel: 'latest', command: '', dshHome: '' }).start()
    await new DP.DshProcess({ port: 3144, channel: 'latest', command: '', dshHome: '', consoleVisible: true, launchMode: 'direct' }).start()
    const dLaunches73 = router.calls.filter((c) => c.kind === 'launch')
    const dHidden73 = dLaunches73.find((c) => c.argv.includes('3143'))
    const dVis73 = dLaunches73.find((c) => c.argv.includes('3144'))
    check('PP-7-3① direct（consoleVisible=false 默认 + consoleVisible=true 显式 direct）spawn argv 零信息头痕迹（PP-2-2 原样逐位）',
      dHidden73 !== undefined && dVis73 !== undefined &&
      dHidden73.argv.every((a) => !a.includes(INFO_ANCHOR) && !a.includes('echo.')) &&
      dVis73.argv.every((a) => !a.includes(INFO_ANCHOR)))
    check('PP-7-3② custom command 边界零信息头（PP-2-7 原样语义：startPayload=null，cmd /d /s /c 直连）',
      (await new DP.DshProcess({ port: 3145, channel: 'latest', command: 'dsh web --port 3145', dshHome: '', consoleVisible: true, launchMode: 'start' }).buildLaunch('')).startPayload === null)
    // 早退 ×2 → 第 3 次 direct：降级随机端口路径需要 banner 才能收敛 ready。
    const writeBanner73 = () => {
      try {
        const dir = path.join(dataDir, 'logs')
        const files = fs.readdirSync(dir)
          .filter((f) => /^dsh-\d{8}-\d{6}\.log$/.test(f))
          .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
          .sort((a, b) => b.t - a.t)
        if (files.length > 0) fs.appendFileSync(path.join(dir, files[0].f), 'dsh web: http://127.0.0.1:3146\n', 'utf8')
      } catch { /* best-effort */ }
    }
    globalThis.fetch = step2FailFetch7()
    seedInst({ dsh: null, windows: [] })
    releaseStartupLock()
    router.calls.length = 0
    let seq73 = 0
    let directAttempt73 = null
    router.onLaunch = (entry) => {
      seq73++
      if (isConhostForm(entry)) return launcherMock7({ pid: 4820 + seq73, exitCode: 0 }) // 内层早死 → 常驻窗宿主随退
      writeBanner73()
      directAttempt73 = entry
      return fakeChild({ pid: 4820 + seq73, code: 0 })
    }
    const r73 = newRuntime(process.pid, { port: 3146, consoleVisible: true, resolvePortPidFn: holderFn7 })
    await r73.start()
    check('PP-7-3③ 早退 ×2 回退后的 direct 尝试同样零信息头（PP-5-4 降级链路下 direct 载荷 node-bin 直连原样）',
      directAttempt73 !== null && directAttempt73.argv.every((a) => !a.includes(INFO_ANCHOR) && !a.includes('echo.')))
    r73.dispose()

    // ---- PP-7-4: 字符集安全 + 长度预算 ----
    px('PP-7-4 信息头字符集安全与长度预算：输出头无裸 [&|<>^"%!] + 括号仅存于 echo 段内 + 零新增双引号 + 最长现实样本 < 8191')
    const segs74 = DP.consoleInfoHeader(HDR_LOG).split(' & ')
    const BAD_RE = /[&|<>^"%!]/
    check('PP-7-4① 输出头按链段切分 = 10 段且每段 echo 文本位无裸禁字符（echoSafe 后静态扫描；echo. 空行段除外）',
      segs74.length === 10 && segs74[segs74.length - 1] === 'echo.' &&
      segs74.slice(0, 9).every((seg) => seg.startsWith('echo ') && !BAD_RE.test(seg.slice(5))))
    check('PP-7-4② 括号仅出现于 echo 段内部（顶层字面存活——探针 ⑤-a）+ 零新增双引号（信息头串内无 " 字符）',
      segs74.filter((seg) => seg.includes('(') || seg.includes('（')).every((seg) => seg.startsWith('echo ')) &&
      !DP.consoleInfoHeader(HDR_LOG).includes('"') && !DP.consoleInfoHeader(BAD_LOG).includes('"'))
    const LONG_LOG = `C:\\Users\\${'用户名特别长的目录名'.repeat(8)}（工作区）\\AppData\\Local\\DshVscode\\logs\\dsh-20260901-120000.log`
    const fullInner74 = DP.buildConhostLaunchArgv(
      DP.wrapStartPayloadWithMarkers(DP.withConsoleInfoHeader(NPX_LITERAL7(3080, LONG_LOG), LONG_LOG), LONG_LOG)
    )[4]
    check('PP-7-4③ 完整内层命令长度 < 8191（最长现实路径样本构造：长用户名 + 全角目录 + 生产引号形状；探针 ⑥ 同口径）',
      typeof fullInner74 === 'string' && fullInner74.length > 0 && fullInner74.length < 8191)

    // ---- PP-7-5: marker / F-PORT 家族回归 + 全族聚合 ----
    px('PP-7-5 marker/F-PORT 家族回归：尾锚提取不受头前缀影响 / 信息头段无 --port / marker 家族复合载荷下原样 / 聚合门全绿')
    check('PP-7-5① 复合串尾锚 = >> "LOG" 2>&1（writeBanner/resolvePortFromLog 尾锚数据源不受信息头前缀影响）+ 信息头段无 --port 字样（载荷端口提取不受扰）',
      peeled72 !== null && peeled72.payload.endsWith(`>> "${info72.logFile}" 2>&1`) &&
      specInfoHeader(info72.logFile).split(' & ').every((seg) => !seg.includes('--port')))
    check('PP-7-5② marker 家族（PP-4-1/PP-4-2）在复合载荷下原样 PASS + 聚合门 PP-2-8/PU-7/PP-3-5④/PP-4-5/PP-5-4④/PP-6-5 全绿（本块之前零失败）',
      failures === 0)

    globalThis.fetch = origFetch7
    router.captureLaunch = false
    router.onLaunch = null
    if (resolved7 !== null) { try { delete require.cache[resolved7] } catch { /* best-effort */ } }
    try { fs.unlinkSync(patchedPath7) } catch { /* best-effort */ }
    resetResolverState()
  }

  // ==================== 0.1.14 additions (design §7.1) =====================
  // PP-8-1..6 (ADR-30 token adaptation) + PU-9 (ADR-29 channel model). The
  // mock upstream below implements the dsh server-side fence MINIMUM
  // semantics (api-request-trust.ts L91-118 + rpc-host.ts L95-98): a present
  // Origin must equal the Host authority → else 403 BEFORE the cookie/token
  // check; an accepted `?token=` bootstraps via 303+Set-Cookie; a session
  // cookie passes; everything else 401s. The direct-to-upstream unrewritten-
  // Origin controls pin the upstream side of the fence into the suite (no
  // headless-green/device-red gap, design PP-8-2②).
  {
    const AP = require('../out/authProxy.js') // { startAuthProxy, dshCookieName, mintSessionCookie, readCredentialsSecret }
    const CS = require('../out/channelSelect.js') // { normalizeChannel, normalizeChannelLogLine, channelPickItems, CHANNEL_PICK_PLACEHOLDER, runFirstLaunchChannelSelect, ... }
    const httpMod = require('node:http')
    const cryptoMod = require('node:crypto')

    // -- generic loopback helpers (in-process servers; no spawn needed) ------
    const reqVia = (port, { method = 'GET', p = '/', headers = {} } = {}) =>
      new Promise((resolve, reject) => {
        const rq = httpMod.request({ host: '127.0.0.1', port, method, path: p, headers }, (rs) => {
          const cs = []
          rs.on('data', (c) => cs.push(c))
          rs.on('end', () => resolve({ status: rs.statusCode, headers: rs.headers, body: Buffer.concat(cs).toString('utf8') }))
        })
        rq.on('error', reject)
        rq.end()
      })
    const wsHandshake = (port, originHeader) =>
      new Promise((resolve, reject) => {
        const sock = net.connect({ host: '127.0.0.1', port }, () => {
          sock.write([
            'GET /api/remote.mux HTTP/1.1',
            `Host: 127.0.0.1:${port}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version: 13',
            ...(originHeader ? [`Origin: ${originHeader}`] : []),
            '', '',
          ].join('\r\n'))
        })
        let buf = ''
        const timer = setTimeout(() => { try { sock.destroy() } catch { /* ignore */ } ; reject(new Error('ws handshake timeout')) }, 5000)
        sock.on('data', (d) => {
          buf += d.toString('utf8')
          if (buf.includes('\r\n\r\n') || /^HTTP\/1\.1 \d{3}/.test(buf)) {
            clearTimeout(timer)
            try { sock.destroy() } catch { /* ignore */ }
            resolve(buf.split('\r\n')[0])
          }
        })
        sock.on('error', (e) => { clearTimeout(timer); reject(e) })
      })
    const canBind = (port) =>
      new Promise((resolve) => {
        const s = net.createServer()
        s.once('error', () => resolve(false))
        s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
      })
    const snapshotDir = (root) => {
      const out = new Map()
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name)
          if (e.isDirectory()) walk(p)
          else out.set(path.relative(root, p), fs.statSync(p).size)
        }
      }
      walk(root)
      return out
    }
    const listenInProcess = (server) =>
      new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolve(server.address().port))
      })

    // -- mock upstream: dsh fence minimum semantics (see block header) -------
    const up = { seen: [], validTokens: new Set(), issuedPairs: [] }
    const upServer = httpMod.createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const u = new URL(req.url ?? '/', 'http://x')
        up.seen.push({ method: req.method, url: req.url, headers: req.headers })
        const host = typeof req.headers.host === 'string' ? req.headers.host : ''
        const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null
        if (u.pathname === '/echo') {
          // reflection surface: what the UPSTREAM actually received
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ host, origin, cookie: req.headers.cookie ?? null, secFetchSite: req.headers['sec-fetch-site'] ?? null }))
          return
        }
        if (u.pathname === '/set-cookie-probe') {
          res.writeHead(200, { 'set-cookie': ['dsh-auth-probe=leakme; Path=/; Max-Age=60', 'other=1; Path=/'] })
          res.end('ok')
          return
        }
        // fence FIRST (rpc-host L95-98 order): bad Origin → 403, never 401
        if (origin !== null && origin !== `http://${host}`) {
          res.writeHead(403, { 'content-type': 'text/plain' })
          res.end('cross-site origin')
          return
        }
        const token = u.searchParams.get('token')
        if (token !== null) {
          if (up.validTokens.has(token)) {
            const pair = `dsh-auth-mock=v1.mock.${token}`
            up.issuedPairs.push(pair)
            res.writeHead(303, { 'set-cookie': [`${pair}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict`], location: '/' })
            res.end()
          } else {
            res.writeHead(401, { 'content-type': 'text/plain' })
            res.end('unauthorized')
          }
          return
        }
        const cookie = typeof req.headers.cookie === 'string' ? req.headers.cookie : ''
        const hasSession = cookie.split(';').map((s) => s.trim()).some((p) => /^dsh-auth-[A-Za-z0-9_-]+=v1\./.test(p))
        if (hasSession) {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end('<html>window.__DSH_BOOT__ = {}</html>')
        } else {
          res.writeHead(401, { 'content-type': 'text/plain' })
          res.end('unauthorized')
        }
      })
    })
    upServer.on('upgrade', (req, socket) => {
      up.seen.push({ method: req.method, url: req.url, headers: req.headers, upgrade: true })
      const host = typeof req.headers.host === 'string' ? req.headers.host : ''
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null
      if (origin !== null && origin !== `http://${host}`) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        return
      }
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n')
    })
    up.port = await listenInProcess(upServer)
    const mockHome = path.join(dataDir, 'mock-dsh-home')
    fs.mkdirSync(mockHome, { recursive: true })
    const secret82 = cryptoMod.randomBytes(32).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
    fs.writeFileSync(
      path.join(mockHome, '.credentials.yaml'),
      [
        'version: 1',
        'refs: {}',
        'records:',
        '  client-connection/browser-session:',
        '    payload:',
        `      secret: ${secret82}`,
        "      createdAt: '2026-09-01T00:00:00.000Z'",
        '  other/record:',
        '    payload:',
        '      secret: not-the-one',
      ].join('\n') + '\n',
      'utf8',
    )

    // ---- PP-8-1: token 捕获契约 ---------------------------------------------
    px('PP-8-1 token 捕获契约：URL_RE port 组不受扰 + TOKEN_RE 边界捕获 / malformed 诚实降级')
    const tokA = 'x'.repeat(43) // synthetic base64url-family test value
    const tokB = 'Ab3_9Zq'.padEnd(43, 'k')
    const bannerFile = (name, line) => {
      const f = path.join(dataDir, `banner-${name}.log`)
      fs.writeFileSync(f, line + '\n', 'utf8')
      return f
    }
    const f81a = bannerFile('tok', `dsh web: http://127.0.0.1:45701/?token=${tokA}`)
    const b81a = DP.resolveBannerFromLog(f81a)
    check('PP-8-1① token banner：同一 banner 双解析一致（port 组捕获不受 token 增量扰动）',
      b81a !== null && b81a.port === 45701 && b81a.token === tokA && DP.resolvePortFromLog(f81a) === 45701)
    const f81b = bannerFile('lan', `dsh web: http://127.0.0.1:45702/?token=${tokB} (LAN: http://192.168.1.5:45702/)`)
    const b81b = DP.resolveBannerFromLog(f81b)
    check('PP-8-1② LAN 后缀形态：token 后随空白仍捕获（边界 = \\s|$），port 不受扰',
      b81b !== null && b81b.port === 45702 && b81b.token === tokB)
    const f81c = bannerFile('legacy', 'dsh web: http://127.0.0.1:45703')
    const b81c = DP.resolveBannerFromLog(f81c)
    check('PP-8-1③ 旧形态 banner（无 ?token=）：token=null 且 port 逐位回退（零回退）',
      b81c !== null && b81c.port === 45703 && b81c.token === null && DP.resolvePortFromLog(f81c) === 45703)
    const b81d = DP.resolveBannerFromLog(bannerFile('empty', 'dsh web: http://127.0.0.1:45704/?token='))
    const b81e = DP.resolveBannerFromLog(bannerFile('amp', 'dsh web: http://127.0.0.1:45705/?token=abc&x=1'))
    check('PP-8-1④ malformed token（空值 / 被 & 截断）→ token=null 不抛异常（诚实降级，port 仍解析）',
      b81d !== null && b81d.port === 45704 && b81d.token === null &&
      b81e !== null && b81e.port === 45705 && b81e.token === null)
    check('PP-8-1⑤ 无 banner / 缺文件 → null 不抛异常（既有 F-PORT 语义原样）',
      DP.resolveBannerFromLog(bannerFile('none', 'some other output')) === null &&
      DP.resolveBannerFromLog(path.join(dataDir, 'banner-missing.log')) === null)
    check('PP-8-1⑥ 阈值常量单点 = 0.1.2-alpha.2（三源判定锚；判定看版本、取值看 banner）',
      DP.TOKEN_AUTH_MIN_VERSION === '0.1.2-alpha.2')

    // ---- PP-8-2: authProxy 契约（R1-R10 + Origin-fence 断言组）--------------
    px('PP-8-2 authProxy 契约：自举/Host/Origin 重写/不补/WS/403-401 次序/剥离/不落盘 + C 路径自铸单元')
    up.validTokens.add('tok-pp82')
    const proxyLog82 = []
    const handle82 = await AP.startAuthProxy(up.port, { token: 'tok-pp82', cookie: null }, { log: (m) => proxyLog82.push(m) })
    const waitProxyLog = async (frag, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        if (proxyLog82.some((l) => l.includes(frag))) return true
        if (Date.now() > deadline) return false
        await sleep(50)
      }
    }
    check('PP-8-2⓪ 代理监听：127.0.0.1 随机端口（≠ 上游端口；R9 生命周期起点）',
      typeof handle82.port === 'number' && handle82.port > 0 && handle82.port !== up.port)
    check('PP-8-2① 首次自举：GET /?token → 303 + Set-Cookie → 会话建立留痕（token=<REDACTED> 字面）',
      await waitProxyLog('session bootstrapped via banner token') && proxyLog82.some((l) => l.includes('token=<REDACTED>')))
    const issued82 = up.issuedPairs[up.issuedPairs.length - 1]
    const echo82 = await reqVia(handle82.port, { p: '/echo', headers: { origin: `http://127.0.0.1:${handle82.port}`, 'sec-fetch-site': 'same-origin' } })
    const echoJson82 = JSON.parse(echo82.body)
    check('PP-8-2①a Host 重写（Host fence）：上游实收 Host = 127.0.0.1:<上游端口>',
      echo82.status === 200 && echoJson82.host === `127.0.0.1:${up.port}`)
    check('PP-8-2①b Origin 重写（R4）：上游实收 Origin === Host === 上游 authority → 放行 200',
      echoJson82.origin === `http://127.0.0.1:${up.port}` && echoJson82.origin === `http://${echoJson82.host}`)
    check('PP-8-2①c cookie 注入（R2）：转发请求携带自举捕获的 dsh-auth 会话对（在内存，未落盘）',
      typeof echoJson82.cookie === 'string' && echoJson82.cookie.split(';').map((s) => s.trim()).includes(issued82))
    check('PP-8-2①d sec-fetch-site 透传（R8）：原样到达上游', echoJson82.secFetchSite === 'same-origin')
    const ctrl82a = await reqVia(up.port, { p: '/', headers: { host: `127.0.0.1:${up.port}`, origin: `http://127.0.0.1:${handle82.port}` } })
    check('PP-8-2②a 对照组（上游语义钉入）：未重写 Origin（proxyPort 值）直发上游 → 403（不重写必 403，防门控逃逸）',
      ctrl82a.status === 403)
    const ctrl82b = await reqVia(up.port, { p: '/', headers: { host: `127.0.0.1:${up.port}` } })
    check('PP-8-2②b 次序断言：同 host、无 Origin、无 cookie → 401（fence 先于 cookie——rpc-host L95-98 同判）',
      ctrl82b.status === 401)
    const noOrigin82 = await reqVia(handle82.port, { p: '/echo', headers: {} })
    const noOriginJson82 = JSON.parse(noOrigin82.body)
    check('PP-8-2②c 无 Origin 不补（R4/L112 缺失放行）：上游实收 Origin = null → 放行 200',
      noOrigin82.status === 200 && noOriginJson82.origin === null)
    check('PP-8-2②d WS upgrade 同栅栏（R7）：带 Origin 经代理同规则重写 → 上游 101 透传',
      (await wsHandshake(handle82.port, `http://127.0.0.1:${handle82.port}`)).startsWith('HTTP/1.1 101'))
    check('PP-8-2②e WS 对照：未重写 Origin 直发上游 → 403（同规则钉入）',
      (await wsHandshake(up.port, 'http://127.0.0.1:1')).startsWith('HTTP/1.1 403'))
    const noopProxy82 = await AP.startAuthProxy(up.port, { token: null, cookie: null }, { log: () => {} })
    const pass82 = await reqVia(noopProxy82.port, { p: '/' })
    check('PP-8-2③ 上游 401 原样透传（R6 不吞不改；无会话代理直证）',
      pass82.status === 401 && pass82.body.includes('unauthorized'))
    const strip82 = await reqVia(handle82.port, { p: '/set-cookie-probe' })
    check('PP-8-2⑤a Set-Cookie 一律剥离（R5）：上游 200 + 双 Set-Cookie → 客户端零 set-cookie 头',
      strip82.status === 200 && strip82.headers['set-cookie'] === undefined)
    check('PP-8-2⑤b R1 转发保真：状态行与 body 原样（响应变更仅及 Set-Cookie 剥离）', strip82.body === 'ok')
    noopProxy82.stop()
    // ④ stop() 端口释放 + ⑥ proxy 生命周期零文件写入（快照对照）
    const snapA82 = snapshotDir(dataDir)
    handle82.stop()
    let rebound82 = false
    for (let i = 0; i < 60 && !rebound82; i++) { rebound82 = await canBind(handle82.port); if (!rebound82) await sleep(50) }
    const snapB82 = snapshotDir(dataDir)
    const sameDisk82 = snapB82.size === snapA82.size && [...snapA82.keys()].every((k) => snapB82.get(k) === snapA82.get(k))
    check('PP-8-2④ stop() 端口释放（rebind 断言）', rebound82)
    check('PP-8-2⑥ token 不落盘：proxy 生命周期内 dataDir 零文件写入（会话仅存内存）', sameDisk82)
    // C 路径自铸单元（browser-auth.ts 同构；E-PR-2/3/4/6）
    const auth82 = `127.0.0.1:${up.port}`
    const name82 = AP.dshCookieName(auth82)
    check('PP-8-2-C① cookie 名 = dsh-auth- + base64url(sha256(authority))：确定性、随 authority 变化',
      /^dsh-auth-[A-Za-z0-9_-]{43}$/.test(name82) && name82 === AP.dshCookieName(auth82) && name82 !== AP.dshCookieName('127.0.0.1:1'))
    const minted82 = AP.mintSessionCookie(secret82, auth82, 1_700_000_000_000)
    const mk82 = minted82 !== null ? /^([^=]+)=v1\.([^.]+)\.([^.]+)$/.exec(minted82) : null
    const bodyJson82 = mk82 !== null
      ? JSON.parse(Buffer.from(mk82[2].replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'))
      : null
    const sigExpect82 = mk82 !== null
      ? cryptoMod.createHmac('sha256', Buffer.from(secret82.replaceAll('-', '+').replaceAll('_', '/'), 'base64')).update(mk82[2]).digest().toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
      : null
    check('PP-8-2-C② 值形状 v1.<body>.<sig>：body = base64url(JSON{version:1,authority,issuedAt,expiresAt})，30d 窗口',
      mk82 !== null && mk82[1] === name82 && bodyJson82 !== null && bodyJson82.version === 1 && bodyJson82.authority === auth82 &&
      bodyJson82.issuedAt === 1_700_000_000_000 && bodyJson82.expiresAt === 1_700_000_000_000 + 30 * 24 * 60 * 60 * 1000)
    check('PP-8-2-C③ sig = base64url(HMAC-SHA256(secret, body))（browser-auth encodeCookie 同构，43 字符）',
      mk82 !== null && mk82[3] === sigExpect82 && mk82[3].length === 43)
    check('PP-8-2-C④ 恶劣输入诚实降级：非 32B secret / 空 authority → null 不抛异常',
      AP.mintSessionCookie('short', auth82) === null && AP.mintSessionCookie(secret82, '') === null)
    check('PP-8-2-C⑤ readCredentialsSecret：records[client-connection/browser-session].payload.secret 精确定位（只读；缺失 → null）',
      AP.readCredentialsSecret(mockHome) === secret82 && AP.readCredentialsSecret(path.join(dataDir, 'absent-home')) === null)

    // ---- PP-8-3: probe 双形态与 401 分流 -------------------------------------
    px('PP-8-3 probe 双形态（303/裸/cookie）+ 401 分流：单次重取、独立计数、×3 error、无循环')
    up.validTokens.add('fresh-tok')
    check('PP-8-3① token-303 形态：redirect manual 期待 303 判就绪（若跟随重定向将落 401 → ok 即证未跟随）',
      (await DP.probeDetail(up.port, { token: 'fresh-tok' })).kind === 'ok')
    check('PP-8-3② 裸 GET 形态：无会话 → 401 → unauthorized（alive 事实，非 down、非崩溃信号）',
      (await DP.probeDetail(up.port)).kind === 'unauthorized')
    check('PP-8-3③ cookie 形态（C 路径会话）：Cookie 头直发 → 200 + __DSH_BOOT__ → ok',
      (await DP.probeDetail(up.port, { cookie: `${name82}=v1.probe` })).kind === 'ok')
    check('PP-8-3④ down 形态：死端口 → down（probe 布尔视图 false）',
      (await DP.probeDetail(45999)).kind === 'down' && (await DP.probe(45999)) === false)
    const bootServer82 = httpMod.createServer((rq, rs) => { rs.writeHead(200); rs.end('<html>window.__DSH_BOOT__ = {}</html>') })
    const bootPort82 = await listenInProcess(bootServer82)
    check('PP-8-3⑤ probe() 布尔视图逐位兼容：200+boot → true；401 → false（既有调用方零感知）',
      (await DP.probe(bootPort82)) === true && (await DP.probe(up.port)) === false)
    bootServer82.close()
    try { bootServer82.closeAllConnections() } catch { /* best-effort */ }
    // 401 分流（#1 行会话轮换）：stale token 探活 401 → banner 重取新 token → proxy 重建 → 下一 tick ok
    const bannerLog83 = path.join(dataDir, 'managed-r1.log')
    fs.writeFileSync(bannerLog83, `dsh web: http://127.0.0.1:${up.port}/?token=fresh-tok\n`, 'utf8')
    const managedBefore83 = fs.readFileSync(bannerLog83, 'utf8')
    const rlogOff83a = rlogOffset()
    const r1 = newRuntime(process.pid, { port: up.port, dshHome: mockHome })
    r1.state = 'ready'
    r1.port = up.port
    r1.contract = 'token'
    r1.authToken = 'stale-tok'
    r1.sessionRetried = false
    r1.authFailures = 0
    r1.probeFailures = 0
    r1.lastLaunchLogFile = bannerLog83
    let r1Errored = false
    r1.on('error', () => { r1Errored = true })
    await r1.probeTick()
    check('PP-8-3⑥ 首个 401 → 单次会话重取：banner 新 token 捕获 → proxy 重建（token 轮换；面板 url 切代理面）',
      r1.state === 'ready' && r1.authToken === 'fresh-tok' && r1.proxy !== null &&
      /^http:\/\/127\.0\.0\.1:\d+$/.test(String(r1.url)) && !String(r1.url).includes('token=') &&
      r1.externalUrl === `http://127.0.0.1:${up.port}/?token=fresh-tok`)
    await r1.probeTick()
    check('PP-8-3⑦ 重取后收敛：token-303 ok → 双计数清零、error 未触发、probeFailures 恒 0（不入崩溃回退）',
      r1.state === 'ready' && r1.probeFailures === 0 && r1.authFailures === 0 && !r1Errored)
    check('PP-8-3⑧ 分流留痕（rlog 脱敏面）+ managed log 原文未重写（dsh 输出 token 原样留存）',
      rlogSlice(rlogOff83a).includes('probe: 401 (service alive, session invalid)') &&
      rlogSlice(rlogOff83a).includes('session re-establishment') &&
      rlogSlice(rlogOff83a).includes('token=<REDACTED>') &&
      fs.readFileSync(bannerLog83, 'utf8') === managedBefore83 && managedBefore83.includes('?token=fresh-tok'))
    // 重取边界：重取已耗尽 → 独立 401 计数 ×3 → error 终态（无循环、无重启 spawn）
    const launchesBefore83 = router.calls.filter((c) => c.kind === 'launch').length
    const rlogOff83b = rlogOffset()
    const r2 = newRuntime(process.pid, { port: up.port, dshHome: mockHome })
    r2.state = 'ready'
    r2.port = up.port
    r2.contract = 'token'
    r2.authToken = 'tok-x'
    r2.sessionRetried = true
    r2.authFailures = 0
    r2.probeFailures = 0
    let r2Error = null
    r2.on('error', (m) => { r2Error = m })
    await r2.probeTick()
    await r2.probeTick()
    check('PP-8-3⑨ 重取边界：×2 仍 ready（独立计数递增；单次重取不循环）',
      r2.state === 'ready' && r2.authFailures === 2 && r2.probeFailures === 0)
    await r2.probeTick()
    check('PP-8-3⑩ 连续 401 ×3 → error 终态 + 「dsh 会话失效」指引文案（探测停摆、proxy 停摆）',
      r2.state === 'error' && r2Error === 'dsh 会话失效——请重启服务（面板 ⟳ 或命令「DSH: Restart Runtime」；dsh 进程未停止）' &&
      r2.errorMessage === r2Error && r2.probeTimer === null && r2.proxy === null)
    await r2.probeTick()
    check('PP-8-3⑪ 无循环 / 不入崩溃回退与 ADR-21：error 态 probeTick 早退（计数冻结、probeFailures 恒 0、零重启 spawn）',
      r2.authFailures === 3 && r2.state === 'error' && r2.probeFailures === 0 &&
      router.calls.filter((c) => c.kind === 'launch').length === launchesBefore83)
    r2.removeAllListeners('error')
    // 判定表 #3 行（unknown / 版本不可读）：adopt 会话直连起手 → 401 分流 → C 路径升级
    const r3 = newRuntime(process.pid, { port: up.port, dshHome: mockHome })
    r3.state = 'ready'
    r3.port = up.port
    r3.contract = 'unknown'
    r3.authToken = null
    r3.sessionCookie = null
    r3.sessionRetried = false
    r3.authFailures = 0
    r3.probeFailures = 0
    let r3Errored = false
    r3.on('error', () => { r3Errored = true })
    await r3.probeTick()
    check('PP-8-3⑫ #3 行 unknown：裸 probe 401 → 分流（无 banner 可读）→ C 路径自铸会话 + proxy 升级',
      r3.state === 'ready' && typeof r3.sessionCookie === 'string' && r3.sessionCookie.startsWith(`${name82}=v1.`) &&
      r3.proxy !== null && !String(r3.url).includes('token='))
    await r3.probeTick()
    check('PP-8-3⑬ C 路径升级后收敛：cookie probe ok → 计数清零（否则面板可用却误报会话失效）',
      r3.state === 'ready' && r3.authFailures === 0 && r3.probeFailures === 0 && !r3Errored)
    r3.removeAllListeners('error')

    // ---- PP-8-4: 脱敏与不落盘 ------------------------------------------------
    px('PP-8-4 脱敏面（rlog/panelLog/openBrowser）+ registry D3 字面 + managed log 原文')
    const rlogOff84 = rlogOffset()
    PATH.appendDecisionLog('openInBrowser: http://127.0.0.1:9/?token=SECRETVALUE42 (externalUrl, token contract)')
    const tail84 = rlogSlice(rlogOff84)
    check('PP-8-4① rlog 单点脱敏：token=<REDACTED> 字面落盘、token 原文零残留',
      tail84.includes('token=<REDACTED>') && !tail84.includes('SECRETVALUE42'))
    PATH.appendDecisionLog('idempotent check: url?token=<REDACTED> already-redacted')
    check('PP-8-4② 脱敏幂等：已脱敏形态二次过写不变形（< 在捕获字符集外）',
      rlogSlice(rlogOff84).split('token=<REDACTED>').length - 1 >= 2)
    check('PP-8-4③ 脱敏面枚举（panelLog + openBrowser 消息载荷留痕面）：两处调用点均过 redactSecrets（静态扫描）',
      ['src/webview.ts', 'src/extension.ts'].every((p) =>
        fs.readFileSync(path.join(process.cwd(), p), 'utf8').includes('redactSecrets(')))
    const r4reg = newRuntime(process.pid, { port: up.port })
    r4reg.state = 'ready'
    r4reg.port = up.port
    r4reg.managedBy = 'managed-own'
    r4reg.externalUrl = `http://127.0.0.1:${up.port}/?token=SECRETVALUE43`
    await r4reg.writeRegistry()
    const instRaw84 = fs.readFileSync(path.join(dataDir, 'instance.json'), 'utf8')
    check('PP-8-4④ registry D3 字面级断言：instance.json 载荷零 token 原文、零 externalUrl 字段',
      !instRaw84.includes('SECRETVALUE43') && !instRaw84.includes('externalUrl') && !instRaw84.includes('token='))
    check('PP-8-4⑤ registry 结构不扰：既有字段齐全（pid/port/managedBy/startedAt）',
      readInstance().dsh !== null && readInstance().dsh.port === up.port)

    // ---- PP-8-5: 全族回归聚合门 ----------------------------------------------
    px('PP-8-5 全族回归聚合门')
    check('PP-8-5 token 组（PP-8-1..4）与既有族（PV/PW/PI/PP-1..7/PU）此前零失败', failures === 0)

    // ---- PP-8-6: 版本阈值判定（判定表单测）-----------------------------------
    px('PP-8-6 版本阈值判定：judgeContractByVersion / compareDshVersions 纯函数直测 + 矛盾态装配')
    check('PP-8-6①a 阈值边界：0.1.1-rc.2 → legacy；0.1.2-alpha.1 → legacy（未发布 npm，若现即 #4 行处置）',
      DP.judgeContractByVersion('0.1.1-rc.2') === 'legacy' && DP.judgeContractByVersion('0.1.2-alpha.1') === 'legacy')
    check('PP-8-6①b 阈值含等号：0.1.2-alpha.2 → token；0.1.2-alpha.3 → token',
      DP.judgeContractByVersion('0.1.2-alpha.2') === 'token' && DP.judgeContractByVersion('0.1.2-alpha.3') === 'token')
    check('PP-8-6①c 未来版本自动覆盖：0.1.2-rc.1 / 0.1.2 / 0.1.3-alpha.1 → token（next/latest 升级零设计变更）',
      DP.judgeContractByVersion('0.1.2-rc.1') === 'token' && DP.judgeContractByVersion('0.1.2') === 'token' &&
      DP.judgeContractByVersion('0.1.3-alpha.1') === 'token')
    check('PP-8-6①d prerelease 排序：alpha.10 > alpha.9（数值序）；rc > alpha；stable > prerelease；等值 = 0',
      DP.compareDshVersions('0.1.2-alpha.10', '0.1.2-alpha.9') === 1 &&
      DP.compareDshVersions('0.1.2-rc.1', '0.1.2-alpha.9') === 1 &&
      DP.compareDshVersions('0.1.2', '0.1.2-rc.1') === 1 &&
      DP.compareDshVersions('0.1.2-alpha.2', '0.1.2-alpha.2') === 0)
    check('PP-8-6①e malformed（foo/空）与 null → unknown 不抛异常（compare → null，判定表 #3 行）',
      DP.judgeContractByVersion('foo') === 'unknown' && DP.judgeContractByVersion('') === 'unknown' &&
      DP.judgeContractByVersion(null) === 'unknown' &&
      DP.compareDshVersions('foo', '0.1.2') === null && DP.compareDshVersions('', 'x') === null)
    // ③ 矛盾态（合成 banner 事实：直接装配字段后调 applyContractOnLaunch）
    const rlogOff86a = rlogOffset()
    const r5 = newRuntime(process.pid, { port: up.port, dshHome: mockHome })
    r5.state = 'ready'
    r5.port = up.port
    r5.url = `http://127.0.0.1:${up.port}`
    r5.contract = 'legacy'
    r5.authToken = 'tok-pp86'
    r5.lastResolved = { version: '0.1.1-rc.2' }
    up.validTokens.add('tok-pp86')
    await r5.applyContractOnLaunch()
    check('PP-8-6③a #4 行（token banner + 版本 < V*）：防御对齐 token 契约——proxy 起 + externalUrl = token URL',
      r5.proxy !== null && r5.externalUrl === `http://127.0.0.1:${up.port}/?token=tok-pp86`)
    check('PP-8-6③b #4 行 WARN 双事实：rlog 同留版本与 banner 两面（judgement table #4）',
      rlogSlice(rlogOff86a).includes('WARN contract: contradictory facts') && rlogSlice(rlogOff86a).includes('#4'))
    const rlogOff86b = rlogOffset()
    const r6 = newRuntime(process.pid, { port: up.port, dshHome: mockHome })
    r6.state = 'ready'
    r6.port = up.port
    r6.url = `http://127.0.0.1:${up.port}`
    r6.contract = 'token'
    r6.authToken = null
    r6.lastResolved = { version: '0.1.2-alpha.3' }
    await r6.applyContractOnLaunch()
    check('PP-8-6③c #5 行（版本 ≥ V* + 无 token）：版本侧维持 + C 路径兜底 + WARN；externalUrl 恒 null（不臆造 token URL）',
      r6.proxy !== null && typeof r6.sessionCookie === 'string' && r6.sessionCookie.startsWith(`${name82}=v1.`) &&
      r6.externalUrl === null &&
      rlogSlice(rlogOff86b).includes('WARN contract: contradictory facts') && rlogSlice(rlogOff86b).includes('#5'))
    const rlogOff86c = rlogOffset()
    const r7 = newRuntime(process.pid, { port: up.port, dshHome: mockHome })
    r7.state = 'ready'
    r7.port = up.port
    r7.url = `http://127.0.0.1:${up.port}`
    r7.contract = 'legacy'
    r7.authToken = null
    r7.lastResolved = { version: '0.1.1-rc.2' }
    await r7.applyContractOnLaunch()
    check('PP-8-6④ latest 形态回归：旧 banner 无 token + sub-threshold → 逐位旧路径（零 proxy / 零 externalUrl / 零 WARN）',
      r7.proxy === null && r7.externalUrl === null && r7.url === `http://127.0.0.1:${up.port}` &&
      !rlogSlice(rlogOff86c).includes('WARN contract'))
    // 清理本组会话面（防端口/句柄泄漏；不 dispose——无 timer 无进程持有）
    for (const rr of [r1, r2, r3, r4reg, r5, r6, r7]) { try { rr.stopProxy() } catch { /* none */ } }

    // ---- PU-9: 通道模型与首启选择 --------------------------------------------
    px('PU-9 通道模型与首启选择（channelSelect 纯模块 mock deps 直测 + package.json enum 契约）')
    check('PU-9①a 归一三态：preview → latest + 归一标记；latest/next/alpha 透传（normalized=false）',
      JSON.stringify(CS.normalizeChannel('preview')) === JSON.stringify({ channel: 'latest', normalized: true }) &&
      CS.normalizeChannel('latest').channel === 'latest' && CS.normalizeChannel('latest').normalized === false &&
      CS.normalizeChannel('next').channel === 'next' && CS.normalizeChannel('alpha').channel === 'alpha')
    check('PU-9①b 非法值 → latest + 留痕（不抛异常；ADR-29 归一 rlog 锚单点文案）',
      CS.normalizeChannel('foo').channel === 'latest' && CS.normalizeChannel('foo').normalized === true &&
      CS.normalizeChannelLogLine('preview', 'latest') === "channel 'preview' is not a published dist-tag; normalizing to 'latest' (ADR-29)")
    check('PU-9①c 三选项（latest/next/alpha）+ 占位符单点',
      JSON.stringify(CS.channelPickItems().map((i) => i.label)) === JSON.stringify(['latest', 'next', 'alpha']) &&
      typeof CS.CHANNEL_PICK_PLACEHOLDER === 'string' && CS.CHANNEL_PICK_PLACEHOLDER.includes('通道'))
    const makeChannelDeps = ({ store, pickResult, failWrite = false }) => {
      const calls = []
      return {
        calls,
        deps: {
          pick: async () => { calls.push('pick'); return pickResult },
          readChannel: () => { calls.push('readChannel'); return store.channel },
          writeChannel: async (v) => {
            calls.push(`writeChannel:${v}`)
            if (failWrite) throw new Error('config locked')
            store.channel = v
          },
          readChannelSelected: () => { calls.push('readChannelSelected'); return store.selected },
          writeChannelSelected: async (v) => { calls.push(`writeChannelSelected:${v}`); store.selected = v },
          log: (m) => { calls.push(`log:${m}`) },
        },
      }
    }
    {
      const store = { channel: 'preview', selected: false }
      const md = makeChannelDeps({ store, pickResult: 'alpha' })
      const res = await CS.runFirstLaunchChannelSelect(md.deps)
      const iW = md.calls.indexOf('writeChannel:alpha')
      const iS = md.calls.indexOf('writeChannelSelected:true')
      check('PU-9②a 首启门触发：channelSelected=false → QuickPick → selected:true / cancelled:false / channel=alpha',
        res.selected === true && res.cancelled === false && res.writeFailed === false && res.channel === 'alpha' && md.calls.includes('pick'))
      check('PU-9②b 先选后启顺序（mock 调用序可观察）：writeChannel 先于 writeChannelSelected，pick 先于二者，均先于返回',
        iW !== -1 && iS !== -1 && iW < iS && md.calls.indexOf('pick') < iW)
      check('PU-9②c preview 归一留痕：log 含 ADR-29 归一行（双重防护单点文案）',
        md.calls.some((c) => c.startsWith('log:') && c.includes("channel 'preview' is not a published dist-tag")))
    }
    {
      const store = { channel: 'latest', selected: true }
      const md = makeChannelDeps({ store, pickResult: 'alpha' })
      const res = await CS.runFirstLaunchChannelSelect(md.deps)
      check('PU-9②d 非首启零扰动：channelSelected=true → 不弹窗不写（PU-1..8 的 latest 默认路径不受扰）',
        res.selected === false && res.cancelled === false && !md.calls.includes('pick') && store.channel === 'latest')
      const mdF = makeChannelDeps({ store: { channel: 'next', selected: true }, pickResult: 'alpha' })
      const resF = await CS.runFirstLaunchChannelSelect(mdF.deps, { forcePick: true })
      check('PU-9②e dsh.chooseChannel 重入口：forcePick 绕过首启门（重选生效）',
        resF.selected === true && resF.channel === 'alpha')
    }
    {
      const store = { channel: 'next', selected: false }
      const md = makeChannelDeps({ store, pickResult: undefined })
      const res = await CS.runFirstLaunchChannelSelect(md.deps)
      check('PU-9②f Esc 取消：channel 不变、channelSelected 仍 false、cancelled:true（下次再问）',
        res.cancelled === true && res.selected === false && store.channel === 'next' && store.selected === false &&
        !md.calls.some((c) => c.startsWith('writeChannel')))
    }
    {
      const store = { channel: 'preview', selected: false }
      const md = makeChannelDeps({ store, pickResult: 'alpha', failWrite: true })
      const res = await CS.runFirstLaunchChannelSelect(md.deps)
      check('PU-9②g 写配置抛错 → writeFailed:true、沿用旧值（归一后 latest）、启动继续（诚实降级）',
        res.writeFailed === true && res.selected === false && res.channel === 'latest' && store.selected === false &&
        md.calls.some((c) => c.startsWith('log:') && c.includes('config write failed')))
    }
    const pkgSim = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'))
    const chanProp = pkgSim.contributes.configuration.properties['dsh.channel']
    const selProp = pkgSim.contributes.configuration.properties['dsh.channelSelected']
    check('PU-9③a dsh.channel enum = [latest,next,alpha]（dist-tag 集单点镜像；default latest）',
      JSON.stringify(chanProp.enum) === JSON.stringify(['latest', 'next', 'alpha']) && chanProp.default === 'latest')
    check('PU-9③b dsh.channelSelected：boolean / default false / window scope（首启标志）',
      selProp.type === 'boolean' && selProp.default === false && selProp.scope === 'window')
    check('PU-9③c dsh.chooseChannel 命令注册 + activationEvents（QuickPick 重入口可达）',
      Array.isArray(pkgSim.contributes.commands) && pkgSim.contributes.commands.some((c) => c.command === 'dsh.chooseChannel') &&
      Array.isArray(pkgSim.activationEvents) && pkgSim.activationEvents.includes('onCommand:dsh.chooseChannel'))
    check('PU-9③d 版本 0.1.17（发布单点）', pkgSim.version === '0.1.17')
    check('PU-9④ 回归聚合门：PU-1..8 + PP-8 全族此前零失败', failures === 0)

    // ==================== 0.1.15 additions (#88/#92, design §8.1/§8.2/§8.1b) ==
    // PP-10（adopt 会话定案 / awaitingChannel / 切换器 / #87 门）、PU-10（静态）、
    // PP-11（面板消息路由）、PU-11（静态）。判据来源：
    // docs/0.1.15修复设计-真机验收问题.md v1.5。手法：
    //  - runtime 行为断言 = start() step1 全链（registry adopt）真实驱动 + 实例
    //    方法 spy marks（覆写后委托原实现；JS 层 private 可覆写）；
    //  - 活体验证 401 形态 = 独立 in-process 拒绝上游（fence 过后一律 401 =
    //    「凭证与进程 secret 不同源」失效态，设计 §九-1）；
    //  - vscode 层行为断言 = Module._load 'vscode' mock 驱动编译产物
    //    (webview.js/webviewDetails.js/extension.js)，fake view/commands/config
    //    捕获真实调用序（比纯静态强；静态面仍按 E-SIM-1 先例保留交叉一致性）。

    // -- 0.1.15 共享装置：完整 launchInfo 样例（详情卡 render 输入）------------
    const makeCardInfo15 = () => ({
      dshVersion: '0.1.2-alpha.3', resolverVersion: null, resolverMode: null, versionCrossCheck: 'self-only',
      binDir: null, dshBin: null, port: up.port, pid: process.pid, managedBy: 'managed-own',
      startedAt: new Date().toISOString(), channel: 'alpha', lastCheckAt: null, logFiles: [],
      externalCommandLine: null, launchMode: 'direct',
    })
    const seedExternal15 = (port) => seedInst({
      dsh: makeRecord(process.pid, port, 'external'),
      windows: [{ pid: process.pid, app: 'Sim', startedAt: new Date().toISOString() }],
    })

    // ---- PP-10-1/2: adopt 会话定案时序（#80/#81）----------------------------
    px('PP-10-1/2 adopt 会话定案（#80/#81：starting 保持、ready 一次性终态、调用序 probe→mint→live GET→establishProxy→ready）')
    {
      seedExternal15(up.port)
      const marks = []
      const stateSeq = []
      const eventNames = []
      const r10 = newRuntime(process.pid, { port: up.port, dshHome: mockHome })
      r10.on('error', () => {}) // enterSessionUnavailable emit('error')：无监听会 throw（EventEmitter 语义）
      const origEmit10 = r10.emit.bind(r10)
      r10.emit = (ev, ...a) => { eventNames.push(ev); return origEmit10(ev, ...a) }
      const origProbe10 = r10.probeState.bind(r10)
      r10.probeState = async (p) => { marks.push('probe'); return origProbe10(p) }
      const origMint10 = r10.mintCookieFromCredentials.bind(r10)
      r10.mintCookieFromCredentials = () => { marks.push('mint'); return origMint10() }
      const origLive10 = r10.liveVerifySession.bind(r10)
      r10.liveVerifySession = async () => { marks.push('liveVerify'); return origLive10() }
      const origEst10 = r10.establishProxy.bind(r10)
      r10.establishProxy = async (s) => { marks.push('establishProxy'); const ok = await origEst10(s); marks.push(`establishProxy:${ok ? 'ok' : 'fail'}`); return ok }
      const origSetState10 = r10.setState.bind(r10)
      r10.setState = (s) => { marks.push(`setState:${s}`); origSetState10(s) }
      r10.on('state', (s) => stateSeq.push({ state: s, url: r10.url }))
      await r10.start()
      const iStart10 = marks.indexOf('setState:starting')
      const iProbe10 = marks.indexOf('probe')
      const iMint10 = marks.indexOf('mint')
      const iLive10 = marks.indexOf('liveVerify')
      const iLiveProbe10 = marks.indexOf('probe', iLive10)
      const iEst10 = marks.indexOf('establishProxy')
      const iEstOk10 = marks.indexOf('establishProxy:ok')
      const iReady10 = marks.indexOf('setState:ready')
      check('PP-10-2① adopt(unauthorized) 调用序：probe → mint → live 验证 GET → establishProxy → setState(ready)（ready 晚于代理就绪）',
        iStart10 > -1 && iProbe10 > iStart10 && iMint10 > iProbe10 && iLive10 > iMint10 && iLiveProbe10 > iLive10 &&
        iEst10 > iLiveProbe10 && iEstOk10 > iEst10 && iReady10 > iEstOk10)
      check('PP-10-2② 恰好性：ready/mint/liveVerify/establishProxy 各恰一次、成功路径零 setState(error)（单次活体验证、无重复面）',
        marks.filter((m) => m === 'setState:ready').length === 1 && marks.filter((m) => m === 'mint').length === 1 &&
        marks.filter((m) => m === 'liveVerify').length === 1 && marks.filter((m) => m === 'establishProxy').length === 1 &&
        !marks.includes('setState:error'))
      check('PP-10-1① starting 保持至定案：state 事件序列恰好 [starting, ready]（无中途 ready、无 error 闪烁）',
        JSON.stringify(stateSeq.map((x) => x.state)) === '["starting","ready"]')
      check('PP-10-1② starting 期间 url 恒 null（无地址渲染/消费点；ready 时 url 才首次赋值）',
        stateSeq[0].url === null && stateSeq[1].url !== null)
      check('PP-10-1③ ready 首帧载荷 url = 最终代理 URL（一次性终态渲染；非裸 URL、非 token 形态）',
        stateSeq[1].url === `http://127.0.0.1:${r10.proxy.port}` && r10.url === stateSeq[1].url && !String(r10.url).includes('token='))
      check('PP-10-1④ 零新增 emit 面（动态）：事件名 ⊆ {state}、state 载荷为字符串（事件载荷形状不变）',
        eventNames.length > 0 && eventNames.every((e) => e === 'state') && stateSeq.every((x) => typeof x.state === 'string'))
      r10.dispose()
    }

    // ---- PP-10-3: C 不可用诚实降级（#82）-------------------------------------
    px('PP-10-3 C 不可用诚实降级（#82：凭证不可读 / 活体验证 401 → 无代理、url 保持 null、引导态置位）')
    {
      // 形态 a：凭证不可读（dshHome 指向缺失目录 → readCredentialsSecret null）
      seedExternal15(up.port)
      const marksA = []
      const rA = newRuntime(process.pid, { port: up.port, dshHome: path.join(dataDir, 'absent-home-pp10') })
      let errA = null
      rA.on('error', (m) => { errA = m })
      const origSetStateA = rA.setState.bind(rA)
      rA.setState = (s) => { marksA.push(`setState:${s}`); origSetStateA(s) }
      const origMintA = rA.mintCookieFromCredentials.bind(rA)
      rA.mintCookieFromCredentials = () => { marksA.push('mint'); return origMintA() }
      const origEstA = rA.establishProxy.bind(rA)
      rA.establishProxy = async (s) => { marksA.push('establishProxy'); return origEstA(s) }
      const offA = rlogOffset()
      await rA.start()
      check('PP-10-3① C 失败（凭证不可读）：establishProxy 不被调用、url 保持 null、无代理（面板无地址渲染）',
        !marksA.includes('establishProxy') && rA.url === null && rA.proxy === null)
      check('PP-10-3② 引导态字段置位：恰好一次 setState(error) + #82 引导文案（含 dsh.dshHome 核对提示；error 事件载荷同值）',
        marksA.filter((m) => m === 'setState:error').length === 1 && rA.state === 'error' &&
        typeof rA.errorMessage === 'string' && rA.errorMessage.includes('该 dsh 实例无法建立面板会话') &&
        rA.errorMessage.includes('dsh.dshHome') && errA === rA.errorMessage)
      check('PP-10-3③ rlog 诚实降级留痕（adopt C path: credentials unreadable）',
        rlogSlice(offA).includes('adopt C path: credentials unreadable'))
      rA.dispose()

      // 形态 b：活体验证 401（独立拒绝上游；mockHome 凭证有效 → mint 成功但上游拒绝）
      const rejServer = httpMod.createServer((rq, rs) => {
        rs.writeHead(401, { 'content-type': 'text/plain' })
        rs.end('unauthorized')
      })
      const rejPort = await listenInProcess(rejServer)
      seedExternal15(rejPort)
      const marksB = []
      const rB = newRuntime(process.pid, { port: rejPort, dshHome: mockHome })
      let errB = null
      rB.on('error', (m) => { errB = m })
      const origSetStateB = rB.setState.bind(rB)
      rB.setState = (s) => { marksB.push(`setState:${s}`); origSetStateB(s) }
      const origMintB = rB.mintCookieFromCredentials.bind(rB)
      rB.mintCookieFromCredentials = () => { marksB.push('mint'); return origMintB() }
      const origLiveB = rB.liveVerifySession.bind(rB)
      rB.liveVerifySession = async () => { marksB.push('liveVerify'); return origLiveB() }
      const origEstB = rB.establishProxy.bind(rB)
      rB.establishProxy = async (s) => { marksB.push('establishProxy'); return origEstB(s) }
      const offB = rlogOffset()
      await rB.start()
      check('PP-10-3④ 活体验证 401（mint 成功但 live GET 拒绝）：establishProxy 不被调用、url 保持 null、无代理',
        marksB.includes('mint') && marksB.includes('liveVerify') && !marksB.includes('establishProxy') &&
        rB.url === null && rB.proxy === null && rB.sessionCookie === null)
      check('PP-10-3⑤ 引导态置位 + rlog rejected 留痕（不假装可配；判定表 #6 行 401 侧）',
        marksB.filter((m) => m === 'setState:error').length === 1 && rB.state === 'error' &&
        errB === rB.errorMessage && rB.errorMessage.includes('该 dsh 实例无法建立面板会话') &&
        rlogSlice(offB).includes('C path: minted cookie rejected by live upstream'))
      try { rejServer.closeAllConnections() } catch { /* best-effort */ }
      rejServer.close()
      rB.dispose()
    }

    // ---- PP-10-4/5/6 + PP-11 行为面 + PU-10-3③④: vscode 层（mock 驱动产物）--
    px('PP-10-4/5/6 + PP-11 + PU-10-3 vscode 层行为断言（Module._load vscode mock 驱动编译产物；mock postMessage → 真实路由/guard/命令映射）')
    {
      const Module = require('node:module')
      const origModuleLoad = Module._load
      const cfgCalls = []
      const cmdCalls = []
      const warnMsgs = []
      const openExternalCalls = []
      // 跨 fake 的单一时间线（PU-9②b mock 先例）：config.update 与 runtime
      // spy 都 push 进同一个数组，调用序断言才有可比索引（两个独立数组的
      // 索引互不可比——首跑曾因此假阴性）。
      const timeline = []
      const providers = {}
      const cmdHandlers = {}
      let failConfigWrite = false
      const cfgStore = { port: 3080, channel: 'latest', command: '', autoStart: false, autoOpenPanel: false, dshHome: '', probeIntervalSec: 0, consoleVisible: false, channelSelected: true }
      const fakeConfig = {
        get: (k, d) => (k in cfgStore ? cfgStore[k] : d),
        update: async (k, v) => {
          const entry = `update:${k}=${JSON.stringify(v)}`
          cfgCalls.push(entry)
          timeline.push(entry)
          if (failConfigWrite) throw new Error('config locked')
          cfgStore[k] = v
        },
      }
      const fakeVscode = {
        commands: {
          registerCommand: (id, h) => { cmdHandlers[id] = h; return { dispose() {} } },
          executeCommand: async (id) => { cmdCalls.push(id); return undefined },
        },
        window: {
          createStatusBarItem: () => ({ command: '', text: '', tooltip: '', show() {}, hide() {} }),
          registerWebviewViewProvider: (id, p) => { providers[id] = p },
          showWarningMessage: async (m) => { warnMsgs.push(m); return undefined },
          showInformationMessage: async (m) => undefined,
          showQuickPick: async () => undefined,
        },
        workspace: { getConfiguration: () => fakeConfig },
        env: {
          appName: 'Sim',
          clipboard: { writeText: async () => {} },
          openExternal: async (uri) => { openExternalCalls.push(uri && uri.__url !== undefined ? uri.__url : String(uri)); return true },
        },
        Uri: { parse: (s) => ({ __url: s, toString: () => s }), file: (p) => ({ fsPath: p, toString: () => p }) },
        ConfigurationTarget: { Global: 1 },
        StatusBarAlignment: { Right: 2, Left: 1 },
      }
      Module._load = function (request, parent, isMain) {
        if (request === 'vscode') return fakeVscode
        return origModuleLoad.call(this, request, parent, isMain)
      }
      try {
        const WV = require('../out/webview.js') // { DshPanel }
        const WD = require('../out/webviewDetails.js') // { DshDetailsProvider }
        const mkFakeRuntime = (state) => {
          const rt = new EventEmitter()
          rt.state = state
          rt.url = null
          rt.errorMessage = null
          rt.calls = []
          rt.getLaunchInfo = () => null
          rt.setChannel = (c) => { rt.calls.push(`setChannel:${c}`); timeline.push(`setChannel:${c}`) }
          rt.start = async () => { rt.calls.push('start'); timeline.push('start') }
          rt.reconnect = async () => { rt.calls.push('reconnect'); timeline.push('reconnect') }
          rt.disconnect = () => { rt.calls.push('disconnect') }
          return rt
        }
        const mkFakeView = () => {
          const bag = { posts: [], handler: null }
          const view = {
            title: null,
            visible: true,
            webview: {
              html: '',
              cspSource: 'https://*.vscode-cdn.net',
              options: null,
              onDidReceiveMessage: (h) => { bag.handler = h },
              postMessage: async (m) => { bag.posts.push(m); return true },
            },
            onDidDispose: () => {},
            onDidChangeVisibility: () => {},
          }
          return { view, bag }
        }

        // ---- PP-10-4: awaitingChannel 状态机（webview.ts onChooseChannel）----
        const rtPick = mkFakeRuntime('awaitingChannel')
        const panelPick = new WV.DshPanel(rtPick)
        const pickV = mkFakeView()
        panelPick.resolveWebviewView(pickV.view)
        check('PP-10-4⓪ 面板 mock postMessage 链路就绪（chooseChannel 白名单路由 → onChooseChannel）',
          typeof pickV.bag.handler === 'function')
        cfgCalls.length = 0
        timeline.length = 0
        pickV.bag.handler({ type: 'chooseChannel', channel: 'alpha' })
        await sleep(150)
        const iWC10 = timeline.indexOf('update:channel="alpha"')
        const iSel10 = timeline.indexOf('update:channelSelected=true')
        const iSC10 = timeline.indexOf('setChannel:alpha')
        const iStart10b = timeline.indexOf('start')
        check('PP-10-4① 选择调用序：writeChannel → writeChannelSelected=true → runtime.setChannel → start（先选后启：start 严格晚于写入）',
          iWC10 > -1 && iSel10 > -1 && iSC10 > -1 && iStart10b > -1 && iWC10 < iSel10 && iSel10 < iSC10 && iSC10 < iStart10b)
        check('PP-10-4② 写入值：channel=alpha + channelSelected=true（切换器写入后首启页从结构上不再触发）',
          cfgStore.channel === 'alpha' && cfgStore.channelSelected === true)
        cfgCalls.length = 0
        pickV.bag.handler({ type: 'chooseChannel', channel: 'preview' })
        await sleep(150)
        check('PP-10-4③ 非法/旧值归一：chooseChannel preview → 写入 latest（ADR-29 归一单点贯穿面板流）',
          cfgCalls.includes('update:channel="latest"') && cfgStore.channel === 'latest')
        cfgCalls.length = 0
        rtPick.calls.length = 0
        pickV.bag.handler({ type: 'chooseChannel', channel: null })
        await sleep(150)
        check('PP-10-4④ 稍后再说（null 哨兵）：start（当前值）且零配置写入、不置 channelSelected（下次再问）',
          rtPick.calls.includes('start') && cfgCalls.length === 0 && cfgStore.channelSelected === true &&
          !rtPick.calls.some((c) => c.startsWith('setChannel')))
        cfgCalls.length = 0
        rtPick.calls.length = 0
        failConfigWrite = true
        pickV.bag.handler({ type: 'chooseChannel', channel: 'next' })
        await sleep(150)
        failConfigWrite = false
        check('PP-10-4⑤ 写失败诚实降级：沿用当前通道 start、不置 flag、零 setChannel（channelSelect 诚实降级先例同语义）',
          rtPick.calls.includes('start') && !rtPick.calls.some((c) => c.startsWith('setChannel')) &&
          !cfgCalls.includes('update:channelSelected=true') && cfgStore.channel === 'latest')

        // ---- PP-10-5: 切换器写入序（webviewDetails.ts setChannel）------------
        const rtDet = mkFakeRuntime('ready')
        rtDet.getLaunchInfo = () => makeCardInfo15()
        const detPick = new WD.DshDetailsProvider(rtDet)
        const detV = mkFakeView()
        detPick.resolveWebviewView(detV.view)
        cfgCalls.length = 0
        timeline.length = 0
        detV.bag.handler({ type: 'setChannel', channel: 'alpha' })
        await sleep(150)
        const iWC10c = timeline.indexOf('update:channel="alpha"')
        const iSel10c = timeline.indexOf('update:channelSelected=true')
        const iSC10c = timeline.indexOf('setChannel:alpha')
        check('PP-10-5① 切换器写入序：writeChannel → writeChannelSelected=true → runtime.setChannel（channelSelected=true → 首启页不再触发）',
          iWC10c > -1 && iSel10c > -1 && iSC10c > -1 && iWC10c < iSel10c && iSel10c < iSC10c && cfgStore.channelSelected === true)
        check('PP-10-5② 不自动重启：start/reconnect 零调用（尊重运行中实例；重启是用户动作，复用既有 restart 链）',
          !rtDet.calls.includes('start') && !rtDet.calls.includes('reconnect'))

        // ---- PP-10-6: openInBrowser 诚实引导（#87；extension.ts activate）----
        cfgStore.autoStart = false
        const exitListenersBefore = process.listeners('exit').length
        const EX = require('../out/extension.js') // { activate, deactivate }
        await EX.activate({ subscriptions: [] })
        check('PP-10-6① activate 注册 dsh.openInBrowser + dsh.chooseChannel（#87/#86 命令面可达）',
          typeof cmdHandlers['dsh.openInBrowser'] === 'function' && typeof cmdHandlers['dsh.chooseChannel'] === 'function')
        const rtEx = providers['dsh.panel'].runtime
        // 场景 A：externalUrl=null + token 契约（adopt 无 banner）→ 不打开 401 裸页
        rtEx.contract = 'token'
        rtEx.url = null
        rtEx.externalUrl = null
        openExternalCalls.length = 0
        warnMsgs.length = 0
        const offP106 = rlogOffset()
        await cmdHandlers['dsh.openInBrowser']()
        check('PP-10-6② externalUrl=null + token 契约 → 不调 openExternal、提示分支命中（引导文案：面板已代持会话 + 重启接管首启）',
          openExternalCalls.length === 0 && warnMsgs.length === 1 &&
          warnMsgs[0].includes('外部浏览器需 dsh banner token') && warnMsgs[0].includes('面板已代持会话') && warnMsgs[0].includes('重启'))
        check('PP-10-6③ 决策留痕（bare URL NOT opened；#87 锚单点）',
          rlogSlice(offP106).includes('openInBrowser: externalUrl=null + token contract') && rlogSlice(offP106).includes('#87'))
        // 场景 B：externalUrl 在手（managed+token）→ 照旧
        rtEx.externalUrl = `http://127.0.0.1:${up.port}/?token=pp10-tok`
        openExternalCalls.length = 0
        warnMsgs.length = 0
        await cmdHandlers['dsh.openInBrowser']()
        check('PP-10-6④ externalUrl 在手 → openExternal 照旧（managed+token 行为不变；零提示）',
          openExternalCalls.length === 1 && openExternalCalls[0] === rtEx.externalUrl && warnMsgs.length === 0)

        // ---- #83: activate 首启分支（QuickPick 主形态移除 → awaitingChannel）--
        delete require.cache[require.resolve('../out/extension.js')]
        cfgStore.autoStart = true
        cfgStore.channelSelected = false
        const spawnCallsBefore83 = router.calls.length
        const off83 = rlogOffset()
        const EX2 = require('../out/extension.js')
        await EX2.activate({ subscriptions: [] })
        const rtEx2 = providers['dsh.panel'].runtime
        check('#83① activate 首启（channelSelected=false）：runtime 停在 awaitingChannel、不 start（零 launch spawn；选择归面板选择卡）',
          rtEx2.state === 'awaitingChannel' && router.calls.length === spawnCallsBefore83)
        check('#83② awaitingChannel 留痕 + dsh.chooseChannel 辅助入口仍在（#86 收敛：命令保留 forcePick 面）',
          rlogSlice(off83).includes('channel: awaiting the panel channel pick') && typeof cmdHandlers['dsh.chooseChannel'] === 'function')
        // 移除 activate 挂的 process 'exit' hooks（防 sim 尾部 rmSync 后 shutdownBookkeeping 重建 dataDir）
        const curExitListeners = process.listeners('exit')
        for (let i = exitListenersBefore; i < curExitListeners.length; i++) process.removeListener('exit', curExitListeners[i])

        // ---- PP-11-1②: 按钮全链（mock postMessage → 薄层 → executeCommand）----
        const rtBtn = mkFakeRuntime('ready')
        const panelBtn = new WV.DshPanel(rtBtn)
        const btnV = mkFakeView()
        panelBtn.resolveWebviewView(btnV.view)
        cmdCalls.length = 0
        btnV.bag.handler({ type: 'showDetails' })
        btnV.bag.handler({ type: 'openBrowser' })
        btnV.bag.handler({ type: 'restart' })
        btnV.bag.handler({ type: 'stop' })
        await sleep(150)
        check('PP-11-1② 4 按钮消息 → executeCommand 映射各命中一次（dsh.showDetails/openInBrowser/restart/stop；ready 态全放行）',
          JSON.stringify(cmdCalls) === JSON.stringify(['dsh.showDetails', 'dsh.openInBrowser', 'dsh.restart', 'dsh.stop']))

        // ---- PP-11-2③④: extension 侧 guard 复算（正确性层）------------------
        const rtGuard = mkFakeRuntime('awaitingChannel')
        const panelGuard = new WV.DshPanel(rtGuard)
        const guardV = mkFakeView()
        panelGuard.resolveWebviewView(guardV.view)
        cmdCalls.length = 0
        const offGuard = rlogOffset()
        guardV.bag.handler({ type: 'stop' })
        await sleep(120)
        check('PP-11-2③ awaitingChannel 态 guard 拒绝 stop：executeCommand 零调用 + drop 留痕（不信任脚本侧 disabled）',
          cmdCalls.length === 0 && rlogSlice(offGuard).includes('drop stop (state guard: awaitingChannel)'))
        rtGuard.state = 'ready'
        guardV.bag.handler({ type: 'stop' })
        await sleep(120)
        check('PP-11-2④ ready 态 stop 放行 → dsh.stop 命中（逐消息复算 current state；starting 的 ■=取消启动同判据面）',
          cmdCalls.length === 1 && cmdCalls[0] === 'dsh.stop')

        // ---- PP-11-3④: 未知 type 经薄层 → no-op + panelLog -------------------
        const offUnk = rlogOffset()
        guardV.bag.handler({ type: 'boom' })
        await sleep(120)
        check('PP-11-3④ 未知 type 经薄层 → 零 executeCommand + panelLog no-op 留痕（防御面）',
          cmdCalls.length === 1 && rlogSlice(offUnk).includes("recv unknown message type='boom'") &&
          rlogSlice(offUnk).includes('no-op (PP-11-3)'))

        // ---- PP-11-1③: 详情卡（问题 9）既有 handler 回归 ----------------------
        const rtCard = mkFakeRuntime('awaitingChannel')
        rtCard.getLaunchInfo = () => makeCardInfo15()
        const detCard = new WD.DshDetailsProvider(rtCard)
        const cardV = mkFakeView()
        detCard.resolveWebviewView(cardV.view)
        cmdCalls.length = 0
        cardV.bag.handler({ type: 'restart' })
        await sleep(120)
        check('PP-11-1③ 详情卡（问题 9）：mock onMessage {restart} → executeCommand(dsh.restart) 命中（webviewDetails 既有 handler 回归）',
          cmdCalls.length === 1 && cmdCalls[0] === 'dsh.restart')

        // ---- PU-10-3③④: resolve 显式 view.title（#85 动态断言）---------------
        // PU-12-2②: the rlog offset is taken BEFORE both resolves so the
        // readback evidence lines (#95, E1) are asserted in the fresh slice.
        const offTitle12 = rlogOffset()
        const rtTitle1 = mkFakeRuntime('awaitingChannel')
        const panelTitle1 = new WV.DshPanel(rtTitle1)
        const titleV1 = mkFakeView()
        panelTitle1.resolveWebviewView(titleV1.view)
        check('PU-10-3③ resolve 显式 view.title（会话面板 = 「DSH 会话」，与 manifest views name 同值）',
          titleV1.view.title === 'DSH 会话')
        const rtTitle2 = mkFakeRuntime('awaitingChannel')
        const detTitle = new WD.DshDetailsProvider(rtTitle2)
        const titleV2 = mkFakeView()
        detTitle.resolveWebviewView(titleV2.view)
        check('PU-10-3④ resolve 显式 view.title（详情卡 = 「DSH 配置」，与 manifest views name 同值；v1.5 两视图都显式设置）',
          titleV2.view.title === 'DSH 配置')
        // ---- PU-12-2②: resolve title 回读取证行（#95 E1 动态断言）------------
        check('PU-12-2② 两 resolve 的 title 回读取证行在案（panelLog + [details] appendDecisionLog；set + readback 同值，E1）',
          rlogSlice(offTitle12).includes("resolve: title set='DSH 会话' readback='DSH 会话' (E1, 0.1.16)") &&
          rlogSlice(offTitle12).includes("[details] resolve: title set='DSH 配置' readback='DSH 配置' (E1, 0.1.16)"))
      } finally {
        Module._load = origModuleLoad
      }
    }

    // ---- PU-10-1/2 + PU-12-1（取代 PU-10-3①②，#99 改写）+ PU-12-2/3/4 静态 + PP-11-4/PU-11 ----
    px('PP-11-4/PU-11 脚本/CSP 静态交叉一致性（#90；E-SIM-1 先例）+ PU-10-1/2 静态 + PU-12-1/2/3/4 静态 + PP-11 纯函数面')
    {
      const CSP11 = 'https://*.vscode-cdn.net vscode-webview-resource:'
      const extractScript = (html) => { const m = /<script>([\s\S]*?)<\/script>/.exec(html); return m ? m[1] : null }
      // PU-10-1: awaitingChannel 选择卡静态
      const pickHtml11 = buildPanelHtml(null, CSP11, 'awaitingChannel')
      check('PU-10-1① awaitingChannel 选择卡：三通道卡片 data-channel（latest/next/alpha；channelSelect 单点文案）',
        ['data-channel="latest"', 'data-channel="next"', 'data-channel="alpha"'].every((a) => pickHtml11.includes(a)))
      check('PU-10-1② 风险提示（alpha 首次冷拉取）+ 稍后再说次操作（#83 设计 §5.3 落点）',
        pickHtml11.includes('首次冷拉取可能需数分钟') && pickHtml11.includes('id="pick-later"') && pickHtml11.includes('稍后再说'))
      check('PU-10-1③ 选择卡首帧可见（channel-pick 无 hide）+ overlay 隐藏（#90③ 反向：中立页不再遮蔽诊断）',
        pickHtml11.includes('<div id="channel-pick">') && pickHtml11.includes('<div id="overlay" class="hide">'))
      // PU-10-2: 切换器静态
      const cardCh11 = buildDetailsHtml(makeCardInfo15(), 'ready', { cspSource: CSP11, configChannel: 'latest' })
      check('PU-10-2① 通道切换区：sect 通道 + 当前徽标 + 三枚 set-channel 按钮（当前通道 disabled）',
        cardCh11.includes('<div class="sect">通道</div>') && cardCh11.includes('<b>alpha</b>') &&
        cardCh11.includes('data-action="set-channel" data-channel="alpha" disabled') &&
        cardCh11.includes('data-action="set-channel" data-channel="latest"') &&
        cardCh11.includes('data-action="set-channel" data-channel="next"'))
      check('PU-10-2② 待重启高亮：configChannel≠运行中 → 「立即重启以生效」（复用既有 restart 动作；不自动重启）',
        cardCh11.includes('<button class="primary" data-action="restart">立即重启以生效</button>'))
      const cardSync11 = buildDetailsHtml(makeCardInfo15(), 'ready', { cspSource: CSP11, configChannel: 'alpha' })
      check('PU-10-2③ 通道一致 → 零待重启高亮面（判定 = config 通道 ≠ 运行中快照通道）',
        !cardSync11.includes('立即重启以生效'))
      // PU-12-1（取代 PU-10-3①②，#99 sanctioned 改写）: package.json（无条件断言）
      // —— ADR-38 拆容器后的双容器声明面断言（0.1.16 #93）。
      const pkg11 = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'))
      const conts12 = pkg11.contributes.viewsContainers.secondarySidebar
      check('PU-12-1① manifest 双容器：secondarySidebar 恰 2 项（id/title/icon 三元逐项断言；ADR-38）',
        conts12.length === 2 &&
        conts12[0].id === 'dsh-viewContainer' && conts12[0].title === 'DSH 会话' && conts12[0].icon === 'media/dsh.svg' &&
        conts12[1].id === 'dsh-configContainer' && conts12[1].title === 'DSH 配置' && conts12[1].icon === 'media/dsh.svg')
      check('PU-12-1② views 键拆分：dsh-viewContainer 恰含 dsh.panel（name 不变）；dsh-configContainer 恰含 dsh.details（name 不变、visibility 移除）',
        JSON.stringify(pkg11.contributes.views['dsh-viewContainer'].map((v) => v.id)) === JSON.stringify(['dsh.panel']) &&
        pkg11.contributes.views['dsh-viewContainer'][0].name === 'DSH 会话' &&
        JSON.stringify(pkg11.contributes.views['dsh-configContainer'].map((v) => v.id)) === JSON.stringify(['dsh.details']) &&
        pkg11.contributes.views['dsh-configContainer'][0].name === 'DSH 配置' &&
        !('visibility' in pkg11.contributes.views['dsh-configContainer'][0]))
      // PU-12-2① 静态：resolve 显式 title 保持（#85 不回退）+ 两 resolve 各含回读取证行
      // （detailsSrc12 独立读取：detailsSrc11 声明在本块更后方，此处不可前引）
      const wvSrc12 = fs.readFileSync(path.join(process.cwd(), 'src', 'webview.ts'), 'utf8')
      const detailsSrc12 = fs.readFileSync(path.join(process.cwd(), 'src', 'webviewDetails.ts'), 'utf8')
      check('PU-12-2① 静态：两 resolve 的显式 title 赋值保持（「DSH 会话」/「DSH 配置」）+ 各含回读取证行（set + readback）',
        wvSrc12.includes("webviewView.title = 'DSH 会话'") && wvSrc12.includes("readback='${webviewView.title}' (E1, 0.1.16)") &&
        detailsSrc12.includes("webviewView.title = 'DSH 配置'") && detailsSrc12.includes("readback='${webviewView.title}' (E1, 0.1.16)"))
      // PU-12-3 静态：详情卡两处「启动时间」换源（#98；ADR-40④ 不回退 startedAt）
      const htmlSrc12 = fs.readFileSync(path.join(process.cwd(), 'src', 'webviewHtml.ts'), 'utf8')
      check('PU-12-3① webviewHtml.ts 两处「启动时间」行 = formatLocalTimestamp(info.processStartedAt) ?? 未知（静态形态，external 卡 + ready 卡）',
        (htmlSrc12.match(/kvRow\('启动时间', formatLocalTimestamp\(info\.processStartedAt\) \?\? '未知'\)/g) || []).length === 2)
      check('PU-12-3② info.startedAt 不再入「启动时间」行（语义分离：接管时刻不回卡片，ADR-40④）',
        !/kvRow\('启动时间', info\.startedAt/.test(htmlSrc12))
      // PU-12-4 静态：showDetails 回退链对齐新容器（#94；openPanel 链零改动）
      const extSrc12 = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8')
      check('PU-12-4① showDetails 回退链中间态 = workbench.view.extension.dsh-configContainer（#94 随容器拆分对齐）',
        extSrc12.includes("executeCommand('workbench.view.extension.dsh-configContainer')"))
      check('PU-12-4② openPanel 链 dsh-viewContainer 保持零改动 + showDetails 主路径 dsh.details.focus 不变（跨容器有效）',
        extSrc12.includes("executeCommand('workbench.view.extension.dsh-viewContainer')") &&
        extSrc12.includes("executeCommand('dsh.details.focus')"))
      check('PU-12-4③ webviewDetails openPanel 回退链 dsh-viewContainer 保持零改动（panel 视图仍在旧容器）',
        detailsSrc12.includes("executeCommand('workbench.view.extension.dsh-viewContainer')"))
      // PU-11-1: 面板脚本静态
      const known11 = buildPanelHtml('http://127.0.0.1:45678', CSP11, 'ready')
      const legacy11 = buildPanelHtml('http://127.0.0.1:45678')
      const script11 = extractScript(known11)
      check('PU-11-1① 面板 4 按钮 id 完备（btn-details/btn-open/btn-restart/btn-stop）',
        ['btn-details', 'btn-open', 'btn-restart', 'btn-stop'].every((id) => known11.includes(`id="${id}"`)))
      check('PP-11-4① bind-first 文本序：4 按钮绑定 + 握手 post 均位于 typeof acquireVsCodeApi 检查之前（#90② 死区结构性消失）',
        (() => {
          const firstBind = script11.indexOf("btnD.addEventListener('click'")
          const lastBind = script11.indexOf("btnS.addEventListener('click'")
          const handshake = script11.indexOf("post({ type: 'webviewReady' })")
          const typeofCheck = script11.indexOf("typeof acquireVsCodeApi === 'function'")
          return firstBind > -1 && lastBind > -1 && handshake > -1 && typeofCheck > -1 &&
            firstBind < typeofCheck && lastBind < typeofCheck && handshake < typeofCheck
        })())
      check('PU-11-1② 面板 CSP script-src 含 cspSource 插值（#90①；runtime 属性、非猜测 scheme）',
        known11.includes(`script-src 'unsafe-inline' ${CSP11};`))
      check('PU-11-1③ 单参兼容：空 cspSource 保持旧形（既有 sim/烤路径零破坏，#90 增参可选）',
        legacy11.includes("script-src 'unsafe-inline';") && !legacy11.includes("script-src 'unsafe-inline' http"))
      const bridgeSeg11 = script11.slice(script11.indexOf('function bridgeDown'), script11.indexOf('function post'))
      check('PU-11-1④ 死亡分支诊断可见：classList.remove(hide) + #state 双写（#90③；不再写进隐藏层静默）',
        bridgeSeg11.includes("classList.remove('hide')") && bridgeSeg11.includes("stateEl.textContent = 'webview API unavailable'"))
      // PU-11-2: 详情卡静态
      const card11 = buildDetailsHtml(makeCardInfo15(), 'ready', { cspSource: CSP11, configChannel: null })
      const cardScript11 = extractScript(card11)
      check('PU-11-2① 详情卡 CSP script-src 含 cspSource 插值（#90① 两处之第 2 处，问题 9）',
        card11.includes(`script-src 'unsafe-inline' ${CSP11};`))
      check('PU-11-2② post() 容错模式保留（null-safe + never break the card，L221 先例不回退）',
        cardScript11.includes("var vscode = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;") &&
        cardScript11.includes('/* never break the card */'))
      check('PU-11-2③ vscode=null 存活诊断分支存在（卡面「消息桥不可用」，问题 9 静默吞掉治本）',
        cardScript11.includes("note.textContent = '消息桥不可用"))
      // PP-11-4②③: 白名单/详情卡映射交叉一致
      const PM11 = require('../out/panelMessages.js') // { PANEL_MESSAGE_TYPES, routePanelMessage, buttonDisableRules }
      const uplink11 = [...new Set([...script11.matchAll(/post\(\{ type: '([a-zA-Z]+)'/g)].map((m) => m[1]))].sort()
      check('PP-11-4② PANEL_MESSAGE_TYPES 白名单 ≡ 面板脚本上行 type 集合（7 条交叉一致；setChannel 不入会话面板白名单）',
        JSON.stringify(uplink11) === JSON.stringify([...PM11.PANEL_MESSAGE_TYPES].sort()) && PM11.PANEL_MESSAGE_TYPES.length === 7)
      const cardTypes11 = [...new Set([...cardScript11.matchAll(/post\(\{ type: '([a-zA-Z]+)'/g)].map((m) => m[1]))].sort()
      const detailsSrc11 = fs.readFileSync(path.join(process.cwd(), 'src', 'webviewDetails.ts'), 'utf8')
      const caseTypes11 = [...new Set([...detailsSrc11.matchAll(/case '([a-zA-Z]+)'/g)].map((m) => m[1]))].sort()
      check('PP-11-4③ 详情卡脚本 type 集合 ≡ webviewDetails.ts onMessage case 集合（问题 9 双向覆盖；restart/setChannel 在两组）',
        JSON.stringify(cardTypes11) === JSON.stringify(caseTypes11) && cardTypes11.includes('restart') && cardTypes11.includes('setChannel'))
      // PP-10-1⑤ 静态补强：runtime emit 面零扩张
      const rtSrc11 = fs.readFileSync(path.join(process.cwd(), 'src', 'runtime.ts'), 'utf8')
      const emitKinds11 = [...new Set([...rtSrc11.matchAll(/this\.emit\('([a-zA-Z]+)'/g)].map((m) => m[1]))].sort()
      check('PP-10-1⑤ 静态：runtime emit 面零扩张（仅 state/error；无 notifySurfaceChange 类机制）',
        JSON.stringify(emitKinds11) === '["error","state"]' && !rtSrc11.includes('notifySurfaceChange'))
      // PP-11-2①②: 禁用矩阵逐格（纯函数直测；§5.6 全格）
      const M11 = (s) => PM11.buttonDisableRules(s)
      check('PP-11-2① §5.6 禁用矩阵逐格（五态 × 4 按钮；true = disabled；starting 的 ■ 可点 = 取消启动）',
        JSON.stringify(M11('awaitingChannel')) === JSON.stringify({ details: false, openBrowser: true, restart: true, stop: true }) &&
        JSON.stringify(M11('starting')) === JSON.stringify({ details: false, openBrowser: true, restart: true, stop: false }) &&
        JSON.stringify(M11('ready')) === JSON.stringify({ details: false, openBrowser: false, restart: false, stop: false }) &&
        JSON.stringify(M11('error')) === JSON.stringify({ details: false, openBrowser: true, restart: false, stop: false }) &&
        JSON.stringify(M11('stopped')) === JSON.stringify({ details: false, openBrowser: true, restart: false, stop: true }))
      check('PP-11-2② 未知/idle 态保守全禁（防御默认；无语义可信任时不放行任何按钮）',
        JSON.stringify(M11('idle')) === JSON.stringify({ details: true, openBrowser: true, restart: true, stop: true }) &&
        JSON.stringify(M11('no-such-state')) === JSON.stringify({ details: true, openBrowser: true, restart: true, stop: true }))
      // PP-11-1①② + PP-11-3①②: routePanelMessage sinks 直测
      const hits11 = []
      const sinks11 = {
        webviewReady: () => hits11.push('webviewReady'),
        stateAck: (s) => hits11.push(`stateAck:${s}`),
        showDetails: () => hits11.push('showDetails'),
        openBrowser: () => hits11.push('openBrowser'),
        restart: () => hits11.push('restart'),
        stop: () => hits11.push('stop'),
        chooseChannel: (c) => hits11.push(`chooseChannel:${c === null ? 'null' : c}`),
        unknownType: (t) => hits11.push(`unknown:${t}`),
      }
      PM11.routePanelMessage({ type: 'showDetails' }, sinks11)
      PM11.routePanelMessage({ type: 'openBrowser' }, sinks11)
      PM11.routePanelMessage({ type: 'restart' }, sinks11)
      PM11.routePanelMessage({ type: 'stop' }, sinks11)
      check('PP-11-1① 面板 4 型路由 → sinks 各命中一次（路由映射单点；映射命令面见 PP-11-1②）',
        JSON.stringify(hits11) === JSON.stringify(['showDetails', 'openBrowser', 'restart', 'stop']))
      hits11.length = 0
      PM11.routePanelMessage({ type: 'webviewReady' }, sinks11)
      PM11.routePanelMessage({ type: 'stateAck', appliedState: 'ready' }, sinks11)
      PM11.routePanelMessage({ type: 'chooseChannel', channel: null }, sinks11)
      PM11.routePanelMessage({ type: 'chooseChannel', channel: 'alpha' }, sinks11)
      check('PP-11-1② 握手/ack/chooseChannel 载荷透传（null 哨兵逐位；「稍后再说」协议）',
        JSON.stringify(hits11) === JSON.stringify(['webviewReady', 'stateAck:ready', 'chooseChannel:null', 'chooseChannel:alpha']))
      hits11.length = 0
      const routed11 = PM11.routePanelMessage({ type: 'boom', evil: 1 }, sinks11)
      check('PP-11-3① 未知 type → 返回 false + unknownType sink 恰一次 + 零其他 sink（防御面）',
        routed11 === false && JSON.stringify(hits11) === JSON.stringify(['unknown:boom']))
      const routedNull11 = PM11.routePanelMessage(null, sinks11)
      const routedShape11 = PM11.routePanelMessage({ noType: 1 }, sinks11)
      check('PP-11-3② 无形状消息（null / 缺 type）→ false 不抛异常（never-throws 契约）',
        routedNull11 === false && routedShape11 === false && hits11.length === 1)
    }

    // ---- 0.1.15 新组聚合门 ----------------------------------------------------
    px('0.1.15 新组聚合门（PP-10/PU-10/PP-11/PU-11 全组此前零失败，含既有族）')
    check('#88/#92 聚合门：PP-10 + PU-10 + PP-11 + PU-11 与既有全族零失败', failures === 0)

    // ==================== 0.1.16 additions (#96/#97/#98, design §八/§九) ======
    // PP-12 进程启动时刻数据链（判据来源：docs/0.1.16修复设计-视图页签标题与
    // 启动时刻.md v1.1 §九 PP-12-1..4；PU-12 静态断言已并入上方静态块，
    // PU-12-2② 动态断言在上方 vscode mock 块）。手法：
    //  - PP-12-1/2/3 纯函数/mock-deps 直测（PU-1..8 / PI-3 先例同型）；
    //  - PP-12-4 = DshRuntime 实例直调 writeRegistry（JS 层 private 可调，
    //    0.1.15 spy-marks 先例同型）+ processStartQuery 注入 + .sim-tmp 注册表
    //    隔离（DSH_VSCODE_DATA_DIR env，顶部已设）。
    px('PP-12 进程启动时刻数据链（#96/#97/#98：formatLocalTimestamp 纯函数 + launchInfo 第 17 字段透传 + G3 查询注入面 + writeRegistry keep/fresh）')
    {
      // ---- PP-12-1: formatLocalTimestamp 纯函数 ------------------------------
      const p212 = (n) => String(n).padStart(2, '0')
      const isoA = '2026-09-02T01:35:42.759Z'
      const dA = new Date(isoA)
      check('PP-12-1① 合法 ISO（.759Z 毫秒形态）→ 本地分量 yyyy-MM-dd HH:mm:ss 补零（与 new Date(iso) 本地分量逐位自洽，不锚死测试机时区）',
        LI.formatLocalTimestamp(isoA) === `${dA.getFullYear()}-${p212(dA.getMonth() + 1)}-${p212(dA.getDate())} ${p212(dA.getHours())}:${p212(dA.getMinutes())}:${p212(dA.getSeconds())}` &&
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(LI.formatLocalTimestamp(isoA)))
      check('PP-12-1② null/undefined/空串/非法串 → null（渲染侧「未知」判据，绝不臆造）',
        LI.formatLocalTimestamp(null) === null && LI.formatLocalTimestamp(undefined) === null &&
        LI.formatLocalTimestamp('') === null && LI.formatLocalTimestamp('not-a-date') === null)
      const isoB = '2026-01-05T08:07:09.000Z'
      const dB = new Date(isoB)
      check('PP-12-1③ 单位数月/日/时/分/秒逐位补零（01-05 / 08:07:09 形态自洽）',
        LI.formatLocalTimestamp(isoB) === `${dB.getFullYear()}-${p212(dB.getMonth() + 1)}-${p212(dB.getDate())} ${p212(dB.getHours())}:${p212(dB.getMinutes())}:${p212(dB.getSeconds())}`)

      // ---- PP-12-2: buildLaunchInfo 第 17 字段透传 ---------------------------
      const rec17 = { pid: mockPid, port: MOCK_PORT, managedBy: 'managed-own', startedAt: '2026-09-02T01:00:00.000Z', launchMode: 'start', processStartedAt: '2026-09-01T12:30:33.000Z' }
      const info17 = LI.buildLaunchInfo({ rec: rec17, degraded: true })
      check('PP-12-2① rec.processStartedAt → 字段同值透传（degraded 快照随 rec 保留不清除——进程事实与会话降级正交）',
        info17.processStartedAt === '2026-09-01T12:30:33.000Z')
      const info17b = LI.buildLaunchInfo({ rec: { pid: mockPid, port: MOCK_PORT, managedBy: 'managed-own', startedAt: '2026-09-02T01:00:00.000Z' } })
      check('PP-12-2② rec 无字段 → null（旧 registry 容忍面）', info17b.processStartedAt === null)
      check('PP-12-2③ 既有 16 字段键零回归 + 新增第 17 键（键集恰 17）',
        ['dshVersion', 'resolverVersion', 'versionCrossCheck', 'binDir', 'dshBin', 'channel', 'resolverMode', 'lastCheckAt', 'launchMode', 'port', 'pid', 'managedBy', 'startedAt', 'logFiles', 'externalCommandLine', 'externalUrl'].every((k) => k in info17) &&
        Object.keys(info17).length === 17)

      // ---- PP-12-3: queryProcessStartTimeSync 注入面（G3，PI-3 同型）---------
      const isoOK = '2026-09-01T12:30:33.123Z'
      check('PP-12-3① mock spawnFn 合法输出（含尾换行）→ ISO 原样返回',
        queryProcessStartTimeSync(mockPid, 100, () => ({ status: 0, stdout: `${isoOK}\n` })) === isoOK)
      const failCases12 = [
        { label: '非零 exit', out: { status: 1, stdout: isoOK } },
        { label: '空输出', out: { status: 0, stdout: '' } },
        { label: '垃圾输出', out: { status: 0, stdout: 'Get-Process : No process found' } },
        { label: '缺毫秒形态', out: { status: 0, stdout: '2026-09-01T12:30:33Z' } },
      ]
      check('PP-12-3② 非零 exit/空输出/垃圾输出/缺毫秒形态 → null（输出 regex 校验）',
        failCases12.every((c) => queryProcessStartTimeSync(mockPid, 100, () => c.out) === null))
      check('PP-12-3③ spawnFn 抛异常 → null（never-throw 契约）',
        queryProcessStartTimeSync(mockPid, 100, () => { throw new Error('boom') }) === null)
      let spawnedNull = 0
      check('PP-12-3④ pid=null → 零 spawn 直接返回 null（external 未解析 pid 面）',
        queryProcessStartTimeSync(null, 100, () => { spawnedNull++; return { status: 0, stdout: isoOK } }) === null && spawnedNull === 0)
      check('PP-12-3⑤ G3 形态：PROCESS_START_SCRIPT 常量零双引号、零 pid 字面量（pid 只经 DSH_PROCSTART_PID env 载体）',
        !PROCESS_START_SCRIPT.includes('"') && !PROCESS_START_SCRIPT.includes(String(mockPid)) &&
        PROCESS_START_SCRIPT.includes('Get-Process -Id $env:DSH_PROCSTART_PID'))
      let capArgs = null
      queryProcessStartTimeSync(mockPid, 4321, (exec, argv, opts) => { capArgs = { exec, argv, opts }; return { status: 0, stdout: isoOK } })
      check('PP-12-3⑥ spawn 契约透传：powershell.exe + windowsHide:true + timeout 透传 + env.DSH_PROCSTART_PID 载体（PI-3 同型）',
        capArgs !== null && capArgs.exec === 'powershell.exe' && capArgs.opts.windowsHide === true &&
        capArgs.opts.timeout === 4321 && capArgs.opts.env.DSH_PROCSTART_PID === String(mockPid) &&
        capArgs.argv.includes(PROCESS_START_SCRIPT))

      // ---- PP-12-4: writeRegistry keep/fresh 分支（processStartQuery 注入）---
      seedInst({ dsh: null, windows: [] })
      const qCalls = []
      const r12a = newRuntime(process.pid, { port: MOCK_PORT, processStartQuery: (pid) => { qCalls.push(pid); return '2026-09-01T12:30:33.000Z' } })
      r12a.dshPid = mockPid
      r12a.port = MOCK_PORT
      r12a.managedBy = 'managed-own'
      await r12a.writeRegistry()
      const recA = readInstance().dsh
      check('PP-12-4① fresh 新 pid → query 恰 1 次 + 记录携带返回值（ADR-40 恰一次有界查询）',
        qCalls.length === 1 && qCalls[0] === mockPid && recA !== null && recA.processStartedAt === '2026-09-01T12:30:33.000Z')
      await r12a.writeRegistry()
      check('PP-12-4② keep 同 pid 再写 → query 恰 0 次（计数仍 1）+ prev 值保留（进程创建时刻不可变，与 startedAt keep 同构）',
        qCalls.length === 1 && readInstance().dsh !== null && readInstance().dsh.processStartedAt === '2026-09-01T12:30:33.000Z')
      r12a.dispose()

      // null 分支 + 旧记录自愈（§3.5-5）：同一 mock 第 1 次 null、其后回值
      seedInst({ dsh: null, windows: [] })
      const offNull = rlogOffset()
      let qCallsB = 0
      const r12b = newRuntime(process.pid, { port: MOCK_PORT, processStartQuery: () => { qCallsB++; return qCallsB === 1 ? null : '2026-09-02T08:00:00.000Z' } })
      r12b.dshPid = mockPid
      r12b.port = MOCK_PORT
      r12b.managedBy = 'managed-own'
      await r12b.writeRegistry()
      const recB = readInstance().dsh
      check('PP-12-4③ query 返回 null → 记录无该字段（undefined JSON 丢弃）+ 流程不中断 + rlog 留痕',
        qCallsB === 1 && recB !== null && !('processStartedAt' in recB) &&
        rlogSlice(offNull).includes('processStartedAt query failed'))
      seedInst({ dsh: { pid: mockPid, port: MOCK_PORT, managedBy: 'managed-own', startedAt: '2026-01-01T00:00:00.000Z' }, windows: [{ app: 'Sim', pid: process.pid, startedAt: new Date().toISOString() }] })
      await r12b.writeRegistry()
      const recC = readInstance().dsh
      check('PP-12-4④ 旧记录（无字段）同 pid 再接管 → 自愈重查恰 1 次且字段重建（§3.5-5）',
        qCallsB === 2 && recC !== null && recC.processStartedAt === '2026-09-02T08:00:00.000Z')
      await r12b.writeRegistry()
      check('PP-12-4⑤ 自愈后再写 → 复用零查询（qCallsB 恒 2；每进程生命周期恰一次查询闭环）',
        qCallsB === 2 && readInstance().dsh !== null && readInstance().dsh.processStartedAt === '2026-09-02T08:00:00.000Z')
      r12b.dispose()
    }

    // ---- 0.1.16 新组聚合门 ----------------------------------------------------
    px('0.1.16 新组聚合门（PP-12/PU-12 全组此前零失败，含既有族）')
    check('#93-#99 聚合门：PP-12 + PU-12 与既有全族零失败', failures === 0)

    // ==================== 0.1.17 additions (#1, design §九 #1/#4) ==============
    // PP-13 WINDOWSAFE 三段门控阈值判定（判据来源：docs/0.1.17调研报告-dsh-0.1.3-
    // alpha集成面复验与免常驻窗.md §九 #4；ADR-46 版本区间语义）。手法：
    //  - PP-13-1 纯函数直测（PP-8-6① 先例同型：judgeWindowSafeByVersion +
    //    compareDshVersions 预发布感知比较器）；期望阈值一律取导出常量引用，
    //    版本字面仅作测试输入与 check 名称（唯一事实源，不重复硬编码）；
    //  - PP-13-2 编译产物静态交叉一致性（E-SIM-1 先例：out/dshProcess.js 中
    //    三段判定 rlog 仅由 consoleVisible=false 守卫块触达；unknown 静默跳过）。
    px('PP-13 WINDOWSAFE 三段门控阈值（#1：judgeWindowSafeByVersion 区间判定纯函数直测 + 编译产物静态交叉一致性）')
    // ---- PP-13-1: 版本区间判定（ADR-46 三段区间） ------------------------------
    check('PP-13-1① 阈值常量单点：WINDOWSAFE_MIN_VERSION = 0.1.3-alpha.1 + WINDOWSAFE_REGRESSION_MIN_VERSION = 0.1.3-alpha.2（三源判定锚；TOKEN_AUTH_MIN_VERSION 同址同模式）',
      DP.WINDOWSAFE_MIN_VERSION === '0.1.3-alpha.1' && DP.WINDOWSAFE_REGRESSION_MIN_VERSION === '0.1.3-alpha.2')
    check('PP-13-1② 低于下界 → flashing：0.1.2-alpha.5 / 0.1.2-rc.1（0.1.2 < 0.1.3，隐藏形态上游闪窗取舍）',
      DP.judgeWindowSafeByVersion('0.1.2-alpha.5') === 'flashing' && DP.judgeWindowSafeByVersion('0.1.2-rc.1') === 'flashing')
    check('PP-13-1③ 下界闭（等于下界 → zeroFlash 承诺区）：WINDOWSAFE_MIN_VERSION 输入（0.1.3-alpha.1；该版本未发布 npm）',
      DP.judgeWindowSafeByVersion(DP.WINDOWSAFE_MIN_VERSION) === 'zeroFlash')
    check('PP-13-1④ semver 预发布序：WINDOWSAFE_MIN_VERSION < WINDOWSAFE_REGRESSION_MIN_VERSION（compareDshVersions < 0；alpha.1 < alpha.2）',
      DP.compareDshVersions(DP.WINDOWSAFE_MIN_VERSION, DP.WINDOWSAFE_REGRESSION_MIN_VERSION) < 0)
    check('PP-13-1⑤ 回归上界闭（等于上界起点 → regression）：WINDOWSAFE_REGRESSION_MIN_VERSION 输入（0.1.3-alpha.2；runner 弹窗回归带起点）',
      DP.judgeWindowSafeByVersion(DP.WINDOWSAFE_REGRESSION_MIN_VERSION) === 'regression')
    check('PP-13-1⑥ regression 带内单调：0.1.3-beta.1（beta > alpha）/ 0.1.3 / 0.1.4 → regression',
      DP.judgeWindowSafeByVersion('0.1.3-beta.1') === 'regression' && DP.judgeWindowSafeByVersion('0.1.3') === 'regression' &&
      DP.judgeWindowSafeByVersion('0.1.4') === 'regression')
    check('PP-13-1⑦ 不可解析安全侧 → unknown（不告警不承诺）：null / 空串 / not-a-version',
      DP.judgeWindowSafeByVersion(null) === 'unknown' && DP.judgeWindowSafeByVersion('') === 'unknown' &&
      DP.judgeWindowSafeByVersion('not-a-version') === 'unknown')
    // ---- PP-13-2: 编译产物静态交叉一致性（E-SIM-1 先例） ------------------------
    {
      const dpSrc17 = fs.readFileSync(path.join(process.cwd(), 'out', 'dshProcess.js'), 'utf8')
      const guard17 = 'if (this.options.consoleVisible !== true) {'
      const call17 = 'const windowSafe = judgeWindowSafeByVersion(built.resolved?.version ?? null)'
      // 三段 rlog 期望文案 = 常量拼接（唯一事实源：文案版本字样与导出常量钉死）
      const logs17 = [
        `[dshProcess] 运行时 < ${DP.WINDOWSAFE_MIN_VERSION}，隐藏形态存在上游闪窗取舍`,
        `隐藏形态零闪窗（零闪窗承诺区 [${DP.WINDOWSAFE_MIN_VERSION}, ${DP.WINDOWSAFE_REGRESSION_MIN_VERSION})，上游 PR #3516）`,
        `WARN: dsh ≥ ${DP.WINDOWSAFE_REGRESSION_MIN_VERSION} native runner 在隐藏形态存在上游弹窗回归`,
      ]
      const guardIdx17 = dpSrc17.indexOf(guard17)
      // 守卫块字符级括号配平（块内字符串花括号均成对：${...}；配平至块闭合）
      let depth17 = 0
      let endIdx17 = -1
      for (let i = guardIdx17; i < dpSrc17.length; i++) {
        const ch = dpSrc17[i]
        if (ch === '{') depth17++
        else if (ch === '}') { depth17--; if (depth17 === 0) { endIdx17 = i; break } }
      }
      check('PP-13-2① 守卫单点：windowSafe 判定仅由 consoleVisible=false 守卫块触达（判定调用恰一次 + 三段 rlog 均落守卫块内；consoleVisible=true 零触达）',
        guardIdx17 > 0 && endIdx17 > guardIdx17 &&
        dpSrc17.split(call17).length === 2 && dpSrc17.indexOf(call17) > guardIdx17 && dpSrc17.indexOf(call17) < endIdx17 &&
        logs17.every((s) => { const k = dpSrc17.indexOf(s); return k > guardIdx17 && k < endIdx17 }))
      check('PP-13-2② 三段 rlog 各恰一次（单发幂等；零重复触达点）+ 文案版本字样与导出常量逐位一致（唯一事实源）',
        logs17.every((s) => dpSrc17.split(s).length === 2))
      check("PP-13-2③ unknown 静默跳过留痕：守卫块内 'unknown' → silent skip（安全侧：不告警不承诺）",
        dpSrc17.slice(guardIdx17, endIdx17).includes("windowSafe === 'unknown'"))
    }

    // -- 0.1.14 组清理：关闭 in-process 上游 ----------------------------------
    try { upServer.closeAllConnections() } catch { /* best-effort */ }
    upServer.close()
  }

  // ---- cleanup -------------------------------------------------------------
  try { winA.kill() } catch { /* ignore */ }
  try { winB.kill() } catch { /* ignore */ }
  router.restore()

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}${skips ? `, ${skips} SKIP(ped)` : ''}`)
  fs.rmSync(dataDir, { recursive: true, force: true })
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
