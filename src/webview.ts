// The right-side-bar webview view: an iframe hosting the dsh web UI plus a
// slim status overlay and toolbar (reload / open-in-browser / restart / stop).
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { DshRuntime, RuntimeState } from './runtime'
import { runtimeLogFile } from './paths'

const VIEW_ID = 'dsh.panel'

/** Acknowledgment budget (ms): waiting longer than this for a matching stateAck
 *  after a ready snapshot triggers a defensive re-push (see onAckTimeout). */
const ACK_BUDGET_MS = 3000
/** Max defensive re-pushes per ack window, guarding against hot loops when the
 *  page is stuck and can never ack. */
const MAX_REPUSH = 2

/** Messages the webview page sends to the extension host. */
type WebviewMessage =
  | { type: 'webviewReady' | 'reload' | 'openBrowser' | 'restart' | 'stop' }
  | { type: 'stateAck'; appliedState?: RuntimeState }

/** Append a diagnostic line to logs/runtime.log in the same format as the
 *  runtime's rlog, prefixed with `dsh.panel:` so the panel message round-trip
 *  (emit -> recv -> ack) is grep-able. Diagnostics only; never throws. */
function panelLog(msg: string): void {
  try {
    const file = runtimeLogFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `[${new Date().toISOString()}] [win ${process.pid}] dsh.panel: ${msg}\n`, 'utf8')
  } catch {
    /* diagnostics must never break the panel */
  }
}

export class DshPanel implements vscode.WebviewViewProvider {
  static readonly viewId = VIEW_ID

