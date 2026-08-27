# 面板卡「Initializing」根因分析 · v3（0.1.4 真机复核）

> 场景：用户重装 `dsh-vscode-agent-0.1.4.vsix`、重启 VSCode 后，右下状态栏显示 `DSH 3080`（运行时已 ready），但右侧 DSH 面板仍停在 `initializing…`。
> 版本：DSH Panel **0.1.4（已装，握手+ack+补推在位）** · VSCode 1.135.0 · dsh（CLI 0.1.1-rc.2）
> 类型：排障 / 根因复核（A1 完整链入口）· 日期：2026-08-27 · 状态：**第 3 轮根因复核；推翻「view 未建立」前提；定位到「webview 文档未渲染/未握手」；给出 v4 设计待 QA 设计/用户评审**
> 证据会话：窗口 `win 35964`，启动段 `2026-08-27T02:04:23–25Z`（= 本地 10:04:23–25），VSCode 日志 `%APPDATA%\Code\logs\20260827T100403\`

---

## 零、前置参考

- 上一版：`docs/面板卡Initializing根因分析-v2-0.1.3复核.md`（第 2 轮，结论「消息竞态丢包 + 一次性握手不充分」→ 已实施为 0.1.4）
- 再上一版：`docs/面板卡Initializing根因分析.md`（第 1 轮，0.1.2，结论「boot race + 缺握手」）
- 项目 skill：`dsh-vscode-agent-engineering`
- 本轮中间稿/探针：`.dsh/tmp/architect/`（轮级，闭环清理）

---

## 一、目标 / 背景

**背景**：0.1.3 加 `webviewReady` 握手、0.1.4 加 `stateAck`+ack 超时补推，两轮都假设「`this.view` 已存在、只是 host→webview 消息在启动竞态中丢失」。用户真机装 0.1.4 后仍卡 `initializing…`。本轮 **决定性新证据** 是 0.1.4 自带的 `dsh.panel:` 诊断日志，首次让「消息到底卡在哪一环」可观测。

**目标**：
1. 核对「本轮日志到底证明了什么、推翻了什么」——尤其是**是否真的证伪前两轮根因、是否真的成立「view 从未建立」**；
2. 定位真正的缺陷所在链路；
3. 给出可落地、**不依赖消息往返**的 v4 解决方案设计（含可执行探针，可无装扩展最小化判定视图能否被 resolve）。

---

## 二、结论（TL;DR）

**本轮日志并不支持「`this.view` 从未建立」这一判断——反而证明视图已被解析、host 已成功 `emit state=ready`。真正的异常在 webview 文档这一侧：页面从始至终没有回传过一次握手（`recv webviewReady` 0 次、`recv stateAck` 0 次），面板页脚本没有实际执行，因此停留在初始 `initializing…` 占位。**

一句话根因：
> **`resolveWebviewView` 已被 VSCode 调用、`this.view` 已建立、host 已把 `state=ready`/URL 推给 webview（日志 `emit state=ready` 可证）——但 webview 渲染进程侧的页面文档没有真正加载/执行其脚本，`webviewReady`/`stateAck` 一个都没回来，页面永久停在扩展初始 HTML 的 `initializing…`。前两轮「消息竞态丢包」与「view 未建立」都是同一观测在不同错误假设下的产物，均被本轮日志证伪。**

对前两轮根因的裁决：
- **证伪**「view 从未存在 / 消息丢在 host→webview 途中」：若 view 未建立，`emit` 不会出现（代码中 `emit` 仅在 `this.view` 非空分支打印）；若只是 host→webview 丢包，页面脚本一旦执行就会 `postMessage(stateAck)`，而 0 次 `stateAck` 说明页面脚本根本没跑。
- **证伪**「0.1.4 的 ack/补推未生效或不够」：ack 补推的设计假设「页面在监听、能回 ack、只是某条消息丢」。实际是页面从未回任何 ack——再多的 host 侧补推也毫无意义，因为**回环的另一端（页面脚本）从未启动**。

---

## 三、范围

**做什么**：
- 复核 0.1.4 真机日志（`logs/runtime.log` 的 `dsh.panel:` 行）与 VSCode exthost 日志（`20260827T100403`）；
- 逐项探针 A（视图贡献点配对）、B（注册链路）、C（1.134→1.135 回归）、D（`initializing` 文案唯一来源）并给结论；
- 设计 v4：**不依赖 webview 消息往返的面板渲染方案** + 把「webview 文档是否真的渲染/执行」做成可自动判定的观测。

**不做什么**：
- 不触碰运行时启动/接管/adopt 链路（已由日志证明无异常，非根因）；不改 dsh GUI 前端（已排除 `initializing` 文案来自 dsh）。

---

## 四、已确认事实（证据链）

### 4.1 决定性日志（`%LOCALAPPDATA%\DshVscode\logs\runtime.log`，win 35964 启动段）

```
[02:04:23.364Z] [win 35964] state: idle -> starting
[02:04:23.370Z] [win 35964] dsh.panel: refresh: view=null (state=starting); skipping push
[02:04:23.372Z] [win 35964] start: window 35964 ...
[02:04:25.260Z] [win 35964] step2 looksLikeDsh=true
[02:04:25.261Z] [win 35964] state: starting -> ready
[02:04:25.262Z] [win 35964] dsh.panel: refresh: view=null (state=ready); skipping push
[02:04:25.263Z] [win 35964] adopt: external dsh at http://127.0.0.1:3080 (pid 22216)
[02:04:25.353Z] [win 35964] dsh.panel: emit state=ready url=http://127.0.0.1:3080 error=null
```

全文统计（同一 session，grep 确认）：
| 事件 | 次数 |
|---|---|
| `dsh.panel: refresh: view=null … skipping push` | **2**（starting 与 ready 各 1） |
| `dsh.panel: emit state=…` | **1**（state=ready，25.353） |
| `dsh.panel: recv webviewReady` | **0** |
| `dsh.panel: recv stateAck` | **0** |
| `dsh.panel: dispose` | **0** |

### 4.2 探针逐项结论

| 探针 | 结论 | 证据 |
|---|---|---|
| **A. 视图贡献点配对** | ✅ **配对正确，不成立根因**。`contributes.viewsContainers.secondarySidebar[0].id = dsh-viewContainer`（连字符，满足 `^[a-z0-9_-]+$`）；`contributes.views["dsh-viewContainer"][0].id = dsh.panel`；`registerWebviewViewProvider(DshPanel.viewId='dsh.panel', …)` 与 `activationEvents onView:dsh.panel` 完全一致。**且日志 `emit state=ready` 只在 `this.view` 非空时打印 → 直接证明 resolveWebviewView 已被调用、view id 匹配有效**（若 id 不匹配，resolve 永不回调，view 恒 null，绝无 emit）。视图 id 含点号（`dsh.panel`）在 VSCode 中对 `views` 是合法 id（内置/大量扩展均用点/冒号），与 Bug A（容器 id 禁点号）是两回事。 | `package.json` contributes；`src/extension.ts` L75-78；`src/webview.ts` L9, L121-127；runtime.log |
| **B. registerWebviewViewProvider 注册链路** | ✅ **注册正确、及时**。`activate()` 内同步注册 `DshPanel` provider，`webviewOptions.retainContextWhenHidden:false` 合法；provider 与 `DshRuntime` 松耦合（仅订阅 state 事件），不阻塞 resolve。0.1.4 本次激活事件为 `onStartupFinished`（见 4.3），但 provider 在 activate 内即注册，不依赖具体激活事件。 | `src/extension.ts` L73-78；exthost.log |
| **C. 1.134→1.135 回归** | ⚠️ **未证实具体破坏点，但存在高度可疑的「侧边栏 webview 视图内容不渲染」已知问题面**。1.135 无针对 `viewsContainers`/`secondarySidebar`/`registerWebviewViewProvider` 的明确 breaking change；但 VSCode 一直有「sidebar webview view 已 resolve（host 侧 html 已设）却在 workbench 渲染进程不显示/不执行」的 issue（如 microsoft/vscode#139638）。本会话**激活事件从 0.1.2/0.1.3 的 `onView:dsh.panel` 变为 0.1.4 的 `onStartupFinished`**（见 4.3）——面板非启动即可见，改为启动后懒加载 resolve，与「侧边栏 webview 懒加载不渲染」的已知问题相互作用，列为**主要嫌疑（需下一轮 webview 侧探针证实，非已证根因）**。 | exthost.log；web_search（见关联 §11） |
| **D. `initializing…` 文案唯一来源** | ✅ **唯一来源 = 扩展 webview 初始 HTML**。`src/webview.ts` L232 `#state` 与 L238 `#overlay` 初始均为 `initializing…`；已装 0.1.4 `out/webview.js` 含同样文案；dsh GUI 前端无此文案（v2 已全量排除）。注意：若页面脚本执行但 `acquireVsCodeApi` 未定义，页面会把文案改写为「webview API unavailable」（L246-251）——用户所见为**纯 `initializing…`**，说明**页面脚本连第一个分支（acquireVsCodeApi 判空）都没执行 → 文档根本没有加载/执行其 JS**。 | `src/webview.ts`；已装扩展 `out/webview.js`；v2 文档 |
| **补充：页面脚本语法** | ✅ **页面内联脚本语法合法，非「脚本写错导致不跑」**。从 `src/webview.ts` 提取完整 `<script>` 体（2414 字符）经 `node:vm.Script` 语法校验通过，含 `acquireVsCodeApi` 与 `webviewReady` post。确认不是语法错误阻断 boot。 | `.dsh/tmp/architect/probe_page_boot_syntax.mjs` |

