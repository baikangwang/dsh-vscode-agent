---
name: dsh-vscode-agent-engineering
description: dsh-vscode-agent 项目工程知识：模块分层、编译/测试命令、VSIX 打包与安装验证、生命周期仲裁约定、外网代理与沙箱边界、历史坑与回归流程。
whenToUse: 在 dsh-vscode-agent 项目做开发/测试/打包/排障需要项目级工程上下文时。
---

# dsh-vscode-agent-engineering — 项目级 skill（按需加载）

> 属性：项目级（`.dsh/skills/` 官方发现根，cwd 选择 project roots）
> 用途：低频、大体积、参考型工程项目知识；模型按需 `skill("dsh-vscode-agent-engineering")` 拉取。
> 承载方式：经 `dsh-skill-filesystem` 发现根注册（预设挂载 `skill-filesystem` + `tool-skill`）；本文件为内容源。
> **本 skill 是项目专属内容的家**：共享契约只写"如何检查"，本项目的技术事实与纪律写在这里与 `.dsh/profile.yaml`。

## 1. 项目概览
- 工程：dsh-vscode-agent（displayName **DSH Panel**）—— DeepSeek Harness 的 VSCode 右侧边栏面板扩展
- 语言/框架：TypeScript + VS Code Extension API（engines.vscode ^1.134.0，CommonJS/ES2022）
- 运行时：Node ≥20（npm 托管 dsh，不 fork/不打 dsh 进包）
- 打包：vsce → `dsh-vscode-agent-<ver>.vsix`（薄壳 ~20KB）；离线安装 `code --install-extension *.vsix`
- 数据目录：`%LOCALAPPDATA%\DshVscode`（实例注册表 / 原子锁 / logs）
- 默认端口：3080（`dsh.port` 可配；被非 DSH 占用自动回落随机）

## 2. 模块分层（src 目录）
```
src/
├── extension.ts      ← 激活/命令/配置/状态栏/生命周期钩子（vscode 耦合）
├── webview.ts        ← 右侧边栏 iframe 面板 + 状态覆盖层 + 工具栏（vscode 耦合）
├── webviewDetails.ts ← 面板详情渲染（vscode 耦合，实测 import 'vscode'）
├── webviewHtml.ts    ← 面板 HTML 拼装（纯 Node）
├── panelMessages.ts  ← 面板消息协议（纯 Node）
├── runtime.ts        ← 启动路径编排：复用探测→接管→原子锁→npx 托管（纯 Node）
├── instance.ts       ← 实例注册表 + 启动锁 + pid/端口/命令行校验（纯 Node）
├── dshProcess.ts     ← dsh 子进程监督：spawn/端口解析/就绪/崩溃退避/树杀（纯 Node）
├── dshResolver.ts    ← dsh 可执行文件解析（纯 Node）
├── channelProbe.ts   ← 通道探测（纯 Node）
├── channelSelect.ts  ← 通道选择（纯 Node）
├── authProxy.ts      ← 认证代理（纯 Node）
├── launchInfo.ts     ← 启动信息（纯 Node）
└── paths.ts          ← 数据目录解析（可环境变量覆盖，供无头测试）（纯 Node）
```
依赖关系：`extension.ts → runtime.ts → {instance, dshProcess, dshResolver, paths}`；`webview*.ts → runtime.ts`（订阅状态）。
**纯 Node 层禁止 `import 'vscode'`**，可独立无头测试。
> 分层归属以**实际 import 为准**（`Select-String -Path src\*.ts -Pattern "from 'vscode'"`），
> 不是按文件名猜。声明式副本在 `.dsh/profile.yaml` 的 `tech_stack.module_layout`——**改代码分层时两处同步**。

## 3. 构建与测试命令
- 编译：`npm run compile`（=`tsc -p ./`）→ `out/`
- 无头验证：`node scripts/sim.mjs`（先 compile；期望 8/8 PASS）
- 打包：`npm run package`（=`vsce package --no-dependencies`）
- GUI 联调：按 `docs/联调测试剧本.md`，需真实 VSCode，由用户执行判定
- 失败排障日志：`%LOCALAPPDATA%\DshVscode\logs\dsh.log`、`logs\runtime.log`
- **构建基线 = 普通终端**；DSH 沙箱内用 `node node_modules\typescript\bin\tsc -p tsconfig.json` + 工作区 `.npm-cache`

