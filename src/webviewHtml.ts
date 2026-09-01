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
import type { DshLaunchInfo } from './launchInfo'
export function buildPanelHtml(url: string | null): string {
  const known = url !== null && url !== ''
  const frameAttr = known ? ` style="display:block" src="${escapeAttr(url!)}"` : ''
  const overlayCls = known ? ' class="hide"' : ''
  const stateText = known ? `dsh · ${escapeAttr(url!)}` : 'initializing…'
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  style-src 'unsafe-inline';
  script-src 'unsafe-inline';
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
  #stage { flex: 1; position: relative; min-height: 0; }
  iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: none; }
  #overlay { position: absolute; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 8px; text-align: center; padding: 16px;
    box-sizing: border-box; white-space: pre-wrap; }
  .hide { display: none !important; }
</style>
</head>
<body>
  <div id="chrome">
    <span id="state">${stateText}</span>
    <button id="btn-details" title="DSH 详情">ⓘ</button>
    <button id="btn-open" title="Open in browser">↗</button>
    <button id="btn-restart" title="Restart runtime">⟳</button>
    <button id="btn-stop" title="Stop runtime">■</button>
  </div>
  <div id="stage">
    <div id="overlay"${overlayCls}>initializing…</div>
    <iframe id="frame" sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"${frameAttr}></iframe>
  </div>
<script>
(function () {
  var stateEl = document.getElementById('state');
  var overlayEl = document.getElementById('overlay');
  var frameEl = document.getElementById('frame');
  // Boot observation (v4, item 3): prove the page script actually executed.
  try {
    document.title += ' ·booted';
    console.log('[dsh-panel] page booted at', location.href);
    if (stateEl) stateEl.textContent = 'page booted…';
  } catch (e) { /* observation must never block the page */ }
  if (typeof acquireVsCodeApi !== 'function') {
    // Diagnostics: VSCode's injected API script was blocked (CSP) — without it
    // no state message can ever arrive and the overlay stays at 'initializing…'.
    if (stateEl) stateEl.textContent = 'webview API unavailable';
    if (overlayEl) overlayEl.textContent = 'Webview API 不可用（acquireVsCodeApi 未定义）。\n\n请反馈此信息给开发方；并检查 VSCode 扩展宿主日志中本 webview 的 CSP 报错。';
    return;
  }
  const vscode = acquireVsCodeApi();
  function setUrl(url) {
    if (frameEl.src === url) return;
    frameEl.src = url;
    frameEl.style.display = 'block';
    overlayEl.classList.add('hide');
  }
  window.addEventListener('message', function (e) {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'setUrl' && msg.url) setUrl(msg.url);
    if (msg.type === 'state') {
      stateEl.textContent = msg.state === 'ready' ? ('dsh · ' + (msg.url || '')) : msg.state;
      if (msg.state === 'ready' && msg.url) setUrl(msg.url);
      else if (msg.state === 'error') {
        overlayEl.textContent = '启动失败：' + (msg.error || 'unknown') + '\n\n（可用工具栏 ⟳ 重试）';
        overlayEl.classList.remove('hide');
      } else if (msg.state !== 'ready') {
        overlayEl.textContent = msg.state === 'starting' ? '正在启动 dsh…' : msg.state;
        overlayEl.classList.remove('hide');
      }
      vscode.postMessage({ type: 'stateAck', appliedState: msg.state });
    }
  });
  document.getElementById('btn-details').addEventListener('click', () => vscode.postMessage({ type: 'showDetails' }));
  document.getElementById('btn-open').addEventListener('click', () => vscode.postMessage({ type: 'openBrowser' }));
  document.getElementById('btn-restart').addEventListener('click', () => vscode.postMessage({ type: 'restart' }));
  document.getElementById('btn-stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  vscode.postMessage({ type: 'webviewReady' });
})();
</script>
</body>
</html>`
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
  <div class="muted">正在启动 dsh…启动完成后此处显示版本与 bin 目录信息。</div>`
  } else if (phase === 'error') {
    const errText = opts?.errorMessage ?? null
    body = `
  <div class="head">dsh 启动失败</div>
  <div class="mono err">${escapeAttr(errText !== null && errText.length > 0 ? errText : '未知错误')}</div>
  <div class="actions"><button data-action="restart">重试（重启 dsh）</button></div>`
  } else if (phase === 'stopped') {
    const userStop = info !== null && info.launchMode === 'start'
    const head = userStop
      ? '已按您的操作停止（常驻控制台窗已关闭即停止 dsh）'
      : '已断开（dsh 进程未停止或异常退出）'
    body = `
  <div class="head">${head}</div>
  <div class="muted">如需重新连接，请点「重连」；主面板工具栏 ⟳ 亦可。</div>${info !== null ? stoppedRows(info) : ''}
  <div class="actions"><button data-action="restart">重连</button></div>`
  } else {
    body = info === null ? readyBody(null) : readyBody(info, opts)
  }
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  style-src 'unsafe-inline';
  script-src 'unsafe-inline';