### 4.3 VSCode exthost 日志（`%APPDATA%\Code\logs\20260827T100403\window1\exthost\exthost.log`，共 18 行）

- `10:04:23.256` **`_doActivateExtension dsh-vscode-agent.dsh-vscode-agent, startup:false, activationEvent:'onStartupFinished'`**
- 整个 session **无** `onView:dsh.panel` 激活、**无** webview/CSP/「no view provider」错误行。

对比历史会话激活事件：
| 会话 | 版本 | 激活事件 |
|---|---|---|
| `20260827T005221`（00:52） | 0.1.2 | `onView:dsh.panel` |
| `20260827T022841`（02:28） | 0.1.3 | `onView:dsh.panel` |
| `20260827T100403`（10:04，win 35964） | **0.1.4** | **`onStartupFinished`** |

> 含义：本轮面板**不是启动即解析**，而是 `autoOpenPanel` 在 ready 后 `openPanel()` 才把容器 reveal、VSCode 才懒加载调用 `resolveWebviewView`（与 `emit` 发生在 ready 之后 0.09s 吻合）。这本身可自洽，但叠加「侧边栏 webview 懒加载不渲染」的已知问题面，成为核心嫌疑。

### 4.4 附带发现（非本根因，但需 A1 链处理）

- 当前工作树 `node scripts/sim.mjs` = **6/8**：`closing last window stops dsh` 与 `registry dsh record cleared` 两个 FAIL（已在干净环境复现 2 次）。根因是 0.1.4 **未提交**工作树改动给 `shutdownBookkeeping()` 新增了 `resolvePortPid` 端口占用者校验（safe-side 硬化，`verify holder pid/port mismatch → NOT killing`），而 sim 用 mock server、不满足该真实端口持有校验，最后窗口关停断言失败。**与 webview 根因无关**，但 v4 实施时应一并协调开发/测试适配 sim（或回填 mock 真监听）。证据：`git diff HEAD -- src/runtime.ts`（shutdownBookkeeping 段）；sim 结果。

