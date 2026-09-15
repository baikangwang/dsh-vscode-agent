// Pure (no vscode dependency) builders for the DSH webview documents:
// - buildPanelHtml: the right-side-bar panel — static top-status baking
//   (P0-G / ADR-3) + toolbar (ⓘ details / ↗ / ⟳ / ■). The page script below
//   is an enhancement layer (toolbar / ack handshake / error text).
// - buildDetailsHtml: the dsh.details view card (ADR-22, 0.1.9 §4.7) — one
//   single-point template for all five phases (empty / error / ready /
//   stopped-user / stopped-disconnected), runtime values baked via escapeAttr
//   (转义插值，运行时数据不进未转义拼接), copy actions carried in
//   data-clipboard/data-path attributes (attribute escaping is reversible →
//   the clipboard content equals the VISIBLE string, PU-4).
//
// 去硬编码 constraint: the baked src/state text is the ONLY thing derived from
// `url` (always runtime.url). No host/port/http-prefix literal is written here
// or in the page script; the CSP `frame-src http://127.0.0.1:*` (panel only —
// the details card embeds NOTHING, hence no frame-src) is a hard-coded
// security constraint and stays unchanged.
//
// 0.1.15 #90 (问题 8/9 三层修复, ADR-35): ① both CSP templates interpolate
// `cspSource` (the caller passes the runtime `webview.cspSource` property —
// never a guessed scheme) into `script-src`; ② the panel script is BIND-FIRST:
// every binding attaches BEFORE the `typeof acquireVsCodeApi` check (the
// 0.1.14 dead zone — bindings sat behind the early return and never ran), and
// handlers degrade VISIBLELY when the bridge is down; ③ the dead-bridge
// diagnostics are made visible (classList.remove('hide') + #state 双写) —
// no longer written into the initially-hidden overlay; ④ the details card
// gains a visible survival diagnostic (vscode=null → 「消息桥不可用」 card-top
// note) while its null-safe/event-delegation structure stays untouched.
// #83: the awaitingChannel channel-pick card (DOM always baked, shown/hidden
// by state); the button disable matrix (#91) is baked per state.
import type { DshLaunchInfo } from './launchInfo'
import { EXTERNAL_VERSION_MISMATCH_WARNING, EXTERNAL_VERSION_NOTE_CMDLINE, formatLocalTimestamp } from './launchInfo'
import type { RuntimeState } from './runtime'
import { buttonDisableRules } from './panelMessages'
import { channelPickItems } from './channelSelect'
import { buildChannelUnknownNote, channelSourceNote, type ChannelSource } from './channelProbe'

/** Every RuntimeState, for the baked per-state disable matrix (single source). */
const PANEL_STATES: readonly RuntimeState[] = ['idle', 'awaitingChannel', 'starting', 'ready', 'error', 'stopped']

export function buildPanelHtml(url: string | null, cspSource = '', state: RuntimeState = 'starting'): string {
  const known = url !== null && url !== ''
  const frameAttr = known ? ` style="display:block" src="${escapeAttr(url!)}"` : ''
  const awaiting = state === 'awaitingChannel'
  // #90③: the overlay starts hidden ONLY when a frame is baked or the pick
  // card owns the first frame (awaitingChannel) — the dead-bridge diagnostics
  // must be able to surface (the 0.1.14 bug wrote them into a hidden layer).
  const overlayCls = known || awaiting ? ' class="hide"' : ''
  const stateText = known ? `dsh · ${escapeAttr(url!)}` : 'initializing…'
  // #91 script-side UX layer: the full per-state disable matrix is baked so the
  // page applies `disabled` without any round-trip; the extension side re-checks.
  const disabledMatrix = JSON.stringify(Object.fromEntries(PANEL_STATES.map((s) => [s, buttonDisableRules(s)])))
  const dis = buttonDisableRules(state)
  const btnAttr = (d: boolean): string => (d ? ' disabled' : '')
  // #90①: `script-src` gains the runtime cspSource (caller passes
  // webview.cspSource; never a guessed scheme). Empty source = the pre-0.1.15
  // shape (compat with existing bakes / headless calls).
  const scriptSrc =
    cspSource !== null && cspSource.trim().length > 0 ? `'unsafe-inline' ${escapeAttr(cspSource.trim())}` : `'unsafe-inline'`
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  style-src 'unsafe-inline';
  script-src ${scriptSrc};
  frame-src http://127.0.0.1:*;
">
<style>
  html, body { margin: 0; padding: 0; height: 100%; display: flex; flex-direction: column;
    background: var(--vscode-sideBar-background); color: var(--vscode-foreground);
    font-family: var(--vscode-font-family); font-size: 12px; }
  #chrome { display: flex; align-items: center; gap: 4px; padding: 4px 6px;
    border-bottom: 1px solid var(--vscode-panel-border); flex: 0 0 auto; }
  #state { flex: 1; opacity: .75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  button { background: transparent; border: none; color: var(--vscode-icon-foreground);
    cursor: pointer; font-size: 12px; padding: 2px 6px; border-radius: 3px; }
  button:hover { background: var(--vscode-toolbar-hoverBackground); }
  button:disabled { opacity: .4; cursor: default; }
  button:disabled:hover { background: transparent; }
  #stage { flex: 1; position: relative; min-height: 0; }
  iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: none; }
  #overlay { position: absolute; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 8px; text-align: center; padding: 16px;
    box-sizing: border-box; white-space: pre-wrap; }
  #channel-pick { position: absolute; inset: 0; display: flex; flex-direction: column;
    gap: 6px; padding: 14px 16px; box-sizing: border-box; overflow: auto; }
  .pick-head { font-size: 13px; font-weight: 600; margin: 2px 0 4px; }
  .pick-card { display: flex; flex-direction: column; align-items: flex-start; text-align: left;
    border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px 10px; gap: 2px; }
  .pick-card .pick-label { font-weight: 600; font-size: 13px; }
  .pick-card .pick-detail { opacity: .75; font-size: 11px; white-space: normal; }
  #pick-later { align-self: center; margin-top: 4px; opacity: .8; }
  .hide { display: none !important; }
