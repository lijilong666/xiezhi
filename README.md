# 獬豸 Xiezhi

**辨曲直，触不直者** —— 面向 DeepSeek Harness 的多智能体 GitHub PR 审查插件。

> 架构总览与设计决策见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

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
  │   四态裁决 + checklist + Evidence Pack（无实锤证据即驳回）
  ▼
确定性去重聚合（同文件+行窗口合并，角色溯源）
  │
  ▼
Markdown 判决书（严重度分级 + 每角色 token 成本表）
  → 可选发布为 PR 评论（发现自动锚定为行内评论）
```

**成本感知路由**：深度推理角色（bug 猎手、安全扫描）固定 pro 档模型，高频机械角色（nitpicker、裁决员）固定 flash 便宜档；每次审查自动输出分角色/分模型的 token 账单（输入/输出/缓存命中），机械活用便宜模型的节省量可直接读出。

### 自适应审查规划（实验性，默认关闭）

开启 `adaptive` 后，审查前先由纯函数 Risk Profiler 从 PR diff 与元数据提取确定性特征（变更规模、文件数、语言、测试比例、敏感目录、依赖清单、CI/迁移、patch 截断），规则路由器按加权信号分级：低风险 PR 只派 1 个 flash 主审查员，中风险派 2 个针对性角色（命中敏感/依赖/CI 信号时强制纳入安全员），高风险才启用全队 + pro 档 + 严格验证。运行时预算治理：角色阶段 token 超出预算时，验证批次自动粗化（减调用）并跳过升级复核；light 验证路径上 critical/major 候选若仅得 plausible 结论，自动加一轮 4 条一批的严格复核再定生死，防止"低风险"配置误杀真缺陷。`repoCalibrations` 可按仓库历史中位数（由 `node --import tsx/esm xiezhi/eval/plan-only.mjs` 零成本重放得出）放宽 large/wide 阈值，避免大仓库的常规 PR 恒判高危。每次审查的报告带 `## Review Plan` 审计段（风险信号、组队理由、预算与实际用量、超支处置）；计划不合法或关闭开关时回退固定三角色流水线，Planner 永远不是单点故障。角色白名单静态，规划器不能发明工具或厂商。

整次审查自动写入 dsh 会话日志，可回放、可审计。

### Repository Evidence Pack（实验性，默认关闭）

开启 `evidence` 后，验证员从"只看 diff"升级为"可检索仓库"：插件拉取 PR head 的 tarball 快照解包到临时目录（零第三方依赖，系统 tar；120MB/180s 预算，超限优雅降级为纯 diff 并在报告记录原因），注册 5 个只读检索工具——`xiezhi_read_file`（窗口读）、`xiezhi_search_code`（全词/正则/glob 搜索，排除 node_modules 等噪音树）、`xiezhi_find_references`（引用查找，源码先于测试排序）、`xiezhi_related_tests`（命名约定 + 回退搜索）、`xiezhi_git_history`（REST 查路径提交）。工具只授予验证员（审查员保持零工具——A/B 实证全量注入会注意力稀释）；每次调用进报告 Evidence 段，证据可回放。仓库规则文件（`AGENTS.md` / `.github/copilot-instructions.md`）以不可信数据标签包裹后才进入提示词，防止仓库内容伪装指令。

### 可执行验证（实验性，默认关闭）

开启 `execver`（需同时开 `evidence`）后，验证层获得确定性执行证据：插件解析自带的 `typescript`（peer 依赖），对 base 与 head 双快照各跑一次 `tsc --noEmit`，**取差分**——依赖缺失等环境噪音在两侧完全一致、自动抵消，只有 PR 新引入的编译错误才是有效信号。当 plausible 状态的 critical/major 候选所在文件恰好出现新编译错误时，确定性执行器直接构造 `proofLevel: executed` 的确认裁决（Evidence Pack 附编译器产物与 base/head 对比说明）；文件不匹配、环境失败或超时（180s）则原判保持不变——环境问题永远不确认也不否证一个缺陷（SWE-Cycle 的教训）。LLM 验证员全程拿不到 shell；plausible 升级优先走本执行器，不可用时才回退 LLM 复核。