---

## 五、根因详述（5-Why + 时间线）

### 5.1 时间线重演（win 35964，0.1.4）

```
02:04:23.36  runtime idle->starting
02:04:23.37  state 事件触发 refresh()：view 尚未解析 -> "view=null skip"（正常，面板没被 reveal）
02:04:25.26  runtime starting->ready（接管外部 dsh 22216）
02:04:25.26  state=ready 触发 refresh()：此时 view 仍未解析 -> "view=null skip"
02:04:25.35  openPanel() reveal 容器 -> VSCode 懒加载调用 resolveWebviewView('dsh.panel')
             -> this.view 置位，webview.html=…（含 initializing… 的页面），装 onDidReceiveMessage
             -> resolveWebviewView 末尾 this.refresh() -> emit state=ready url=…（日志最后一行）
   …此后无任何 dsh.panel 日志……
```

### 5.2 5-Why

1. **为什么面板停 `initializing…`？** 页面脚本没有把 `#state`/`#overlay` 的初始文案更新掉（没收到/没处理 `state` 消息）。
2. **为什么没更新？** 页面**从没回过** `webviewReady`/`stateAck`（0 次）→ 页面脚本没有完成其 boot 回环。
3. **为什么脚本没 boot 回环？** 有两个逻辑岔路：
   - (a) 若脚本执行了但 `acquireVsCodeApi` 未定义，脚本会改写文案为「webview API unavailable」——用户**没**看到该文案，故排除 (a)；
   - (b) 因此只剩：**webview 文档在渲染进程侧没有被真正加载/执行**（html 已在宿主侧赋值 `this.view`/`webview.html`，但渲染侧 webview 内容未就绪/未 run），页面仍显示初始 html 的第一个静态帧 `initializing…`。
