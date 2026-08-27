# 獬豸 Xiezhi

**辨曲直，触不直者** —— 面向 DeepSeek Harness 的多智能体 GitHub PR 审查插件。

> 獬豸（xiè zhì）是中国神话中的独角神兽：能辨是非曲直，见人相争，便以角顶理亏的一方。古代法官戴獬豸冠以示明断。本插件以此命名——审查员提出"指控"，验证层辨真伪，最终用角"顶"到真正有问题的那行代码。

## 工作方式

```
PR 事件
  │
  ▼
拉取 PR diff（预算截断，超大 PR 优雅降级）
  │
  ▼
并行派出审查子 agent ── bug猎手 ─┐
  │              └─ 安全扫描 ──┤ 各自输出结构化 findings（outputSchema 强制）
  ▼                            │
獬豸裁决（验证层）◄─────────────┘
  │   逐条复核：diff 中无实锤证据即驳回（无裁决 = 丢弃）
  ▼
确定性去重聚合（同文件+同类别+行窗口合并，角色溯源）
  │
  ▼
Markdown 判决书（严重度分级）→ 可选发布为 PR 评论
```

整次审查自动写入 dsh 会话日志，可回放、可审计。

## 运行（源码仓库内，开发模式）

前置：DeepSeek 凭据（环境变量或 Harness home）；公开仓库无需 GitHub token（`post: comment` 与高限额场景设 `GITHUB_TOKEN`）。

```sh
# 1. 验证插件挂载（keyless，只打印组合后的插件树）
pnpm dsh --profile headless --patch ./xiezhi/dev.patch.yml --dump-config

# 2. 真实运行（会产生少量模型调用费用）
pnpm dsh --profile headless --patch ./xiezhi/dev.patch.yml \
  "Use the review_pull_request tool to review PR owner/repo#123"
```

Web UI 方式：`pnpm dsh web --patch ./xiezhi/dev.patch.yml`，在对话里让模型调用 `review_pull_request`。

## 安装（独立 profile，产品模式）

```sh
dsh plugin --profile review add github:<you>/xiezhi     # git 安装（首次需 pnpm allowBuilds 授权，见 action.yml 注释）
dsh plugin --profile review add ./dsh-xiezhi-0.1.0.tgz  # 或 tarball / npm
dsh --profile review --dump-config                       # 应出现 "# == dsh-xiezhi" 层
```

`cordis.patch.yml` 是 bundle 层（按包名引用）；`dev.patch.yml` 是仓库内源码调试层（file:// 绝对路径）。

## GitHub Action

`action.yml` 提供组合 Action：装插件 → 生成 overlay（`post: comment`）→ headless 审查。用法见 `workflow-example.yml`（放入目标仓库 `.github/workflows/`，配 `DEEPSEEK_API_KEY` secret）。

## 构建

```sh
pnpm exec tsdown --config xiezhi/tsdown.config.ts   # 仓库内
pnpm build                                           # 独立仓库内（含 prepare，供 git 安装）
```

构建产物 `lib/index.mjs` 仅运行时依赖 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery`，其余工作区导入均为类型、构建期擦除。

## 配置（patch 行的 config 键）

| 键 | 默认 | 含义 |
|---|---|---|
| `verifier` | `true` | 报告前对每条候选发现做证据复核 |
| `batchSize` | `8` | 每个裁决子 agent 复核的候选数 |
| `post` | `off` | `off` 仅返回报告；`comment` 同时发布为 PR 评论（需 `GITHUB_TOKEN`） |
| `maxFindings` | `30` | 聚合后报告条数上限 |

## 结构

```
src/
├── index.ts          # 插件入口：Config schema + review_pull_request 工具
├── orchestrator.ts   # 流水线：采集 → 并行审查 → 裁决 → 聚合 → 判决书 → 发布
├── roles.ts          # 角色注册表（扩展点：加角色=加一项）
├── verify.ts         # 獬豸裁决（分批复核，无裁决即丢弃）
├── schema.ts         # Finding 类型 + 结构化 schema + 去重聚合（对齐公开 benchmark 真值字段）
└── github.ts         # PR 拉取 + diff 预算截断 + 评论发布
```

## Roadmap

- P1：✅ 多角色并行审查、验证裁决、聚合去重、GitHub 评论发布、配置化
- P2：✅ dsh bundle 打包 + GitHub Action 模板｜待办：行内 review comments、角色×模型成本路由、评测（Martian Code Review Bench + AACR-Bench）
- P3：GitHub App 模式、脱敏导出、推广