## 4. 生命周期仲裁约定（README/调研报告 v4 核心）
- **启动路径**：读注册表 → 探测外部实例 → 原子锁（`startup.lock` wx 独占）→ npx spawn → 端口解析 → 就绪 → 写注册表
- **接管外部**：netstat 枚举 + 校验命令行含 dsh 特征（`@deepseek-ai/dsh` / `--profile web`）→ 记录 `adoptedPid`
- **关停判定**（最后窗口退出）：注销窗口 → 计数空 → 三重防误杀（pid 存活 + 端口监听 + `__DSH_BOOT__`）全过才 `taskkill /T /F`
- **崩溃重启**：退避 1→2→4→8→16→32s，6 次上限转 `error`
- **面板**：`viewsContainers.secondarySidebar` + webview iframe；CSP `frame-src http://127.0.0.1:*`，
  `style-src 'unsafe-inline'; script-src 'unsafe-inline'`（放行 VSCode 注入，Bug C 教训）

### 4.1 关键运行契约（来自《调研报告 v4》《开发报告》）
- dsh 就绪锚点：stdout 打印 `dsh web:\s+http://127.0.0.1:(\d+)`；页面签名 `window.__DSH_BOOT__`
- 数据目录：`%LOCALAPPDATA%\DshVscode\`（`instance.json` 注册表 / `startup.lock` 原子锁 / `logs\*.log`），
  `paths.ts` 支持用环境变量（如 `DSH_VSCODE_DATA_DIR`）覆盖以便无头测试
- **dsh 启动契约**：`dsh web --host 127.0.0.1 --port <n> --no-open`；端口 0 = OS 分配；`--host` 拒绝 0.0.0.0
- **语义分离（本项目实例）**：`adoptedPid`（外部接管 pid）≠ `process.pid`（托管子进程 pid），
  两者都要持久化，不可互相顶替——`managedBy` 同时表示"extension 托管"与"external 接管"是已知反例
- 修改 `package.json` 贡献点（命令/配置/视图容器）时同步更新 README 配置表与激活事件

## 5. VSIX 打包发布
- 产物：`dsh-vscode-agent-<ver>.vsix`（gitignore 排除）；publisher `dsh-vscode-agent`
- 打包排除：`.vscodeignore`（node_modules/.npm-cache/src/scripts/docs/.dsh/out）
- 安装：`code --install-extension .\dsh-vscode-agent-<ver>.vsix`（重装前卸载旧版 + 完全退出 VSCode）
- 主线文档：`docs/调研报告.md`（方案 v4）、`docs/开发报告.md`（实施）、`docs/联调测试剧本.md`、`docs/环境基线调查报告.md`

### 5.1 打包标准流程（基线 = 普通终端）
```powershell
npm run compile                 # 或 node node_modules\typescript\bin\tsc -p tsconfig.json
node scripts/sim.mjs            # 8/8 PASS 期望
npm run package                 # vsce package --no-dependencies → dsh-vscode-agent-<ver>.vsix
```
- `.vscodeignore` 生效范围：排除 `node_modules/ .npm-cache/ src/ scripts/ docs/ .dsh/` 等，仅收
  `package.json README.md LICENSE media/ out/` 及 manifest（对照现有包 12 文件 / ~20KB 量级）。
- `package.json` 的 `version` 同步递增（0.1.x）；`engines.vscode ^1.134.0` 勿随意降低。
- **`out/` 必须入包，不得排除**——包内 `package.json` 的 `main` 指向 `./out/extension.js`，
  排除 `out/` 会让分发物不含任何可运行代码（0.1.23 部署检查 QA-D23-02 订正）。
- 发版流程：`version` 提升 → 编译 → sim 全过 → `npm run package` → 记录产物 hash/大小。
- 产品无关的自动升级渠道由 dsh 运行时承担（`dsh.channel` latest/preview），扩展本身作为薄壳不打 dsh。
- 变更摘要写入 `docs/开发报告.md`（历史版本表格）+ `docs/联调测试剧本.md`（复测项）。

### 5.2 安装 / 发布验证（替代 Docker/K8s 部署验证）
1. **离线安装**：`code --install-extension .\dsh-vscode-agent-<ver>.vsix`；
   重装前先卸载旧版（扩展面板 → DSH Panel → Uninstall），并**完全退出 VSCode**（清残留 `Code` 进程）。
2. **安装后冒烟**（场景 A/B，见 `docs/联调测试剧本.md`）：右侧边栏出现 DSH 面板（带样式，不卡 `initializing`）、
   注册表 `dsh.pid` 非 null、状态栏 `● DSH 3080`。
3. **取证命令**（判定依据，非部署操作）：
   - 注册表：`Get-Content "$env:LOCALAPPDATA\DshVscode\instance.json"`
   - 日志：`$env:LOCALAPPDATA\DshVscode\logs\dsh.log`、`logs\runtime.log`
   - 端口：`netstat -ano | findstr :3080`；进程：`tasklist /FI "PID eq <pid>"`
4. **防误杀满足性自查**：最后窗口关停前 dsh.pid 存活 + 端口仍监听 + 页面含 `__DSH_BOOT__` 三重复核；
   外部实例接管须命令行校验含 dsh 特征。
5. 产物核对：`vsix` 大小/文件清单、版本号、`.vscodeignore` 生效（无源码/依赖误打包）。

## 6. 测试方法（双层模型 + 确定性原则）

### 6.1 双层测试模型（本工程特有）
1. **纯 Node 无头层**（沙箱内可跑）：脚本 `scripts/sim.mjs`，用 `DSH_VSCODE_DATA_DIR` 指向工作区内临时目录；
   覆盖：启动锁原子性、窗口登记/注销、非最后窗口不停、最后窗口关停、注册表记录、端口就绪、mock server 树杀。
2. **GUI 联调层**（需真实 VSCode，普通终端/用户执行）：按 `docs/联调测试剧本.md` 场景（外部实例接管、
   npx 托管启动、崩溃自动恢复、端口占用回落、离线回退），逐项判定并回报。

> 这两层缺一不可：纯 Node 层验证仲裁逻辑，GUI 层验证 vscode 耦合（面板渲染、自动展开、正误杀防护）。
> **无头层受沙箱限制**，`netstat`/PowerShell 管道相关断言在沙箱内可能解析 null → 属环境差异，须如实标注，
> **不能当作代码缺陷**（对照《环境基线调查报告》§3.4）。

### 6.2 生命周期关键断言（纯 Node 层应覆盖的事实）
- 启动锁：窗口 A 抢锁成功后窗口 B 无法再抢（原子独占，消除双窗口竞态）
- 注册表：`dsh.pid`（托管 spawn pid **或** 外部接管 `adoptedPid`，不可恒为 null）、`port`、`managedBy`、`windows[]`
- 关停判定：注销最后窗口 → 仅当 dsh.pid 存活 + 端口仍监听 + 页面含 `__DSH_BOOT__` 三重复核全过才杀；任一失败不杀（安全侧）
- 崩溃重启：退避 1→2→4→8→16→32s，6 次上限转 `error`
- 端口回落：固定 3080 被非 DSH 占用 → 落到随机端口并存回注册表

### 6.3 确定性原则（替代数据驱动三层模型）
本工程无数据库，测试数据改为**确定性构造 + 真实 mock**：
1. **唯一事实源**：硬编码期望值来自实现契约（如端口正则、退避序列、注册表结构），先在文档/源码定稿再断言，禁止魔法数字
2. **真实依赖**：生命周期关停用真实 mock HTTP server（监听 127.0.0.1，返回 `__DSH_BOOT__` 页面）验证，不 mock 掉被测部分
3. **测试隔离**：每个用例用独立临时数据目录（`DSH_VSCODE_DATA_DIR`），用例间、与真实 `%LOCALAPPDATA%\DshVscode` 隔离
4. **清理**：测试结束清空自身临时目录，不删共享数据

### 6.4 测试类型选择
| 条件 | 执行测试类型 |
|------|:-----------:|
| 打包/发布后（任何变更） | 冒烟（必做：安装 VSIX → 复现核心链路） |
| 核心模块变更（生命周期/端口/关停） | 回归：`node scripts/sim.mjs` 全量 + GUI 剧本复侧 |
| 涉及 vscode 渲染/命令/配置 | GUI 联调 + package.json 贡献点核对 |
| 设计文档含性能指标（启动/就绪/重试时延） | 性能记录（启动耗时、端口就绪、崩溃重启时延） |

### 6.5 测试执行方式
- 编译检查：`node node_modules\typescript\bin\tsc -p tsconfig.json`（0 错误）
- 无头逻辑：`node scripts/sim.mjs`（先 `npm run compile` 生成 `out/`）
- GUI 联调：按 `docs/联调测试剧本.md` 场景由用户在真实 VSCode 执行并回报判定与日志
- 编写新无头用例：参考 `scripts/sim.mjs` 既有风格（check() 断言 + mock server + 独立 data dir）

## 7. 外网出口与沙箱边界
- 本机直连外网常被断（connection reset/timeout）；外网操作（git push/fetch、npm registry）**须显式走本地代理**：
  `$env:HTTPS_PROXY='http://127.0.0.1:10808'`，或 `git -c http.proxy=http://127.0.0.1:10808 -c https.proxy=http://127.0.0.1:10808 <cmd>`