</style>
</head>
<body>
  <div id="chrome">
    <span id="state">${stateText}</span>
    <button id="btn-details" title="DSH 配置"${btnAttr(dis.details)}>ⓘ</button>
    <button id="btn-open" title="Open in browser"${btnAttr(dis.openBrowser)}>↗</button>
    <button id="btn-reconnect" title="重连（只认领运行实例，不拉起）"${btnAttr(dis.reconnect)}>⟳</button>
    <button id="btn-start" title="启动 dsh（有实例先认领，无实例拉起）"${btnAttr(dis.start)}>▶</button>
    <button id="btn-stop" title="Stop runtime"${btnAttr(dis.stop)}>■</button>
  </div>
  <div id="stage">
    <div id="overlay"${overlayCls}>initializing…</div>
    <div id="channel-pick"${awaiting ? '' : ' class="hide"'}>${channelPickCardHtml()}</div>
    <iframe id="frame" sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"${frameAttr}></iframe>
  </div>
<script>
(function () {
  // #91 script-side UX layer: the baked per-state disable matrix (extension
  // side re-computes the same rules per message — correctness layer).
  var DISABLE = ${disabledMatrix};
  var stateEl = document.getElementById('state');
  var overlayEl = document.getElementById('overlay');
  var frameEl = document.getElementById('frame');
  var pickEl = document.getElementById('channel-pick');
  var btnD = document.getElementById('btn-details');
  var btnO = document.getElementById('btn-open');
  var btnR = document.getElementById('btn-reconnect');
  var btnStart = document.getElementById('btn-start');
  var btnS = document.getElementById('btn-stop');
  // Boot observation (v4, item 3): prove the page script actually executed.
  // RV-16-11 取证口径：title「·booted」区分两候选死因（a: title 正常 + 握手缺失
  // = CSP 拦 shim / b: title 异常 = 脚本未执行）——语义保留。
  try {
    document.title += ' ·booted';
    console.log('[dsh-panel] page booted at', location.href);
    if (stateEl) stateEl.textContent = 'page booted…';
  } catch (e) { /* observation must never block the page */ }
  // 0.1.15 #90② bind-first: \`vscode\` is DECLARED here and assigned by the API
  // check BELOW — every binding attaches unconditionally, so the 0.1.14 dead
  // zone (bindings behind \`typeof acquireVsCodeApi\` + early return, never ran)
  // is structurally gone; a dead bridge degrades VISIBLELY on click.
  var vscode = null;
  var handshakeSent = false;
  function bridgeDown() {
    // #90③ 死亡诊断必须可见：#state 双写 + remove('hide')（不再写进隐藏层）。
    try {
      if (stateEl) stateEl.textContent = 'webview API unavailable';
      if (overlayEl) {
        overlayEl.textContent = 'Webview API 不可用（acquireVsCodeApi 未定义）。\\n\\n请反馈此信息给开发方；并检查 VSCode 扩展宿主日志中本 webview 的 CSP 报错。';
        overlayEl.classList.remove('hide');
      }
    } catch (e) { /* diagnostics must never break the panel */ }
  }
  function post(m) {
    if (!vscode) { bridgeDown(); return; }
    try { vscode.postMessage(m); } catch (e) { /* never break the panel */ }
  }
  // 握手 post（定义位于 API 检查之前——bind-first；实际发送在检查之后）。
  function sendHandshake() {
    if (handshakeSent) return;
    handshakeSent = true;
    post({ type: 'webviewReady' });
  }
  function setUrl(url) {
    if (frameEl.src === url) return;
    frameEl.src = url;
    frameEl.style.display = 'block';
    overlayEl.classList.add('hide');
  }
  function applyDisabled(st) {
    var m = DISABLE[st];
    if (!m) return;
    if (btnD) btnD.disabled = !!m.details;
    if (btnO) btnO.disabled = !!m.openBrowser;
    if (btnR) btnR.disabled = !!m.reconnect;
    if (btnStart) btnStart.disabled = !!m.start;
    if (btnS) btnS.disabled = !!m.stop;
  }
  function applyState(msg) {
    var st = msg.state;
    applyDisabled(st);
    if (pickEl) {
      if (st === 'awaitingChannel') {
        if (overlayEl) overlayEl.classList.add('hide');
        pickEl.classList.remove('hide');
      } else {
        pickEl.classList.add('hide');
      }
    }
    if (stateEl) stateEl.textContent = st === 'ready' ? ('dsh · ' + (msg.url || '')) : (st === 'awaitingChannel' ? '请选择 dsh 通道' : st);
    if (st === 'ready' && msg.url) setUrl(msg.url);
    else if (st === 'error') {
      overlayEl.textContent = '启动失败：' + (msg.error || 'unknown') + '\\n\\n（可用工具栏 ⟳ 重试）';
      overlayEl.classList.remove('hide');
    } else if (st === 'stopped') {
      // 0.1.22 §4.6 第 1 条：停止态文案——一句话覆盖「手动启动/等待外部 dsh」两个
      // 行动指引（DR-22-5：不引入子态状态机；发现探活兜底说明自动连接）。
      overlayEl.textContent = 'dsh 已停止\\n点 ▶ 启动新实例，或 ⟳ 重连运行中的实例；检测到运行中的 dsh 会自动连接';
      overlayEl.classList.remove('hide');
    } else if (st !== 'ready' && st !== 'awaitingChannel') {
      overlayEl.textContent = st === 'starting' ? '正在启动 dsh…' : st;
      overlayEl.classList.remove('hide');
    }
  }
  // ---- bind-first：全部绑定先于 typeof acquireVsCodeApi 检查（#90②）----
  if (btnD) btnD.addEventListener('click', function () { post({ type: 'showDetails' }); });
  if (btnO) btnO.addEventListener('click', function () { post({ type: 'openBrowser' }); });
  // 0.1.22 O-22-e 拆分：⟳ = 重连（只认领不拉起，dsh.reconnect）；▶ = 启动
  // （start() 四步仲裁，dsh.start）；ready 态 ⟳/▶ 按禁用矩阵置灰（DR-22-9）。
  if (btnR) btnR.addEventListener('click', function () { post({ type: 'reconnect' }); });
  if (btnStart) btnStart.addEventListener('click', function () { post({ type: 'start' }); });
  if (btnS) btnS.addEventListener('click', function () { post({ type: 'stop' }); });
  if (pickEl) pickEl.addEventListener('click', function (e) {
    var t = e.target;
    var card = t && t.closest ? t.closest('[data-channel]') : null;
    if (card) { post({ type: 'chooseChannel', channel: card.getAttribute('data-channel') || '' }); return; }
    if (t && t.id === 'pick-later') post({ type: 'chooseChannel', channel: null });
  });
  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'setUrl' && msg.url) setUrl(msg.url);
    if (msg.type === 'state') {
      applyState(msg);
      post({ type: 'stateAck', appliedState: msg.state });
    }
  });
  // ---- API 检查在绑定之后：无提前 return 死区；失败诊断立即可见（#90②③）----
  if (typeof acquireVsCodeApi === 'function') {
    try { vscode = acquireVsCodeApi(); } catch (e) { vscode = null; }
  }
  if (vscode) sendHandshake();
  else bridgeDown();
})();
</script>
</body>
</html>`
}

/**
 * #83: the awaitingChannel pick card (design §5.3) — three channel cards with
 * the verbatim 0.1.14 §2.3-② copy (single-sourced from channelSelect
 * channelPickItems; no version literals) + the 稍后再说 secondary action.
 * Always baked into the DOM (hidden unless awaitingChannel) so the state
 * message can reveal it regardless of the bake-time state.
 */
function channelPickCardHtml(): string {
  const cards = channelPickItems()
    .map(
      (it) => `<button class="pick-card" data-channel="${escapeAttr(it.label)}"><span class="pick-label">${escapeAttr(it.label)}</span><span class="pick-detail">${escapeAttr(it.detail ?? '')}</span></button>`,
    )
    .join('\n    ')
  return `
    <div class="pick-head">选择要启动的 dsh 通道</div>
    ${cards}
    <button id="pick-later">稍后再说（沿用当前通道启动，下次再问）</button>`
}

// ---------------------------------------------------------------------------
// dsh.details view card (ADR-22, 0.1.9 §4.7.3c/§4.7.4/§4.7.6) — pure builder
// ---------------------------------------------------------------------------

/** Lifecycle phase of the details card (derived by DshDetailsProvider). */
export type DetailsPhase = 'empty' | 'error' | 'ready' | 'stopped'

export interface DetailsRenderOptions {
  /** Full error text (error phase card, §4.7.4). */
  errorMessage?: string | null
  /** True while a launch is in flight with a snapshot present — the
   *  启动方式 row shows 「启动中（以就绪后为准）」 (§4.7.8). */
  launching?: boolean
  /**
   * 0.1.15 #90①: the runtime `webview.cspSource` (caller passes it; never a
   * guessed scheme) interpolated into the card CSP `script-src`. Empty/absent
   * = the pre-0.1.15 shape (compat with existing headless calls).
   */
  cspSource?: string
  /**
   * 0.1.15 #84: the normalized config channel (`dsh.channel`). When it differs
   * from the running snapshot channel, the switcher renders the highlighted
   * 「立即重启以生效」 button (reuses the existing restart action; never
   * auto-restarts). Absent = no pending-restart surface.
   */
  configChannel?: string | null
  /**
   * 0.1.18 落点 3: the EXTENSION's own version (caller passes it from
   * `context.extension.packageJSON.version`，容错 null)。插件版本不是 dsh 启动
   * 事实——走渲染选项通道（cspSource / configChannel 同型先例），不进
   * DshLaunchInfo。null → 插件版本行显示「未知」（诚实降级）。
   */
  extVersion?: string | null
}

/** Escape a runtime value for safe embedding into HTML attribute/content. */
export function escapeAttr(s: string): string {
  return s.replace(/[&"<>]/g, (c) =>
    ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c] as string)
}

/**
 * Single-point details-card template (v2.8 F-01: lives in the pure module so
 * sim can import it directly, PU-4/PU-6/PU-8). Runtime values are baked via
 * escapeAttr ONLY; copy/open actions carry their payload in data-clipboard /
 * data-path attributes (attribute un-escaping is performed by the DOM, so the
 * clipboard content equals the visible string). The stopped phase copy is
 * split by the snapshot launchMode (v2.8 F-02, §4.7.4):
 *   launchMode === 'start' → 「已按您的操作停止（常驻控制台窗已关闭即停止 dsh）」
 *   otherwise (direct/缺省/null) → 「已断开（dsh 进程未停止或异常退出）」.
 * CSP mirrors the panel minus frame-src (nothing is embedded here).
 */
export function buildDetailsHtml(
  info: DshLaunchInfo | null,
  phase: DetailsPhase,
  opts?: DetailsRenderOptions,
): string {
  let body: string
  if (phase === 'empty') {
    body = `
  <div class="head">dsh 未就绪</div>
  ${kvRow('插件版本', extVersionText(opts?.extVersion))}
  <div class="muted">正在启动 dsh…启动完成后此处显示版本与 bin 目录信息。</div>`
  } else if (phase === 'error') {
    const errText = opts?.errorMessage ?? null
    // 0.1.22 O-22-e 拆分（V3-3）：error 相位行动 = 启动 dsh（重试）为主 +
    // 重连为辅（双按钮）；data-action="start"/"reconnect"，不含 restart。
    body = `
  <div class="head">dsh 启动失败</div>
  ${kvRow('插件版本', extVersionText(opts?.extVersion))}
  <div class="mono err">${escapeAttr(errText !== null && errText.length > 0 ? errText : '未知错误')}</div>
  <div class="muted">启动 = 重新启动 dsh（有运行实例则认领，无实例拉起新实例）；重连 = 只认领运行中的实例。</div>
  <div class="actions"><button data-action="start">启动 dsh（重试）</button><button data-action="reconnect">重连</button></div>`
  } else if (phase === 'stopped') {
    const userStop = info !== null && info.launchMode === 'start'
    const head = userStop
      ? '已按您的操作停止（常驻控制台窗已关闭即停止 dsh）'
      : '已断开（dsh 进程未停止或异常退出）'
    // 0.1.22 O-22-e 拆分 + §4.6 第 2 条：既有二分文案保留；行动指引行改写为
    // 重连/启动语义拆分说明 + 自动连接说明行；按钮组改「重连」「启动」双按钮。
    body = `
  <div class="head">${head}</div>
  ${kvRow('插件版本', extVersionText(opts?.extVersion))}
  <div class="muted">重连 = 只认领运行中的实例（不拉起新进程）；启动 = 无运行实例时拉起新实例（有实例则认领）。</div>
  <div class="muted">检测到运行中的 dsh 实例时会自动连接。</div>${info !== null ? stoppedRows(info) : ''}
  <div class="actions"><button data-action="reconnect">重连</button><button data-action="start">启动</button></div>`
  } else {
    body = info === null ? readyBody(null) : readyBody(info, opts)
  }
  // #90①: card CSP script-src gains the runtime cspSource (same rule as the panel).
  const cardScriptSrc =
    opts?.cspSource != null && opts.cspSource.trim().length > 0
      ? `'unsafe-inline' ${escapeAttr(opts.cspSource.trim())}`
      : `'unsafe-inline'`
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  style-src 'unsafe-inline';
  script-src ${cardScriptSrc};
">
<style>
  html, body { margin: 0; padding: 0; background: var(--vscode-sideBar-background);
    color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 12px; }
  #card { padding: 10px 12px 16px; }
  .head { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
  .bridge-dead { font-size: 11px; color: var(--vscode-editorWarning-foreground, #cca700);
    border: 1px solid var(--vscode-editorWarning-foreground, #cca700); border-radius: 4px;
    padding: 4px 8px; margin: 0 0 8px; }
  .sect { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .7;
    margin: 12px 0 4px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 2px; }
  .ver { font-size: 20px; font-weight: 700; margin: 2px 0; }
  .xcheck { opacity: .8; margin: 2px 0; }
  .xcheck.warn { color: var(--vscode-editorWarning-foreground, #cca700); }
  .amber { background: var(--vscode-editorWarning-background, rgba(204,167,0,.12));
    border: 1px solid var(--vscode-editorWarning-foreground, #cca700); border-radius: 4px;
    padding: 6px 8px; margin: 6px 0 10px; }
  .row { display: flex; gap: 8px; margin: 2px 0; }
  .row .k { flex: 0 0 72px; opacity: .7; }
  .row .v { flex: 1; word-break: break-all; }
  .mono { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px;
    word-break: break-all; margin: 2px 0; }
  .mono.small { font-size: 11px; opacity: .85; }
  .mono.err { white-space: pre-wrap; background: var(--vscode-inputValidation-errorBackground, rgba(180,0,0,.15));
    border-radius: 4px; padding: 6px 8px; }
  .muted { opacity: .75; margin: 2px 0; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; }
  .logrow { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
  .logrow .grow { flex: 1; }
  button { background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.2));
    border: none; color: var(--vscode-button-secondaryForeground, inherit);
    cursor: pointer; font-size: 11px; padding: 3px 8px; border-radius: 3px; }
  button:hover { background: var(--vscode-toolbar-hoverBackground); }
  button:disabled { opacity: .45; cursor: default; }
  button:disabled:hover { background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.2)); }
  button.primary { background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff); font-weight: 600; }
</style>
</head>
<body>
<div id="card">${body}
</div>
<script>
(function () {
  var vscode = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;
  function post(m) { if (vscode) { try { vscode.postMessage(m); } catch (e) { /* never break the card */ } } }
  // 0.1.15 #90④ 存活诊断（问题 9 静默吞掉治本）：vscode=null → 卡顶小字
  // 「消息桥不可用」——防御设计保留（null-safe + never break the card），
  // 但失败必须留下可见痕迹；null-safe/事件委托结构零改动。
  if (!vscode) {
    try {
      var card = document.getElementById('card');
      if (card) {
        var note = document.createElement('div');
        note.className = 'bridge-dead';
        note.textContent = '消息桥不可用（webview API 不可用——卡片按钮将无响应；请反馈此信息给开发方）';
        card.insertBefore(note, card.firstChild);
      }
    } catch (e) { /* diagnostics must never break the card */ }
  }
  document.getElementById('card').addEventListener('click', function (e) {
    var t = e.target;
    var el = t && t.closest ? t.closest('[data-action]') : null;
    if (!el) return;
    var a = el.getAttribute('data-action');
    if (a === 'copy') post({ type: 'copyText', text: el.getAttribute('data-clipboard') || '' });
    else if (a === 'open-dir') post({ type: 'openPath', path: el.getAttribute('data-path') || '', kind: 'dir' });
    else if (a === 'open-file') post({ type: 'openPath', path: el.getAttribute('data-path') || '', kind: 'file' });
    else if (a === 'update') post({ type: 'updateRuntime' });
    // ready 相位「重启 dsh」沿用 restart（dsh.restart 组合语义，DR-22-9）。
    else if (a === 'restart') post({ type: 'restart' });
    // 0.1.22 O-22-e 拆分：error/stopped 相位双按钮（启动 = dsh.start 四步仲裁；
    // 重连 = dsh.reconnect 只认领不拉起）。
    else if (a === 'reconnect') post({ type: 'reconnect' });
    else if (a === 'start') post({ type: 'start' });
    else if (a === 'open-panel') post({ type: 'openPanel' });
    else if (a === 'set-channel') post({ type: 'setChannel', channel: el.getAttribute('data-channel') || '' });
    else if (a === 'apply-channel-restart') post({ type: 'applyChannelRestart' });
  });
})();
</script>
</body>
</html>`
}

