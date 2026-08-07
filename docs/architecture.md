# InkOS Episode v2 架构

## 目标

InkOS 面向 100 集、单集约 90 秒的中文竖屏漫剧。系统保留原有多阶段治理、状态管理、原子持久化和多入口能力，但不再把小说章节作为创作真源。

创作目标是：新颖设定、熟悉爽点、高压关系、因果反转和情绪钩子同时成立，并最终完整收束全剧。

## 生产层级

```text
全剧总纲
→ 10 个故事篇章
→ 当前篇章计划
→ 单集计划
→ EpisodeScript
→ 审计与修订
→ 状态交接
```

Planner 只规划当前集，不擅自重写全剧总纲。Writer 只输出结构化 `EpisodeScript`。如果结构化解析失败，系统先执行本地 JSON 清洗，必要时最多进行一次带错误反馈的修复调用；仍失败则停止当前集。

## EpisodeScript

剧本顶层包含：

- 集数、标题和估算时长。
- 开场钩子、反转、情绪钩子和结尾状态。
- 单集 `contract`。
- 1～3 个场景和 6～12 个镜头。

镜头保存景别、机位、时长、可视画面、动作、对白、旁白、声音和转场。心理活动必须转化为可制作的表演或旁白。

## 单集合同

`contract` 是 Writer 和 Auditor 的共同依据：

- `incomingState`：进入本集时的知识、权力、关系、身体和进行中行动。
- `objective`：人物要改变什么以及为什么必须现在行动。
- `opposition`：阻力的目标和筹码。
- `causalEscalation`：`becauseOf → choice → countermove → stateChange → nextPressure`。
- `localDramaticResult`：本集明确给出的结果、状态变化和代价。
- `outgoingPressure`：由本集结果启动的下一股压力。
- `handoffState`：下一集必须继承的最小状态。
- `informationPermissions`：观众和人物分别知道、怀疑、误解和不知道什么。

反转、局部兑现、情绪钩子和出去压力不能互相替代。

## 上下文生命周期

Pipeline 在一次剧集操作开始时只加载一个 `EpisodeContextSnapshot`。同一对象引用贯穿 Planner、Composer、Writer、Auditor、Reviser 和修订后的最终审计。

Composer 将 `ContextPackage` 与 `RuleStack` 挂载到原 snapshot 并更新哈希，不创建第二份上下文对象。Writer 只读取稳定总纲、当前篇章、当前状态、相关 Hook、最近摘要和当前集 memo，不读取完整历史正文。

## 确定性结算

结构化剧本通过门禁后，`deriveEpisodeRuntimeDelta` 从合同、镜头、信息权限和 Hook ledger 推导状态变化。Episode-native reducer 使用 `episode`、`lastAppliedEpisode`、`startEpisode` 和 `episodeSummaries` 等字段运行。

旧 `chapter` 字段仅保留在单一持久化适配边界，用于读取当前 schema v2 的历史字段名。它们不参与 Episode reducer 核心算法。

## 审计分级

- `structural_invariant`：schema、引用、ID、时长算术和直接状态矛盾，可阻断。
- `reviewed_invariant`：因果、兑现、关系变化和信息权限，需要证据，可阻断。
- `craft_default`：晚进早出、动作经济和反应落点，只产生建议。
- `taste_option`：钩子类型、旁白、沉默、视角和节奏，不阻断。

审计报告保存完整描述、建议、证据定位、责任方和源文件哈希。源文件变化后旧 finding 标记为 `stale`。

## 恢复与持久化

每集保存 JSON、Markdown、索引、结构化状态、摘要、Hook、审计证据、性能报告和 handoff capsule。多文件事务先写 staging，校验后提交；失败时恢复受影响文件。

handoff capsule 保存剧本哈希和最小交接状态。恢复时 hash 不一致会丢弃旧胶囊并从 Episode JSON 重新推导。

## 完本门禁

最终集必须解决主线冲突、主角核心欲望、主要人物弧线、关键 plot hook、关键 emotion hook 和核心关系冲突。存在核心未解决项时，`series complete` 拒绝将项目标记为 `completed`。
