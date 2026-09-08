# 面板卡「Initializing」根因分析 · v2（0.1.3 复核）

> 场景复述：用户重装 `dsh-vscode-agent-0.1.3.vsix`、重启 VSCode 后，右下状态栏显示 `DSH 3080`（运行时已 ready），但右侧 DSH 面板仍停在 `initializing…`。
> 版本：DSH Panel 0.1.3（已装，握手修复在位）· VSCode 1.135.0 · dsh（CLI 0.1.1-rc.2，前端 web-frontend 同）
> 类型：排障 / 根因复核 + 解决方案设计（A1 完整链入口）
> 日期：2026-08-27 · 状态：**根因已复核定位，0.1.3 方案被证明不充分；给出 v3 设计待 QA 设计/用户评审**

---

## 1. 目标 / 背景

- **背景**：0.1.2 诊断结论为「webview 启动竞态 + 缺握手」，0.1.3 已按 0.1.2 版 §5.1/5.2 实施
  （webviewReady 握手 + dispose 置空 + 清 lastUrl，commit `e00f974`，分支 `fix-webview-boot-race`）。
- **目标**：复核 0.1.3 已装、握手在位的前提下，面板为何仍卡 `initializing…`；给出**真正的缺陷点**与可落地的 v3 解决方案设计（含角色分工清单）。
- **产出**：本 v2 文档（正式，git 跟踪）；一次性探针中间稿在 `.dsh/tmp/architect/`（轮级，闭环清理）。

---

## 2. 结论（TL;DR）

**根因仍是「扩展 webview 启动竞态 + 消息『单次推送、无 ack、无自愈』」；0.1.3 的握手只是把这个竞态的丢消息概率降低，并没有消除丢点，也不具备任何观测/自愈手段，因此在真实环境仍可复现。**

复核后的真正缺陷点（比 0.1.2 文档更进一步）：

1. `refresh()` 首行 `const view = this.view; if (!view) return` —— **一次静默提前 return，则该轮一条消息都不发**。当 `webviewReady` 到达（或某次 state 事件）恰好发生在 `this.view` 被 `onDidDispose` 置空的窗口内，握手重推被静默吞掉；
2. 握手仍是一次性动作：`webviewReady → refresh()` 只重推**当前那一刻**快照，此后不再补偿。一旦该次重推丢失，而 state 又长期稳定在 `ready`，将永远没有下一条消息 → 面板永久停在 `initializing…`；
3. **扩展侧 `webview.ts` 零日志**：state / setUrl / webviewReady / view 生命周期均不可观测。这是 0.1.2、0.1.3 无法在日志中区分"消息到底丢在哪一环"的根本原因，也让每一次验证都只能靠真机肉眼复测（`REQ_USER`），无法自动判定。

**关键判据**：用户所见为**纯 `initializing…`**（顶部 `#state` 与中央 `#overlay` 都是初始文本）。若页面哪怕收到过一条 `state:starting`，顶部会变成「正在启动 dsh…」；若收到过 `state:ready`，overlay 已被隐藏。因此：**webview 页面在挂上监听器后，一条 state 消息都没收到**——不是"收到但显示错"，而是"根本没收到"。

---

## 3. 范围

**做什么**：
- 复核 0.1.2/0.1.3 方案的充分性；定位真正缺陷点；
- 设计 v3：把"一次性推送"改为"**可自愈、可观测、带 ack 的握手状态机**"；
- 补齐 webview 生命周期观测（诊断日志）。

**不做什么**：
- 不触碰运行时启动/接管/adopt 链路（已由 §4.1 证据证明无异常，非根因）；
- 不改 dsh GUI 前端（已证明前端无 `initializing` 文案，排除）；
- 不在此文档做实施/打包/QA（由 §10 实施清单承接）。

---

## 4. 技术选型及设计：真正缺陷点与 v3 方案

### 4.1 已确认事实（v2 证据链）

