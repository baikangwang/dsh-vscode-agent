---
name: dsh-vscode-agent-engineering
description: dsh-vscode-agent 项目工程知识：模块分层、编译/测试命令、VSIX 打包与安装验证、生命周期仲裁约定。
whenToUse: 在 dsh-vscode-agent 项目做开发/测试/打包/排障需要项目级工程上下文时。
---

# dsh-vscode-agent-engineering — 项目级 skill（形态 C，按需加载）

> 属性：项目级（`.dsh/skills/` 官方发现根，cwd 选择 project roots）
> 用途：低频、大体积、参考型工程项目知识；模型按需 `skill("dsh-vscode-agent-engineering")` 拉取。
> 承载方式：经 `dsh-skill-filesystem` 发现根注册（预设挂载 `skill-filesystem` + `tool-skill`）；本文件为内容源。

## 1. 项目概览
- 工程：dsh-vscode-agent（displayName **DSH Panel**）—— DeepSeek Harness 的 VSCode 右侧边栏面板扩展
- 语言/框架：TypeScript + VS Code Extension API（engines.vscode ^1.134.0，CommonJS/ES2022）
- 运行时：Node ≥20（npm 托管 dsh，不 fork/不打 dsh 进包）
- 打包：vsce → `dsh-vscode-agent-<ver>.vsix`（薄壳 ~20KB）；离线安装 `code --install-extension *.vsix`
- 数据目录：`%LOCALAPPDATA%\DshVscode`（实例注册表 / 原子锁 / logs）
- 默认端口：3080（`dsh.port` 可配；被非 DSH 占用自动回落随机）

## 2. 模块分层（src目录）
```
src/
├── extension.ts      ← 激活/命令/配置/状态栏/生命周期钩子（vscode 耦合）
├── webview.ts        ← 右侧边栏 iframe 面板 + 状态覆盖层 + 工具栏（vscode 耦合）
├── runtime.ts        ← 启动路径编排：复用探测→接管→原子锁→npx 托管（纯 Node）
├── instance.ts       ← 实例注册表 + 启动锁 + pid/端口/命令行校验（纯 Node）
├── dshProcess.ts     ← dsh 子进程监督：spawn/端口解析/就绪/崩溃退避/树杀（纯 Node）
└── paths.ts          ← 数据目录解析（可环境变量覆盖，供无头测试）（纯 Node）
```
依赖关系：`extension.ts → runtime.ts → {instance, dshProcess, paths}`；`webview.ts → runtime.ts`（订阅状态）。
纯 Node 层 **禁止 `import 'vscode'`**，可独立无头测试。

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

## 5. VSIX 打包发布
- 产物：`dsh-vscode-agent-<ver>.vsix`（gitignore 排除）；publisher `dsh-vscode-agent`
- 打包排除：`.vscodeignore`（node_modules/.npm-cache/src/scripts/docs/.dsh/out）
- 安装：`code --install-extension .\dsh-vscode-agent-<ver>.vsix`（重装前卸载旧版 + 完全退出 VSCode）
- 主线文档：`docs/调研报告.md`（方案 v4）、`docs/开发报告.md`（实施）、`docs/联调测试剧本.md`、`docs/环境基线调查报告.md`
