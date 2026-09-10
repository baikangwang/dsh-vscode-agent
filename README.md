# DSH Panel (dsh-vscode-agent)

DeepSeek Harness 的 VSCode 右侧边栏面板：自动启动/复用 `dsh web`，并以内嵌 iframe
呈现其 Web UI。**薄壳设计**：不 fork、不打包 DSH 前端，`dsh` 运行时由 npm/npx 托管。

## 特性

- 右侧边栏（auxiliary bar）双容器页签——「DSH 会话」/「DSH 配置」两个独立视图，启动后自动展开；
- **应用级生命周期**：第一窗口启动 dsh、后续窗口复用；关闭非最后一个窗口不停，
  关闭最后一个窗口/VSCode 退出时同步关停（含外部实例接管，带防误杀校验）；
- 运行时由 npm/npx 托管：每次启动自动检查 `latest`，离线回退 npx 缓存；
- 已运行的 dsh（浏览器/npx 启动于 `127.0.0.1:<port>`）直接复用，不重复启动；
- **常驻服务控制台**（默认开启）：dsh 运行于自持的经典控制台窗（标题
  `dsh service console (DSH Panel)`），其全部子进程共享该控制台，结构性消除
  每次工具调用的闪现窗口；窗内启动即显示静态信息头（窗口身份、关闭后果、本次启动
  日志路径、误关恢复指引；服务实时日志不回显窗内——全部输出重定向至 per-launch
  log 供取证与排障）；**关闭该窗口 = 用户停止 dsh**（不会自动重拉，面板点 ⟳
  重连即可按需重启）。极端情况下（探活瞬时误判）可能出现「面板显示已停止而
  常驻控制台窗口仍在」——此时点重连即可重新接管，不会误杀存活的 dsh；
- **dsh 版本与详情可见**：状态栏 `● DSH <端口> · v<版本>`（点击打开详情视图），
  面板工具栏 ⓘ 同样可达；详情卡含版本双源核对、bin 目录（复制/打开）、
  启动方式、端口/pid、启动时间（dsh 进程真实启动时刻，OS 报告，本地
  `yyyy-MM-dd HH:mm:ss` 格式）、resolver 状态与日志文件快捷操作。
- **dsh 通道选择**：三个发布通道 `latest`/`next`（rc 稳定系）/`alpha`（最新
  实验系）。首次启动先弹通道选择（选完才启动 dsh；Esc = 沿用当前值、下次
  再问）；之后随时可从命令面板 `DSH: 选择 dsh 通道` 更改（改选经重启 dsh
  生效，不自动重启）。旧配置值 `preview` 非有效 dist-tag，运行时按 `latest`
  处理（不写回用户配置）。
- **token 适配（dsh ≥ 0.1.2-alpha.2 自动启用）**：dsh 0.1.2-alpha.2 起网页
  访问需要登录契约（启动 banner 带访问 token）。插件按**运行中具体 dsh
  版本**（阈值 `0.1.2-alpha.2`）自动判定：token 契约下面板经插件内嵌的本地
  回环代理（authProxy，仅绑 127.0.0.1 随机端口）接入——登录态自动建立，无需
  复制 token；「在浏览器打开」外发带 token 的直达链接。会话 cookie 只在代理
  内存中持有（**不落盘**、不写入注册表，响应 Set-Cookie 一律剥离），插件
  日志中 token 一律脱敏为 `token=<REDACTED>`。latest/next（现值 0.1.1-rc.2）
  保持直连行为逐位不变。

## 安装（离线 VSIX）

**团队安装（GitHub Release 一行命令，自动下载）：**

```powershell
$ver = '0.1.20'
Invoke-WebRequest "https://github.com/baikangwang/dsh-vscode-agent/releases/download/v$ver/dsh-vscode-agent-$ver.vsix" -OutFile "$env:TEMP\dsh-vscode-agent-$ver.vsix"
code --install-extension "$env:TEMP\dsh-vscode-agent-$ver.vsix"
```

**本地 VSIX：**

```powershell
code --install-extension dsh-vscode-agent-0.1.20.vsix
# 或 VSCode 扩展面板 → 「…」→ 从 VSIX 安装…
```

## 前置要求

- VSCode ≥ 1.99（需 auxiliary bar 贡献点支持；本机 1.134 已满足）
- Node.js ≥ 20 与 npm 在 PATH（首次启动 dsh 时经 npx 安装；之后命中缓存离线运行）

## 配置

| 配置 | 默认 | 说明 |
|---|---|---|
| `dsh.port` | `3080` | dsh 监听端口（0=随机；被非 DSH 占用自动回落随机）。固定端口可被浏览器 dsh 复用；扩展先启动会占用它，浏览器中请用 `dsh web --port 0` |
| `dsh.channel` | `latest` | 版本通道（`latest` = 正式版 / `next` = rc 稳定系 / `alpha` = 最新实验系；旧值 `preview` 运行时按 `latest` 处理，不写回） |
| `dsh.channelSelected` | `false` | 首启通道选择已完成标志（首次启动弹通道选择后写入；命令面板重选通道不改此值） |
| `dsh.command` | 空 | 自定义启动命令，如 `dsh web --port 3080` |
| `dsh.autoStart` | `true` | VSCode 启动时自动启动/复用 dsh |
| `dsh.autoOpenPanel` | `true` | 启动后自动展开右侧边栏面板 |
| `dsh.dshHome` | 空 | DSH_HOME（空 = 默认 `~/.dsh`，与浏览器版共享会话） |
| `dsh.probeIntervalSec` | `30` | detached dsh 存活探活周期（秒；0 = 关闭探活） |
| `dsh.consoleVisible` | `true` | `true` = dsh 运行于自持常驻可见控制台（子进程共享该控制台，无弹窗；**关闭窗口 = 停止 dsh**，不自动重拉）；`false` = 完全隐藏——dsh = 0.1.3-alpha.1 时无闪现窗口（上游 PR #3516），但该版本未发布 npm；dsh ≥ 0.1.3-alpha.2 的 native runner 在隐藏形态存在上游弹窗回归（上游 master 未修，等上游修复版）；更低版本保留已知的闪现窗口问题取舍 |

