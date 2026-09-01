// The right-side-bar webview view: an iframe hosting the dsh web UI plus a
// slim status overlay and toolbar (reload / open-in-browser / restart / stop).
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { DshRuntime, RuntimeState } from './runtime'
import { runtimeLogFile } from './paths'
import { buildPanelHtml } from './webviewHtml'

const VIEW_ID = 'dsh.panel'

/** Acknowledgment budget (ms): waiting longer than this for a matching stateAck
 *  after a ready snapshot triggers a defensive re-push (see onAckTimeout). */
const ACK_BUDGET_MS = 3000
/** Max defensive re-pushes per ack window, guarding against hot loops when the
 *  page is stuck and can never ack. */
const MAX_REPUSH = 2

/** Messages the webview page sends to the extension host. */
type WebviewMessage =
  | { type: 'webviewReady' | 'reload' | 'openBrowser' | 'restart' | 'stop' | 'showDetails' }
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
    webviewView.webview.html = buildPanelHtml(this.runtime.url)
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
        case 'showDetails':
          // ADR-22 (0.1.9): toolbar ⓘ → the details view (command → focus
          // fallback chain handled by dsh.showDetails).
          void vscode.commands.executeCommand('dsh.showDetails')
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
      // panel at "initializing鈥? when a push landed in the dispose window.
      panelLog(`refresh: view=null (state=${this.runtime.state}); skipping push`)
      return
    }
    const state: RuntimeState = this.runtime.state
    const url = this.runtime.url
    const error = this.runtime.errorMessage
    // ADR-22 (0.1.9): the state payload gains the launchInfo snapshot (plain
    // JSON, additive → backward compatible; existing consumers ignore the
    // unknown field, zero break).
    view.webview.postMessage({ type: 'state', state, url, error, launchInfo: this.runtime.getLaunchInfo() })
    panelLog(`emit state=${state} url=${url ?? 'null'} error=${error ?? 'null'}`)
    if (state === 'ready' && url && url !== this.bakedUrl) {
      // v4: the current html was baked without this url (resolve happened
      // before ready, or the url changed). Re-write it once so the iframe
      // carries `src=runtime.url` and shows dsh UI even if the page script
      // never runs (the 0-handshake root cause). Guarded by bakedUrl so this
      // fires at most once per url; the setUrl message below stays as the
      // script-level enhancement.
      panelLog(`re-bake html url=${url} (was baked=${this.bakedUrl ?? 'null'})`)
      view.webview.html = buildPanelHtml(url)
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

  /** Fallback: no matching ack arrived within the budget; re-push (鈮?MAX_REPUSH). */
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
}