### 灰区混合规划与跨文件破坏检测（实验性，默认关闭）

- **Hybrid Planner**（`hybridPlanner`）：规则路由对大多数 PR 足够，但评分落在 medium/high 边界 ±1（4-6 分）的"灰区"判断代价高。灰区 PR 追加一次 flash 结构化规划调用；其输出被当作**不可信数据**处理——角色只能从静态白名单 enum 中选、预算/批量由规则从 level/depth 推导（模型无权设定）、整体过 `validatePlan` 修复闸、置信度 <0.6 或调用失败/超时即保留规则计划，`fallbackReason` 全程落报告。规划员永不构成单点故障。
- **Cross-Change 静态检测**（随 `evidence` 自动启用）：PR 删除或重命名文件后，快照中仍有 import 指向旧路径 → 产生 `cross-file-break` 风险信号（权重 2，可联动灰区/升级风险）并以不可信数据块提示验证员核查。纯静态正则解析（ES import/export/require），零模型调用。
- 零成本标定：`node --import tsx/esm xiezhi/eval/plan-only.mjs` 输出 20 PR 分级分布、灰区占比与分仓库中位数（本地缓存，限流可断点续跑）。

### 安全边界与反馈抑制（实验性）

对抗面假设（GitInject/SEVRA-BENCH 结论）：PR 标题、描述、commit message、代码注释、仓库规则文件、工具输出都可能是攻击者控制的自然语言。

- **不可信数据分区**：PR 标题/描述进入任何提示词前用 `<untrusted-data>` 包裹（注入的闭合标签被零宽字符中和），声明"是数据不是指令"；仓库规则文件与跨文件分析块同理（M1/M3 已落地）
- **权限拆分（结构性）**：审查员零工具；验证员只有 5 个只读检索工具（路径防逃逸）；执行器固定 argv 不碰网络不碰凭据；`GITHUB_TOKEN` 只在主进程发布环节读取，**任何子 agent 都拿不到发布权与凭据**；LLM 规划员输出经 enum 白名单 + 规则预算 + validatePlan 三重约束
- **透明抑制表**：`suppressions` 配置按 (file glob, category) 在发布边界过滤已驳回的发现类型；报告明确列出每条规则抑制数量——没有隐藏学习，人工可审计可撤销

### 增量重审与生产韧性（实验性）

- **增量重审**：`review_pull_request` 传 `since`（上次审查的 commit sha）→ 只审 `since...head` 的变更文件（GitHub compare API 的 diff-of-diff），成本随增量而非全量；无变更即返回空报告并提示旧评论可能过期；compare 失败自动回退全量并在报告注明
- **熔断与降级**：provider 连续失败达阈值（默认 3）即跳闸，该 provider 的后续 spawn 直接降级到 `fallbackRoute`（跨厂商，默认 deepseek flash）；任一成功复位；单角色失败另有一次性降级重试；报告记录跳闸事件
- **角色级超时**：`roleTimeoutMs` 墙钟预算（默认 15 分钟），超时取消该角色、其余角色与验证层照常；规划员调用独立 60s 超时，失败保留规则计划

### Evidence Pack v1

Verifier 对每条候选生成 `confirmed / plausible / inconclusive / rejected` 四态结论，并检查位置锚定、触发条件、可观察影响和证据充分性。只有 `confirmed`、四项清单全部通过且带有同文件附近 diff 引用的 finding 才能进入报告；最终评论附带 claim、trigger、impact、证据位置和裁决理由。

## 基准结果

固定开发集取自 Martian Code Review Benchmark：5 个真实开源仓库各 4 个 PR，共 20 PR、68 条人工核实的 golden findings；另有 30 PR 冻结为 held-out，只在设计定稿后运行一次。

| 配置 | 成功率 | Findings | Matched | Precision | Recall | P50 | P95 |
|---|---:|---:|---:|---:|---:|---:|---:|
| DeepSeek V4 Flash（3 审查角色 + Verifier） | 20/20 | 104 | 27 | 26.0% | 39.7% | 8.6 min | 14.3 min |

