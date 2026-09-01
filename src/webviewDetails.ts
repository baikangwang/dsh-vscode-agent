// DshDetailsProvider — the dsh.details WebviewViewProvider (ADR-22, 0.1.9
// §4.7.6). This is the ONLY vscode-coupled layer of the details view; the HTML
// template lives in the pure module webviewHtml.ts (buildDetailsHtml) and the
// data model in launchInfo.ts (both headlessly testable, QA C2 layering).
//
// Contract (§4.7.6):
//  - visibility: 'collapsed' (package.json) → resolveWebviewView runs only
//    when the user first opens the view → the main launch path gains ZERO
//    overhead (H5 lazy render);
//  - state events arriving while invisible only set `dirty` (no build, no
//    push); onDidChangeVisibility(visible) rebuilds when dirty; invisible
//    transitions are no-ops;
//  - data = runtime.on('state') subscription + runtime.getLaunchInfo() pull;
//    every render also posts {type:'launchInfo', info}/{type:'phase', phase}
//    (plain JSON; the baked HTML is the source of truth, the push keeps the
//    documented message protocol observable);
//  - messages (page → host): copyText / openPath / updateRuntime / restart /
//    openPanel — ALL reuse existing commands or VSCode clipboard/OS APIs;
//    zero new kill/relaunch semantics;
//  - onDidDispose: the view is unchecked/disposed → drop the handle (v2.8
//    N-01); a re-check re-resolves a fresh webview.
import * as path from 'node:path'
import * as vscode from 'vscode'
import { DshRuntime, type RuntimeState } from './runtime'
import { buildDetailsHtml, type DetailsPhase } from './webviewHtml'

const VIEW_ID = 'dsh.details'

/** Messages the details page sends to the extension host (§4.7.6). */
type DetailsMessage =
  | { type: 'copyText'; text?: string }
  | { type: 'openPath'; path?: string; kind?: 'dir' | 'file' }
  | { type: 'updateRuntime' }
  | { type: 'restart' }
  | { type: 'openPanel' }

export class DshDetailsProvider implements vscode.WebviewViewProvider {
  static readonly viewId = VIEW_ID

  private view: vscode.WebviewView | null = null
  /** A state change landed since the last render (or the view was re-resolved). */
  private dirty = true

  constructor(private readonly runtime: DshRuntime) {
    runtime.on('state', () => {
      this.dirty = true
      this.renderIfVisible()
    })
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    }
    webviewView.webview.onDidReceiveMessage((msg: DetailsMessage) => {
      void this.onMessage(msg)
    })
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && this.dirty) this.render()
      // invisible: no-op — the dirty flag carries the pending change.
    })
    webviewView.onDidDispose(() => {
      // N-01: unchecking the view disposes it; re-checking resolves a fresh
      // one. Drop the stale handle so later renders are no-ops.
      if (this.view === webviewView) this.view = null
    })
    this.render()
  }

  private renderIfVisible(): void {
    if (this.view !== null && this.view.visible) this.render()
  }

  /** Build the full card document (baked values) + push the protocol payloads. */
  private render(): void {
    const view = this.view
    if (view === null) return
    const info = this.runtime.getLaunchInfo()
    const state = this.runtime.state
    const phase = derivePhase(state, info)
    view.webview.html = buildDetailsHtml(info, phase, {
      errorMessage: this.runtime.errorMessage,
      launching: state === 'starting' && info !== null,
    })
    this.dirty = false
    void view.webview.postMessage({ type: 'launchInfo', info })
    void view.webview.postMessage({ type: 'phase', phase })
  }

  private async onMessage(msg: DetailsMessage): Promise<void> {
    switch (msg.type) {
      case 'copyText': {
        const text = typeof msg.text === 'string' ? msg.text : ''
        if (text.length > 0) {
          try {
            await vscode.env.clipboard.writeText(text)
          } catch {
            /* clipboard is best-effort */
          }
        }
        break
      }
      case 'openPath': {
        const p = typeof msg.path === 'string' ? msg.path : ''
        if (p.length === 0) break
        try {
          if (msg.kind === 'file') {
            // revealFileInOS selects the file in the OS file manager; fall back
            // to opening its parent directory when unavailable.
            try {
              await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(p))
            } catch {
              await vscode.env.openExternal(vscode.Uri.file(path.dirname(p)))
            }
          } else {
            await vscode.env.openExternal(vscode.Uri.file(p))
          }
        } catch {
          /* OS-open is best-effort */
        }
        break
      }
      case 'updateRuntime':
        void vscode.commands.executeCommand('dsh.updateRuntime')
        break
      case 'restart':
        void vscode.commands.executeCommand('dsh.restart')
        break
      case 'openPanel':
        try {
          await vscode.commands.executeCommand('dsh.panel.focus')
        } catch {
          try {
            await vscode.commands.executeCommand('workbench.view.extension.dsh-viewContainer')
          } catch {
            await vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar')
          }
        }
        break
    }
  }
}

/**
 * Phase derivation (§4.7.4): error/stopped map directly (the stopped copy is
 * split inside buildDetailsHtml by the snapshot launchMode); idle/starting
 * with a full snapshot keep rendering the ready card (the 启动方式 row shows
 * 「启动中（以就绪后为准）」) — only a snapshot-less idle/starting renders the
 * empty card.
 */
function derivePhase(state: RuntimeState, info: ReturnType<DshRuntime['getLaunchInfo']>): DetailsPhase {
  if (state === 'error') return 'error'
  if (state === 'stopped') return 'stopped'
  if (state === 'ready') return 'ready'
  return info !== null ? 'ready' : 'empty'
}
