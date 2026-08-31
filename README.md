# 獬豸 Xiezhi

**辨曲直，触不直者** —— 面向 DeepSeek Harness 的多智能体 GitHub PR 审查插件。

<p align="center">
  <img src="./docs/assets/xiezhi.png" alt="獬豸 Xiezhi 多智能体代码审查" width="720">
</p>

> 獬豸（xiè zhì）是中国神话中的独角神兽：能辨是非曲直，见人相争，便以角顶理亏的一方。古代法官戴獬豸冠以示明断。本插件以此命名——审查员提出"指控"，验证层辨真伪，最终用角"顶"到真正有问题的那行代码。

## 工作方式

```
PR 事件
  │
  ▼
拉取 PR diff（预算截断，超大 PR 优雅降级）
  │
  ▼
并行派出审查子 agent ── bug猎手(pro) ──┐
  │              ├─ 安全扫描(pro) ────┤ 各自输出结构化 findings（outputSchema 强制）
  │              └─ nitpicker(flash) ┤
  ▼                                  │
獬豸裁决（验证层, flash）◄────────────┘
  │   逐条复核：diff 中无实锤证据即驳回（无裁决 = 丢弃）
  ▼
确定性去重聚合（同文件+行窗口合并，角色溯源）
  │
  ▼
Markdown 判决书（严重度分级 + 每角色 token 成本表）
  → 可选发布为 PR 评论（发现自动锚定为行内评论）
```

**成本感知路由**：深度推理角色（bug 猎手、安全扫描）固定 pro 档模型，高频机械角色（nitpicker、裁决员）固定 flash 便宜档；每次审查自动输出分角色/分模型的 token 账单（输入/输出/缓存命中），机械活用便宜模型的节省量可直接读出。

整次审查自动写入 dsh 会话日志，可回放、可审计。

## 基准结果

固定开发集取自 Martian Code Review Benchmark：5 个真实开源仓库各 4 个 PR，共 20 PR、68 条人工核实的 golden findings；另有 30 PR 冻结为 held-out，只在设计定稿后运行一次。

| 配置 | 成功率 | Findings | Matched | Precision | Recall | P50 | P95 |
|---|---:|---:|---:|---:|---:|---:|---:|
| DeepSeek V4 Flash（3 审查角色 + Verifier） | 20/20 | 104 | 27 | 26.0% | 39.7% | 8.6 min | 14.3 min |

这是用于后续消融的开发基线，不是 held-out 最终成绩。固定样本见 [`eval/baseline-20.json`](./eval/baseline-20.json)，运行记录与判分摘要见 [`eval/baseline-20-manifest.json`](./eval/baseline-20-manifest.json) 和 [`eval/baseline-20-results.json`](./eval/baseline-20-results.json)。

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
| `repoContext` | `off` | `changed` 注入变更文件在 PR head 的完整内容（预算：10 文件/单文件 16KB/共 48KB）。**A/B 实测（express#7377, glm-5.3）：注入后候选 3→0、真实缺陷丢失（注意力稀释），故默认 `off`**；保留给需要文件级核验的场景 |
| `routes` | `[]` | 按角色覆盖厂商/模型（多厂商路由开关） |

`routes` 示例（把 bug 猎手切回 DeepSeek，其余保持智谱）：

```yaml
- id: xiezhi
  config:
    routes:
      - id: bug-hunter
        provider: deepseek-official
        model: deepseek-v4-pro
```

内置路由：bug-hunter/security → `glm-5.3`，nitpicker/verifier → `glm-5.3-flash`（provider `zhipu`，需同时挂载 `dsh-llm-zhipu` 适配器）。

## 测试

```sh
node --import tsx/esm --test xiezhi/tests/schema.test.ts xiezhi/tests/github.test.ts xiezhi/tests/context.test.ts zhipu-adapter/tests/sse.test.ts
```

纯函数覆盖：去重聚合（行窗口合并/严重度优先/角色并集）、hunk 行解析与锚点分流、SSE 分帧（多行 join/CRLF/注释跳过/截断检测/UTF-8 分片）。

## 结构

```
src/
├── index.ts          # 插件入口：Config schema + review_pull_request 工具
├── orchestrator.ts   # 流水线：采集 → 仓库上下文 → 并行审查 → 裁决 → 聚合 → 判决书（含成本表）→ 发布
├── roles.ts          # 角色注册表 + 模型路由（扩展点：加角色=加一项）
├── context.ts        # 仓库上下文：变更文件全量拉取（预算截断，additions 优先）
├── verify.ts         # 獬豸裁决（分批复核，无裁决即丢弃）
├── usage.ts          # 从子 agent 会话日志提取 token 用量
├── schema.ts         # Finding 类型 + 结构化 schema + 去重聚合（对齐公开 benchmark 真值字段）
└── github.ts         # PR 拉取 + diff 预算截断 + hunk 行解析 + 行内评论发布
```

## Roadmap

- P1：✅ 多角色并行审查、验证裁决、聚合去重、GitHub 评论发布、配置化
- P2：✅ dsh bundle 打包 + GitHub Action 模板、成本感知路由 + token 账单、行内评论代码、Martian 20 PR 开发基线｜待办：行内评论真机验证
- P3：验证层/上下文/模型档位消融、held-out 30 PR 最终验证、GitHub App 模式、脱敏导出