4. **为什么渲染侧文档没加载/执行？** 表白在 `resolveWebviewView` 之后 `emit state=ready` 确已发出（宿主侧调度正常），问题在 **workbench/webview-iframes 渲染进程侧的内容呈现**：侧边栏 webview view 懒加载（`onStartupFinished` 而非启动即 reveal）时，其文档加载存在未渲染/未执行脚本的已知不稳定面（VSCode issue #139638 类），或本机 1.135 该路径出现回归。
5. **为什么前两轮没发现？** 前两轮没有 `dsh.panel:` 日志，看不到「emit 已发、recv 为 0」，只能把「页面没动」误归因为「消息在 host→webview 途中丢」。0.1.4 日志第一次把这条链路点亮，反证宿主导出正常、页面侧没跑起来。

> **诚实边界**：宿主侧证据链（4.1/4.2）**已确证**「视图已建立、host 已 emit、页面 0 握手、`initializing` 文案只能来自未被执行脚本的初始 html」。至于「渲染进程为何不加载/执行该 webview 文档」的**确切子原因**（懒加载不渲染回归 / 1.135 回归 / 本机 webview 进程异常），宿主日志无法观测到渲染进程侧，**必须在 v4 以 webview 侧探针实证**，不能在此臆定。给出优先级最高的可执行探针见 §七。

---

## 六、系统技术选型及设计（v4 方案）

### 6.1 设计目标

让面板**不再依赖「宿主 → webview 消息往返」才能显示 dsh UI**，从而既绕开「页面脚本不执行就永远 initializing」这一根因，也顺带对「页面脚本偶发不跑」的残余风险免疫；并把「webview 文档是否真的渲染/执行」变成可自动核对的探针结果。

### 6.2 核心改动思路

当前 html 把 `<iframe src>` 留空，靠 `setUrl` 消息驱动（页面脚本**必须**跑起来才能收到 setUrl 去赋值 src）。一旦页面脚本不跑 → iframe 永远空、overlay 永远 initializing。

**v4 让 iframe 的 src 由宿主在写 html 时就确定下来**，即使页面脚本完全不执行，iframe 也会按 html 里的静态 src 加载 dsh UI：

```
resolveWebviewView():
  this.view = webviewView
  const url = this.runtime.url            // 本场景已 ready，url 已知
  webviewView.webview.html = this.html(wv, url)   // url 直接烘进 <iframe src="...">
  ...
```

页面脚本保留为**增强层**（工具栏、错误文案、state 更新显示），而非**必需层**；若脚本不跑，至少 dsh UI 已显示（iframe 自载），不再卡 initializing。

> **★ 硬约束（去硬编码，用户评审意见）**：v4 烘焙进 `<iframe src>` 的 url / 端口**一律运行时驱动，必须来自 `DshRuntime.url`**（其在运行时由端口解析 / `dsh.port` 配置 / 实际探测得到，见 §八-8.3）。**任何处（iframe src、html 模板、host 拼接、页面脚本）不得出现 `127.0.0.1` / `3080` / `http://` 字面量写死**；iframe 基础 url 前缀（`http://127.0.0.1:`）也须**整体取自 `runtime.url`**——烘焙时直接 `src="${this.htmlEscape(runtime.url)}"`，禁止再自行拼接主机前缀或硬编码端口。此约束由 QA 代码审计 C3（无硬编码）专项核对（见 §十一-项 1/2 与跨项说明）。

> 时序注意：`resolveWebviewView` 也可能发生在 ready 之前（url 未知）。此时先渲染不带 src 的占位；随后 state→ready 时由宿主**重设 html（带最终 url）** 或调用 `webviewView.webview.postMessage`。为确定性，v4 采用「ready 后重设 html / 或 html 里放 `data-url` 占位 + 脚本回填 + 宿主兜底」的双保险，见 6.4 决策。**不论走哪条路径，最终写入 iframe 的 src 都只能是 `runtime.url`（或 `runtime.url` 派生，如 None 时留空）**，绝无其它来源。