/** Ready-phase body (info null → honest minimal degraded card). */
function readyBody(info: DshLaunchInfo | null, opts?: DetailsRenderOptions): string {
  if (info === null) {
    return `
  <div class="head">dsh 配置</div>
  ${kvRow('插件版本', extVersionText(opts?.extVersion))}
  <div class="muted">版本未知（本次会话未解析）</div>
  <div class="muted">尚无启动信息；dsh 就绪后此处显示版本与 bin 目录。</div>`
  }
  if (info.managedBy === 'external') {
    // 0.1.18 ADR-48 受控放宽（替代 0.1.9 H1 的「external 无版本」现状，§3.4
    // 落点 2）：版本区间接源 = 目录版本（主源）/ 命令行字面版本；每个版本值带
    // 来源标注，标注一律引用 launchInfo 文案单点（buildExternalVersionNote
    // 输出经快照 note 字段 + 标注常量），UI 层禁止就地书写标注文案字面
    // （QA r1 A5）。双缺 = 「版本未知（本次会话未能确定）」（诚实降级）。
    // bin 目录照旧无（扩展未解析，H1 bin 语义不放宽）。
    const cmd = info.externalCommandLine
    const dirV = info.externalDshVersion ?? null
    const cmdV = info.externalCmdlineVersion ?? null
    let verBlock: string
    if (dirV !== null) {
      verBlock = `<div class="ver" id="version-big">${escapeAttr(`v${dirV}`)}</div>
  <div class="muted">${escapeAttr(info.externalDshVersionNote ?? '')}</div>`
      if (cmdV !== null) {
        verBlock += `
  <div class="muted">启动命令行含版本 v${escapeAttr(cmdV)}</div>`
      }
      if (cmdV !== null && cmdV !== dirV) {
        verBlock += `
  <div class="xcheck warn">${escapeAttr(EXTERNAL_VERSION_MISMATCH_WARNING)}</div>`
      }
    } else if (cmdV !== null) {
      // 仅命令行版本可得（§7.2 矩阵第 3 行 / PU-13-1⑤）：标注 = 文案单点常量。
      verBlock = `<div class="ver" id="version-big">${escapeAttr(`v${cmdV}`)}</div>
  <div class="muted">${escapeAttr(EXTERNAL_VERSION_NOTE_CMDLINE)}</div>`
    } else {
      // 双缺：诚实降级（无版本可显示，绝不放占位版本号）。
      verBlock = `<div class="muted">版本未知（本次会话未能确定）</div>`
    }
    return `
  <div class="head">dsh 配置</div>
  <div class="amber">外部接管的 dsh——由外部命令自行启动，扩展未解析其 bin 目录；版本为间接来源（见标注）。</div>
  <div class="sect">版本</div>
  ${verBlock}
  ${kvRow('插件版本', extVersionText(opts?.extVersion))}
  ${kvRow('端口', info.port !== null ? String(info.port) : '—')}
  ${kvRow('pid', info.pid !== null ? String(info.pid) : '—')}
  ${kvRow('managedBy', managedByText(info.managedBy))}
  ${kvRow('启动时间', formatLocalTimestamp(info.processStartedAt) ?? '未知')}
  ${channelSwitcherHtml(info.channel, opts, info.channelSource)}
  ${kvRow('启动方式', '外部启动/未知')}
  ${kvRow('最近检查', info.lastCheckAt ?? '未知')}
  ${cmd !== null ? `<div class="sect">接管命令行</div>\n  <div class="mono small">${escapeAttr(cmd)}</div>` : ''}
  <div class="muted">如需版本与 bin 目录信息：停止该 dsh 后由扩展重新启动，或点「重启 dsh」。</div>
  ${logFilesHtml(info)}
  <div class="sect">操作</div>
  <div class="actions">
    <button data-action="restart">重启 dsh</button>
    <button data-action="open-panel">打开主面板</button>
  </div>`
  }
  // managed-own / extension
  const cc = info.versionCrossCheck
  let verBlock: string
  if (info.dshVersion !== null) {
    const big = `v${info.dshVersion}`
    const aux =
      cc === 'match'
        ? `<div class="xcheck">已核对：自报 = resolver（${info.resolverMode ?? '—'}）</div>`
        : cc === 'mismatch'
          ? `<div class="xcheck warn">自报与 bin 目录版本不一致——可能为刷新后旧进程仍在运行；重启 dsh 可对齐。</div>
  <div class="muted">bin 目录版本：v${escapeAttr(info.resolverVersion ?? '未知')}</div>`
        : '' // self-only: no resolver line
    verBlock = `<div class="ver" id="version-big">${escapeAttr(big)}</div>${aux}`
  } else if (info.resolverVersion !== null) {
    verBlock = `<div class="ver" id="version-big">v${escapeAttr(info.resolverVersion)}</div><div class="muted">据 bin 目录（自报版本不可得）</div>`
  } else {
    verBlock = `<div class="ver" id="version-big">版本未知</div>${info.managedBy === 'managed-own' ? '<div class="muted">版本未知（本次会话未解析）</div>' : ''}`
  }
  const binBlock =
    info.binDir !== null && info.dshBin !== null
      ? `<div class="sect">bin 目录</div>
  <div class="mono" id="bin-dir">${escapeAttr(info.binDir)}</div>
  <div class="actions">
    ${copyBtn(info.binDir, '复制路径')}
    <button data-action="open-dir" data-path="${escapeAttr(info.binDir)}">打开目录</button>
  </div>
  <div class="mono small">bin 脚本：${escapeAttr(info.dshBin)}</div>
  <div class="actions">${copyBtn(info.dshBin, '复制')}</div>`
      : `<div class="sect">bin 目录</div>
  <div class="muted">本次会话未解析 bin 目录（复用既有 dsh）；重启 dsh 后此处显示。</div>`
  return `
  <div class="head">dsh 配置</div>
  <div class="sect">版本</div>
  ${verBlock}
  ${kvRow('插件版本', extVersionText(opts?.extVersion))}
  ${channelSwitcherHtml(info.channel, opts, info.channelSource)}
  ${kvRow('启动方式', launchModeText(info, opts))}
  ${binBlock}
  <div class="sect">运行</div>
  ${kvRow('进程', `端口 ${info.port !== null ? String(info.port) : '—'} · pid ${info.pid !== null ? String(info.pid) : '—'} · ${managedByText(info.managedBy)}`)}
  ${kvRow('启动时间', formatLocalTimestamp(info.processStartedAt) ?? '未知')}
  ${kvRow('resolver', `${info.resolverMode ?? '未知'} · 最近检查 ${info.lastCheckAt ?? '未知'}`)}
  ${logFilesHtml(info)}
  <div class="sect">操作</div>
  <div class="actions">
    <button data-action="update">重新检查更新</button>
    <button data-action="restart">重启 dsh</button>
    <button data-action="open-panel">打开主面板</button>
  </div>`
}

