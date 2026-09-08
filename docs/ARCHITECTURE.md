# 獬豸架构

> 面向评审者的一页式架构说明：流水线、模块职责、关键设计决策与取舍。
> 配置项与用法见 [README](../README.md)，评测方法论见 [eval/README](../eval/README.md)。

## 流水线

```
PR 事件（owner/repo#N，可选 since=上次审查的 commit）
  │
  ▼ 采集与预算
  PR meta + files（60 文件/单文件 8KB/总 60KB 预算，锁文件过滤）
  since 存在 → compare diff-of-diff（增量模式，失败回退全量）
  PR title/body → <untrusted-data> 包裹
  │
  ▼ 快照与静态分析（evidence 开启时）
  head[/base] tarball → 系统 tar 解包（symlink 排除，120MB/180s 预算）
  ├─ 跨文件断链：removed/renamed 路径仍被 import → cross-file-break 信号
  └─ 仓库规则（AGENTS.md 等）→ 不可信包裹备用
  │
  ▼ 审查规划（adaptive 开启时）
  Risk Profiler：8 类确定性信号 → 加权评分 → low/medium/high
  ├─ 规则路由：docs-only→nitpicker｜low→bug-hunter(flash,light)｜
  │   medium→2 针对性角色(安全底线:敏感/依赖/CI→security 强制)｜high→全队(pro,strict)
  ├─ 灰区(score 4-6)且 hybridPlanner：一次 flash 结构化规划（enum 白名单 +
  │   规则推导预算 + validatePlan 修复 + 置信度闸，失败回退规则计划）
  └─ 非法计划/关闭开关 → 固定三角色（fallbackReason 落报告）
  │
  ▼ 并行审查（熔断 + 角色超时）
  1-3 个零工具子 agent，outputSchema 强制结构化 findings
  provider 连续失败≥3 → 跳闸降级跨厂商 fallback；单角色失败一次降级重试
  │
  ▼ 裁决（verifier 开启时）
  checklist 四态：confirmed/plausible/inconclusive/rejected
  发布门槛：confirmed + 四项清单全过 + 同文件 ±3 行 diff 实锤锚定
  verifier 可用 5 个只读检索工具（read/search/references/tests/history，≤12 次/批）
  ├─ plausible 升级复核：light 路径 critical/major → 4/批严格复核（预算内）
  └─ execver：base/head 差分 tsc，新编译错误命中 → executed 证明（环境失败不改判）
  │
  ▼ 发布边界
  透明抑制表（glob+类别，报告标注）→ 去重聚合（同文件行窗口合并）
  → 判决书（findings + Evidence Pack + Review Plan + 成本表 + Evidence 轨迹）
  → 可选 PR 评论（行内锚定；GITHUB_TOKEN 只在本进程读取，不进任何子 agent）
```

## 信任模型

攻击面假设（GitInject/SEVRA-BENCH）：PR 标题、描述、commit message、代码注释、仓库规则文件、工具输出均可能是攻击者控制的自然语言。

| 边界 | 机制 |
|---|---|
| PR 文本 → 提示词 | `<untrusted-data>` 包裹，闭合标签零宽中和，4k 截断 |
| 仓库规则/跨文件分析 → 提示词 | 同上（`<repository-rules>` / `<cross-change-analysis>`） |
| LLM 规划员输出 → 执行计划 | schema enum 白名单 + 预算由规则推导 + validatePlan 修复闸 |
| 审查员 | 零工具（toolFilter allow:[]），结构性 incapable |
| 验证员 | 5 个只读工具，safePath 防逃逸，vendored 目录排除 |
| 执行器 | 固定 argv 的 tsc，无网络、无凭据、不写回 |
| 发布权 | GITHUB_TOKEN 仅主进程发布环节；子 agent 无凭据无发布权 |

## 关键设计决策

| 决策 | 依据 |
|---|---|
| 工具只给 verifier 不给 reviewer | A/B 实测（express#7377, glm-5.3）：全量文件注入 reviewer → 候选 3→0（注意力稀释）；证据核验受益、代价小 |
| 全部增强默认关闭（adaptive/evidence/execver/hybridPlanner） | 无付费基准实证的功能不默认上线；`repoContext` A/B 后默认 off 的同一证据文化 |
| 增强层永不构成单点故障 | 快照失败→diff-only；planner 失败→规则计划；execver 环境失败→不改判；LLM 升级→执行器优先，LLM 兜底 |
| 差分对消（base/head tsc diff） | 免安装依赖：缺 node_modules 的报错两侧一致自动抵消，零网络零供应链风险 |
| 阈值标定走零成本重放 | plan-only（仅 GitHub API）产出分布/灰区/中位数；拍脑袋阈值 → 实证阈值 |
| dev/held-out 分离 | 20 PR 开发集（迭代用）+ 30 PR held-out（终测一次，防过拟合指控） |
| 抑制表透明可审计 | 每条规则抑制数量落报告；无隐藏学习（对"AI 审查不可控"质疑的直接回答） |

## 已知限制（如实）

- 灰区 LLM 规划员未做真机冒烟（spawn 路径与 verifier 同构，风险低）；plan-only 校准对比数字待限流窗口补录
- execver v1 仅 TypeScript tsc：测试运行依赖 node_modules，离线不可建立（诚实降范围）；语义型缺陷（类型检查通过）不触发 executed 升级
- find_references 是朴素全词匹配（AST 级精确化未做）
- 所有新架构未经付费基准验证（M5 待做），README 数字均为冻结基线（全 flash 三角色）