## 命令

- `DSH: Open Panel` / `DSH: Show Details`（dsh 版本/bin 目录/启动方式详情视图）/ `DSH: Restart Runtime`（reconnect，不关停 dsh）/ `DSH: Stop Runtime`（disconnect，不关停 dsh）
- `DSH: Open in Browser` / `DSH: Update Runtime`（受控重拉 managed dsh；外部 dsh 提示手动 `npx @deepseek-ai/dsh@latest web`）
- `DSH: 选择 dsh 通道`（重选 `latest`/`next`/`alpha`；经重启 dsh 生效，不自动重启）

## 数据与日志

- 协调注册表/启动锁：`%LOCALAPPDATA%\DshVscode\`（注册表 `dsh.pid` = 端口持有者
  pid，即 start-launch 模式下的真实 dsh 服务进程；外层 cmd 包装 pid 仅作诊断）
- dsh 日志：`%LOCALAPPDATA%\DshVscode\logs\dsh.log`；managed detached dsh 输出：`logs\dsh-<ts>.log`（按日轮转，保留最近 3 份）

## 已知限制

- **常驻控制台窗口载荷 = npx 形态（版本跟随 registry latest）**：常驻控制台窗内的
  dsh 由 `npx --yes --prefer-offline @deepseek-ai/dsh@latest web …` 拉起——运行时版本跟随
  npm registry 的 `latest` 标签（resolver 仍并行解析 npx 缓存命中目录供详情卡展示；npx 启动分支下
  详情卡「自报版本」可能滞后于缓存版本，双源核对照常呈现 `self-only`/`mismatch` 档）。
- **常驻控制台窗口就绪预算分档 60s/30s（direct 90s）**：常驻控制台窗口+npx 启动分支就绪预算 60s（暖缓存预期
  12-22s，冷缓存大概率覆盖）；node-bin 备轨 30s；direct 90s。冷启动（首装 / npx
  缓存冷 / AV 全盘扫描）时 dsh 本身可能超预算 → 误判超时 → 回退 direct——可用性保住、
  常驻控制台窗口一次性丢失；回退后重开 VSCode 窗口重新尝试常驻控制台窗口模式。
- **回退 direct = 降级态（恒 node-bin 直连）**：dsh 就绪前常驻控制台窗口宿主退出
  （任意退出码）即判启动失败并快速暴露；连续 2 次失败自动回退 direct 模式（0.1.8 形态，
  90s 就绪预算，载荷恒为 node-bin 直连、不受 npx 变体影响）。回退态**无常驻控制台窗**，
  属降级态而非验收形态（可用性保住），runtime.log 留痕可归因。
- **marker 排障文件（永久 instrumentation）**：每次常驻控制台窗口启动（start-wait/conhost 两分支
  同型留痕）在 `logs\dsh-<ts>.log` 旁写入三个同批伴生文件——`.cmd-start`（内层 cmd 已启动）、
  `.node-start`（载荷执行点已到达；npx 启动分支下对应 npx 进程层）、`.node-exit`（内容
  `node-exit-nonzero`/`node-exit-0` = 载荷自退出分类；**`node-exit-0` = 链正常走完的记录
  而非死亡信号**）。三文件存在性 + mtime 即启动链
  时间线（失败分型判读用）；随 per-launch log 同轮转清理（保留策略一致，不累积）。
  另：resolver 子进程输出（`npm view` 等）落独立 `<log>.resolver` 同批伴生文件，不进主 log。
- **常驻控制台窗口宿主 = 构建期常量**：`START_LAUNCH_STRATEGY`（0.1.12 起默认 `'conhost'`，
  备选 `'start'` = start /wait 形态，改回该值重打包即回切）与载荷变体
  `START_PAYLOAD_VARIANT`（当前 `'npx'`，可切回 `'node-bin'`）均仅构建期单点切换，
  不做运行期自动降级链。
- **真机根因未定案，不作根因承诺**：0.1.9 首打版真机验证曾出现常驻控制台窗口未成功建立（4/4）且
  启动退化 ~190s；受控环境未能复现该现象（E-RES-7 未定案）。0.1.11 npx 启动分支在 start-wait
  窗内真机三次闪退（R3）后，0.1.12 按预案切至 conhost 宿主形态（实验②实证该形态在同
  上下文存活）并显式化端口纪律留痕（配置/有效/载荷端口三行互证）——**绕开了失效形态，
  未解开根因**；conhost 形态下的真机存活性/时延/关窗杀树/版本行为仍为待观测项，若真机
  复验仍失败，按上述回退语义降级可用。

## 开发

```powershell
npm install            # devDeps（typescript / @vscode/vsce）
npm run compile        # tsc → out/
npm run package        # vsce package → .vsix
node scripts/sim.mjs   # 无头验证生命周期仲裁
```

F5（Extension Development Host）联调；打包后 `code --install-extension *.vsix` 真装验证。