- **DSH 沙箱内 git 无法交互提示凭据**（GCM 命名管道被禁）→ 需认证的联网操作（首次 push/登录）
  由用户在本机普通终端执行，带同代理参数推/拉一次以缓存凭据。
- 沙箱内 `npm install` 会被拒（写 `%LOCALAPPDATA%\npm-cache` EPERM + spawn 管道 EPERM）
  → 沙箱内用 `node node_modules\typescript\bin\tsc -p tsconfig.json` + 工作区 `.npm-cache`，如实记录环境差异。

## 8. 本工程特有的硬约束

| # | 约束 | 违反后果 |
|---|------|---------|
| 1 | 构建以**普通终端**为基线；DSH 沙箱内 `npm install` 会被拒 → 沙箱内用 `node tsc` + 工作区 `.npm-cache`，并如实记录环境差异 | 沙箱内照搬普通终端命令，安装步骤直接失败 |
| 2 | VSCode 视图容器/命令 id 必须匹配 `^[a-z0-9_-]+$`；location key 用 `secondarySidebar` | id 含点号等字符被拒（`dsh.viewContainer`）；`auxiliarybar` 已改名失效 |
| 3 | webview 须放行 `style-src 'unsafe-inline'; script-src 'unsafe-inline'` 供 VSCode 注入 | 面板无样式，卡在 `initializing` |
| 4 | `adoptedPid` 必须持久化 | 注册表 `dsh.pid` 恒 null → 最后窗口不关停 |
| 5 | 外部实例唯经 netstat + 命令行校验后接管；关停前三重复核，任一失败不杀 | 误杀无关进程（安全侧） |
| 6 | 外网操作须显式走本地代理；DSH 沙箱内 GCM 无法交互提示凭据 → push 前先在普通终端带同代理参数推/拉一次以缓存凭据 | 直连常被断；沙箱内 push 卡在凭据提示 |