这是 Evidence Pack v1 引入前（提交 `0c8edeb`）的开发基线，不代表当前实现成绩，也不是 held-out 最终成绩。固定样本见 [`eval/baseline-20.json`](./eval/baseline-20.json)，运行记录与判分摘要见 [`eval/baseline-20-manifest.json`](./eval/baseline-20-manifest.json) 和 [`eval/baseline-20-results.json`](./eval/baseline-20-results.json)。

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
| `adaptive` | `false` | 自适应审查规划：Risk Profiler 从 diff 提取确定性风险特征（规模/语言/测试比例/敏感目录/依赖/CI·迁移/截断），Hybrid Router 按风险分级动态组队（低 1 角色、中 2 针对性角色、高全队）并联动模型档位、验证深度与 token 预算；非法计划自动回退固定三角色。**实验性：未经付费基准验证，故默认关闭** |
| `hybridPlanner` | `false` | 灰区混合规划：风险评分 4-6 分（medium/high 边界 ±1）的 PR 由 flash 模型规划员重新决定计划——输出经白名单校验（角色 enum 约束 + validatePlan 修复）、预算/批量仍由规则推导、置信度 <0.6 或任何失败回退规则计划并记录原因。需同时开 `adaptive`。**实验性** |
| `evidence` | `false` | Repository Evidence Pack：拉取 PR head 只读快照（GitHub tarball，120MB 预算，超限/失败降级为纯 diff 并记录原因），给验证员 5 个检索工具（read_file/search_code/find_references/related_tests/git_history）做跨文件核验；快照同时驱动跨文件破坏检测（删除/重命名文件仍被 import → `cross-file-break` 风险信号 + 验证员提示）；仓库规则文件（AGENTS.md 等）以不可信数据包裹注入；报告附 Evidence 段（快照状态 + 验证员工具调用轨迹）。**实验性** |
| `execver` | `false` | 可执行验证：用插件自带的 TypeScript 编译器对 base/head 双快照跑 `tsc --noEmit`，**差分对消环境噪音**（缺 node_modules 的报错两侧一致即抵消），仅 PR 新引入的编译错误才能把 plausible 的 critical/major 候选升级为 `executed` 实证确认（附编译器产物）；环境失败只降级不改判。需同时开 `evidence`。**实验性** |
| `verifier` | `true` | 报告前对每条候选发现做证据复核 |
| `batchSize` | `8` | 每个裁决子 agent 复核的候选数 |
| `post` | `off` | `off` 仅返回报告；`comment` 同时发布为 PR 评论（需 `GITHUB_TOKEN`） |
| `maxFindings` | `30` | 聚合后报告条数上限 |
| `repoContext` | `off` | `changed` 注入变更文件在 PR head 的完整内容（预算：10 文件/单文件 16KB/共 48KB）。**A/B 实测（express#7377, glm-5.3）：注入后候选 3→0、真实缺陷丢失（注意力稀释），故默认 `off`**；保留给需要文件级核验的场景 |
| `routes` | `[]` | 按角色覆盖厂商/模型（多厂商路由开关） |
| `repoCalibrations` | `[]` | 按仓库中位数放宽 large/wide 阈值（`plan-only.mjs` 重放生成，见自适应规划小节） |
| `suppressions` | `[]` | 透明反馈抑制表：`{filePattern, category?, reason}`，在发布边界按 glob+类别过滤被开发者驳回的发现类型；报告始终标注每条规则抑制了几条（可审计、可随时编辑删除，无隐藏学习） |
| `circuitThreshold` | `3` | 同一 provider 连续失败 N 次后跳闸，后续 spawn 直接降级到 fallbackRoute |
| `fallbackRoute` | `deepseek-official/deepseek-v4-flash` | 跨厂商兜底路由（跳闸降级 + 单次角色失败重试） |
| `roleTimeoutMs` | `900000` | 单角色墙钟预算，超时取消该角色 |