### 6.3 时序图（v4）

```
Extension host                                     Webview 渲染进程（页面）
  runtime ready, url=known
  openPanel reveal container
   └─ resolveWebviewView('dsh.panel')
       ├─ this.view = view
       ├─ html = this.html(wv, url)   // <iframe src="url"> 已烘焙
       └─ html 写入 webview.webview
                                                     ┌─ 文档加载：iframe 直接按 src 加载 dsh UI（无消息依赖）
                                                     └─ 若脚本执行：向 host 发 webviewReady（增强）
  (可选) recv webviewReady -> 补推 state（增强）
```

### 6.4 关键决策点（见表 §九-决策记录）

| 决策 | 采用 | 理由 |
|---|---|---|
| iframe 初始化方式 | **html 烘焙 src**（而非仅靠 setUrl 消息） | 根因是「页面脚本不执行→收不到 setUrl」；烘焙 src 让 iframe 不依赖脚本，直接显示 dsh |
| iframe/url 来源 | 运行时 `runtime.url` 驱动 | **去硬编码基线**：url 为运行时计算结果（端口回落/配置 `dsh.port`/外部探测），烘焙 src 直接取 `runtime.url`，任何处不得出现 `127.0.0.1`/`3080`/`http://` 字面量写死 |
| 脚本角色 | **增强层非必需层** | 出现「脚本不跑」这一根因时，面板仍显示 UI；脚本负责状态栏文字/错误/工具栏等非关键增强 |
| ready 前 resolve 的补丁 | host 在 state→ready 且 url 变化时重设 html 一次（带 url），并保留 setUrl/ack 增强 | 保证「resolve 早于 ready」的启动时序同样能烘焙到最终 url |
| 观测 | 页面脚本首行向 document.title / #state 写「page-booted」，host 与 QA 通过 iframe 加载+页面文件判据核对 | 把「webview 文档到底跑没跑」变成可抓证据，替代纯肉眼 |
| 兜底再升级（可选） | 若 webview view 渲染面持续不可靠，备选 **WebviewPanel** 或浏览器打开 | 不在此轮实施，仅记录为 Plan B |

### 6.5 范围收敛（v4 改动文件）

- 主要：`src/webview.ts`（html 烘焙 url + ready 重设 html + 页面 boot 观测）
- 不动：`runtime.ts`/`instance.ts`/`dshProcess.ts`/`paths.ts`（纯 Node 层）
- 不改：`package.json` contributes（视图 id 配对已证实正确，无需改）

---

## 七、可行性分析（含探针数据）

### 7.1 技术可行性

- 改动集中于 `src/webview.ts`，`node node_modules\typescript\bin\tsc -p tsconfig.json` 零错误（本轮已验证基线通过）。
- 不触纯 Node 层、不新增依赖。

### 7.2 下一轮探针计划（把「webview 文档是否渲染/执行」实证化，均可不重装扩展、最小化验证）

1. **确认 activated / resolve 侧状态**（宿主侧，本轮已证）：`exthost.log` 应能 grep 到 `activate onView:dsh.panel` **或** `onStartupFinished` + runtime.log `dsh.panel: emit state=ready`。只要出现 emit 即证明 resolve 已调、view 已建。
2. **证实「页面脚本是否执行」**（关键，需一次带观测的运行）：
   - 在 v4 html 页面脚本首行增加 `document.title += ' ·booted'` 并在 `#state` 写 `page booted`；同时 `console.log`（转 devtools）。启动后：
     - 若 VSCode 状态栏右侧出现「DSH view ·booted」标题 / 用户能打开 Webview DevTools 看到 boot 日志 → 页面脚本执行了（此时若仍卡 initializing 则是脚本执行后 postMessage/收到消息环节问题，另行定向）；
     - 若 devtools 打开看不到任何 boot 输出、页面还是初始 html → **证实 webview 文档未加载/未执行**，落定根因（此即本轮最可能的结论）。
3. **判定 VSCode 侧成因**（区分 1.135 回归 vs 懒加载不稳）：
   - 用 `code --enable-logging --log=window/webview` 起一次，grep `webview` 相关日志（`Webview`/`iframe`/`didFailLoad`）；
   - 或对比：把 `dsh.autoOpenPanel` 关掉、手动点开面板，看是否触发 `onView:dsh.panel` 激活且页面是否渲染——可区分「启动即 reveal」与「懒加载 reveal」两种路径的差异。