/** Stopped-phase diagnostic rows (available fields only, honest nulls). */
function stoppedRows(info: DshLaunchInfo): string {
  return `
  ${kvRow('端口', info.port !== null ? String(info.port) : '—')}
  ${kvRow('pid', info.pid !== null ? String(info.pid) : '—')}
  ${kvRow('managedBy', managedByText(info.managedBy))}
  ${kvRow('启动方式', launchModeText(info, undefined))}`
}

/**
 * #84: the always-present channel switcher for the ready card (design §5.3).
 * Current channel highlighted (its own button disabled — no redundant write);
 * the three buttons carry `data-action="set-channel"` (setChannel uplink).
 * When the config channel differs from the RUNNING snapshot channel, the
 * highlighted 「立即重启以生效」 button renders — 0.1.21（改动点 4）起改发
 * `applyChannelRestart` 上行消息（语义分离于 restart 的重连语义：受管受控杀后
 * 以新通道重拉 / 外部不代杀只给指引；never auto-restarts; channelSelected=true
 * is written by the host, so the first-launch pick card never fires again).
 *
 * 0.1.21（改动点 5，CR-8）: `current` = 快照 channel 真值（string | null），
 * 绝不回显配置值。
 *
 * 0.1.23 三态改造（设计 §5.3 / DR-23-5；用户裁决 O-23-1/O-23-2/O-23-3/O-23-4）：
 * 运行通道可知与否分出三条分支，来源标注常驻显示在「当前」行（O-23-2）：
 *  - B1 运行通道可知且与配置一致 → 「当前 {值}（{来源标注}）」，无括号提示、
 *    无重启按钮；
 *  - B2 运行通道可知且与配置不一致 → 追加「（已选「{cfg}」，待重启生效）」并
 *    渲染按钮（文案不变；此时提示是有依据的，正是 0.1.21 要保的形态）；
 *  - B3 运行通道不可知（running === null）→ 「当前 未知」+ 如实文案
 *    buildChannelUnknownNote(cfg)，**不渲染按钮**（O-23-1：在我们无法知道当前
 *    跑什么的情况下，让用户点一个承诺「重启后生效」的按钮，本身就是不可兑现的
 *    承诺）。判据据此从 `cfg !== current` 改为 `running !== null && cfg !== null
 *    && cfg !== running`——恒真只是实现细节的副产物，改后不再做无法验证的断言。
 *
 * 来源标注随 channelSource 取值（O-23-2 / R-9），字面单点定义在 channelProbe，
 * 渲染层 import 引用、禁止就地书写；channelSource 为 null 时不标注（不编造来源）。
 */
