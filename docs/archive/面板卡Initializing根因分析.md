# 面板卡「Initializing」根因分析

> 场景：用户在 Windows cmd 手动启动 `npx @deepseek-ai/dsh web`，再启动 VSCode，右侧边栏 DSH 面板「能加载」，但一直停留在 `initializing…`；状态栏显示 `DSH 3080`（ready）。
> 版本：DSH Panel 0.1.2（已装）· VSCode 1.135.0 · dsh web latest（rev 8b2404a806ca）
> 类型：排障 / 根因分析（A2 简）· 状态：根因已定位，修复待确认后实施

---

## 1. 结论（TL;DR）

根因是 **webview 启动竞态（boot race）+ 缺握手机制**，不是 CSP 注入冲突（Bug C 已在 0.1.2 修复），也不是 dsh 运行时问题。

**链条**：
1. 扩展宿主侧 `DshRuntime` 已正确**接管外部 dsh** 并到达 `ready`（状态栏 `DSH 3080` 即证据，`runtime.log` 有完整决策轨迹）。
2. 面板 WebviewView 在 `starting`/`ready` 过渡期间被解析，扩展在 `html` 刚写入、**webview 页面还没挂上 `message` 监听器时**就连续 `postMessage`（`refresh()` 在 `resolveWebviewView` 与每次 state 变化时都会发）。
3. 这些发生在 webview 启动窗口（约 0:52:25→0:52:33，8 秒）内的 `state`/`setUrl` 消息**全部丢失**；
4. 而扩展**只在 state 变化时**才重发（`runtime.on('state', refresh)`）。等到 webview 真正 boot 完成、监听器就位时，运行时早已是 `ready`，**之后不再有任何 state 变化** → `ready`/`setUrl` 永远不会补发 → 面板永久停在初始 `initializing…`。

> 判定依据：用户确认面板显示**纯 `initializing…`**（而非顶行 `正在启动 dsh…`/`idle`，也非 `Webview API 不可用` 诊断）。纯初始字样说明**连第一条 `state` 消息都没被 webview 处理过**——即消息在监听器挂上前全部丢失，且此后无重发。这与状态栏 `ready` 构成唯一自洽解释。

---

## 2. 已确认事实（证据链）

| # | 事实 | 证据 |
|---|---|---|
| 1 | 运行时正确接管外部 dsh 并 ready | `%LOCALAPPDATA%\DshVscode\logs\runtime.log`：`state: starting -> ready`、`adopt: external dsh at http://127.0.0.1:3080 (pid 35248)`、`looksLikeDsh=true` |
| 2 | 注册表正确持久化接管 pid | `instance.json`：`dsh.pid=35248, managedBy=external, port=3080`；窗口 25560 已登记 |
| 3 | 已装扩展为 0.1.2，CSP 修复在位 | `%USERPROFILE%\.vscode\extensions\dsh-vscode-agent.dsh-vscode-agent-0.1.2\out\webview.js`：`style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src http://127.0.0.1:*`，含 acquireVsCodeApi 诊断分支 |
| 4 | webview 端代码正确、会自我隐藏 overlay | 安装版 `webview.js` 与源码一致：收到 `state:ready`/`setUrl` 即 `overlay.classList.add('hide')`、`frame.src=url` |
| 5 | dsh web 页面可被 frame、无自身 "Initializing" 界面 | `GET /` 200 且含 `__DSH_BOOT__`；无 CSP/X-Frame-Options 阻止 frame；全量 44 个 JS 包仅发现 "initializing"（代码注释）/“加载中”（i18n），无独立 Initializing 界面 → “Initializing” 只能是本扩展 webview 的占位文字 |
| 6 | 面板在 ready 前就被解析 | exthost.log：`0:52:25 activate onView:dsh.panel`；runtime.log：`0:52:26 start`、`0:52:33 ready` → 面板解析先于 ready 约 8s（正是丢消息窗口） |
| 7 | 扩展宿主无异常 | exthost.log 无 ERROR/WARN/未捕获异常 |
| 8 | 环境为 VSCode 1.135.0（> 0.1.2 验证基线 1.134.0） | `Code.exe` ProductVersion 1.135.0 |

---

## 3. 为什么不是已有 Bug（排除项）

- **不是 Bug A（容器/位置）**：面板“能加载”、右侧边栏正常显示 → 容器与视图贡献已生效。
- **不是 Bug B（外部 pid 落库）**：注册表已持久化 `pid=35248`，关停链路可用。
- **不是 Bug C（CSP 挡注入）**：0.1.2 已把 `script-src` 改为 `'unsafe-inline'`；且用户所见为纯 `initializing…`，若 `acquireVsCodeApi` 未定义，webview 会显示 `Webview API 不可用…` 诊断而非纯初始占位 → CSP 注入冲突已排除。
- **不是运行时/后端**：dsh 页面 200 可 frame，状态栏 ready；即便 iframe 载入失败也只会导致空白，不会停在 `initializing…`（`setUrl` 一旦执行 overlay 即隐藏）。

