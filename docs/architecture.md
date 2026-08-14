# InkOS Episode v2 架构

## 系统目标

InkOS 面向长篇竖屏漫剧的文本生产。系统以 Episode 为业务单位，以结构化剧本、可验证状态和可恢复事务保证长线连续性，不把小说章节或自由文本文件当作隐式真源。

核心原则：

- Episode JSON 是剧本唯一权威。
- Core 拥有领域规则、锁、事务、状态转换和恢复逻辑。
- CLI、Studio、TUI 和 Agent 只负责输入适配与结果展示。
- 派生文件可以重建，不能反向覆盖权威数据。
- 审查、批准、交付和完本必须基于同一份当前正文证据。

## 包边界

```text
packages/core
  models        结构化合同与 schema
  agents        Planner / Writer / Auditor / Reviser 等模型边界
  pipeline      建书、写集、审计、修订、同步与调度
  state         索引、结构化状态、锁、事务与快照
  interaction   类型化交互 action 与共享 mutation
  llm           Provider、模型路由与遥测

packages/cli     命令、TUI、daemon
packages/studio  本地 API、SSE 生命周期和 React 工作台
```

接口包不得复制 Core 的状态判断、回滚顺序或文件写入协议。自由文本请求必须先在中央交互边界转为类型化 action，再调用 Core application use case。

## 权威数据

| 数据 | 权威位置 | 派生或投影 |
| --- | --- | --- |
| 剧本 | `episodes/NNNN_Title.json` | 同名 Markdown、导出文件、台词表 |
| 剧集状态 | `episodes/index.json` | Studio/CLI 状态展示 |
| 连续性真相 | `story/state/*.json` | `current_state.md`、摘要与诊断视图 |
| 设定事实 | `story/canon/*.json` | 人工可读设定说明、运行时索引 |
| 审查证据 | `episodes/NNNN_review.json` | UI 审查摘要 |
| 操作上下文 | `story/runtime/` | 可丢弃并重建的计划、trace、性能与诊断 |
| 回滚基线 | `story/snapshots/<episode>/` | 无 |

Markdown 不是备用真源。缺失或非法 Episode JSON 时，审计、修订、审批和导出必须失败，而不是回退到 Markdown 猜测。

## 单集流水线

```text
加载一个 EpisodeContextSnapshot
→ Planner 生成单集意图
→ Composer 组装 ContextPackage / RuleStack / trace
→ Writer 生成 EpisodeScript
→ 确定性门禁
→ Auditor 产生证据
→ 必要时 Reviser 修订并重新审查
→ reducer 推导状态、Hook、摘要与 Canon 演化
→ 事务化持久化正文、索引、真相、快照和 sidecar
```

同一次操作只使用一个上下文快照。Writer 不读取完整历史正文，只读取稳定总纲、当前卷计划、当前状态、相关 Hook、最近摘要和当前集 memo。

## EpisodeScript 与合同

EpisodeScript 包含集数、标题、估算时长、开场钩子、反转、情绪钩子、结尾状态、1～3 个场景和结构化单集合同。

合同字段：

- `incomingState`：进入本集时的知识、权力、关系、身体和进行中行动。
- `objective`：人物要改变什么，以及为什么必须现在行动。
- `opposition`：阻力的目标与筹码。
- `causalEscalation`：`becauseOf → choice → countermove → stateChange → nextPressure`。
- `localDramaticResult`：本集结果、状态变化和代价。
- `outgoingPressure`：由本集结果启动的下一股压力。
- `handoffState`：下一集必须继承的最小状态。
- `informationPermissions`：观众和人物分别知道、怀疑、误解和不知道什么。

反转、局部兑现、情绪钩子和出去压力不能互相替代。镜头必须提供可制作的视觉、动作或声音载体。

## 审查状态机

```text
自动模式：写作 → 审查/修订 → ready-for-review → approved → published
手动模式：写作 → drafted → 显式审查 → ready-for-review → approved → published

失败分支：audit-failed / state-degraded / rejected
```