## 9. 问题修复流程（本项目）
### 修复前 — 影响评估
1. 严谨评估解决方案，调研强相关模块（生命周期状态机、注册表结构、webview CSP、端口探测）
2. 评估潜在影响范围和副作用（多窗口并发、进程树残留、误杀风险）
3. 设计自验证方案（无头 sim + 必要 GUI 剧本）后再动手

### 修复后 — 回归测试
1. 修复的问题本身
2. 与修改代码强相关的模块（仲裁/端口解析/关停判定）
3. 用户视角核心链路（启动→面板显示→关窗→关停）
4. 测试自动化执行（`node scripts/sim.mjs`），结果含通过/失败明细 + 用户可感知功能影响评估

## 10. 项目风险与合规清单（QA 代码审计按此检查）
- **分层**：纯 Node 层（除 extension/webview/webviewDetails 外）不得 `import 'vscode'`
- **无硬编码**：端口/退避/正则/数据目录参数化或常量集中，可配置（`dsh.port` 等），无魔法数字
- **敏感值不落源码**：明文密钥、口令、令牌不得硬编码；本项目访问凭证经 DSH `credentials`
  （`~/.dsh/.credentials.yaml` refs）运行时解析，规则文件只保留 `credential:<KEY>` 占位
- **编译**：`tsc` 编译 0 错误
- **生命周期契约**：接管 pid 正确持久化（`process.pid ?? adoptedPid`）、防误杀三重复核、
  崩溃退避、端口回落均实现
- **越界提示**：`docs/` 属架构师、`scripts/` 属测试专家（`scripts/sim.mjs` 是为开发自测保留的例外）

## 11. 文档与台账落点（本项目）
- 设计文档 / 根因分析 / 测试方案 → `docs/`（架构师）
- 变更台账（一行一版，修订记录只写这里）→ `docs/CHANGELOG-设计文档.md`
- 运行台账 → `docs/CHANGELOG-运行台账.md`（链级闭环时由编排者追加一行）
- 编译/打包等构建配置 → `package.json` / `tsconfig.json` / `.vscodeignore`（开发专家）
- 探针脚本与原始输出 → `.dsh/tmp/<role>/`（闭环清理）
- > 注：写法判据的来源是 `design-doc-writing` skill（已随 `.dsh/skills/` 交付），
  > 它是本项目写法方面的完整判据来源。