| # | 事实 | 证据 |
|---|---|---|
| 1 | 安装版为 0.1.3，**握手代码在位**（exthost `case 'webviewReady'` + 页面 `postMessage({type:'webviewReady'})` + dispose 置空/清 lastUrl） | 安装版 `out/webview.js` L59/L187/L83-85 与 src 一致 |
| 2 | 运行时**确实到 ready**：`[win 36652] state: starting->ready` + `adopt external dsh at http://127.0.0.1:3080 (pid 35864)` | `%LOCALAPPDATA%\DshVscode\logs\runtime.log` 末条 18:28:54Z |
| 3 | 端口 3080 有 dsh 在监听并提供 GUI，`GET /` 200 含 `__DSH_BOOT__`；当前 GUI 即运行于其上 | `netstat`；Invoke-WebRequest |
| 4 | dsh 前端**无 "initializing" 文案**；自身 boot 卡片文案为 **"Loading plugins…"**（wordmark HARNESS + spinner），错误走 `page.fail(msg)` | web-frontend `dist/index.html` + bundle `index-ClqxG24t.js`（"Initializing" 0 命中） |
| 5 | 用户所见 `initializing…` = **扩展 webview overlay/占位**（`#state`、`#overlay` 初始均为此文案） | src/webview.ts |
| 6 | engines.vscode `^1.134.0` vs VSCode 1.135.0 → 兼容，无版本漂移 | package.json 0.1.3、`code --version` |
| 7 | 扩展 `webview.ts` **零日志**，消息链路不可观测 | src/webview.ts 全文 |

### 4.2 为什么 0.1.2 判定与 0.1.3 施策不够（真正的缺陷点）

- **0.1.2 判定的正确部分**：webview「监听器未挂时 host 推送即丢」确实存在；补『挂好后再重推』方向对。
- **0.1.3 的盲区**：
  - 重推**仅一次**、无 ack、无超时自愈；`refresh()` 的 `if (!view) return` 使「view 置空窗口」内重推静默归零；
  - **没有反向 ack**：页面收到 `state:ready` 后不向 host 回报"已显示"，host 无从知道面板是否真的脱离 initializing；
  - **没有观测**：无法从 runtime/dsh/exthost 日志判断消息卡在哪一环，导致每轮验证都依赖真机肉眼（`REQ_USER`），无法自动化回归。

### 4.3 v3 方案设计：带 ack 的自愈状态机 + 观测

用「拉取-确认-重试/自愈」取代「一次性推」：

```
Webview(页面)                           Extension host
   │  boot: acquireVsCodeApi,挂监听       │
   │──postMessage{type:'webviewReady'}──▶│  onReceiveMessage
   │                                     │  push snapshot(state,url,error)  + 记 logs
   │◀──postMessage{type:'state'...}───── │
   │  setUrl / 隐藏 overlay               │
   │──postMessage{type:'stateAck', state,│
   │       applied:true}───────────────▶ │  核对 ack 的 state 是否=当前 state
   │                                     │  └ 不一致 → 再 push（defensive）
```

要点：
1. **ack 回环**：页面渲染/隐藏 overlay 后回 `stateAck {appliedState}`；host 比对，若 ack 的 state ≠ 当前 state（期间又变了）则补推一次。
2. **状态变化重推已具备**：`runtime.on('state')` 会推，但叠加第 1 点后可自愈"推了但页面没收到/没显示"。
3. **一次性兜底**：host 侧在 `ready` 且收到 `webviewReady` 但一段时间（如 ≤3s）未收到对应 ack 时，主动补推 `setUrl`/`state`（抗 view 置空窗口与反向丢包）。
4. **观测**：`webview.ts` 加入 `rlog` 风格诊断（`dsh.panel: emit state=<s> url=<u> | recv <type> | ack=<s> ok=<b>`），写入 `logs/runtime.log`（与现有一致），供无头/QAAutomation 断言与真机复盘。
5. **消除 `if(!view) return` 静默吞**：`onDidDispose` 置空时记录日志；`refresh()` 空 view 时记一条 `view=null` 诊断而非静默返回（可观测化）。

> 不做过度设计：不加轮询心跳；ack 仅做"不一致补推"，不阻塞正常推送路径（推送仍由 `runtime.on('state')` 与 `resolveWebviewView` 驱动，ack 只作为**保险**）。

