// Extension entry: activation, commands, configuration, panel wiring and the
// application-level lifecycle hooks (window registration + last-window shutdown).
// 0.1.9 ADR-22: the ready status bar renders the version segment (via the pure
// statusLine()), the item command points at dsh.showDetails, and the
// dsh.details WebviewViewProvider is registered (visibility: collapsed).
import * as vscode from 'vscode'
import { DshRuntime } from './runtime'
import { DshPanel } from './webview'
import { DshDetailsProvider } from './webviewDetails'
import { statusLine } from './launchInfo'
import { ensureDataDir, logFile } from './paths'

let runtime: DshRuntime | null = null
let statusItem: vscode.StatusBarItem | null = null

interface Cfg {
  port: number
  channel: string
  command: string
  autoStart: boolean
  autoOpenPanel: boolean
  dshHome: string
  probeIntervalSec: number
  consoleVisible: boolean
}

function readConfig(): Cfg {
  const c = vscode.workspace.getConfiguration('dsh')
  return {
    port: c.get<number>('port', 3080),
    channel: c.get<string>('channel', 'latest'),
    command: c.get<string>('command', ''),
    autoStart: c.get<boolean>('autoStart', true),
    autoOpenPanel: c.get<boolean>('autoOpenPanel', true),
    dshHome: c.get<string>('dshHome', ''),
    probeIntervalSec: c.get<number>('probeIntervalSec', 30),
    // P-POPUP 方案 B (ADR-20, user ruling 2026-08-29): DEFAULT TRUE — dsh runs
    // on a visible console so its tool subprocesses share it (no per-call
    // popup windows); false = fully hidden (the 0.1.7 accepted shape, switch
    // back once the upstream windowsHide fix lands).
    consoleVisible: c.get<boolean>('consoleVisible', true),
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  ensureDataDir()
  const cfg = readConfig()

  runtime = new DshRuntime({
    app: vscode.env.appName ?? 'Visual Studio Code',
    windowPid: process.pid,
    port: cfg.port,
    channel: cfg.channel,
    command: cfg.command,
    dshHome: cfg.dshHome,
    probeIntervalSec: cfg.probeIntervalSec,
    consoleVisible: cfg.consoleVisible,
  })

  // Status bar (ADR-22: ready shows 端口 · 版本; click opens the details view)
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusItem.command = 'dsh.showDetails'
  context.subscriptions.push(statusItem)
  const updateStatus = (): void => {
    if (!runtime || !statusItem) return
    const info = runtime.getLaunchInfo()
    switch (runtime.state) {
      case 'ready': {
        // Version segment = self-reported primary, resolver fallback; BOTH
        // missing → no version segment (never a misleading placeholder, H1).
        const version = info?.dshVersion ?? info?.resolverVersion ?? null
        statusItem.text = statusLine('ready', runtime.port, version)
        const tip = [`dsh web · ${runtime.url ?? ''}`]
        if (info?.dshVersion) tip.push(`版本：v${info.dshVersion}（自报）`)
        if (info?.resolverVersion) tip.push(`版本：v${info.resolverVersion}（bin 目录）`)
        if (info?.binDir) tip.push(`bin：${info.binDir}`)
        tip.push(`日志：${logFile()}`)
        tip.push(`(${runtime.managedBy ?? 'unknown'}：stop/restart 不关停 dsh；点击查看 dsh 详情)`)
        statusItem.tooltip = tip.join('\n')
        statusItem.show()
        break
      }
      case 'starting':
        statusItem.text = statusLine('starting', null, null)
        statusItem.show()
        break
      case 'error':
        statusItem.text = statusLine('error', null, null)
        statusItem.tooltip = runtime.errorMessage ?? undefined
        statusItem.show()
        break
      default:
        statusItem.hide()
    }
  }
  runtime.on('state', updateStatus)

  // Panel (right side bar) + details view (ADR-22, both in dsh-viewContainer)
  const panel = new DshPanel(runtime)
  const details = new DshDetailsProvider(runtime)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DshPanel.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: false },
    }),
    vscode.window.registerWebviewViewProvider(DshDetailsProvider.viewId, details, {
      webviewOptions: { retainContextWhenHidden: false },
    }),
  )

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('dsh.open', async () => {
      await openPanel()
    }),
    vscode.commands.registerCommand('dsh.showDetails', async () => {
      // ADR-22 (0.1.9): reveal the dsh.details webview view — focus command
      // first (auto-registered per view id), then the container, then a bare
      // auxiliary-bar toggle.
      await showDetails()
    }),
    vscode.commands.registerCommand('dsh.restart', async () => {
      // Reconnect semantics (P0-D): never kills dsh; re-discover/adopt/launch.
      await runtime?.reconnect()
      await openPanel()
    }),
    vscode.commands.registerCommand('dsh.stop', async () => {
      // Disconnect semantics (P0-D): detach without killing dsh.
      runtime?.disconnect()
    }),
    vscode.commands.registerCommand('dsh.openInBrowser', async () => {
      const url = runtime?.url
      if (url) await vscode.env.openExternal(vscode.Uri.parse(url))
      else void vscode.window.showWarningMessage('DSH 尚未就绪')
    }),
    vscode.commands.registerCommand('dsh.updateRuntime', async () => {
      // F-UPDATE (ADR-10): explicit force-relaunch EXCEPTION — only for a
      // managed-own dsh, after explicit user confirmation. Independent code
      // path; does NOT reuse dsh.restart (reconnect can't update the version).
      const mb = runtime?.managedBy
      if (mb === 'managed-own' && runtime) {
        const pick = await vscode.window.showInformationMessage(
          '受控重拉 managed dsh 以获取 npx latest（将结束当前 dsh 并按最新版本重新启动）。继续？',
          { modal: true },
          '升级并重拉',
        )
        if (pick === '升级并重拉') {
          await runtime.forceRelaunchManaged()
          await openPanel()
        }
        return
      }
      const sep = mb === null ? '' : `（当前 dsh 为 ${mb}）`
      void vscode.window.showWarningMessage(
        '外部/已接管 dsh 无法自动升级。请手动运行 `npx @deepseek-ai/dsh@latest web` 或受控重拉。' + sep,
      )
    }),
  )

  // Lifecycle bookkeeping on extension-host exit (reliable; deactivate is not).
  process.on('exit', () => {
    runtime?.shutdownBookkeeping()
  })

  // Window-scoped cleanup: unregister this window whenever the extension is
  // disabled/reloaded (last-window shutdown is handled by the exit hook).
  context.subscriptions.push({
    dispose: () => {
      runtime?.shutdownBookkeeping()
      runtime?.dispose?.()
    },
  })

  // Auto start on first window; subsequent windows adopt the running instance.
  if (cfg.autoStart) {
    void runtime.start().then(() => {
      if (cfg.autoOpenPanel && runtime?.state === 'ready') void openPanel()
    })
  }
}

async function openPanel(): Promise<void> {
  // Secondary sidebar (auxiliary bar) container reveal; fall back to toggling
  // the part. The container's open command is auto-registered by VSCode as
  // workbench.view.extension.<containerId> (verified in 1.134 workbench source).
  try {
    await vscode.commands.executeCommand('workbench.view.extension.dsh-viewContainer')
  } catch {
    await vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar')
  }
}

async function showDetails(): Promise<void> {
  // ADR-22: focus the details view itself (expands the secondary sidebar
  // container without hiding the main panel — H4); double-level fallback for
  // focus-command drift across VSCode versions.
  try {
    await vscode.commands.executeCommand('dsh.details.focus')
  } catch {
    try {
      await vscode.commands.executeCommand('workbench.view.extension.dsh-viewContainer')
    } catch {
      await vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar')
    }
  }
}

export function deactivate(): void {
  // Best-effort; the authoritative path is the process 'exit' hook above.
  runtime?.shutdownBookkeeping()
}
