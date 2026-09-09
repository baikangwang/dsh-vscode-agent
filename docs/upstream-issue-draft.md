# 上游 issue 反馈要点（起草稿，**不代发**，交编排者/用户裁决后由人工提交）

> 依据：r2 探针（probe-r2-window.mjs，本轮实测）+ 上游 git 取证（0.1.3-alpha.2 `e379fa8bdd` vs master HEAD `c389f96bf3`）。
> 先例：0.1.6 轮上游 issue #18 反馈材料模式。

---

## 标题（建议）

`subprocess: Windows native containment runner spawns a visible console window when the host has no console (regression vs 0.1.3-alpha.1 windowsHide fix)`

## 环境与版本

- Windows 11（win32），Node.js console 子系统进程链
- 受影响版本：`@deepseek-ai/dsh` 0.1.3-alpha.2（koffi 为正式 dependency，`probeWindowsJob()` 默认成功 → ordinary 命令默认走 windows-job runner）
- 未受影响（对照）：0.1.3-alpha.1（PR #3516 后的 `spawnSubprocess` 带 `windowsHide: platform === 'win32'`，`spawn.ts:387`）
- master HEAD `c389f96bf3`（0.1.3-alpha.2 之后 133 提交）：`windows-job.ts` / `runner-launch.ts` 两文件 `git diff e379fa8bdd c389f96bf3` 零输出，**回归仍在**

## 最小复现（两级 spawn 链 + GetConsoleProcessList 判别）

1. 宿主 A = `spawn(node, [mid.js], { detached: true, windowsHide: true, stdio: 'ignore' })`
   （= 无 console 宿主；判别：A 再 spawn 无选项孙 B 时 B `consoleprocs=1` 只含自己 = 新建 console，反证 A 无 console 可继承）
2. mid.js 中按 runner 形态 spawn：`spawn(node, [grandchild.js], { cwd, env, stdio })`
   （与 `windows-job.ts` `launchWindowsJob` 的 spawn options 同构：**无 windowsHide、无 detached**）
3. grandchild.js（console 程序）自报 `GetConsoleWindow()` / `IsWindowVisible()` / `GetConsoleProcessList()`

## 实测结果（r2 轮，M3/M3r 组）

- runner 形态孙：`console=True visible=True`，`consoleprocs=1 ids=<仅自己>` → **新建了可见 console（闪窗/弹窗）**
- 对照组（同链孙带 `windowsHide: true`，= `spawnSubprocess` 修复形态）：`console=False` → 无 console，无窗
- 对照组（有不可见 console 的宿主直接 spawn 无选项子）：`console=True visible=False`、`consoleprocs≥2 且含宿主 pid` → 继承成立（判别器有效）
- `stdio` 为 `ignore`（M3）与文件重定向（M3r = 扩展 DIRECT 字节级同构）两种形态均复现（pipe 未单独成组，未测）

## 语义解释（供上游参考）

- mid（detached+windowsHide）= libuv 同传 `DETACHED_PROCESS | CREATE_NO_WINDOW`；按 MSDN，DETACHED_PROCESS 生效（不继承也不新建 console，console handle 未设置）→ mid 无 console。
- runner spawn 无 windowsHide → console 目标按默认语义"无父 console 可继承则新建**可见** console" → 每次工具调用闪一窗。
- PR #3516（issue #2390）在 alpha.1 修掉的正是"无（可见）控制台宿主下工具子进程新建可见控制台闪窗"；alpha.2 的 native containment（PR #2825）在 runner 路径上使该修复对 ordinary 命令失效。

## 影响面

- 无 console 宿主下的 dsh（如 VS Code 扩展 detached 启动、服务化部署）在 alpha.2 上每次 ordinary 工具调用弹一可见 console 窗，闪窗 + 抢焦点；比 alpha.1 退化。
- `consoleVisible=true` 常驻形态不受影响（runner 继承常驻可见 console，无新窗）。

## 修复建议

- `windows-job.ts` runner spawn 增加 `windowsHide: true`（与 `spawnSubprocess` 同语义；runner 是 node console 程序，`runner-launch.ts` `spawnRunnerInvocation` 返回 `process.execPath`）；Job 目标（win32-process `spawnCurrentTokenJobProcess`，`CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT`）继承 runner console，runner 隐藏即整链无窗。
- 或 runner spawn 用 `detached: true, windowsHide: true`（runner 与 Job 目标完全脱离宿主 console 体系）。

## 证据文件（r2 落盘，随附可复现脚本）

- 探针脚本：`.dsh/tmp/architect/r2/probe-r2-window.mjs`（G1 宿主对照的内联 spawn 逻辑在 `probe-r2-window.mjs:81-83`；+ report.ps1 / host-g1.ps1）
- 原始输出：`.dsh/tmp/architect/r2/M3-grandchild-noOpt.txt`（=runner 形态弹窗证据）、`M3-grandchild-hide.txt`、`M0-grandchild-noOpt.txt`（=继承判别器有效证据）、`r2-result.txt`（全组汇总）
- 上游源码锚点：`git show e379fa8bdd:packages/subprocess/subprocess-local/src/windows-job.ts`（spawn options 无 windowsHide）；`git diff e379fa8bdd c389f96bf3 -- packages/subprocess/subprocess-local/src/windows-job.ts packages/subprocess/subprocess-local/src/runner-launch.ts`（零输出）
