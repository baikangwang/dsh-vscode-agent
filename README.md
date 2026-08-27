# DSH Panel (dsh-vscode-agent)

DeepSeek Harness 的 VSCode 右侧边栏面板：自动启动/复用 `dsh web`，并以内嵌 iframe
呈现其 Web UI。**薄壳设计**：不 fork、不打包 DSH 前端，`dsh` 运行时由 npm/npx 托管。

## 特性

- 右侧边栏（auxiliary bar）独立视图，启动后自动展开；
- **应用级生命周期**：第一窗口启动 dsh、后续窗口复用；关闭非最后一个窗口不停，
  关闭最后一个窗口/VSCode 退出时同步关停（含外部实例接管，带防误杀校验）；
- 运行时由 npm/npx 托管：每次启动自动检查 `latest`，离线回退 npx 缓存；
- 已运行的 dsh（浏览器/npx 启动于 `127.0.0.1:<port>`）直接复用，不重复启动；
- 状态栏指示 + 面板工具栏（打开浏览器 / 重启 / 停止）。

## 安装（离线 VSIX）

```powershell
code --install-extension dsh-vscode-agent-0.1.0.vsix
# 或 VSCode 扩展面板 → 「…」→ 从 VSIX 安装…
```

## 前置要求

- VSCode ≥ 1.99（需 auxiliary bar 贡献点支持；本机 1.134 已满足）
- Node.js ≥ 20 与 npm 在 PATH（首次启动 dsh 时经 npx 安装；之后命中缓存离线运行）

## 配置

| 配置 | 默认 | 说明 |
|---|---|---|
| `dsh.port` | `3080` | dsh 监听端口（0=随机；被非 DSH 占用自动回落随机）。固定端口可被浏览器 dsh 复用；扩展先启动会占用它，浏览器中请用 `dsh web --port 0` |
| `dsh.channel` | `latest` | 版本通道（`latest`/`preview`） |
| `dsh.command` | 空 | 自定义启动命令，如 `dsh web --port 3080` |
| `dsh.autoStart` | `true` | VSCode 启动时自动启动/复用 dsh |
| `dsh.autoOpenPanel` | `true` | 启动后自动展开右侧边栏面板 |
| `dsh.dshHome` | 空 | DSH_HOME（空 = 默认 `~/.dsh`，与浏览器版共享会话） |
| `dsh.probeIntervalSec` | `30` | detached dsh 存活探活周期（秒；0 = 关闭探活） |

## 命令

- `DSH: Open Panel` / `DSH: Restart Runtime`（reconnect，不关停 dsh）/ `DSH: Stop Runtime`（disconnect，不关停 dsh）
- `DSH: Open in Browser` / `DSH: Update Runtime`（受控重拉 managed dsh；外部 dsh 提示手动 `npx @deepseek-ai/dsh@latest web`）

## 数据与日志

- 协调注册表/启动锁：`%LOCALAPPDATA%\DshVscode\`
- dsh 日志：`%LOCALAPPDATA%\DshVscode\logs\dsh.log`；managed detached dsh 输出：`logs\dsh-<ts>.log`（按日轮转，保留最近 3 份）

## 开发

```powershell
npm install            # devDeps（typescript / @vscode/vsce）
npm run compile        # tsc → out/
npm run package        # vsce package → .vsix
node scripts/sim.mjs   # 无头验证生命周期仲裁
```

F5（Extension Development Host）联调；打包后 `code --install-extension *.vsix` 真装验证。
