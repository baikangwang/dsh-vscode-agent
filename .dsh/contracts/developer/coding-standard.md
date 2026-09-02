# contracts/developer — 开发专家契约与规则（形态 B，按角色注入）
> 来源基线：baseline/project/agents/开发专家.md、baseline/project/rules/项目规则.mdc、baseline/global/rules/03-工程规范.mdc、05-单元测试.mdc
> 注入时机：编排者调度到「开发专家」阶段 / 编码实施时
> 本工程：dsh-vscode-agent（TypeScript / VS Code 扩展）

## 职责与边界
- 正式产出：`src/`（生产 TS 源码，git 跟踪）
- 临时产出：一切中间物（探针脚本、中间补丁、草稿）→ `.dsh/tmp/developer/`（闭环清理）
- **禁止写入**：`scripts/sim.mjs` 之外的测试脚本由测试专家管理、`docs/`、`*/.vsix`（发布物由部署专家打包）

## 技术栈骨架（声明式，来自 .dsh/profile.yaml；此处为角色理解要点）
- TypeScript + VS Code Extension API（engines.vscode ^1.134.0）+ Node ≥20
- 构建：`tsc -p ./` → `out/`（CommonJS, ES2022）；打包：`vsce package`
- 分层约束（QA 代码审计 C2 项按此检查）：
  - **纯 Node 层**：`instance.ts` / `runtime.ts` / `dshProcess.ts` / `paths.ts` —— **禁止 `import 'vscode'`**，保证可无头测试
  - **vscode 耦合层**：`extension.ts` / `webview.ts` —— 只经 runtime 订阅状态，不直连 dsh 子进程

## 编码规范
1. **自研代码须经测试**：测试通过后才能报告成功
2. **语义分离**：同一变量不同上下文语义不同须明确分离
   - 反例：`managedBy` 同时表示"extension 托管"与"external 接管"两种生命周期语义而不区分
   - `adoptedPid`（外部接管 pid）≠ `process.pid`（托管子进程 pid），两者都要持久化，不可互相顶替
3. **去硬编码**：端口 3080、退避序列、正则、本地数据目录等一律参数化/常量集中，可配置（`dsh.port` 等）
4. **类型安全**：尽量用类型别名收敛契约（实例注册表结构、RuntimeState、端口解析结果）

## 基础设施 / 关键运行契约（来自《调研报告 v4》《开发报告》）
- dsh 就绪锚点：stdout 打印 `dsh web:\s+http://127.0.0.1:(\d+)`；页面签名 `window.__DSH_BOOT__`
- 数据目录：`%LOCALAPPDATA%\DshVscode\`（`instance.json` 注册表 / `startup.lock` 原子锁 / `logs\*.log`），
  `paths.ts` 支持用环境变量（如 `DSH_VSCODE_DATA_DIR`）覆盖以便无头测试
- 生命周期仲裁原则：**三重防误杀**（pid 存活 + 端口仍监听 + 页面含 `__DSH_BOOT__`）缺一不杀；
  外部实例经 `netstat`/PowerShell CIM 校验命令行含 dsh 特征后才接管
- **外网出口**：本机直连外网常被断；npm/npx/git 外网操作须显式走本地代理 `http://127.0.0.1:10808`
  （`$env:HTTPS_PROXY='http://127.0.0.1:10808'` 或 `git -c http.proxy=… -c https.proxy=…`）；
  DSH 沙箱内 git 无法交互提示凭据（GCM 命名管道被禁）→ 需认证的联网操作（首次 push/登录）由用户在本机终端执行

## 变更文件（既有工程结构 — 新增改动必须贴合）
| 文件 | 归属层 | 职责 |
|------|--------|------|
| `src/extension.ts` | vscode | 激活/命令/配置/状态栏/生命周期钩子 |
| `src/webview.ts` | vscode | 右侧边栏 iframe 面板 + 状态覆盖层 + 工具栏 |
| `src/runtime.ts` | 纯 Node | 启动路径编排：复用探测→接管→原子锁→npx 托管 |
| `src/instance.ts` | 纯 Node | 实例注册表 + 启动锁 + pid/端口/命令行校验 |
| `src/dshProcess.ts` | 纯 Node | dsh 子进程监督：spawn/端口解析/就绪/崩溃退避/树杀 |
| `src/paths.ts` | 纯 Node | 数据目录解析（可环境变量覆盖） |
| `scripts/sim.mjs` | 测试 | 无头生命周期仲裁验收 |
| `docs/` | 文档 | 调研/开发/联调/环境基线报告 |

## 问题修复流程
### 修复前 — 影响评估
1. 严谨评估解决方案，调研强相关模块（生命周期状态机、注册表结构、webview CSP、端口探测）
2. 评估潜在影响范围和副作用（多窗口并发、进程树残留、误杀风险）
3. 设计自验证方案（无头 sim + 必要 GUI 剧本）后再动手
### 修复后 — 回归测试
1. 修复的问题本身
2. 与修改代码强相关的模块（仲裁/端口解析/关停判定）
3. 用户视角核心链路（启动→面板显示→关窗→关停）
4. 测试自动化执行（`node scripts/sim.mjs`），结果含通过/失败明细 + 用户可感知功能影响评估

## 需要遵循的外部契约（修改跨模块调用/外部系统时先读清）
- **dsh 启动契约**：`dsh web --host 127.0.0.1 --port <n> --no-open`；端口 0 = OS 分配；`--host` 拒绝 0.0.0.0
- **vscode 注入机制**：webview 的 CSP 需放行 VSCode 注入的 `style-src 'unsafe-inline'`、`script-src 'unsafe-inline'`
  （Bug C 教训：strict CSP 会挡掉 VSCode 注入的默认样式与 `acquireVsCodeApi` 脚本）
- 修改 `package.json` 贡献点（命令/配置/视图容器）时同步更新 README 配置表与激活事件
