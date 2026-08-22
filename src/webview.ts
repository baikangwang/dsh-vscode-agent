// The right-side-bar webview view: an iframe hosting the dsh web UI plus a
// slim status overlay and toolbar (reload / open-in-browser / restart / stop).
import * as vscode from 'vscode'
import { DshRuntime, RuntimeState } from './runtime'

const VIEW_ID = 'dsh.panel'

function nonce(): string {
  const b = Buffer.alloc(16)
  for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256)
  return b.toString('hex')
}

export class DshPanel implements vscode.WebviewViewProvider {
  static readonly viewId = VIEW_ID

  private view: vscode.WebviewView | null = null
  private lastUrl: string | null = null

  constructor(private readonly runtime: DshRuntime) {
    runtime.on('state', () => this.refresh())
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    }
    webviewView.webview.html = this.html(webviewView.webview)
    webviewView.webview.onDidReceiveMessage((msg) => {
      switch (msg.type) {
        case 'reload':
          void vscode.commands.executeCommand('dsh.restart')
          break
        case 'openBrowser':
          void vscode.commands.executeCommand('dsh.openInBrowser')
          break
        case 'restart':
          void vscode.commands.executeCommand('dsh.restart')
          break
        case 'stop':
          void vscode.commands.executeCommand('dsh.stop')
          break
      }
    })
    this.refresh()
  }

  private refresh(): void {
    const view = this.view
    if (!view) return
    const state: RuntimeState = this.runtime.state
    const url = this.runtime.url
    const error = this.runtime.errorMessage
    view.webview.postMessage({ type: 'state', state, url, error })
    if (state === 'ready' && url && url !== this.lastUrl) {
      // Script updates the iframe src (kept in the DOM between messages).
      view.webview.postMessage({ type: 'setUrl', url })
      this.lastUrl = url
    }
    if (state !== 'ready') this.lastUrl = null
  }

  private html(wv: vscode.Webview): string {
    const csp = wv.cspSource
    const n = nonce()
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  style-src ${csp};
  script-src 'nonce-${n}';
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
    <span id="state">initializing…</span>
    <button id="btn-open" title="Open in browser">↗</button>
    <button id="btn-restart" title="Restart runtime">⟳</button>
    <button id="btn-stop" title="Stop runtime">■</button>
  </div>
  <div id="stage">
    <div id="overlay">initializing…</div>
    <iframe id="frame" sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"></iframe>
  </div>
<script nonce="${n}">
(function () {
  const vscode = acquireVsCodeApi();
  const stateEl = document.getElementById('state');
  const overlayEl = document.getElementById('overlay');
  const frameEl = document.getElementById('frame');
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
    }
  });
  document.getElementById('btn-open').addEventListener('click', () => vscode.postMessage({ type: 'openBrowser' }));
  document.getElementById('btn-restart').addEventListener('click', () => vscode.postMessage({ type: 'restart' }));
  document.getElementById('btn-stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
})();
</script>
</body>
</html>`
  }
}
