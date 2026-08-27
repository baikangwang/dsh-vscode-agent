// Pure (no vscode dependency) builder for the DSH panel document, including the
// static top-status baking (P0-G / ADR-3): when the dsh url is known the top
// `<span id="state">` and the iframe are baked statically so they show the dsh
// UI + "dsh · <url>" even if the page script never runs. The page script below
// is an enhancement layer (toolbar / ack handshake / error text).
//
// 去硬编码 constraint: the baked src/state text is the ONLY thing derived from
// `url` (always runtime.url). No host/port/http-prefix literal is written here
// or in the page script; the CSP `frame-src http://127.0.0.1:*` is a hard-coded
// security constraint and stays unchanged.
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
  document.getElementById('btn-open').addEventListener('click', () => vscode.postMessage({ type: 'openBrowser' }));
  document.getElementById('btn-restart').addEventListener('click', () => vscode.postMessage({ type: 'restart' }));
  document.getElementById('btn-stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  vscode.postMessage({ type: 'webviewReady' });
})();
</script>
</body>
</html>`
}

/** Escape a runtime value for safe embedding into HTML attribute/content. */
function escapeAttr(s: string): string {
  return s.replace(/[&"<>]/g, (c) =>
    ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c] as string)
}
