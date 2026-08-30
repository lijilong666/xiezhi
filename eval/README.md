# 评测（Martian Code Review Bench 离线集）

对齐 [withmartian/code-review-benchmark](https://github.com/withmartian/code-review-benchmark)（MIT）的离线评测：
50 个真实 PR（Sentry/Grafana/Cal.com/Discourse/Keycloak 各 10 个），人工核实的 golden comments 作为真值。

## 方法论

1. **批跑**：`driver.mjs` 逐个用 headless profile 审查全部 50 个 PR，保存每份报告到 `results/`（断点续跑）
2. **解析**：报告的 `### [severity] title — file:line` 结构解析为 findings
3. **裁判**：LLM-as-judge 逐对判定"是否同一底层问题"（沿用 Martian 的判定语义：措辞可不同，实质须相同），贪心 1:1 匹配
4. **指标**：precision = 匹配数/我方发现数，recall = 匹配数/golden 数，分仓库 + 总表

对比基线（Martian 官方仪表盘已有同数据集数字）：CodeRabbit、GitHub Copilot、Cursor Bugbot、Claude Code、Codex、Greptile 等 12+ 工具。

## 用法（harness 仓库根目录）

```sh
node xiezhi/eval/driver.mjs --sample 1   # 试点：每仓库第 1 个 PR
node xiezhi/eval/driver.mjs              # 全量 50 个（断点续跑）
node xiezhi/eval/judge.mjs --dry         # 只解析不判分
node xiezhi/eval/judge.mjs               # 判分 + 指标表（需 DEEPSEEK_API_KEY）
```

Driver 在 `results/manifest.json` 逐 PR 记录起始时间、时长、状态（ok/failed/no-report）、发现数与 golden 数（崩溃安全，逐条落盘），批跑结束打印 ok/failed 统计与成功运行的 P50/P95/max 时延——即 Phase 0 要求的延迟与失败率指标来源。

## 消融实验（Roadmap）

同一 harness 换配置重跑即可：`verifier: false`（验证层消融）、单角色（多角色消融）、全 flash（模型档位消融）。

## 已知口径差异

- golden 真值来自各工具+人工的综合标注，`az_comment` 等噪音字段未计入真值
- 我们的预算截断（60 文件/60KB patch）在超大 PR 上可能漏审部分文件，计入 recall 损失（与商业工具同条件竞争）
- 裁判模型为 deepseek-chat（Martian 用 Claude/GPT 系）；裁判模型差异是 LLM-as-judge 的固有噪声源