function channelSwitcherHtml(current: string | null, opts?: DetailsRenderOptions, channelSource?: ChannelSource): string {
  const cfg = typeof opts?.configChannel === 'string' && opts.configChannel.length > 0 ? opts.configChannel : null
  const running = current
  const pending = running !== null && cfg !== null && cfg !== running
  const currentText = running ?? '未知'
  const buttons = channelPickItems()
    .map(
      (it) =>
        `<button data-action="set-channel" data-channel="${escapeAttr(it.label)}"${it.label === current ? ' disabled' : ''}>${escapeAttr(it.label)}</button>`,
    )
    .join('\n    ')
  // 来源标注：仅当运行通道有值时渲染（配对不变式，launchInfo 已做同向防御）。
  const note = running !== null ? channelSourceNote(channelSource ?? null) : ''
  const sourceNote = note.length > 0 ? ` <span class="muted">（${escapeAttr(note)}）</span>` : ''
  const pendingNote = pending ? ` <span class="muted">（已选「${escapeAttr(cfg!)}」，待重启生效）</span>` : ''
  // B3：运行通道不可知 → 如实文案取代「待生效」断言，且不渲染重启按钮（O-23-1）。
  const unknownNote =
    running === null && cfg !== null ? ` <span class="muted">${escapeAttr(buildChannelUnknownNote(cfg))}</span>` : ''
  const pendingAction = pending
    ? `
  <div class="actions"><button class="primary" data-action="apply-channel-restart">立即重启以生效</button></div>`
    : ''
  return `
  <div class="sect">通道</div>
  <div class="row"><span class="k">当前</span><span class="v"><b>${escapeAttr(currentText)}</b>${sourceNote}${pendingNote}${unknownNote}</span></div>
  <div class="actions">
    ${buttons}
  </div>${pendingAction}`
}

