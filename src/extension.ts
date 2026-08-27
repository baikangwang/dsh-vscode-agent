// Extension entry: activation, commands, configuration, panel wiring and the
// application-level lifecycle hooks (window registration + last-window shutdown).
import * as vscode from 'vscode'
import { DshRuntime } from './runtime'
import { DshPanel } from './webview'
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
  })

  // Status bar
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusItem.command = 'dsh.open'
  context.subscriptions.push(statusItem)
  const updateStatus = (): void => {
    if (!runtime || !statusItem) return
    switch (runtime.state) {
      case 'ready':
        statusItem.text = `$(circle-filled) DSH ${runtime.port ?? ''}`
        statusItem.tooltip = `dsh web · ${runtime.url}\n日志：${logFile()}`
        statusItem.show()
        break
      case 'starting':
        statusItem.text = '$(sync~spin) DSH starting…'
        statusItem.show()
        break
      case 'error':
        statusItem.text = '$(error) DSH error'
        statusItem.tooltip = runtime.errorMessage ?? undefined
        statusItem.show()
        break
      default:
        statusItem.hide()
    }
  }
  runtime.on('state', updateStatus)

  // Panel (right side bar)
  const panel = new DshPanel(runtime)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DshPanel.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: false },
    }),
  )

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('dsh.open', async () => {
      await openPanel()
    }),
    vscode.commands.registerCommand('dsh.restart', async () => {
      await runtime?.restart()
      await openPanel()
    }),
    vscode.commands.registerCommand('dsh.stop', async () => {
      runtime?.stopManaged()
    }),
    vscode.commands.registerCommand('dsh.openInBrowser', async () => {
      const url = runtime?.url
      if (url) await vscode.env.openExternal(vscode.Uri.parse(url))
      else void vscode.window.showWarningMessage('DSH 尚未就绪')
    }),
    vscode.commands.registerCommand('dsh.updateRuntime', async () => {
      const pick = await vscode.window.showInformationMessage(
        '重启 dsh 以获取最新版本（npx 将在启动时解析 latest）。继续？',
        { modal: true },
        '重启',
      )
      if (pick === '重启') await vscode.commands.executeCommand('dsh.restart')
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

export function deactivate(): void {
  // Best-effort; the authoritative path is the process 'exit' hook above.
  runtime?.shutdownBookkeeping()
}
