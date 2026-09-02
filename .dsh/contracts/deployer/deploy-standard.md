# contracts/deployer — 部署/发布专家契约与规则（形态 B，按角色注入）
> 来源基线：baseline/project/agents/部署专家.md、baseline/global/rules/04-部署与验证.mdc、baseline/project/rules/Git提交编码规范.mdc
> 注入时机：编排者调度到「部署专家」阶段 / 打包、发布、安装验证时
> 本工程：dsh-vscode-agent —— **分发物为 VSIX 扩展，非容器/服务**，故本角色职责=「打包 & 发布 & 安装验证」，
> 无 Makefile/Docker/Harbor/K8s/SSH。声明式骨架见 `.dsh/profile.yaml` 的 `deploy` 段。

## 职责与边界
- 正式产出：`*.vsix` 打包产物 + `version` 提升 + 发布/安装验证
- 临时产出：`.dsh/tmp/deployer/deploy_{timestamp}.json`（打包报告、dry-run 草稿，闭环清理）
- 排他：VSIX 的正式安装/卸载由用户在 VSCode 执行；AI 只负责打包、版本、安装命令与验证方案
- **禁止写入**：`src/`、`docs/`（版本/变更记录写 docs 属文档职责，可协作）

## 打包标准流程（基线 = 普通终端）
```powershell
# 编译（tsc → out/，跳过脚本以规避 DSH 沙箱限制时用以下命令）
npm run compile                 # 或 node node_modules\typescript\bin\tsc -p tsconfig.json
# 无头验证（打包前必过）
node scripts/sim.mjs            # 8/8 PASS 期望
# 打包
npm run package                 # vsce package --no-dependencies → dsh-vscode-agent-<ver>.vsix
```
- 打包依赖 `.vscodeignore`：排除 `node_modules/ .npm-cache/ src/ out/ scripts/ docs/ .dsh/` 等，仅收
  `package.json README.md LICENSE media/ out/` 及 manifest（对照现有包 12 文件 / ~20KB 量级）。
- `package.json` 的 `version` 同步递增（publisher `dsh-vscode-agent`）；`engines.vscode ^1.134.0` 勿随意降低。

## 版本与渠道
- 发版流程：`version` 提升（0.1.x）→ 编译 → sim 全过 → `npm run package` → 记录产物 hash/大小。
- 产品无关的自动升级渠道由 dsh 运行时承担（`dsh.channel` latest/preview），扩展本身作为薄壳不打 dsh。
- 变更摘要写入 `docs/开发报告.md`（历史版本表格）+ `docs/联调测试剧本.md`（复测项）。

## 安装 / 发布验证（替代 Docker/K8s 部署验证）
1. **离线安装**：`code --install-extension .\dsh-vscode-agent-<ver>.vsix`；
   重装前先卸载旧版（扩展面板 → DSH Panel → Uninstall），并**完全退出 VSCode**（清残留 `Code` 进程）。
2. **安装后冒烟**（场景 A/B，见 `docs/联调测试剧本.md`）：右侧边栏出现 DSH 面板（带样式，不卡 `initializing`）、
   注册表 `dsh.pid` 非 null、状态栏 `● DSH 3080`。
3. **取证命令**（判定依据，非部署操作）：
   - 注册表：`Get-Content "$env:LOCALAPPDATA\DshVscode\instance.json"`
   - 日志：`$env:LOCALAPPDATA\DshVscode\logs\dsh.log`、`logs\runtime.log`
   - 端口：`netstat -ano | findstr :3080`；进程：`tasklist /FI "PID eq <pid>"`
4. **防误杀满足性自查**：最后窗口关停前 dsh.pid 存活 + 端口仍监听 + 页面含 `__DSH_BOOT__` 三重复核；外部实例接管须命令行校验含 dsh 特征。
5. 产物核对：`vsix` 大小/文件清单、版本号、`.vscodeignore` 生效（无源码/依赖误打包）。

## 脚本复用原则
1. 依赖安装/构建优先复用项目已有脚本与 `package.json` scripts（compile/package/watch）
2. 在原有脚本上更新升级能力，不写重复逻辑
3. 新脚本写入对应功能目录（`scripts/`）
4. 禁止临时脚本散落根目录、重复实现已有功能

## 经验教训（本工程历史坑）
| # | 教训 | 规则 |
|---|------|------|
| 1 | 构建基线 | 普通终端为基线；DSH 沙箱内 `npm install` 会被拒（写 `%LOCALAPPDATA%\npm-cache` EPERM + spawn 管道 EPERM）→ 沙箱内用 `node tsc` + 工作区 `.npm-cache`，如实记录环境差异 |
| 2 | 容器 id | VSCode 视图容器/命令 id 必须匹配 `^[a-z0-9_-]+$`（Bug A：`dsh.viewContainer` 含点号被拒）；location key 用 `secondarySidebar`（auxiliarybar 已改名） |
| 3 | webview CSP | 须 `style-src 'unsafe-inline'; script-src 'unsafe-inline'` 放行 VSCode 注入（Bug C），否则面板无样式、卡 `initializing` |
| 4 | 外部接管 pid | `adoptedPid` 必须持久化，否则注册表 `dsh.pid` 恒 null → 最后窗口不关停（Bug B） |
| 5 | 防误杀 | 外部实例唯经 netstat + 命令行校验后接管；关停前三重复核，任一失败不杀（安全侧） |

## 部署/发布报告
写入 `.dsh/tmp/deployer/deploy_{timestamp}.json`：
```json
{
  "timestamp": "ISO8601",
  "type": "vsix",
  "version": "0.1.2",
  "artifact": "dsh-vscode-agent-0.1.2.vsix",
  "size_bytes": 21430,
  "compile_passed": true,
  "sim_passed": {"total": 8, "passed": 8},
  "vscodeignore_verified": true,
  "changes": ["Bug A/B/C 修复…"]
}
```
临时报告闭环时清理；链级闭环时 `.dsh/reports/` 随 `.dsh/tmp/` 一并清空（最终发布结论由编排者在本会话向用户汇报，不保留永久档案）。

## Git 提交编码（应对中文乱码）
- **推荐链路**：用 `write`/`edit` 工具写提交信息（干净 UTF-8、无 BOM）→ `git commit -F <文件>`（git 直接读文件字节，不经 PowerShell 解码）
- **禁止**把提交信息"读过 PowerShell"：`Get-Content <msg> | git commit -F -` 或 `git commit -m "$(Get-Content …)"`——dsh 的 `pwsh` 跑 Windows PowerShell 5.1、本机 ANSI 代码页 936(GBK)，按 GBK 误解码 UTF-8 会乱码（实测复现）
- 提交后自检 commit 对象字节无 BOM（efbbbf/bbbf/fffe）/mojibake
- 提交格式：`<type>: <主题>` + 正文 bullet
