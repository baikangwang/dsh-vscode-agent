// Extension entry: activation, commands, configuration, panel wiring and the
// application-level lifecycle hooks (window registration + last-window shutdown).
// 0.1.9 ADR-22: the ready status bar renders the version segment (via the pure
// statusLine()), the item command points at dsh.showDetails, and the
// dsh.details WebviewViewProvider is registered (visibility: collapsed).
// 0.1.14 ADR-29: first-launch channel selection runs BEFORE the DshRuntime
// construction (「先选后启」), the vscode surface shrinks to the deps lambdas
// consumed by the pure channelSelect module; `dsh.chooseChannel` re-enters the
// same flow any time (restart-to-apply hint, never auto-restarts). ADR-30:
// openInBrowser sends runtime.externalUrl (token contract) and logs the URL
// redacted; the legacy tier keeps the bare URL byte-identically.
// 0.1.15 #83/#86 (ADR-31, user ruling): the QuickPick FIRST-LAUNCH form is
// REMOVED — the runtime is constructed first, parks in awaitingChannel when
// dsh.channelSelected=false, and the PANEL pick card drives the selection
// (chooseChannel uplink → config writes → start; 先选后启 kept). The
// `dsh.chooseChannel` command STAYS as the auxiliary QuickPick entry
// (forcePick; the pick dep is now carried by this command flow).
// 0.1.15 #87: openInBrowser refuses to open the bare URL for a token-contract
// session without a banner (adopt) — it would 401; a guided hint is shown
// instead (managed+token externalUrl behavior unchanged).
import * as vscode from 'vscode'
import { DshRuntime } from './runtime'
import { DshPanel } from './webview'
import { DshDetailsProvider } from './webviewDetails'
import { statusLine } from './launchInfo'
import { appendDecisionLog, ensureDataDir, logFile, redactSecrets } from './paths'
import { CHANNEL_PICK_PLACEHOLDER, runFirstLaunchChannelSelect, type ChannelSelectDeps } from './channelSelect'

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
  // ADR-29-② 归一点（extension 侧单点）：legacy `preview`（E404 dist-tag）与
  // 任何非法枚举值运行时归一为 'latest' + rlog 留痕；不写回用户配置（保守
  // 取舍，设置 UI 中旧值可见、用户可自行修改）。
  const rawChannel = c.get<string>('channel', 'latest')
  let channel = rawChannel
  if (rawChannel !== 'latest' && rawChannel !== 'next' && rawChannel !== 'alpha') {
    channel = 'latest'
    appendDecisionLog(`[extension] channel '${rawChannel}' is not a published dist-tag; normalizing to 'latest' (ADR-29)`)
  }
  return {
    port: c.get<number>('port', 3080),
    channel,
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

/**
 * ADR-29 deps 构造（vscode 耦合收敛为 deps lambda 单点；channelSelect 纯模块
 * 消费）。首启选择与 `dsh.chooseChannel` 重入口共用同一形状。
 */
function buildChannelSelectDeps(): ChannelSelectDeps {
  const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('dsh')
  return {
    pick: async (items) => {
      const picked = await vscode.window.showQuickPick(
        items.map((i) => ({ label: i.label, detail: i.detail })),
        { canPickMany: false, ignoreFocusOut: true, placeHolder: CHANNEL_PICK_PLACEHOLDER },
      )
      return picked?.label
    },
    readChannel: () => config().get<string>('channel', 'latest'),
    writeChannel: (v) => config().update('channel', v, vscode.ConfigurationTarget.Global),
    readChannelSelected: () => config().get<boolean>('channelSelected', false),
    writeChannelSelected: (v) => config().update('channelSelected', v, vscode.ConfigurationTarget.Global),
    log: (msg) => appendDecisionLog(`[channelSelect] ${msg}`),
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  ensureDataDir()
  // 0.1.15 #83/#86 (ADR-31): the QuickPick FIRST-LAUNCH form is REMOVED — the
  // runtime is constructed FIRST below; when dsh.channelSelected=false the
  // auto-start parks it in awaitingChannel (the panel pick card owns the
  // selection; start() runs strictly AFTER the config writes). The
  // `dsh.chooseChannel` command (below) keeps the QuickPick as the AUXILIARY
  // entry. 已选过（channelSelected=true）的老用户路径零变化（直接 start）。
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
        tip.push(`(${runtime.managedBy ?? 'unknown'}：stop/restart 不关停 dsh；点击查看 dsh 配置)`)
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

  // Panel (right side bar) + details view (ADR-22; 0.1.16 #93: split into two
  // containers — dsh.panel stays in dsh-viewContainer, dsh.details moved to
  // dsh-configContainer; view ids / activationEvents unchanged)
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
      // ADR-30-4 (§3.6): token contract sends the banner-authenticated URL
      // (免登录直达，与用户 alpha 手跑样本同路径); legacy/degraded = the bare
      // url (原样). The log line is secret-redacted (NOTE-5 留痕面).
      // 0.1.15 #87: a token-contract session WITHOUT a banner (adopt → C path)
      // has externalUrl=null — the bare URL would 401 in the browser. Honest
      // guidance instead: the panel already holds the session; opening the
      // bare page is refused. managed+token (externalUrl in hand) unchanged.
      const rt = runtime
      if (!rt) {
        void vscode.window.showWarningMessage('DSH 尚未就绪')
        return
      }
      const url = rt.externalUrl ?? rt.url ?? null
      if (url === null && rt.contractTier === 'token') {
        appendDecisionLog('openInBrowser: externalUrl=null + token contract (adopt, no banner) — bare URL NOT opened (would 401); guided hint (#87)')
        void vscode.window.showWarningMessage(
          '外部浏览器需 dsh banner token，面板已代持会话；如需浏览器直连请重启 dsh 由面板接管首启。',
        )
        return
      }
      if (url) {
        appendDecisionLog(`openInBrowser: ${redactSecrets(url)}${rt.externalUrl != null ? ' (externalUrl, token contract)' : ' (bare url, legacy contract)'}`)
        await vscode.env.openExternal(vscode.Uri.parse(url))
      } else void vscode.window.showWarningMessage('DSH 尚未就绪')
    }),
    vscode.commands.registerCommand('dsh.chooseChannel', async () => {
      // ADR-29-⑤ 重入口 → 0.1.15 #86 辅助入口收敛：命令保留（forcePick QuickPick
      // 形态；面板选择卡为主形态）；改选写配置后提示「重启 dsh 后生效」，不自动
      // 重启（尊重运行中实例；用户可用既有「重启服务」完成切换）。
      // 0.1.15 最小正确性补全（#86 注）：sel.selected 时同步 runtime.setChannel —
      // 否则 options.channel 停在构造快照，⟳ 重启仍用旧通道，「重启生效」提示
      // 不真实（0.1.14 既有缺陷；PP-10-5 语义要求的写入面补齐）。
      const sel = await runFirstLaunchChannelSelect(buildChannelSelectDeps(), { forcePick: true })
      if (sel.selected) {
        runtime?.setChannel(sel.channel)
        void vscode.window.showInformationMessage(
          `dsh 通道已选择「${sel.channel}」；重启 dsh 后生效（面板 ⟳ 或命令「DSH: Restart Runtime」）。`,
        )
      } else if (sel.writeFailed) {
        void vscode.window.showWarningMessage('通道写入失败；沿用当前通道（详见 runtime.log）。')
      }
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
  // 0.1.15 #83: channelSelected=false → awaitingChannel (no start — the panel
  // pick card owns the launch); otherwise the pre-0.1.15 auto-start unchanged.
  if (cfg.autoStart) {
    const channelSelected = vscode.workspace.getConfiguration('dsh').get<boolean>('channelSelected', false)
    if (!channelSelected) {
      runtime.enterAwaitingChannel()
    } else {
      void runtime.start().then(() => {
        if (cfg.autoOpenPanel && runtime?.state === 'ready') void openPanel()
      })
    }
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
      // 0.1.16 #94: the details view now lives in dsh-configContainer (ADR-38
      // container split); the fallback container command follows the view.
      await vscode.commands.executeCommand('workbench.view.extension.dsh-configContainer')
    } catch {
      await vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar')
    }
  }
}

export function deactivate(): void {
  // Best-effort; the authoritative path is the process 'exit' hook above.
  runtime?.shutdownBookkeeping()
}
