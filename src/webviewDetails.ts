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
import { normalizeChannel } from './channelSelect'
import { appendDecisionLog } from './paths'

const VIEW_ID = 'dsh.details'

/** Messages the details page sends to the extension host (§4.7.6). */
type DetailsMessage =
  | { type: 'copyText'; text?: string }
  | { type: 'openPath'; path?: string; kind?: 'dir' | 'file' }
  | { type: 'updateRuntime' }
  | { type: 'restart' }
  | { type: 'openPanel' }
  | { type: 'setChannel'; channel?: string } // 0.1.15 #84: the ready-card switcher uplink
  | { type: 'applyChannelRestart' } // 0.1.21 改动点 4: 「立即重启以生效」上行（受管受控杀重拉 / 外部不代杀指引）

export class DshDetailsProvider implements vscode.WebviewViewProvider {
  static readonly viewId = VIEW_ID

  private view: vscode.WebviewView | null = null
  /** A state change landed since the last render (or the view was re-resolved). */
  private dirty = true

  constructor(
    private readonly runtime: DshRuntime,
    /**
     * 0.1.18 落点 3: the EXTENSION's own version (activate reads
     * `context.extension.packageJSON.version`，容错 null)。经渲染选项通道进入
     * 详情卡（插件版本行全相位可见）；插件版本不是 dsh 启动事实，不进
     * DshLaunchInfo。
     */
    private readonly extVersion: string | null = null,
  ) {
    runtime.on('state', () => {
      this.dirty = true
      this.renderIfVisible()
    })
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView
    // 0.1.15 #85: explicit view title (VSCode-side tab-title fallback fix;
    // verbatim vs the manifest views name; container title「DSH」untouched).
    webviewView.title = 'DSH 配置'
    // 0.1.16 #95 (E1 evidence, permanent): readback right after the #85 set —
    // same evidence line as the panel resolve (webview.ts), [details]-prefixed.
    appendDecisionLog(`[details] resolve: title set='DSH 配置' readback='${webviewView.title}' (E1, 0.1.16)`)
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
    // 0.1.15 #84/#90①: the render passes the runtime cspSource (never a
    // guessed scheme) and the normalized CONFIG channel — a mismatch with the
    // running snapshot channel renders the highlighted 「立即重启以生效」
    // button (the switcher wrote the config; the restart is user-driven).
    const cfgChannel = normalizeChannel(
      vscode.workspace.getConfiguration('dsh').get<string>('channel', 'latest'),
    ).channel
    view.webview.html = buildDetailsHtml(info, phase, {
      errorMessage: this.runtime.errorMessage,
      launching: state === 'starting' && info !== null,
      cspSource: view.webview.cspSource,
      configChannel: info !== null ? cfgChannel : null,
      extVersion: this.extVersion,
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
      case 'applyChannelRestart':
        // 0.1.21 改动点 4: 「立即重启以生效」→ dsh.applyChannel（语义分离于
        // dsh.restart 的重连语义；受管形态受控杀后以新通道重拉，外部形态不代
        // 杀、给手动路径指引——判定与提示在 runtime / extension 层）。
        void vscode.commands.executeCommand('dsh.applyChannel')
        break
      case 'setChannel': {
        // 0.1.15 #84: the ready-card switcher — write order FIXED (PP-10-5):
        // normalize → writeChannel → writeChannelSelected=true → runtime
        // setChannel (the restart chain must launch the new channel) → re-render
        // (the pending-restart highlighted button appears; never auto-restarts).
        const raw = typeof msg.channel === 'string' ? msg.channel : ''
        const norm = normalizeChannel(raw)
        if (norm.normalized) {
          appendDecisionLog(`[details] setChannel '${raw}' is not a published dist-tag; normalizing to '${norm.channel}' (ADR-29)`)
        }
        const config = vscode.workspace.getConfiguration('dsh')
        try {
          // 0.1.21 改动点 6（v4 QA G-6）: 写设置侧幂等——同值不重复写设置
          // （与 onDidChangeConfiguration 的 echo 防护配套，避免监听器自激）；
          // channelSelected=true 仍照常写（首启标志语义独立）。
          if (config.get<string>('channel', 'latest') !== norm.channel) {
            await config.update('channel', norm.channel, vscode.ConfigurationTarget.Global)
          }
          await config.update('channelSelected', true, vscode.ConfigurationTarget.Global)
        } catch (err) {
          appendDecisionLog(`[details] setChannel config write failed (${(err as Error).message}); keeping the current channel (honest degradation)`)
          void vscode.window.showWarningMessage('通道写入失败；沿用当前通道（详见 runtime.log）。')
          break
        }
        this.runtime.setChannel(norm.channel)
        appendDecisionLog(`[details] setChannel: wrote channel='${norm.channel}' + channelSelected=true; restart required to take effect (not auto-restarted)`)
        this.render()
        break
      }
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