4. **最小化判定视图可被 resolve**（无装扩展）：不必装 vsix——`src` 改动后 `npm run compile` + F5 扩展宿主调试（或 `code --extensionDevelopmentPath .`），在面板打开后看 runtime.log 是否出现 `dsh.panel: emit state=ready`→即证 resolve 链路通；若有「页面 booted」观测则进一步证页面渲染。

---

## 八、可维护性分析

- 烘焙 src 用 `runtime.url`（现有 `DshRuntime.url`），不新增配置；语义单一（url 即 iframe 目标），符合「去硬编码/参数驱动」。
- **url 为参数/配置驱动，非字面量**：烘焙 `<iframe src>` 只接受 `runtime.url` 这一个来源；html 模板中不留任何 `127.0.0.1` / `3080` / `http://` 字面量。iframe 基础 url 前缀整体取自 `runtime.url`，禁止在 webview 侧自行拼接主机前缀或端口。
- 观测文案集中在页面脚本局部，`dsh.panel:` 日志写口已存在（本轮沿用），grep 规则不变。
- 增强层与必需层的职责切分清楚：html 烘焙为必需（保底显示），消息回环为增强（交互/状态），注释标注，降低后续维护认知负担。

### 8.3 `runtime.url` 来源核实（去硬编码的既有事实）

核实 `src/runtime.ts` 中 `DshRuntime.url` 的两条赋值来源（均已复读源码）：

| 路径 | 赋值 | 是否运行时解析 | 说明 |
|---|---|---|---|
| `spawnManaged`（L148-155） | `this.url = info.url` | ✅ 是 | 来自 `DshProcess` 的 `'port'` 事件——dsh 子进程**实际监听地址**（`--port 0` 回落随机后由 dsh 上报真实端口），完全运行时 |
| `adopt`（L183） | `this.url = \`http://127.0.0.1:${port}\`` | ✅ 端口是（运行时探测），⚠️ **前缀是字面量** | 端口来自注册表 / `probe` / `waitForExternalStartup` 的运行时探测结果（`dsh.port` 配置或已记录真实端口），非写死；但**主机前缀 `http://127.0.0.1:` 为源码字面量硬编码** |

结论：
- **`url` 本身无硬编码 3080 默认、无写死端口**——`this.options.port` 由 `dsh.port` 配置驱动（配置缺省 3080 一旦被非 DSH 占用即回落随机并由 dsh 上报实际值）。因此烘焙用 `runtime.url` 即满足「参数/配置驱动/运行时计算」语义。
- **发现既有硬编码点（标注，非本轮改动引入）**：`adopt()` L183 的 `http://127.0.0.1:` 前缀、以及 webview 侧 CSP `frame-src http://127.0.0.1:*` 均为字面量。**v4 烘焙 src 不得沿用/复制这类字面量**，只整体取 `runtime.url`；上述既有字面量点的彻底重构（如统一由 host 配置拼接、暴露为常量）属后续收敛项，可纳入 A1 链扩展或在设计评审时明确其边界，**不改变 v4 技术方案**。

---

## 九、性能分析

- 面板首帧：ready 后一次 html 写入即含 dsh URL，iframe 与页面脚本并行加载，**不再等消息往返**，理论首屏更快；无新增定时器/轮询。
- 若走「ready 重设 html」路径：html 重写一次 < 1KB，开销可忽略；仅在 resolve 早于 ready 的时序触发一次。
- 诊断日志为既有 `fs.appendFileSync` 短行，量级不变。

---

## 十、决策记录