| 状态 | 持久化语义 | 后续规则 |
| --- | --- | --- |
| `drafted` | 只保存 JSON/Markdown，不推进真相、快照或 Canon | 必须先审计 |
| `ready-for-review` | 审查通过，真相、快照与 Canon 已提交 | 手动模式必须先批准；自动模式可继续生产 |
| `audit-failed` | 正文存在阻断问题，或人工编辑后证据已失效 | 修订、重写或重审 |
| `state-degraded` | 正文已保存，但状态提交不完整 | 修复状态或重写 |
| `approved` / `published` | 可交付 | 可继续生产与默认导出 |
| `rejected` | 当前集不被接受 | 回滚依赖状态并重写或移除 |

批准要求：

- 剧集状态是 `ready-for-review`。
- Episode JSON 能通过当前 schema。
- 审查 sidecar 状态为 `PROVISIONAL`。
- sidecar 中的正文哈希与当前 JSON 完全一致。

`approve-all` 只处理满足以上条件的 `ready-for-review`，不会覆盖 `audit-failed`。

## 审计与修订

审计问题按规则类别分层：

- `structural_invariant`：schema、ID、时长算术、直接状态矛盾等硬约束。
- `reviewed_invariant`：因果、兑现、关系变化、信息权限和 Hook 证据。
- `craft_default`：动作经济、节奏、反应落点等工艺建议。
- `taste_option`：视角、旁白、沉默和钩子类型等风格选择。

Critical 或硬性长度问题可以触发自动修订；warning-only 结果保留证据，不自动扩大为整集重写。Reviser 只处理自己负责的 finding，上游 Planner/Canon 问题会写入反馈文件，交由下一次规划修正。

结构化 screenplay 不运行面向小说散文的段落、人称和句式阻断规则，但仍检查镜头表面的 AI 味与跨集重复，以及 schema、时长、合同、Canon、Hook/memo 和角色引用。

## 变更事务

剧集替换、局部补丁、实体重命名、审批、拒绝、重写、审计和状态同步都必须持有书锁，并通过 Core mutation 执行。

人工剧集编辑的事务边界包括：

- 权威 JSON 与 Markdown 投影。
- `episodes/index.json`。
- 对应 runtime、review 和其他派生 sidecar。

提交成功后，旧派生物被失效，剧集标记为需要重新审查；任一步骤失败时恢复正文、索引和 sidecar。较早剧集被拒绝或重写时，后续依赖集不能被当作仍然有效。

## 状态、Hook 与 Canon

`deriveEpisodeRuntimeDelta` 从合同、镜头、信息权限和 Hook ledger 推导结构化变化。Reducer 使用 Episode 语义字段；旧 `chapter` 名称只允许存在于明确的兼容适配边界。

Canon 分为人工可读来源和机器可校验结构：

- `story/outline/`、`story/roles/` 和规则文件提供创作来源。
- `story/canon/*.json` 保存 claims、世界系统、资产注册表和未认领事实。
- 只有审查通过且状态结算成功的剧集才能演化 Canon。
- 状态快照同时包含 Canon；拒绝、重写和最新集修订按快照恢复。
- 未认领事实达到阈值时，规划和写作以 `CANON_REFRESH_REQUIRED` 暂停，要求显式执行 `inkos canon refresh`。

Hook 保存开始集、计划回收集、铺设/推进/终局证据和当前状态。提前回收只依据完整、可见的终局证据，不从人名或自由文本备注猜测。

## 恢复与交付

流水线多文件事务使用 staging 与恢复标记；交互式编辑使用原子文件替换和备份。启动新操作前会恢复未完成事务，并检查最新集是否处于阻断态。

`write sync` 从权威 JSON 重建 Markdown 与运行真相；`write repair-state` 修复已持久化正文对应的状态派生物。两者都不能把非法 JSON 静默修成可交付内容。

默认导出与 `series complete` 只接受全部剧集处于 `approved/published`。`--approved-only` 是显式的部分交付选择，不改变剧集状态。

最终集还必须解决主线冲突、主角核心欲望、主要人物弧线、关键 Hook 和核心关系冲突，才可将项目标记为完成。
