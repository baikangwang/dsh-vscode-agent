# .dsh/contracts/README — 约定式 workspace 契约结构（敏捷模式 agile）

> 这是"零代码新项目接入"的规范说明。任何项目在本 workspace 的 `.dsh/` 下按此约定放置文件，
> 敏捷模式编排人格（预设内建，非外部插件）会话开始时自动读取；派发时把契约清单写进派发提示词、由子代理开工前自读契约（2026-09-09 用户决策），**无需编写任何 host 逻辑**。
> 敏捷模式自身足迹（A/B/C + 临时工作区）全部收进 `<cwd>/.dsh/`，不污染真实项目根。

## 目录约定

```
<workspace>/.dsh/
├── profile.yaml                # A：声明式技术骨架（项目事实声明）
├── contracts/
│   ├── _shared/                # 全局通用方法论基线（所有角色子代理必读）
│   ├── architect/              # B：架构师契约（设计模板/根因/文档规范）
│   ├── developer/              # B：开发专家契约（编码规范/接口契约/包结构）
│   ├── tester/                 # B：测试专家契约（纯Node无头 + GUI联调双层/报告）
│   ├── deployer/              # B：部署/发布专家契约（VSIX 打包/发布/安装验证/版本）
│   └── qa/                     # B：QA 检查标准（D/C/P 检查项/回环）
├── skills/                     # C：项目级 skill（低频大知识）挂载源（官方 skill-filesystem 发现根）
├── reports/                    # 临时产物（链级闭环随 .dsh/tmp/ 一并清空，不保留永久档案）
└── tmp/                        # 临时工作区（一次性轮级产物，git 忽略，闭环清空）
    ├── architect/  developer/  tester/  deployer/   # 各角色一次性草稿/探针/中间物
    └── audits/                               # QA 每轮审计（中间轮随轮级闭环清理）
```

**目录契约（闭环白名单）**：正式产出绝不清理 —— `src/`（生产代码）、`scripts/`（无头测试脚本）、
`docs/`（设计文档）、`.dsh/{profile.yaml,contracts,skills}`。临时产物一律写入 `.dsh/tmp/<role>/` 或 `.dsh/reports/`，
按目录收敛清理，禁止硬编码文件名。

## 三种形态的分工

| 形态 | 载体 | 性质 | 加载方式 | 何时用 |
|------|------|------|---------|--------|
| **A** | `.dsh/profile.yaml` | 声明式**数据** | 编排者会话开始读取 tech_stack/deploy 骨架作为项目事实 | 可结构化的技术事实：语言/构建/包结构/端口/部署骨架/安全红线 |
| **B** | `.dsh/contracts/<role>/*.md` | 结构化**文本** | 派发时把契约清单写进派发提示词，子代理开工前自读（硬性开工指令） | 可叙事、需模型理解的契约：设计模板、编码约束、检查标准、语义约定 |
| **C** | `.dsh/skills/{project}-*.md` | 项目级 **skill** | 按需 skill() 拉取（官方发现根 `.dsh/skills`） | 大体积低频参考知识：工程规范全文、部署 SOP、测试方法论 |

## 按角色 × 按 workspace 加载

- **按项目**：编排者读取 `.dsh/profile.yaml` → 项目骨架/红线事实（tech_stack/deploy/security）。
- **按角色**：编排者调度到某角色时，把该角色 `.dsh/contracts/<role>/` + `_shared` 基线的文件清单写进派发提示词并附硬性开工指令，由 subagent 开工前自读；未调度角色不加载 → 上下文受控、token 不浪费（2026-09-09 用户决策：子代理自读替代编排者读+内联）。

## 新项目接入步骤（零代码）

1. 在 workspace 的 `.dsh/` 下新建 `profile.yaml`（声明语言/构建/包结构/部署骨架/安全红线）。
2. 可选的：`.dsh/contracts/<role>/` 放该项目特有的角色契约；没有就不建（用通用契约）。
3. 可选的：`.dsh/skills/` 放该项目大知识库（需 frontmatter：`name`/`description`）；没有就不建。
4. 完成——会话选择"敏捷模式"即自动生效。无需改引擎、无需写代码。

> 每个契约文件顶部保留 `来源基线` 注释，指向 `baseline/` 备份，保证可追溯与审计。
