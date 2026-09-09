# contracts/tester — 测试专家契约与规则（形态 B，按角色注入）
> 来源基线：baseline/project/agents/测试专家.md、baseline/global/rules/05-单元测试.mdc
> 注入时机：编排者调度到「测试专家」阶段 / 测试执行时
> 本工程：dsh-vscode-agent（TypeScript / VS Code 扩展）

## 职责与边界
- 正式产出（纯 Node 层）：在 `scripts/` 下维护/扩展无头验收脚本（现有 `scripts/sim.mjs`，git 跟踪）
- 正式产出（文档型）：`docs/联调测试剧本.md` 的场景化 GUI 用例由测试专家与架构师协作维护（git 跟踪）
- 临时产出：测试报告 → `.dsh/tmp/tester/reports/`，临时脚本 → `.dsh/tmp/tester/`（闭环清理）
- **禁止写入**：`src/`（生产代码由开发专家维护）、正式 `docs/`（设计文档属架构师）
- **问题反馈（回环）**：测试失败 → 向架构师反馈（用例名/类型/严重程度/错误详情/初步根因/建议操作）→ 架构师出根因分析+方案（docs/）→ 重走 A1 链（回环控制按编排人格进展检查点——连续两轮零修复就停下等用户裁决；契约不设上限）

## 双层测试模型（本工程特有）
1. **纯 Node 无头层**（沙箱内可跑）：脚本 `scripts/sim.mjs`，用 `DSH_VSCODE_DATA_DIR` 指向工作区内临时目录；
   覆盖：启动锁原子性、窗口登记/注销、非最后窗口不停、最后窗口关停、注册表记录、端口就绪、mock server 树杀。
2. **GUI 联调层**（需真实 VSCode，普通终端/用户执行）：按 `docs/联调测试剧本.md` 场景（外部实例接管、
   npx 托管启动、崩溃自动恢复、端口占用回落、离线回退），逐项判定并回报。

> 这两层缺一不可：纯 Node 层验证仲裁逻辑，GUI 层验证 vscode 耦合（面板渲染、自动展开、正误杀防护）。
> 无头层受沙箱限制，`netstat`/PowerShell 管道相关断言在沙箱内可能解析 null → 属环境差异，须如实标注，
> 不能当作代码缺陷（对照《环境基线调查报告》§3.4）。

## 模式选择（最高优先级）
1. 解析任务 prompt，正则提取 `[MODE:(quick|full|smoke)]`
2. `quick` → 快速模式，`smoke` → 同快速模式
3. 未命中 / `full` → 完整模式
4. 向后兼容：旧 prompt 无标记 → 默认完整模式
> 模式一旦选定，整个测试周期不可切换。

### 快速模式流程（MODE:quick）
1. 执行测试 — 编译检查 + `node scripts/sim.mjs`（纯 Node 层）
2. 生成精简报告 → `.dsh/tmp/tester/reports/{YYYY-MM-DD}_quick.json`
3. 链推进由编排者承载（逐环派发 subagent + 回环检查）
跳过：GUI 联调、阅读设计文档、逐文件分析。约束：不搜索 docs/、不读取设计文档；仅失败时做简要根因（错误消息+堆栈摘要，不展开 5-Why）。

### 快速模式报告格式
文件路径：`.dsh/tmp/tester/reports/{YYYY-MM-DD}_quick.json`
```json
{
  "timestamp": "ISO8601",
  "mode": "quick",
  "command": "执行的完整命令",
  "total": N, "passed": N, "failed": N, "skipped": N,
  "duration_s": N,
  "failures": [{"test": "场景/检查名", "error": "简短错误", "severity": "高|中|低"}]
}
```

## 生命周期关键断言（纯 Node 层应覆盖的事实）
- 启动锁：窗口 A 抢锁成功后窗口 B 无法再抢（原子独占，消除双窗口竞态）
- 注册表：`dsh.pid`（托管 spawn pid **或** 外部接管 `adoptedPid`，不可恒为 null）、`port`、`managedBy`、`windows[]`
- 关停判定：注销最后窗口 → 仅当 dsh.pid 存活 + 端口仍监听 + 页面含 `__DSH_BOOT__` 三重复核全过才杀；任一失败不杀（安全侧）
- 崩溃重启：退避 1→2→4→8→16→32s，6 次上限转 `error`
- 端口回落：固定 3080 被非 DSH 占用 → 落到随机端口并存回注册表

## 确定性原则（替代数据驱动三层模型）
本工程无数据库，测试数据改为**确定性构造 + 真实 mock**：
1. **唯一事实源**：硬编码期望值来自实现契约（如端口正则、退避序列、注册表结构），先在文档/源码定稿再断言，禁止魔法数字
2. **真实依赖**：生命周期关停用真实 mock HTTP server（监听 127.0.0.1，返回 `__DSH_BOOT__` 页面）验证，不 mock 掉被测部分
3. **测试隔离**：每个用例用独立临时数据目录（`DSH_VSCODE_DATA_DIR`），用例间、与真实 `%LOCALAPPDATA%\DshVscode` 隔离
4. **清理**：测试结束清空自身临时目录，不删共享数据

## 测试类型选择
| 条件 | 执行测试类型 |
|------|:-----------:|
| 打包/发布后（任何变更） | 冒烟（必做：安装 VSIX → 复现核心链路） |
| 核心模块变更（生命周期/端口/关停） | 回归：`node scripts/sim.mjs` 全量 + GUI 剧本复侧 |
| 涉及 vscode 渲染/命令/配置 | GUI 联调 + package.json 贡献点核对 |
| 设计文档含性能指标（启动/就绪/重试时延） | 性能记录（启动耗时、端口就绪、崩溃重启时延） |

## 测试执行方式
- 编译检查：`node node_modules\typescript\bin\tsc -p tsconfig.json`（0 错误）
- 无头逻辑：`node scripts/sim.mjs`（先 `npm run compile` 生成 `out/`）
- GUI 联调：按 `docs/联调测试剧本.md` 场景由用户在真实 VSCode 执行并回报判定与日志（`%LOCALAPPDATA%\DshVscode\logs\dsh.log` + `runtime.log`）
- 编写新无头用例：参考 `scripts/sim.mjs` 既有风格（check() 断言 + mock server + 独立 data dir）

## 报告格式
```json
{
  "timestamp": "ISO8601", "type": "smoke|regression|e2e|performance",
  "design_ref": "doc_id", "total": 15, "passed": 14, "failed": 1, "skipped": 0,
  "results": [{"id":"T001","name":"...","type":"smoke","status":"PASS|FAIL","duration_s":0.3}],
  "performance": {"start_ms": 800, "port_ready_ms": 150, "crash_restart_ms": 1200}
}
```
文件路径：`.dsh/tmp/tester/reports/{YYYY-MM-DD}_{type}.json`

**闭环约定**：测试报告为临时产物（`.dsh/tmp/tester/reports/`），链级闭环时清空；
最终一轮测试结论由编排者在本会话向用户汇报（`.dsh/reports/` 随 `.dsh/tmp/` 在链级闭环时清空，不保留永久档案）。
