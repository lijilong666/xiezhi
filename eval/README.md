# 评测（Martian Code Review Bench 离线集）

对齐 [withmartian/code-review-benchmark](https://github.com/withmartian/code-review-benchmark)（MIT）的离线评测：
50 个真实 PR（Sentry/Grafana/Cal.com/Discourse/Keycloak 各 10 个），人工核实的 golden comments 作为真值。

## 方法论

1. **批跑**：`driver.mjs` 逐个用 headless profile 审查 PR，保存每份报告到独立结果目录（断点续跑）
2. **解析**：报告的 `### [severity] title — file:line` 结构解析为 findings
3. **裁判**：LLM-as-judge 逐对判定"是否同一底层问题"（沿用 Martian 的判定语义：措辞可不同，实质须相同），贪心 1:1 匹配
4. **指标**：precision = 匹配数/我方发现数，recall = 匹配数/golden 数，分仓库 + 总表

对比基线（Martian 官方仪表盘已有同数据集数字）：CodeRabbit、GitHub Copilot、Cursor Bugbot、Claude Code、Codex、Greptile 等 12+ 工具。

## 用法（harness 仓库根目录）

```sh
node xiezhi/eval/driver.mjs --sample 1   # 试点：每仓库第 1 个 PR
node xiezhi/eval/driver.mjs              # 全量 50 个（断点续跑）
node xiezhi/eval/driver.mjs --sample 4 --results-dir xiezhi/eval/results/my-experiment
node xiezhi/eval/judge.mjs --dry         # 只解析不判分
node xiezhi/eval/judge.mjs               # 判分 + 指标表（需 DEEPSEEK_API_KEY）
node xiezhi/eval/judge.mjs --results-dir xiezhi/eval/results/my-experiment --output xiezhi/eval/results/my-experiment/judge.json
```

Driver 在 `results/manifest.json` 逐 PR 记录起始时间、时长、状态（ok/failed/no-report）、发现数与 golden 数（崩溃安全，逐条落盘），批跑结束打印 ok/failed 统计与成功运行的 P50/P95/max 时延——即 Phase 0 要求的延迟与失败率指标来源。

`--results-dir` 为每个实验隔离报告和 manifest，避免覆盖基线；Driver 和 Judge 必须指向同一目录。Judge 的 `--output` 会保存逐 PR 计数、汇总指标与裁判配置。结果目录默认被 Git 忽略，公开基线只提交去除模型原文后的 manifest 和汇总文件。

## 固定开发基线（2026-08-30）

- 样本：[`baseline-20.json`](./baseline-20.json)，每仓库按原始顺序取前 4 个 PR，无人工挑选
- 配置：3 个审查角色和 Verifier 均使用 `deepseek-official/deepseek-v4-flash`，`repoContext: off`
- 批跑：20/20 成功，0 失败、0 空报告；P50 8.6 min，P95 14.3 min，最长 16.0 min
- 判分：104 findings / 68 golden / 27 matched，Precision 26.0%，Recall 39.7%
- 证据：[`baseline-20-manifest.json`](./baseline-20-manifest.json) 与 [`baseline-20-results.json`](./baseline-20-results.json)
- 隔离：剩余 30 PR 为 held-out；迭代和消融不得使用

## 零成本审计（plan-only 重放）

```sh
node --import tsx/esm xiezhi/eval/plan-only.mjs
```

不打模型 API：对 baseline-20 逐 PR 跑 Risk Profiler + Hybrid Router，输出分级分布、灰区占比（score 4-6，LLM 规划员适用范围）与分仓库中位数（可填 `repoCalibrations`）。首次实测：low 6 / medium 9 / high 5，灰区 6/20=30%。本地缓存 `.cache-plan-only.json` 断点续跑（GitHub 无 token 限流 60/h）；缓存为空时拒绝覆写分布文件。

## 待做：M5 终测窗口（开发冻结后一次性执行）

- 20 PR 终版全配置（adaptive + evidence + execver + 安全层）vs 2026-08-30 冻结基线 → 架构演进净效果
- held-out 30 PR 一次性验证（`baseline-20.json` 已声明约定，跑完锁版）
- 预估 ¥50-85（新配置单 PR ¥1-2：双快照 + tsc + 工具循环）；执行前需单独批准

## 已知口径差异

- golden 真值来自各工具+人工的综合标注，`az_comment` 等噪音字段未计入真值
- 我们的预算截断（60 文件/60KB patch）在超大 PR 上可能漏审部分文件，计入 recall 损失（与商业工具同条件竞争）
- 裁判模型为 deepseek-chat（Martian 用 Claude/GPT 系）；裁判模型差异是 LLM-as-judge 的固有噪声源