">
<style>
  html, body { margin: 0; padding: 0; background: var(--vscode-sideBar-background);
    color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 12px; }
  #card { padding: 10px 12px 16px; }
  .head { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
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
</style>
</head>
<body>
<div id="card">${body}
</div>
<script>
(function () {
  var vscode = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;
  function post(m) { if (vscode) { try { vscode.postMessage(m); } catch (e) { /* never break the card */ } } }
  document.getElementById('card').addEventListener('click', function (e) {
    var t = e.target;
    var el = t && t.closest ? t.closest('[data-action]') : null;
    if (!el) return;
    var a = el.getAttribute('data-action');
    if (a === 'copy') post({ type: 'copyText', text: el.getAttribute('data-clipboard') || '' });
    else if (a === 'open-dir') post({ type: 'openPath', path: el.getAttribute('data-path') || '', kind: 'dir' });
    else if (a === 'open-file') post({ type: 'openPath', path: el.getAttribute('data-path') || '', kind: 'file' });
    else if (a === 'update') post({ type: 'updateRuntime' });
    else if (a === 'restart') post({ type: 'restart' });
    else if (a === 'open-panel') post({ type: 'openPanel' });
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
  <div class="head">dsh 详情</div>
  <div class="muted">版本未知（本次会话未解析）</div>
  <div class="muted">尚无启动信息；dsh 就绪后此处显示版本与 bin 目录。</div>`
  }
  if (info.managedBy === 'external') {
    // H1 external degraded card: explanatory copy + available fields only;
    // NO big version, NO bin copy/open actions (§4.7.4 / PU-3).
    const cmd = info.externalCommandLine
    return `
  <div class="head">dsh 详情</div>
  <div class="amber">外部接管的 dsh——由外部命令自行启动，扩展未解析其 bin 目录与版本。</div>
  ${kvRow('端口', info.port !== null ? String(info.port) : '—')}
  ${kvRow('pid', info.pid !== null ? String(info.pid) : '—')}
  ${kvRow('managedBy', managedByText(info.managedBy))}
  ${kvRow('启动时间', info.startedAt ?? '未知')}
  ${kvRow('通道', info.channel)}
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
  <div class="head">dsh 详情</div>
  <div class="sect">版本</div>
  ${verBlock}
  ${kvRow('通道', info.channel)}
  ${kvRow('启动方式', launchModeText(info, opts))}
  ${binBlock}
  <div class="sect">运行</div>
  ${kvRow('进程', `端口 ${info.port !== null ? String(info.port) : '—'} · pid ${info.pid !== null ? String(info.pid) : '—'} · ${managedByText(info.managedBy)}`)}
  ${kvRow('启动时间', info.startedAt ?? '未知')}
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

function copyBtn(text: string, label: string): string {
  return `<button data-action="copy" data-clipboard="${escapeAttr(text)}">${escapeAttr(label)}</button>`
}

function managedByText(m: DshLaunchInfo['managedBy']): string {
  if (m === 'external') return 'external（外部启动）'
  if (m === 'managed-own') return 'managed-own（扩展代拉）'
  if (m === 'extension') return 'extension'
  return '—'
}

function launchModeText(info: DshLaunchInfo, opts?: DetailsRenderOptions): string {
  if (opts?.launching === true) return '启动中（以就绪后为准）'
  if (info.launchMode === 'start') return 'start-launch（常驻控制台窗，关闭即停止 dsh）'
  if (info.launchMode === 'direct') return 'direct（隐藏，无控制台窗）'
  return '外部启动/未知'
}