| 决策点 | 候选 | 约束 | 决策 | 理由 |
|---|---|---|---|---|
| 面板首屏渲染依赖 | ①仅 setUrl 消息（0.1.4 现状）②html 烘焙 src（v4） | 根因=页面脚本不执行→消息路径失效 | **② html 烘焙 src** + 消息作为增强层 | 使 iframe 自载 dsh 不依赖消息与脚本，直接绕开根因；对「脚本偶发不跑」免疫 |
| 剩余消息回环 | ①去掉 ②保留为增强 | ack/补推新增完整、无害 | **② 保留**（webviewReady/stateAck/补推） | 增强层提供状态栏/错误/工具栏；不阻塞不依赖 |
| 观测判据 | 纯肉眼 | 历史 P5：真机从未自动核对 | 页面 boot 观测（`·booted` 标题+devtools 日志）+ runtime 已有 emit/recv 链 | 把「文档是否渲染/脚本是否执行」变为可抓取证据 |
| view/容器贡献点 | 改 id | id 实测已配对成功、emit 已在 | **不改** | A 探针证伪「未配对」；改 id 徒增风险 |
| 兜底 Plan B | WebviewPanel/浏览器 | 架构层级大 | 作为可选 Plan B 记录 | 若 webview view 渲染面持续不可靠再升级 |
| iframe/url 来源 | 硬编码字面量 vs `runtime.url` | 去硬编码基线 + 端口可能由 3080 回落随机 | **仅运行时 `runtime.url` / 配置驱动**，禁止硬编码字面量（`127.0.0.1`/`3080`/`http://`） | 去硬编码基线；端口可能由 3080 回落随机，写死即失效；`runtime.url` 已是运行时计算结果 |

---

## 十一、实施清单（逐项标注角色）

| # | 事项 | 角色 |
|---|---|---|
| 1 | `webview.ts`：`html()` 增加可传入 `url` 并烘焙 `<iframe src>`；`resolveWebviewView` 用当前 `runtime.url` 渲染（resolve 早于 ready 时先空 src）。**子约束：src 只取自 `runtime.url`；html 模板/拼接处不得出现 `127.0.0.1`/`3080`/`http://` 字面量；iframe 基础 url 前缀整体用 `runtime.url`，禁止自行拼前缀/端口** | [开发专家] |
| 2 | `webview.ts`：state→ready 且 url 变化时，若当前 html 未含该 url，则「重设 html（含 url）」一次，并保留 setUrl/ack 补推增强。**子约束：同项 1——重设写入的 src 只来自 `runtime.url`，不引入任何硬编码** | [开发专家] |
| 3 | `webview.ts`：页面脚本首行加 boot 观测（`document.title += ' ·booted'` + `console.log`），不改坏 ack/工具栏逻辑 | [开发专家] |
| 4 | `npm run compile` 零错误。`node scripts/sim.mjs`：**注意当前工作树为 6/8（2 FAIL：`closing last window stops dsh`、`registry dsh record cleared`）**——0.1.4 未提交改动给 `shutdownBookkeeping` 新增了 `resolvePortPid` 端口占用者校验（safe-side 硬化），但 sim 用 mock server、未满足该真实端口占用者校验，导致最后窗口关停断言失败；v4 应与开发/测试协调**适配 sim**（或回填 mock 真监听）以恢复 8/8 | [开发专家][测试专家] |
| 5 | fake `WebviewView` 探针：断言「url 已知时 html 含 iframe src」、「resolve 早于 ready 时空 src、ready 后重设含 src」 | [测试专家] |
| 6 | `npm run package` 打包 vsix | [部署专家] |
| 7 | 真机复测场景 A；以 runtime.log `emit state=ready` + 页面 `·booted` 标题（或 devtools boot 日志）为自动化核对判据；区分「脚本执行但消息不通」vs「文档未渲染」 | [QA]（真机 [REQ_USER，用户执行]） |
| 8 | 若第 7 步确证「文档未渲染」，按 §7.2 探针 3 再定位 1.135 回归 vs 懒加载不稳，必要时提交/跟踪 VSCode issue，并评估 Plan B | [架构师][QA] |

> **跨项说明（去硬编码 C3 专项审计）**：项 1/2 的「子约束」为**不可违反约束**。开发专家实施后，须经 QA 代码审计的 **C3（无硬编码）专项核对**：grep 烘焙入 `src/webview.ts` 的 `iframe src` 赋值链，断言其只源自 `runtime.url`/配置，且源码中**新增**（v4 引入）的 `127.0.0.1`/`3080`/`http://` 字面量为 0 处。该核对结果作为项 1/2 完成的 QA 门控判据之一；C3 不通过则回环开发专家（retry ≤3）。
>
> 评审人：QA 设计门控（[QA]）→ 用户评审 → 通过后进入开发。状态：待评审。

---
> 关联与后置：本 v3 属第 3 轮，若本轮设计经 QA/用户评审通过，进入 A1 实施链；若真机复测仍 FAIL，回环架构师（retry ≤2）。历史文档见 §零。