---

## 4. 根因详述（并发时序）

`refresh()` 的实现（src/webview.ts 44-57）：

```ts
private refresh(): void {
  const view = this.view
  if (!view) return
  const state = this.runtime.state
  const url = this.runtime.url
  view.webview.postMessage({ type: 'state', state, url, error })   // ①
  if (state === 'ready' && url && url !== this.lastUrl) {
    view.webview.postMessage({ type: 'setUrl', url })               // ②
    this.lastUrl = url
  }
  if (state !== 'ready') this.lastUrl = null
}
```

触发点只有两个：
- `resolveWebviewView()` 里写 HTML 后立刻 `refresh()`；
- 构造器里 `runtime.on('state', () => this.refresh())`（仅 **state 变化** 时）。

VSCode webview 的 `postMessage`（宿主→webview）在 webview **尚未完成页面加载 / 尚未挂上 `window.addEventListener('message')`** 时不是可靠缓冲（不存在“必达”握手语义）。本场景中：
1. 0:52:25 面板解析，`refresh()` 发 `state: idle` → 途中丢；
2. 0:52:26 `starting` → `refresh()` 发 `state: starting` → 途中丢；
3. 0:52:33 `ready` → `refresh()` 发 `state: ready` + `setUrl` → 若此刻 webview 仍在 boot 中，仍丢；
4. 之后 state 稳定为 `ready`，**不再触发任何 `refresh()`** → 已 `ready` 的 URL 永不补发 → 面板永远停在 `initializing…`。

**放大因素**：`this.view` 在 `onDidDispose` 时**不置空**；配合 `retainContextWhenHidden:false`，若期间 webview 被回收/重建，`refresh()` 可能对已废弃 webview `postMessage`（静默丢弃），加重首条消息丢失概率。

> 本质：**“推”式状态分发缺少“可投递”确认**。webview 何时能收消息是不确定的，而扩展只在状态**变化**时投递一次，错过即永久错过。

---

## 5. 解决方案（待确认后实施）

### 5.1 加握手 + 快照重发（核心，覆盖竞态）
- webview 侧，`acquireVsCodeApi()` 后就绪后立即 `vscode.postMessage({ type: 'ready' })` 通告扩展“监听器已挂好”；
- 扩展侧监听 `onDidReceiveMessage` 的 `ready` 类型，收到后**无条件重发当前 state 快照**（`state` + `setUrl`）——即使状态已是 `ready`；
- `resolveWebviewView` 里仍保留首发，但以握手为准。
- 效果：无论 webview 何时 boot 完成，只要挂上监听器，扩展都会把**最新** ready 状态推给它 → overlay 必被隐藏。

### 5.2 清理失效 view（消除丢消息放大）
- `resolveWebviewView` 里 `webviewView.onDidDispose(() => { if (this.view === webviewView) this.view = null })`；
- `refresh()` 已做 `if (!view) return`，置空后不会再对废弃 webview 投递。

### 5.3 兼容性兜底（1.135 注入漂移，可选加强）
- 若上线后仍偶发，将 CSP 在保留 `'unsafe-inline'` 基础上追加 `vscode-webview://*` 与 `https://*.vscode-cdn.net` 到 `script-src`/`style-src`，兼容 1.135 可能的注入形态。先实施 5.1/5.2，此项按需。

### 5.4 验证
- `npm run compile` → `node scripts/sim.mjs`（生命周期不回归）→ `npm run package` → 重装 VSIX → 按 `docs/联调测试剧本.md` 场景 A（手动起 dsh 再开 VSCode）复测面板应直接显示 dsh UI、不再卡 Initializing。

---

## 6. 待办（等你确认）

- [ ] 你确认按 §5.1/5.2 修改 `src/webview.ts` 并重新打包安装验证（当前选择“先分析，后动手”）。
- [ ]（备查）若需我先把修复落地，随时说一声，改完跑 compile+sim+打包。

## 7. 关联

- 本项目 skill：`dsh-vscode-agent-engineering`（webview 生命周期仲裁约定见 `docs/开发报告.md` §9 Bug C）
- 排障日志：`%LOCALAPPDATA%\DshVscode\logs\runtime.log`、`logs\dsh.log`；VSCode 日志 `%APPDATA%\Code\logs\20260827T005221\window1\exthost\exthost.log`