### 4.4 文件级设计点（供开发专家实施）
- `src/webview.ts`：
  - `WebviewMessage` 增加 `{ type:'stateAck', appliedState?: RuntimeState }`；
  - `refresh()` 空 view 分支加诊断日志（不静默）；
  - `onDidReceiveMessage` 的 `webviewReady`/`stateAck` 分支加日志 +（可选）`ack` 比对补推；
  - 页面侧 `state` 处理末尾追加 `vscode.postMessage({type:'stateAck', appliedState: msg.state})`；
  - 引入复用现有 `rlog`（需在 webview.ts 暴露一个诊断写口或在 extension.ts 传入 logger；纯 `vscode` 耦合层可自行 `fs.appendFileSync(runtimeLogFile())`，禁用任何 vscode 依赖以外新增——遵循项目基线）。
- 日志写入口建议抽一个小函数（复用 `runtimeLogFile()`，路径见 `src/paths.ts`），避免重复。
- 不改 `package.json` engines / 不改运行时链路。

---

## 5. 可行性（证据与风险）

- **可行性**：改动集中在 `src/webview.ts`（纯 UI 消息层 + 日志），不触运行时、不触纯 Node 层，`npm run compile` 可即时校验类型；`node scripts/sim.mjs` 覆盖生命周期（webview 消息不在 sim 范围，需 QA 子代理补 message 单测或脚本级模拟）。
- **风险与缓解**：
  - 反向 `postMessage`（host→webview）在页面刚建时仍可能丢——已由 `webviewReady` 握手 + 本设计 ack 保险兜底；
  - `retainContextWhenHidden:false` 下页面重载会重发 `webviewReady` → 每次重载都会触发 push，天然自愈（加固既有效）。
  - 无法在无头环境直接观测真实 webview 渲染：需在 QA 阶段把**消息往返**做成可测单元（用事件探针注入 fake WebviewView），并保留真机联调（`REQ_USER`）作为最最终判定定。

---

## 6. 可维护性

- **配置/语义分离**：ack 超时、最大补推次数收敛为模块内命名常量（如 `ACK_BUDGET_MS`、`MAX_REPUSH`），不硬编码在逻辑行内；与 `dshProcess.ts` 的 `READY_TIMEOUT_MS` 命名风格一致。
- **观测一致性**：复用一个写日志入口，时间戳/格式与 runtime.log 现有行对齐，便于 grep/exthost 复盘。
- **不膨胀**：方案只改 webview 消息往返 + 日志，不新增文件/不引依赖/不加后台任务；策略参数保留 `dsh.*` 配置扩展余地但 v3 阶段用常量即可（不做配置也够）。

---

## 7. 性能

- 消息量极小：每状态变化 1 条 `state`（现成）+ 页面 1 条 `stateAck`（新增），均为刚性小 JSON，无轮询、无新增定时器热循环；
- ack 超时兜底仅在"应 ack 未 ack"时触发一次补推，开销可忽略；
- 日志追加为异步 `fs.appendFileSync` 短行，现有 `rlog` 同款，不影响范围板首屏。

---

## 8. 验证方案

1. [开发专家] `npm run compile`（`node node_modules\typescript\bin\tsc -p tsconfig.json`）零错误；
2. [测试专家] 在无头/脚本层构造 fake `WebviewView` 与消息探针，断言：`webviewReady → push → stateAck appliedState` 回环；"推了但无 ack"触发补推 ≤ MAX_REPUSH；`view=null` 时 refresh 记录诊断不抛错；
3. [测试专家] `node scripts/sim.mjs` 生命周期不回归（8/8）；
4. [部署专家] `npm run package` → `dsh-vscode-agent-<ver>.vsix`；
5. [QA] 真机联调（`REQ_USER`，按 `docs/联调测试剧本.md` 场景 A：手动起 dsh 再开 VSCode），需确认：面板直接显示 dsh UI、`logs/runtime.log` 出现 `dsh.panel` 消息链（`emit state=ready` → `recv webviewReady` → `ack=ready ok=true`），以此作为可自动核对的通过判据（不再纯肉眼）。

---

## 9. 决策记录

> 本节以「候选方案 / 约束 / 决策 / 理由」四列结构化收敛 v3 方案的关键决策（决策理由源自 §4.2/4.3/4.4 的散文说明），供评审、回溯与后续维护直接引用。