工具参数 `review_pull_request` 增加 `since`（上次审查的 head commit sha）：增量重审——只审 `since...head` 的 diff-of-diff（compare API），无新变更时直接返回"无可审查"并提示旧行内评论可能过期；compare 不可用时回退全量并注明。

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
node --import tsx/esm --test xiezhi/tests/schema.test.ts xiezhi/tests/github.test.ts xiezhi/tests/context.test.ts xiezhi/tests/evidence.test.ts xiezhi/tests/evidence-tools.test.ts xiezhi/tests/planner.test.ts xiezhi/tests/escalation.test.ts xiezhi/tests/verify-prompt.test.ts xiezhi/tests/execver.test.ts xiezhi/tests/crosschange.test.ts xiezhi/tests/hybrid-planner.test.ts xiezhi/tests/adversarial.test.ts xiezhi/tests/resilience.test.ts zhipu-adapter/tests/sse.test.ts
```

99/99 纯函数与 fixture 覆盖：风险画像/分级/灰区/预算执行/仓库校准（表驱动含边界值）、Evidence Pack 发布门槛与四态裁决、快照检索原语（glob/路径逃逸/dispose 所有权）、跨文件断链解析、差分 tsc（真实编译器跑 fixture：升级命中/跨文件不升级/环境失败不改判）、planner 输出防弹映射、对抗注入中和、抑制表精确匹配、熔断跳闸/复位/自降防护、去重聚合、hunk 锚点、SSE 分帧。

## 结构

```
src/
├── index.ts          # 插件入口：Config schema + review_pull_request 工具（含 since 增量）+ 5 个只读检索工具
├── orchestrator.ts   # 流水线：采集(→增量) → 快照 → cross-change → 规划(规则→灰区LLM) → 并行审查(熔断/超时) → 裁决(→execver) → 抑制 → 聚合 → 判决书 → 发布
├── planner.ts        # Risk Profiler + Hybrid Router + ReviewPlan（预算/校准/灰区/validatePlan）
├── hybrid-planner.ts # 灰区 LLM 规划员：enum 白名单 + 规则预算 + validatePlan 防弹
├── roles.ts          # 角色注册表 + 路由（pro/flash 档 + verifier/planner 路由）
├── verify.ts         # checklist 四态裁决（分批 + plausible 升级复核）
├── evidence.ts       # Evidence Pack 类型、发布门槛（proofLevel/artifact）与渲染
├── evidence-tools.ts # tarball 快照（symlink 跳过）+ EvidenceStore 检索原语 + 不可信规则包裹
├── execver.ts        # 可执行验证：base/head 差分 tsc，executed 证明构造
├── crosschange.ts    # 跨文件静态断链检测（removed/renamed 仍被 import）
├── feedback.ts       # 透明反馈抑制表（glob+类别，报告标注）
├── resilience.ts     # Provider 熔断（连续失败跳闸→跨厂商降级）+ 单次重试
├── context.ts        # 仓库上下文：变更文件全量拉取（预算截断）
├── usage.ts          # 从子 agent 会话日志提取 token 用量
├── schema.ts         # Finding 类型 + 结构化 schema + 去重聚合
└── github.ts         # PR 拉取 + 预算截断 + compare 增量 + hunk 解析 + 行内发布 + 不可信包裹
```

## Roadmap

- P1：✅ 多角色并行审查、验证裁决、聚合去重、GitHub 评论发布、配置化
- P2：✅ dsh bundle 打包 + GitHub Action 模板、成本感知路由 + token 账单、行内评论代码、Martian 20 PR 开发基线（P 26.0% / R 39.7%）
- P3：✅ 自适应路由（规则 + 灰区混合规划 + 预算治理 + 仓库校准）、Repository Evidence Pack（快照检索 + 跨文件断链）、可执行验证（差分 tsc / executed 证明）、安全边界（不可信分区 + 透明抑制 + 对抗测试）、增量重审、熔断降级｜待办：行内评论真机验证
- P4（待做）：**M5 终测窗口**——20 PR 终版全配置 vs 冻结基线对比 + held-out 30 PR 一次性验证（预估 ¥50-85）；之后 GitHub App 模式、脱敏导出、推广