/** Log inventory rows: copy + reveal-in-OS actions (§4.7.3c H3). */
function logFilesHtml(info: DshLaunchInfo): string {
  if (info.logFiles.length === 0) return ''
  const rows = info.logFiles
    .map(
      (f) => `<div class="logrow"><span class="mono small grow">${escapeAttr(f.label)}</span>
    ${copyBtn(f.path, '复制')}
    <button data-action="open-file" data-path="${escapeAttr(f.path)}">在文件管理器中显示</button>
  </div>`,
    )
    .join('\n  ')
  return `<div class="sect">日志文件</div>
  ${rows}`
}

function kvRow(k: string, v: string): string {
  return `<div class="row"><span class="k">${escapeAttr(k)}</span><span class="v">${escapeAttr(v)}</span></div>`
}

/**
 * 插件版本行取值（0.1.18 落点 3，五相位全显示）：null / 空串 → 「未知」（诚实
 * 降级），否则 `v<version>`。值经 kvRow 的 escapeAttr 转义注入（PU-13-6 注入
 * 安全断言面）。
 */
function extVersionText(extVersion: string | null | undefined): string {
  return extVersion != null && extVersion.length > 0 ? `v${extVersion}` : '未知'
}

function copyBtn(text: string, label: string): string {
  return `<button data-action="copy" data-clipboard="${escapeAttr(text)}">${escapeAttr(label)}</button>`
}

function managedByText(m: DshLaunchInfo['managedBy']): string {
  if (m === 'external') return 'external（外部启动）'
  if (m === 'managed-own') return 'managed-own（扩展代为启动）'
  if (m === 'extension') return 'extension'
  return '—'
}

function launchModeText(info: DshLaunchInfo, opts?: DetailsRenderOptions): string {
  if (opts?.launching === true) return '启动中（以就绪后为准）'
  if (info.launchMode === 'start') return 'start-launch（常驻控制台窗，关闭即停止 dsh）'
  if (info.launchMode === 'direct') return 'direct（隐藏，无控制台窗）'
  return '外部启动/未知'
}