| 决策点 | 候选方案 | 约束 | 决策 | 理由 |
|---|---|---|---|---|
| 握手机制 | ①一次性 webviewReady 握手（0.1.3 现状）；②带 ack 的自愈状态机（v3） | 消息「单次推送、无反向 ack、无超时自愈」；`refresh()` 首行 `if(!view) return` 使 view 置空窗口内重推静默归零 | 采用 v3 带 ack 的自愈状态机：反向 `stateAck` + 比对补推 + 超时兜底 | 0.1.3 一次性推仅降低丢概率、不消除丢点，且无观测/自愈手段，真实环境仍可复现永久 `initializing…`；ack 回环 + 比对补推 + 超时兜底能抗「推了但页面没收到/没显示」与 view 置空窗口 |
| 心跳机制 | 轮询心跳（候选） | 额外消息量/复杂度/非必要；已有 ack 提供防御性自愈 | 否决轮询心跳；ack 仅作「不一致补推」保险，不阻塞正常推送路径 | 推送仍由 `runtime.on('state')` 与 `resolveWebviewView` 驱动，ack 只作保险；轮询会引入定时器热循环、复杂度与日志噪音，属过度设计 |
| retainContextWhenHidden 加固 | 额外加固（候选） | `retainContextWhenHidden:false` 下页面重载会重发 `webviewReady` | 保留现有配置，利用「重载重发」实现自愈，不额外加固 | 每次页面重载都重发 `webviewReady` → 触发 push，天然自愈；加固既有方案有效且零新增成本 |
| 常量命名 | 行内硬编码超时/补推次数 | 去硬编码、可维护性 | 收敛为模块内命名常量 `ACK_BUDGET_MS`、`MAX_REPUSH` | 与 `dshProcess.ts` 的 `READY_TIMEOUT_MS` 命名风格对齐；常量集中、语义清晰，便于调整与测试断言 |
| 日志观测 | 复用 `runtimeLogFile()` 写 runtime.log（`dsh.panel` 消息链） | webview.ts 现状零日志、消息链路不可观测；上轮 qa_publish P5「真机联调从未自动验证」仅肉眼 REQ_USER | 统一写日志入口，记录 `emit/recv/ack` 消息链 | 补足 P5 缺口：将真机联调通过判据自动化为 runtime.log 中可 grep 的 `dsh.panel` 消息链，供无头/QAAutomation 断言，不再纯肉眼 |

---

## 10. 实施清单（逐项标注角色）

| # | 事项 | 角色 |
|---|---|---|
| 1 | 在 `webview.ts` 引入统一诊断写口（复用 `runtimeLogFile()`），`refresh()` 空 view 分支记录而非静默 return | [开发专家] |
| 2 | `WebviewMessage` 增 `stateAck`；页面 `state` 处理后回报 `stateAck{appliedState}` | [开发专家] |
| 3 | host 侧 `webviewReady`/`stateAck` 处理：日志 + ack 比对（不一致则补推）+ 无 ack 超时兜底补推（≤常量上限） | [开发专家] |
| 4 | 常量收敛（`ACK_BUDGET_MS`、`MAX_REPUSH`）命名与注释 | [开发专家] |
| 5 | `npm run compile` 零错误；fake WebviewView 消息回环/补推/空view 探针单测 | [测试专家] |
| 6 | `node scripts/sim.mjs` 生命周期不回归（8/8） | [测试专家] |
| 7 | `npm run package` 打包 vsix | [部署专家] |
| 8 | 装回并真机复测场景 A；以 runtime.log `dsh.panel` 消息链为自动可核对的通过判据 | [QA]（真机 [REQ_USER，用户执行]） |
| 9 | 回归确认状态栏 `DSH 3080` ready 正常、关闭后 dsh 不误杀 | [QA] |

---

## 11. 关联与后续

- 上一版：`docs/面板卡Initializing根因分析.md`（0.1.2）
- 发布/代码/部署审计：`.dsh/reports/qa_publish_fixwebview_20260827.json`、`qa_code_fixwebview_20260827.json`、`deploy_fixwebview_20260827.json`（注意 P5：0.1.3 真机联调从未自动验证，本 v2 已把"可自动核对判据"纳入验证方案）
- 探针中间稿：`.dsh/tmp/architect/probe-notes-0.1.3.md`（闭环清理）
- 项目 skill：`dsh-vscode-agent-engineering`