  private view: vscode.WebviewView | null = null
  private lastUrl: string | null = null
  /** The dsh url baked into the current webview html's `<iframe src>`, or null
   *  when the current html carries no baked src (url unknown at resolve time,
   *  or pre-ready placeholder). Guards the one-time re-bake in refresh(). */
  private bakedUrl: string | null = null
  /** True once the page has signalled webviewReady (listener attached). */
  private pageReady = false
  /** State whose ack we are still waiting on; a timer re-pushes on timeout. */
  private awaitingAck: RuntimeState | null = null
  private awaitingAckRepushes = 0
  private ackTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly runtime: DshRuntime) {
    runtime.on('state', () => this.refresh())
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    }
    webviewView.webview.html = this.html(webviewView.webview, this.runtime.url)
    // Track exactly what was baked so refresh() can re-bake once when the url
    // becomes known/changes after a pre-ready resolve (see refresh()).
    this.bakedUrl = this.runtime.url
    webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      switch (msg.type) {
        case 'webviewReady':
          // Handshake: the page has attached its listener; unconditionally
          // re-push the current state snapshot (covers the boot race where
          // earlier messages were dropped before the listener was live).
          this.pageReady = true
          // A reloaded page is a fresh ack period: any prior stuck-loop repush
          // budget is no longer relevant, so clear the timer and zero the
          // counter before re-pushing the current snapshot.
          this.clearAckTimer()
          this.awaitingAckRepushes = 0
          panelLog(`recv webviewReady; re-pushing snapshot (state=${this.runtime.state})`)
          this.refresh()
          break
        case 'stateAck': {
          this.clearAckTimer()
          const applied = msg.appliedState ?? null
          const current = this.runtime.state
          if (applied === current) {
            panelLog(`recv stateAck appliedState=${applied ?? 'undefined'} ok=true`)
            this.awaitingAck = null
            this.awaitingAckRepushes = 0
          } else {
            // The page rendered a stale snapshot (state changed underneath it);
            // defensively re-push so the panel can converge (refresh re-arms).
            panelLog(`recv stateAck appliedState=${applied ?? 'undefined'} != current=${current}; defensive re-push`)
            this.awaitingAck = null
            this.awaitingAckRepushes = 0
            this.refresh()
          }
          break
        }
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
    webviewView.onDidDispose(() => {
      // Only drop the reference for the exact instance being disposed so a
      // freshly recreated view is not suppressed, and clear lastUrl so setUrl
      // is not blocked after a rebuild. Also stop any pending ack timer.
      this.resetAck()
      if (this.view === webviewView) {
        this.view = null
        this.lastUrl = null
        this.bakedUrl = null
        panelLog(`dispose: view closed (state=${this.runtime.state})`)
      }
    })
    this.refresh()
  }

  private refresh(): void {
    const view = this.view
    if (!view) {
      // Not silent: observability. A drop here used to invisibly stall the
      // panel at "initializing…" when a push landed in the dispose window.
      panelLog(`refresh: view=null (state=${this.runtime.state}); skipping push`)
      return
    }
    const state: RuntimeState = this.runtime.state
    const url = this.runtime.url
    const error = this.runtime.errorMessage
    view.webview.postMessage({ type: 'state', state, url, error })
    panelLog(`emit state=${state} url=${url ?? 'null'} error=${error ?? 'null'}`)
    if (state === 'ready' && url && url !== this.bakedUrl) {
      // v4: the current html was baked without this url (resolve happened
      // before ready, or the url changed). Re-write it once so the iframe
      // carries `src=runtime.url` and shows dsh UI even if the page script
      // never runs (the 0-handshake root cause). Guarded by bakedUrl so this
      // fires at most once per url; the setUrl message below stays as the
      // script-level enhancement.
      panelLog(`re-bake html url=${url} (was baked=${this.bakedUrl ?? 'null'})`)
      view.webview.html = this.html(view.webview, url)
      this.bakedUrl = url
    }
    if (state === 'ready' && url && url !== this.lastUrl) {
      // Script updates the iframe src (kept in the DOM between messages).
      view.webview.postMessage({ type: 'setUrl', url })
      this.lastUrl = url
    }
    if (state !== 'ready') this.lastUrl = null
    // Arm the ack budget for the just-pushed snapshot (no-op unless a ready
    // push is in flight on a webviewReady page).
    this.armAckWait()
  }

  /** Clear the pending ack timeout, if any. */
  private clearAckTimer(): void {
    if (this.ackTimer !== null) {
      clearTimeout(this.ackTimer)
      this.ackTimer = null
    }
  }

  /** Reset all ack state (on dispose / when not tracking a ready push). */
  private resetAck(): void {
    this.clearAckTimer()
    this.pageReady = false
    this.awaitingAck = null
    this.awaitingAckRepushes = 0
  }

  /** Arm a boundary-timed ack wait after pushing a `ready` snapshot, so we can
   *  defend against "pushed but the page never rendered / ack was lost". */
  private armAckWait(): void {
    if (!this.pageReady || this.view === null || this.runtime.state !== 'ready') {
      this.clearAckTimer()
      this.awaitingAck = null
      this.awaitingAckRepushes = 0
      return
    }
    this.awaitingAck = 'ready'
    // Do NOT reset awaitingAckRepushes here: it must stay monotonic across the
    // re-push loop so a page that never acks can reach >= MAX_REPUSH and give
    // up instead of re-pushing forever. The counter is reset to 0 only at a
    // fresh-cycle boundary (matching stateAck / new webviewReady / giving-up /
    // non-ready); see onAckTimeout and the webviewReady handler.
    this.clearAckTimer()
    this.ackTimer = setTimeout(() => this.onAckTimeout(), ACK_BUDGET_MS)
  }

  /** Fallback: no matching ack arrived within the budget; re-push (≤ MAX_REPUSH). */
  private onAckTimeout(): void {
    this.ackTimer = null
    if (!this.pageReady || this.view === null || this.awaitingAck === null) return
    const state = this.runtime.state
    if (state !== 'ready') {
      // Converged to a non-ready state meanwhile; normal push path handles it.
      this.awaitingAck = null
      this.awaitingAckRepushes = 0
      return
    }
    if (this.awaitingAckRepushes >= MAX_REPUSH) {
      panelLog(`ack timeout: no ack for ${state} after ${MAX_REPUSH} re-pushes; giving up`)
      this.awaitingAck = null
      this.awaitingAckRepushes = 0
      return
    }
    this.awaitingAckRepushes++
    panelLog(`ack timeout: no ack for state=${state} within ${ACK_BUDGET_MS}ms; defensive re-push #${this.awaitingAckRepushes}`)
    this.refresh()
  }

  /** Escape a runtime value for safe embedding into an HTML attribute. */
  private escapeAttr(s: string): string {
    return s.replace(/[&"<>]/g, (c) =>
      ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c] as string)
  }

  /**
   * Build the panel document. v4: when `url` is known (ready), the dsh url is
   * baked straight into `<iframe src>` and the iframe is made visible / the
   * overlay hidden at the STATIC HTML level — so dsh UI displays even if the
   * page script never executes (the 0-handshake root cause). The page script
   * below is then only an enhancement layer (toolbar/status/errors).
   *
   * HARD CONSTRAINT (去硬编码): the baked src is the ONLY thing that may come
   * from `url` (which is always `this.runtime.url`). No host/port/http prefix,
   * no 127.0.0.1 / 3080 literal, is ever written here or in the page script.
   * When url is empty/unknown the iframe is left without src and hidden, and
   * the overlay shows the initializing placeholder.
   */
  private html(wv: vscode.Webview, url: string | null): string {
    const known = url !== null && url !== ''
    // Static visibility decided at write time: known url -> iframe visible and
    // overlay hidden without requiring the page script to run (critical v4
    // implementation item from the QA design gate).
    const frameAttr = known ? ` style="display:block" src="${this.escapeAttr(url!)}"` : ''
    const overlayCls = known ? ' class="hide"' : ''
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
    <span id="state">initializing…</span>
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
  // Grep for the appended title marker / console line to tell "document
  // rendered and script ran" apart from "document never loaded". Observation
  // only — must never break the ack / toolbar logic below.
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
      // Ack back to the extension host so it can defensively re-push on a
      // stale snapshot or a lost ack (self-healing handshake).
      vscode.postMessage({ type: 'stateAck', appliedState: msg.state });
    }
  });
  document.getElementById('btn-open').addEventListener('click', () => vscode.postMessage({ type: 'openBrowser' }));
  document.getElementById('btn-restart').addEventListener('click', () => vscode.postMessage({ type: 'restart' }));
  document.getElementById('btn-stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  // Handshake: all listeners and button handlers are registered, so any state
  // snapshot pushed now will be received. Ask the extension host to re-push the
  // current state (covers messages dropped during the boot window).
  vscode.postMessage({ type: 'webviewReady' });
})();
</script>
</body>
</html>`
  }
}
