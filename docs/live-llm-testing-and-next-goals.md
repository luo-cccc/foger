# InkOS 真实 LLM 测试方法与阶段记录

> 文档状态：真实 provider 测试方法与阶段记录。本文保留 2026-07-09 至 2026-07-16 的实验与收敛记录；当前全项目优先级以[当前架构与开发优先级](current-architecture-and-priorities.md)为准。下文旧 P0/P1 不应被理解为最新排期。

## 1. 文档目的

本文记录 InkOS 在真实上游 LLM、双 API 路由和多章连载场景下的测试逻辑。它补充 `pnpm test` 这类确定性回归测试无法覆盖的风险：模型格式漂移、状态结算丢失、跨供应商路由错误、真实 API 长耗时、长度治理失效和前后端调用路径差异。

本文面向开发者，不记录任何 API Key。真实测试时密钥只能来自环境变量或临时 `.inkos/secrets.json`，测试结束必须删除并扫描报告目录。

## 2. 当前结论

截至 2026-07-16，项目本地逻辑、持久化、确定性测试和前后端联动合同已经较稳；真实证据包括历史 DeepSeek 15 章样本，以及修复后 Ark Plan 的新隔离项目 8 章终态：

- DeepSeek 官方 `deepseek-v4-flash` 20 章 linked acceptance 实际持久化第 1-15 章，全部为 `ready-for-review` 且 Doctor 通过；索引、manifest、current state 和 `0..15` 快照一致。
- 运行时 JSONL 共记录 310 次 LLM 调用，310 次 success、0 retry、`3,848,794` tokens，最大估算 prompt `23,402`。这证明 provider 连接不是本轮阻断点；token 仅作为资源画像，不再阻断当前功能验收。
- 第 16 章只存在于报告中间态，没有进入章节索引。进程被外部终止后报告顶层仍标记 `running`，因此真实测试终态必须以章节索引、结构化 truth、快照和运行时 JSONL 交叉判定，不能只读报告顶层累计值。
- 根因是第 15 章 resync analyzer 把标准伏笔 ID 写成 `H027 (标题)` 等复合值；第 16 章 Planner 使用规范 ID `H027` 时被 ledger 校验拒绝。当前已在 resync 校验/落盘前规范化 Markdown 第一列，并修复已有结构化状态的 canonical ID 与重复冲突。
- 浏览器请求、Studio API/SSE、Core operation、LLM telemetry、章节落盘和 Doctor 筛选继续由 `pnpm test:linked` 统一验收；stub E2E、章节/工作流事务、跨进程锁和真实强杀恢复仍是确定性基础门禁。
- Ark Plan `deepseek-v4-pro` 新隔离 20 章 linked acceptance 在第 8 章可靠失败：第 1-7 章均为 `ready-for-review` 且 Doctor 通过；第 8 章先 `state-degraded`，随后 `repair-state -> resync -> revise -> rewrite -> repair-state` 仍为 `audit-failed`，因此连续写作门禁没有启动第 9 章。最终报告为 `failed`，共 `2,110,778` tokens，运行 2 小时 48 分钟。
- 当前下一步是针对“rewrite 后仍为 `audit-failed`”建立确定性复现与恢复收敛修复，再从全新隔离项目重跑 20 章；不能把第 7 章或第 8 章样本表述为 20 章通过。

## 3. 测试分层

### 3.1 确定性回归

每次涉及主链路、模型路由或状态写入变更后，必须至少运行：

```powershell
pnpm typecheck
pnpm test
```

必要时增加定向测试：

```powershell
pnpm --filter @actalk/inkos-core test -- model-override-routing
pnpm --filter @actalk/inkos-core test -- writer
```

这些测试验证 schema、parser、runner 接线、状态 reducer、CLI/Studio 基础行为，但不能证明真实模型输出稳定。

### 3.2 真实 API Smoke

真实 API smoke 只验证服务连通、协议、模型名、鉴权和非流式返回是否正常。它不是创作质量测试。

当前 OpenRouter-only 基线的最低要求：

- OpenRouter `deepseek/deepseek-v4-flash` 返回短句确认。
- 记录 `service`、`model`、`apiFormat`、`stream`、usage。
- 不把密钥写入报告。

只有显式选择 `minimax-writer` 或 `minimax-governance` 路由模式时，才额外要求 MiniMax `MiniMax-M3` smoke；OpenRouter-only 测试不应因为缺少 MiniMax Key 而失败。

### 3.3 路由探针

真实多模型测试前必须探测 agent 到模型的实际映射，不能只看配置文件。

默认 `openrouter-only` 模式必须检查：

- `writer`、`reviser`、`length-normalizer` 是否路由到 OpenRouter DeepSeek Flash。
- `settler`、`planner`、`composer`、`state-validator`、`canon-extractor` 是否路由到同一个已配置 OpenRouter 模型。
- 只有显式选择 MiniMax 路由模式时，才按该模式核对 writer 或 governance agent 的 MiniMax 映射。

原因：`modelOverrides` 的错误服务名、错误 `apiFormat`、缓存 key 不完整都会造成“看似配置成功，实际调用错上游”。

### 3.4 多章连载实测

真实连载测试分层执行，不能用单章 smoke 替代长跑：

- 单章只验证 provider、建书和完整写章合同。
- 3-5 章用于快速定位状态或治理回归。
- 当前发布候选验收为全新隔离项目连续写 20 章，目标字数可用 1000 字控制运行时长。
- 每次使用真实 API 创建新书，不复用被手工修过的历史状态。
- 每章后增量写报告，避免长调用超时后丢失证据。
- 每章后检查章节索引、状态文件、结构化 JSON 和快照。

当前测试脚本：

```powershell
node scripts/live-dual-api-routing.mjs
```

推荐以环境变量传入密钥：

```powershell
$env:OPENROUTER_API_KEY="..."
$env:MINIMAX_API_KEY="..."
node scripts/live-dual-api-routing.mjs --chapters 5 --words 1000 --route-mode minimax-writer
```

脚本默认使用 `--review-mode manual`：写完章节后停在前端人工审核点，长度超出 hard range 或轻微审计问题会进入报告，不会静默推进。需要验证自动审计、修订和长度归一化时显式使用 `--review-mode auto`。

report v2 还支持以下门禁与恢复参数：

- `--recovery-mode none|repair|resync|repair-then-resync`
- `--max-retry-rate 0.2`
- `--max-timeout-rate 0`
- `--max-fallbacks 0`
- `--min-hard-range-rate 0.8`

任一门禁失败时，报告仍会完整写入，但进程退出码为非零，供外部任务判定失败。

测试结束后先清除进程级密钥，再使用仓库统一清理入口删除临时项目、原始报告和缓存：

```powershell
Remove-Item Env:\OPENROUTER_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:\MINIMAX_API_KEY -ErrorAction SilentlyContinue
pnpm clean
```

### 3.5 状态健康检查

真实连载测试的通过标准不是“章节文件生成了”，而是状态链路完整。

必须检查：

- `chapters/index.json` 章节数与实际章节文件一致。
- `story/current_state.md` 存在、非空、不是建书占位或 `(状态卡未更新)`。
- `story/pending_hooks.md` 存在、非空、不是 `(伏笔池未更新)`。
- `story/chapter_summaries.md` 存在、非空，并包含已写章节摘要。
- `story/state/current_state.json` 可解析，章节号推进。
- `story/state/hooks.json` 可解析，核心 hook 未被整体清空。
- `story/snapshots/` 包含 `0..N` 快照。
- pipeline 日志中无 `state-degraded`；如果有，必须停止连写并定位。

## 4. 本轮真实测试记录

测试时间：2026-07-09 至 2026-07-10。

测试上游：

- OpenRouter：`deepseek/deepseek-v4-flash`，OpenAI-compatible Chat，非流式。
- MiniMax：`MiniMax-M3`，官方 OpenAI-compatible Chat，非流式。

关键过程：

- 第一轮把结构治理 agent 大量切给 MiniMax，建书和第 1 章可运行，但第 2 章 writer 阶段长耗时超出窗口；同时暴露基础设定/执行目标的人称不一致。
- 第二轮把 `writer` 切给 MiniMax，但状态结算仍跟随 writer，MiniMax 正文可用，状态 delta 为空，触发 `state-degraded`。
- 随后将 `writer` 和 `settler` 拆分为可独立路由。第三轮 `writer -> MiniMax-M3`、`settler -> OpenRouter DeepSeek Flash`，连载完成 4 章，状态链路完整。

第三轮健康结果：

- `chapters/index.json`：4 章。
- `story/current_state.md`：非空，当前章节推进到 4。
- `story/pending_hooks.md`：非空，hook 表仍存在。
- `story/chapter_summaries.md`：非空，包含 1-4 章摘要。
- `story/state/current_state.json`：可解析。
- `story/state/hooks.json`：可解析。
- `story/snapshots/`：包含 `0`、`1`、`2`、`3`、`4`。

仍暴露的问题：

- MiniMax-M3 正文字数倾向偏长，1000 字目标下多章超过硬区间。
- OpenRouter DeepSeek Flash 的 planner memo 偶发缺 section 或空 section，需要 retry。
- Canon 抽取偶发 schema 不合规，会走 heuristic fallback。
- 第 5 章开始后达到 20 分钟窗口，说明真实多章运行需要更强的调用级超时、阶段级报告和恢复机制。

### 4.1 补充：Studio 本地/Stub 验收（2026-07-10）

作为与真实 API 多章连载互补的本地验收，Studio 现已具备一条稳定、可回归的“真实后端路径但使用 stub LLM”的端到端链路：

- `smoke.spec.ts` 验证 Studio Shell 与 `/api/v1/books` 基本可用。
- `authoring.spec.ts` 现在走真实建书接口，而不是预种子 `e2e-seeded-book`：先调用 `/api/v1/books/create`，轮询 `/create-status`，再进入工作台写第 1 章、打开 truth files、验证 runtime diagnostic。
- `llm-stub` 已按现网 agent 合同返回 architect foundation 与 foundation review 文本，因此 stub 模式也能覆盖“创建书籍 -> 完成 foundation -> 开始写作”的完整链路。

这意味着：Studio 的下一步前端 E2E 不应再停留在“是否能跑通建书”，而应继续向“真实服务配置、错误诊断与长耗时反馈”推进。

### 4.2 Studio + OpenRouter DeepSeek V4 Pro 复测（2026-07-12）

测试入口：Studio 书籍设置页真实按钮，前端请求进入本地 Hono API，再进入 Core Pipeline。测试使用已有配置，不读取或记录 API Key。

测试模型：

- service：`openrouter`
- model：`deepseek/deepseek-v4-pro`
- telemetry 中 Planner、Writer、Length Normalizer、Continuity Auditor、Reviser、Chapter Analyzer、State Validator 均使用该模型。
- 未观察到 `openrouter/auto` 回退。

最终测试书状态：

- 章节数：3。
- 第 3 章：《塔内的第两百一十八秒》，3014 字，`ready-for-review`。
- `manifest.lastAppliedChapter = 3`。
- `current_state.chapter = 3`。
- 快照：`0..3` 完整。
- 章节摘要：3 条。
- 活动 hook：14 条，H001-H012 完整，无本轮重复 `information-*` hook。

真实流程暴露并已局部修复的问题：

1. Hook ledger 解析器曾把 ID 截成最多 20 个字符；已取消该限制并增加长中文 ID 回归。
2. Planner 首次输出会删去长 ID 中的连字符；合法 ID 重试后第二次通过。说明重试有效，但长描述型 ID 仍不适合作为协议主键。
3. 中断写作留下的 fallback plan 会被下一次写作复用；已让持久化 fallback memo 在新操作中强制重新规划。
4. Writer 原始约 5115 字，长度治理压到约 3355 字，修订后为 3014 字，证明严格二次压缩可进入软区间。
5. Claim gate 曾把“无需维护”“无需人工复核”与全文世界规则拼接为 critical；已改为局部高置信度绕过证据。
6. 长 hook ID 后直接接箭头时，正文落点校验没有提取动作关键词；已增加箭头后动作文本回退。
7. 已有 hook 类型“信息”与新候选 `information` 被当成不同家族，创建两条重复 hook；已增加常见中英文类型族归一化并清理测试状态。

本轮后续已关闭的问题：

- 完整写作循环与独立“审计”按钮已复用统一 gate 合同，Core 回归已覆盖同文一致性。
- Settler 在 repair/resync 连续遗漏 state/hook 后会转入 Chapter Analyzer 确定性重建；仍不完整时恢复原状态并返回单一错误。
- 书籍详情页已增加统一取消入口，重写/同步等六类参数改用可测试对话框；真实 OpenRouter 浏览器取消和隔离状态机 E2E 已通过。

仍未关闭的问题：

- 第 3 章完整流程约消耗 17.7 万 token，单章成本和耗时偏高。
- 确定性测试仍不能替代真实输出 corpus；下一步需要把 service/model、重试、fallback、repair/resync 和长度偏差写入 3-5 章 live report。

本轮结论：事务、快照和状态校验保护有效，错误没有静默推进到第 4 章；下一阶段重点应从“增加更多重试”转为“统一合同、稳定身份、确定性重建和降低单章成本”。

### 4.3 Studio 取消、恢复与修复路径复测（2026-07-12）

- 真实浏览器复用已有 OpenRouter `deepseek/deepseek-v4-pro` 配置，在 3 章测试书上从同步对话框启动 resync，操作期间长任务按钮统一禁用；点击取消后显示“已保留取消前的持久化章节状态”，章节数和正文状态未推进。
- 后端为 write、draft、rewrite、repair-state、resync 返回 `202 + requestId`，同书并发长操作返回 `409 BOOK_OPERATION_ACTIVE`；取消会中止下游 AbortSignal，取消后的非协作正常返回也不会产生 complete 事件。
- 隔离 E2E 新增“对话框 -> 启动 -> 取消 -> 确认未落章 -> 再次启动 -> 写出第一章 -> 注入 state-degraded -> 前端 repair-state -> ready-for-review”状态机，完整套件为 9/9。
- 开发服务器使用严格前端端口；隔离 `4577/4579` 启动时前后端均为 200，Ctrl+C 后监听端口和子进程树均清空。

### 4.4 提示词与上下文固定语料基线（2026-07-12）

本轮只运行确定性测试和 stub/固定语料，不读取密钥、不调用真实付费模型。实现内容：

- Provider telemetry 新增 Prompt Assembly Trace，记录 message/source 的 chars、估算 tokens、fingerprint、tier、selected/compressed 状态和重复 source 组；报告可按 prompt source 聚合。
- Writer/Composer 删除 chapter memo、标题历史、情绪轨迹、摘要、hook、canon 和 current-state 的确定性重复组装。
- 上下文分为 `verbatim`、`semantic`、`compressible`，语义编译必须保留事实、ID、禁令、优先级和时序。
- Planner 只决定剧情与 memo；Writer 只执行正文；Auditor 只报告已填承诺的证据缺口，不发明剧情或重写正文。
- PipelineRunner 已缓存稳定 foundation、角色、正典和卷级上下文的编译结果；章节状态、hook 和近期摘要不进入缓存，并按书籍、模型、语言、预算和 source 指纹失效。
- `buildLLMTokenBudgetReport` 与 live script 的 `--max-total-tokens`、`--max-chapter-tokens`、`--max-prompt-tokens-per-call`、`--max-agent-tokens`、`--max-phase-tokens` 已接入。
- `prompt-optimization-gate.test.ts` 固化成本与质量门禁：Writer 三组系统提示词至少比记录基线低 15%，用户方向、章节任务、禁令、hook、章尾改变、Volume KR、长度 hard range 和输出合同必须保留。

离线测量结果：

| 固定语料 | 优化前估算 tokens | 当前估算 tokens | 变化 |
| --- | ---: | ---: | ---: |
| Writer 中文开篇 | 6422 | 4405 | -31.4% |
| Writer 中文常规章 | 5452 | 4281 | -21.5% |
| Writer 英文开篇 | 4584 | 3520 | -23.2% |

Planner 中文/英文仍为 2113/2031 估算 tokens，本轮没有为了追求数字而压缩其规划合同。以上只证明提示词体积下降、确定性重复被删除、关键合同仍在；真实 prose 质量、供应商 usage、缓存命中率和整章成本必须由下一次明确成本范围的 3-5 章运行验证。

### 4.5 项目配置真实 API 连载基线（目标 3 章，实际完成 2 章，2026-07-12）

本次测试在隔离项目 `.tmp-project-config-live` 中复制项目 `inkos.json` 和 `openrouter` service secret，实际使用 `openrouter / deepseek/deepseek-v4-pro`、Chat、stream=true；测试结束后隔离目录中的 secret 已删除，报告和日志未发现 key 泄漏。

- 建书成功，但 Foundation 经过一次重生成后才通过；3 次 Architect/Reviewer 组合请求均成功。
- `canon-extractor` 真实请求失败，耗时约 106 秒、usage 为 0；系统按合同降级并继续建书，没有阻断主链路。
- 第 1 章 `ready-for-review`：目标 1000 字，最终 1028 字，total usage 66,390 tokens。
- 第 2 章触发 Reviser 和二次 Auditor 后仍为 `audit-failed`：最终 1399 字，超过 hard max 1272；审计记录视角越界、爽点外化不足、短段重复和 hook 状态矛盾等问题，total usage 121,226 tokens。
- 第 3 章未执行：CLI 按合同拒绝在 `audit-failed` 章节之后继续写作。
- 全部 26 次真实调用中 25 次成功、1 次失败，总 usage 294,073 tokens；本次测试没有 `state-degraded` 静默推进。

本次基线确认：真实模型可以完成建书和第 1 章，但单章成本偏高，长度归一化在第 2 章未能稳定进入 hard range，审计失败会正确阻断连载。由于 CLI 每章使用独立进程，本次未形成跨命令的内存缓存命中证据；稳定上下文缓存仍需持久化或单进程连续运行后再评估收益。

### 4.6 修复后项目配置真实 API 复测（2026-07-12）

本次使用同一项目配置 `openrouter / deepseek/deepseek-v4-pro`、Chat、项目默认 `stream=true`，在新的隔离目录中执行建书和连续写作命令；隔离目录仅短期复制 `.inkos/secrets.json`，测试结束后已删除。

- 建书成功；`canon-extractor` 改为 `phase=extract` 的非流式结构化请求，状态 success，未再出现空流响应。
- 全部 12 次真实调用成功，未出现 error、partial 或 `empty response`，总 usage 为 147,185 tokens。
- 第 1 章最终 `audit-failed`，但不是长度失败：目标 1000 字，hard range 为 728-1272，`writerCount=4048`、`postWriterNormalizeCount=1222`、`finalCount=1222`，`lengthWarnings=[]`、`lengthWarning=false`。审计失败来自章纲后半段缺失、角色身份/时间线冲突等真实内容问题。
- 第 2 章命令被系统正确拒绝：`Latest chapter 1 is audit-failed`；没有绕过门禁继续写作，因此第 3 章未执行。

本次复测确认两个修复生效：结构化 canon 抽取不再依赖不稳定的流式空响应；长度 normalizer 在测试覆盖中会在两次 LLM 尝试仍超过 hard max 时做有边界的确定性收敛，真实复测中也未产生长度 warning。下一步应处理审计暴露的“章节备忘覆盖不足/角色设定冲突”问题，而不是放宽 `audit-failed` 连载门禁。

### 4.7 修复收敛与结构化传输复测（2026-07-13）

本次仍使用项目配置的 `openrouter / deepseek/deepseek-v4-pro`，复制到系统临时目录后完成建书和 1 章写作；源 `.inkos/secrets.json` 未被修改，临时目录在测试结束后删除。

- 建书和 `write next` 均返回成功；共记录 18 次成功调用，总 usage 为 138,148 tokens。
- Planner 发生 3 次解析尝试并进入 fallback，具体暴露 hook ledger 引用漂移和过短过渡 section；这仍是当前真实质量问题，不能当作通过。
- 本章链路出现 3 次 audit、2 次 revise、1 次 length-normalize；审查循环的新默认 2 轮已经实际生效。
- `plan`、`audit`、`revise`、`settle`、`settle-observe`、`analyze`、`validate-state`、`extract`、`foundation-review` 和 `normalize-length` 等结构化阶段均记录 `stream=false`；Writer 保留流式体验。
- 本次单章未生成稳定上下文编译缓存条目，因此不能用它证明跨 CLI 的 cache hit；缓存跨实例读取/损坏恢复已有离线测试，多章真实运行仍是待验收项。

本次结论：结构化传输和审查收敛路径已经进入真实运行，但 Planner 合同质量和单章 token 成本仍未关闭。下一步应针对真实 memo 失败样例优化 hook ledger/section 生成，并用 3-5 章报告验证 cache hit、hard-range rate、retry rate 和总成本。

## 5. 推荐的双 API 分工

下表保留 2026-07-10 双 API 实验得到的分工策略。2026-07-12 已验证单一 `openrouter / deepseek/deepseek-v4-pro` 可以贯穿 Planner、Writer、Normalizer、Auditor、Reviser 和 Settler 并完成 3 章，但代价是单章 token/耗时偏高，且结构结算仍可能漏字段。因此它证明“单模型路由可运行”，不证明“单模型路由是默认成本最优方案”。

双 API 推荐策略：

| Agent | 推荐模型 | 原因 |
| --- | --- | --- |
| `writer` | MiniMax-M3 | 正文质感和长上下文表现可用 |
| `reviser` | MiniMax-M3 | 与正文风格保持一致 |
| `length-normalizer` | MiniMax-M3 或专门短输出模型 | 当前仍需加强硬长度收敛 |
| `settler` | OpenRouter DeepSeek Flash | 状态 delta 和结构化输出更稳 |
| `planner` | OpenRouter DeepSeek Flash | 成本较低，格式可 retry |
| `composer` | OpenRouter DeepSeek Flash | 主要是结构编排 |
| `state-validator` | OpenRouter DeepSeek Flash | 需要严格结构判断 |
| `canon-extractor` | OpenRouter DeepSeek Flash，失败时 fallback | 抽取失败非致命，但需要记录 warning |

不建议把正文生成、事实观察、状态合并全部绑定到 `writer` 一个路由。它会把“文笔模型的格式弱点”放大成“连载状态断链”。

## 6. 2026-07-10 阶段目标与完成状态（历史记录）

### P0：真实调用可靠性

- 为每次 LLM 请求增加调用级 timeout、阶段名、agent、model、service 的结构化 telemetry。
- 长调用超时后保留 partial report，并能安全恢复到上一章快照。
- 将 `scripts/live-dual-api-routing.mjs` 固化为可重复的开发验收脚本，支持 `--chapters`、`--words`、`--route-mode`、`--review-mode`、`--timeout-ms`。
- 把真实 API 测试报告中的关键健康字段标准化，便于前端和 CI 外部任务读取。

### P1：状态结算与结构化输出稳定性

- 对 `settler` 输出增加更强的 delta 空值诊断：区分“模型没写”“解析失败”“被 reducer 拒绝”“状态确实无变化”。
- 对 planner memo parse retry 建立统计和样例归档，反向优化 prompt。
- 对 CanonExtractor schema fallback 建立 corpus，用真实失败样例回归。
- 增加“状态 Markdown 投影必须跟随 JSON 推进”的测试，防止结构化状态正确但可读 truth files 停留在占位。

### P1：长度治理

- 将长度超限纳入真实测试的失败或黄色门禁，而不是只记录 warning。
- 针对 MiniMax-M3 增加更硬的长度约束 prompt 与重写策略。
- length-normalizer 应能在目标 1000 字时稳定压回 hard range；超过一次仍失败时记录模型、章节、输入长度和输出长度。

### P2：前端全链路覆盖

- [已完成] Studio 已跑真实后端 API 路径，而不是只测前端 store 和 mock。
- [已完成] 前端 E2E 已覆盖一条核心 authoring 链路：创建书籍、写下一章、读取 truth files、显示 runtime diagnostic。
- 下一步前端目标应转向：服务配置、测试连接、创建失败/超时/降级时的错误诊断展示，而不是重复建设已通过的 stub authoring 主链路。
- 前端错误面板应展示 agent、model、service、baseUrl、apiFormat、stream、阶段名和可读错误，不泄露 API Key。

### P2：开发体验与工程治理

- 增加 `docs/` 入口或 README 链接，说明真实 LLM 测试与普通单测的区别。
- 清理或抑制已知非功能性噪音：Node `punycode` deprecation warning、SQLite experimental warning。
- Studio 构建体积继续拆分重依赖，避免诊断面板引入首屏负担。

### 6.1 进度更新：Studio LLM 诊断与遥测（2026-07-10）

相较于本文前半段仍以“待补 telemetry / 待补前端诊断”为主的描述，当前工作区里的 `packages/core`、`packages/cli`、`packages/studio` 已经进一步落地了一轮 Studio 诊断能力，需补充记录如下：

- [已完成] core 已为调用级 timeout、阶段名、agent、model、service、token usage、partial content length、error message 建立统一 telemetry 结构，并在 pipeline / agent / provider 路径中写出。
- [已完成] `INKOS_LLM_TIMEOUT_MS` 已接入 core 辅助函数，并由 CLI 与 Studio server 统一读取，默认超时不再只存在于单点调用处。
- [已完成] Studio 已打通 `llm:telemetry` SSE 事件，从服务端流到前端 store；不再需要只靠最终错误字符串猜测调用过程。
- [已完成] Doctor 页面、书籍侧边栏、聊天页顶部会话条、聊天中的工具执行卡都已显示最近 LLM 调用的耗时、状态、tokens 与错误信息。
- [已完成] 前端已为常见上游失败建立“根因摘要”而不只展示原始报错，当前覆盖超时、partial stream、reasoning_content 兼容、malformed function call、empty response、context limit、content policy、provider unavailable、rate limit、auth、slow success。
- [已完成] 遥测已进一步聚合为“主要问题类型统计”，Doctor、侧边栏、会话条会直接显示最近最常见的根因类别与次数，而不是只平铺单次失败。

这意味着：本节原先的 P0 / P2 中，关于“增加调用级 timeout / telemetry”“在前端显示可读诊断”的基础目标，已经不是纯待办，而是进入了可用的 v1 状态。接下来更高价值的工作不再是“有没有 telemetry”，而是“如何把 telemetry 变成更可执行的定位与验收能力”。

### 6.2 2026-07-10 优先级更新（历史记录）

在当前实现基础上，最值得继续推进的目标应调整为：

- P0：把根因统计继续按 `service` / `model` / `agent` 维度聚合，直接回答“最近是谁更容易超时、限流、上下文超限”。
- P0：为真实 API 与 Studio E2E 补“服务配置 -> 测试连接 -> 创建失败/超时/降级 -> 聊天内诊断展示”的完整回归链路，而不只验证 stub-mode authoring 主路径。
- P1：把 telemetry / root-cause 摘要沉淀为可读报告格式，供真实多章长跑脚本和后续 CI 外部任务消费。
- P1：继续归档真实 provider 失败样例，扩充根因分类语料，减少“未知错误只能显示原文”的比例。
- P2：在不增加首屏负担的前提下，把 Doctor 与治理面板结合起来，让 runtime diagnostic、telemetry 和 truth files 能互相跳转定位。

### 6.3 本轮相关验证（2026-07-10）

本轮围绕 Studio LLM 诊断补充，已确认通过的验证包括：

- `pnpm --filter @actalk/inkos-studio typecheck`
- `pnpm exec vitest run src/lib/error-copy.test.ts src/lib/llm-telemetry-display.test.ts src/store/chat/__tests__/message-parts.test.ts src/store/chat/slices/message/action.test.ts`

这些验证主要覆盖：根因分类、根因文案、遥测聚合、消息 parts 重建、聊天流事件更新与工具卡内联展示。

## 7. 完成定义

下一阶段可以视为完成，当满足：

- 双 API 路由真实测试可稳定完成 5 章，不出现 `state-degraded`。
- 章节状态、伏笔、摘要、JSON、快照全部推进到第 5 章。
- 1000 字目标下至少 4/5 章落在 hard range 内，超限章有自动二次归一化或明确失败报告。
- planner memo parse retry 和 canon fallback 均被记录到报告中，并有样例归档。
- Studio 在 stub LLM 模式下已通过真实后端路径完成一次“创建书 -> 写一章 -> 查看 truth files”的 E2E；下一步验收应提升为“配置服务 -> 测试连接 -> 创建失败/成功反馈 -> 写一章 -> 查看 truth files”的完整前端诊断链路。
- `pnpm typecheck` 与 `pnpm test` 全通过。

新增 2026-07-12 完成条件：

- [Core 已完成] 完整写作与独立审计对同一正文返回一致的 blocking issues；入口级 Studio/CLI/Chat E2E 与 gate 来源展示待补。
- [Core 已完成] Settler 连续两次漏 state/hook 时，resync 会改由 Chapter Analyzer 重建；Analyzer 仍不完整时返回单一可执行错误并恢复原快照。
- [Core 已完成] 新派生 hook 使用 `Dnnn` 短稳定 ID，中英文类型/status 在输入边界规范化，旧书长 ID 继续兼容。
- [已完成] Studio 可取消 write/draft/rewrite/repair/resync，且中断后不复用 fallback plan；浏览器和隔离 E2E 已覆盖取消、重启与状态修复。
- [确定性已完成] Prompt Assembly Trace、per-source 统计、三层上下文、确定性去重、职责清理、稳定上下文编译缓存、per-agent/per-phase token budget 报告和固定语料 A/B 门禁已通过；真实 3-5 章质量、账单成本和缓存命中率仍待验收。
- 真实 3000 字章节的 agent/phase token 成本进入报告，并建立可接受预算。

## 8. 2026-07-12 复核后的使用方式

本文第 7 节仍可作为“真实多章 LLM 质量”的专项完成定义，但不再代表整个项目的下一版本完成定义。

当前开发顺序调整为：

1. 可靠性 P0 已关闭：core command 迁移、sub-agent auditor、revise mode、受控文件 Chat edit、recovery preflight、配置锁与 workflow crash journal 均已完成。
2. 统一审计、确定性 settlement/resync、稳定 hook ID 和前端取消/恢复路径已经完成。
3. P1.1 report v2 代码已完成：service/model、token、provider retry、结构化 fallback、repair/resync、长度偏差和质量门禁均已接入。
4. Prompt Assembly Trace、per-source 统计、三层上下文、确定性去重、职责清理、稳定上下文编译缓存、per-agent/per-phase token budget 报告和固定语料门禁已经完成。
5. 当前待办是一次明确成本范围的真实 3-5 章基线；使用新 trace 验证已实现的跨 agent token 预算和稳定缓存，并归档 provider 失败和质量样例。

当前本轮确定性基线为：Core 128 个测试文件、1372 项，Studio 34 个测试文件、405 项，CLI 36 个测试文件、209 项；`pnpm verify` 共通过 1986 项，根级离线质量门禁已完整通过，隔离 Studio E2E 基线为 10/10，生产依赖审计为 0。此前 preparing/committed 真实进程 recovery 连续 5 轮共 10/10、`pnpm stress:process` 的 8 worker/400 次竞争 mutation/30 轮强杀恢复结果仍有效。真实 LLM 测试必须单独报告，不得与确定性测试结果合并表述。

### 8.1 P1.1 report v2 实现记录（2026-07-12）

- Core 新增统一 telemetry summary，汇总 calls、attempts、retries、duration、status 和 usage，并按三种维度分组。
- Provider 每次最终遥测都带 `attemptCount` / `retryCount`；stub 模式也遵守同一合同，因此离线测试可验证报告结构。
- Pipeline 新增结构化 diagnostics，覆盖 Planner parse retry/fallback、Canon heuristic fallback 和 Resync Chapter Analyzer fallback。
- 每章报告写入目标/最终长度、偏差百分比、soft/hard range、Normalizer、warning 数量；总报告计算 hard-range rate 和平均绝对偏差。
- `state-degraded` 恢复会记录 repair/resync 每次尝试的状态前后、耗时、遥测、诊断与异常。
- 已用 dummy credentials + stub LLM 完成一次单章脚本验收，确认 report v2、双服务模型分组、质量门禁和测试密钥清理；这不是现实模型质量或 token 成本证据。

### 8.2 P1.2 提示词与上下文治理实现记录（2026-07-12）

- Prompt Assembly Trace 与 `byPromptSource` 汇总已接入，ChapterTrace 写入 per-source 统计和三层 token 预算。
- Writer/Composer 的可确定重复已删除，结构化 current-state facts 优先于完整 Markdown 状态卡。
- Context compiler 分别接收 verbatim、semantic、compressible entries；编译产物统一为 `runtime/compiled-context`。
- PipelineRunner 已按项目/书籍、模型、语言、预算和稳定 source 指纹缓存 foundation、角色、正典和卷级编译结果；动态章节上下文仍每章重新编排。
- `buildLLMTokenBudgetReport` 和 live report budget options 已接入总章、agent、phase、单次 prompt 预算检查。
- Planner/Writer/Auditor 合同已收口，旧“7 段 memo”措辞从运行提示词和相关代码说明中移除。
- 固定语料门禁已覆盖成本、职责和关键质量合同；真实 3-5 章验证仍是独立完成条件，不得由 stub 证据替代。

### 8.3 2026-07-13 MiniMax-M3 真实 API 复测

本轮将项目默认服务切换为 MiniMax 官方 OpenAI-compatible Chat：`minimax / MiniMax-M3`、非流式。API Key 只写入本地 `.inkos/secrets.json`，不进入项目配置、报告或版本库；原有 OpenRouter 配置仍保留供双路由测试使用。

- MiniMax 服务探测成功，返回 8 个模型，`MiniMax-M3` 被选中；项目 `doctor` 确认 11 个 Agent 使用 `MiniMax-M3` 默认路由。
- 双路由 smoke 成功：OpenRouter 结构治理调用约 8.6 秒，MiniMax 调用约 2.2 秒。随后执行 `minimax-writer` 五章测试，基础设定生成成功并进入第 1 章，但在第 1 章状态结算阶段长时间无响应，未形成五章完成证据，任务被安全停止。
- MiniMax-only 隔离项目建书成功，Foundation Reviewer 评分 `87/100` 通过；CanonExtractor 的结构化输出出现多处 schema 漂移（如 `scope.geography` 返回字符串、`systemRelations.mode` 缺失），进入 heuristic fallback。
- MiniMax-only 第 1 章最终长度约 `1235` 字，处于目标 `1000` 字的 hard range 内；首次写作与人工 brief 修订后仍为 `audit-failed`，系统阻止第 2 章继续。主要问题是 memo 章尾承诺与正文因果链不一致、解释性回忆提前泄露悬念、hook 观察边界漂移。
- 隔离项目共记录 26 次 MiniMax 调用，合计约 `314,147` tokens（包含建书、写章和修订），累计调用耗时约 12.2 分钟；这还不能作为可接受的正式生产成本。

本轮结论：MiniMax-M3 的连接、建书和正文生成路径可用，但真实章节质量、结构化输出稳定性、状态结算耗时和单章成本仍未达到五章生产验收标准。最终 `pnpm release` 已通过 Core 126 个测试文件/1333 项、Studio 33 个测试文件/402 项、CLI 36 个测试文件/207 项，共 1942 项；生产依赖审计无漏洞，Studio E2E 为 9/9。确定性工程基线通过不能替代上述真实模型质量结论。

### 8.4 2026-07-13 双 API 分工真实复测

本轮将已验证的分工写入正式 `inkos.json`：默认使用 OpenRouter `deepseek/deepseek-v4-flash` 承接规划、编排、审计与状态治理；`writer`、`reviser`、`length-normalizer` 使用 MiniMax `MiniMax-M3` 独立 override。密钥仍只从 `.inkos/secrets.json` 读取，不写入配置、报告或版本库。

- 隔离测试使用 `minimax-writer`、1 章、目标 1000 字。OpenRouter 与 MiniMax smoke 均成功；正式配置下未手工设置模型环境变量时，writer 仍解析到 MiniMax，settler 仍解析到 OpenRouter。
- 第二次完整运行的 8 次 LLM 调用全部成功，无 retry、timeout、error，合计约 `89,076` tokens。第 1 章生成 `871` 字，落在 hard range `728-1272` 内，状态为 `ready-for-review`；没有 `state-degraded`。
- `canon-extractor` 出现 1 次 schema fallback，部分 `relations` / `constraints` 为 `null`，并缺少 `protagonistSystem.name`、`systemRelations.mode`。系统按 warning 降级并继续保存 truth files；live quality gate 因 fallback 上限设为 0 而未通过，这不是放宽门禁的理由。
- 首次运行曾在 architect 阶段遭遇一次上游连接中断；重跑后建书、规划、写作、settle 和 state-validator 全部完成。该现象应继续计入供应商稳定性观察，不能只看 smoke。
- 同步修复 live 报告健康检查对数组式 `chapters/index.json` 的误判，并让终端摘要直接输出 `qualityGate`；补充了从项目 service secret 到 model override `apiKeyEnv` 的内存桥接测试。

本轮结论：双 API 分工已经具备可运行的正式配置，连接、路由、状态结算和 hard-range 基线通过；但 canon schema fallback 和单章约 7 分钟的运行成本仍未达到正式长篇生产验收。下一轮应直接运行 3 章，保持 `state-degraded=0`、retry/timeout 可控、hard-range rate 至少 `4/5` 的门槛思路，并单独记录 fallback 数量与总 tokens。

### 8.5 2026-07-13 三章双 API 重测阻断

在 8.4 的单章运行后，使用相同的 `minimax-writer` 分工连续启动两次 3 章真实测试。两次都通过 OpenRouter/MiniMax smoke 和路由探针，但都在建书 `architect` 阶段终止，异常为上游非流式响应体为空或截断，Core 在 `response.json()` 处抛出 `Unexpected end of JSON input`。两次均未进入第 1 章，没有章节文件、状态推进或 `state-degraded` 结果。

这说明当时的问题已经从“单章质量 warning”升级为“多章验收阻断”。随后已在 provider 层加入空/非法 JSON、SSE JSON 和常见网络错误的受控重试，并在 canon 输入侧加入 nullable 字段与单值 geography 归一化；这两项均有确定性回归测试覆盖，不能再把旧的 `Unexpected end of JSON input` 描述为当前未修复代码缺陷。

### 8.6 2026-07-13 修复后 3 章双 API 重测

使用相同的 `minimax-writer` 分工、3 章、目标 1000 字和默认 `review-mode=manual` 重新运行。两路 smoke 和路由探针均成功：`writer -> MiniMax-M3`，`settler/planner/composer/state-validator/canon-extractor -> OpenRouter deepseek/deepseek-v4-flash`。

- 建书成功，Foundation Reviewer `80/100 PASSED`；第 1 章生成约 `1106` 字，进入 `ready-for-review`。
- 第 2 章生成约 `1892` 字，超出目标 1000 字的 hard range `728-1272`，被正确标记为 `audit-failed`，没有静默推进到第 3 章；这次是手动审核模式，未调用自动长度归一化，前端应提示用户审核/重写。
- 全流程记录 `19` 次成功调用、`2` 次重试、无 timeout/error/partial，总 usage 约 `183,410` tokens；OpenRouter 的 architect 约 `452` 秒、canon extractor 约 `373` 秒，真实长链路耗时仍明显偏高。
- `canon-extractor` 出现 `1` 次 fallback；状态校验重试后没有 `state-degraded`，但暴露了 hook 备注与正文事件覆盖不一致。该问题属于真实内容/提示词质量问题，不应通过放宽状态门禁掩盖。

本轮结论：provider 稳定性修复已生效，双 API 路由和状态保护可用；正式长篇写作仍差两类能力：模型输出的章节长度与 memo/hook 因果覆盖，以及真实长链路成本控制。下一步应分别用 `--review-mode auto` 验证长度归一化/自动修订，再针对真实 hook 漂移样例优化 planner-writer contract；不能把 smoke 通过等同于生产验收。

### 8.7 前后端联动验收门禁（2026-07-13）

为避免继续把 Studio E2E 与真实 Core/LLM 测试当成两套互不关联的证据，项目新增 `pnpm test:linked` 和 `pnpm test:linked:live`：

- 同一次写章必须贯通浏览器请求、Studio HTTP `requestId`、SSE start/complete、Core `operationId`、LLM telemetry、章节索引和 Doctor 操作筛选。
- 修复了 Studio 转发 `llm:telemetry` 时遗漏 `operationId` 的问题；此前 Doctor 虽然支持操作筛选，实际 SSE 数据无法命中该筛选，旧 E2E 只检查了筛选文字而没有检查真实调用数。
- stub 模式作为快速确定性联动门禁；live 模式复制当前服务配置到一次性项目，默认只跑 1 章、1000 字并设置总 token 上限，不污染正式书籍和密钥文件。
- live 报告保存运行指纹与失败签名；同一代码、配置和场景的已知失败默认拒绝重复执行。只有代码/场景发生变化，或显式传入 `--repeat-known-failure` 时才重测。

这条门禁不替代 3-5 章内容质量基准，但负责保证下一轮真实测试得到的是一份可跨前端、API、Core、模型调用和落盘状态追溯的统一证据，而不是两份各自全绿的自测结果。

### 8.8 审计门禁与联动测试收敛（2026-07-14）

本轮不调用真实付费模型，针对历史 live 报告暴露的重复测试、上下文成本和前后端证据割裂做确定性收敛：

- `resync` 不再把已有 `audit-failed` 错误提升为 `ready-for-review`；最终审计在 Settler、长跨度、hook 和段落检查全部完成后统一去重并重算通过状态。
- `write --count`、`auto` 和双 API live 脚本遇到 `audit-failed` 会立即停止，避免在质量门禁失败后继续消耗模型调用。
- `INKOS_MAX_PROMPT_ESTIMATED_TOKENS_PER_CALL` 在 provider/stub transport 之前执行单次提示词预算检查，超限请求不会发送到上游；live 报告的事后预算仍保留用于汇总诊断。
- 联动 E2E 校验审计/长度问题唯一性和 critical issue 为 0；运行元数据记录 launcher PID，正常退出会清理本次目录，下一次启动会回收 launcher 已死亡的遗留运行目录，避免临时 secrets 长期残留。
- Studio 的书籍、章节和 SSE 摘要改用 Core 共享合同，减少前端自定义类型与后端真实返回结构逐渐漂移的风险。

本轮确定性基线为 Core 1372、Studio 405、CLI 209，共 1986 项；离线联动链路已覆盖浏览器请求、SSE、Core operation、LLM telemetry、章节落盘与 Doctor 筛选。真实 3-5 章测试仍然是模型质量和成本验收，不能由这组确定性结果替代。

### 8.9 真实浏览器到 Doctor 联动复测（2026-07-14）

本轮使用正式双路由配置执行 `pnpm test:linked:live`：OpenRouter `deepseek/deepseek-v4-flash` 负责规划、编排、审稿与状态治理，MiniMax `MiniMax-M3` 负责正文、修订和长度归一化。场景为 1 章、目标 1000 字、总预算 250000 tokens、单次 prompt 上限 16000 tokens；密钥只从隔离项目 secret 读取。

- 前两次章节运行分别在 Continuity Auditor 发送前被 `16306` 和 `18078` token 的 prompt 预算门禁拦截。随后删除 auditor 对 hook/摘要证据的重复组装，不再向模型重复发送由 deterministic post-write claim gate 独立校验的完整 claim brief，并加入预算感知的低优先级上下文压缩。最终真实运行的 3 次 auditor prompt 为 `10696 / 10657 / 10661`，均低于上限；全流程最大 prompt 为 Chapter Analyzer 的 `14834`。
- 一次独立建书尝试返回不完整 foundation，缺少 `story_frame / volume_map / pending_hooks`。联动 harness 因此新增有限建书重试：live 默认最多 2 次，只对明确的 foundation 缺段错误重建新书；每次尝试单独记录 bookId、错误、遥测和 tokens，鉴权、传输、预算和状态错误仍立即失败。
- 最终运行耗时约 `21.4` 分钟，总 usage `197724` tokens，建书第 1 次成功，Foundation Reviewer `85/100 PASSED`。CanonExtractor 首次空响应后重试，并从不完整 JSON 中恢复 12 个完整 claim；该路径有 warning，但没有丢弃整个 canon。
- 第 1 章初稿 `1654` 字，审计前归一化到 `1261`，修订后最终 `1231` 字，`lengthWarnings=[]`。同一次浏览器操作的 HTTP requestId、SSE lifecycle、Core operationId、17 次章节 LLM telemetry、章节索引和 Doctor 筛选全部关联成功；`linkedGate.passed=true`。
- 生产质量门禁保持严格：章节最终为 `audit-failed`，`qualityGate.passed=false`。模型审稿从 `68` 提升到 `92`，但仍把“最多 3 个场景”中的 3 个允许场景误判为超过上限的 critical。Auditor 提示已补充数值上限规则：必须指出第 4 个及以后场景才能判 critical；本条修改只有确定性提示词回归，未继续用付费调用追逐随机的单次全绿结果。
- `report-only` 只属于隔离 live harness：它允许质量失败后继续验证持久化和 Doctor，不会改变 Core 对 `audit-failed` 的生产阻断。最终报告不含 API key 前缀，测试结束后项目目录和 runtime 目录均清理为 0。

本轮结论：项目此前“永远卡在真实模型审计”的主要原因不是单一模型能力，而是把链路完整性和随机内容质量绑定成同一个终止断言。现在两者被拆成 `linkedGate` 与 `qualityGate`：链路失败仍立即阻断，质量失败完整记录但不再遮蔽持久化、遥测和 Doctor 证据，也不再触发无边界重复测试。

### 8.10 章节首尾质量门与真实联动验证（2026-07-14）

针对真实生成文章中反复出现的“空开头”和“总结式结尾”，本轮把首尾质量加入确定性后写校验，而不是继续依赖 Writer 提示词或增加一次整章模型调用：

- 开头只拦截高置信度的天气、城市、房间等静态说明，并要求开头窗口内缺少具体行动、事件、对话、异常、目标或阻力；“凌晨三点，电话响了”和“海风压着窗户，门把手转了一下”仍会放行。
- 结尾拦截“一切才刚刚开始”“真正的较量即将到来”“命运的齿轮已经转动”“新的篇章即将开启”等抽象总结或泛化预告；具体证据、决定、发现、对话和威胁仍会放行。
- 两类问题均为 blocking error，但标记为 `repairScope=local`。审计门会把该字段传给 Reviser，使单一首尾问题进入 PATCH-only 修复，而不是整章重写。
- Length Normalizer 明确保留首个具体故事节拍和最后一个具体后果或选择，压缩时不得把它们替换为氛围铺垫或总结预告。

确定性发布基线为 Core `1383`、Studio `405`、CLI `209`，共 `1997` 项；生产构建、语义模板审计、包清单、依赖审计和 `10` 项浏览器 E2E（含 stub 联动）全部通过。

随后使用正式双路由配置执行 1 章、1000 字的 `test:linked:live`，质量策略为 `report-only`，但本次 `linkedGate` 与 `qualityGate` 均实际通过：

- 运行耗时约 `16.0` 分钟，总 usage `79720` tokens；建书第 1 次成功，Foundation Reviewer `81/100 PASSED`。
- Planner 第一次因 hook 分类冲突被确定性门禁拒绝，第二次有限重试成功；CanonExtractor 从不完整 JSON 中恢复 9 个完整 claim。
- Writer 初稿 `1116` 字，最终章节 `1109` 字，状态为 `ready-for-review`，无长度告警，也没有“空开头”或“总结式结尾”问题。
- 剩余质量信息为 1 条 memo 落点警告、1 条新伏笔债务警告和 1 条信息级具体性提示；没有 critical issue，也没有触发 Reviser。
- 同一次操作的浏览器请求、Studio API、SSE、Core operation、11 次模型 telemetry、章节落盘和 Doctor 筛选全部关联成功；隔离项目与 runtime 目录在结束后均清理为 0。

本轮真实样本证明新增门禁没有误伤正常首尾，但因为初稿直接通过，未在付费调用中触发 PATCH-only 修复；该路由由确定性 PipelineRunner/Reviser 联动测试覆盖。后续 3-5 章内容基准应继续统计首尾命中率和修复后复发率，不应为了强行制造一次 live 修复样本重复消耗模型调用。

### 8.11 无人值守五步验收与真实基线阻断（2026-07-14）

本轮按“5 章真实 auto 基线 -> 持久化处置状态机 -> 生产门禁 -> 20 章故障注入 -> 门禁通过后启用 daemon”的顺序推进。状态机、门禁和故障注入已经完成；真实五章门禁未通过，因此 daemon 保持未启动。

无人值守状态机将每本书的 `status/action/consecutiveFailures/failureDimensions/attemptsByAction/nextAttemptAt`、单章指标、累计指标和每日章节数原子写入 `.inkos/unattended-state.json`。`audit-failed` 先 revise，连续失败升级 rewrite；`state-degraded` 先 repair 再 resync；provider transient 退避重试；鉴权和预算错误立即暂停。重启后优先恢复最后失败章节，不会误写下一章。`529` 和“负载较高/稍后重试/服务繁忙”已归入 transient provider 分类。

`pnpm stress:unattended` 的最新结果为 `UNATTENDED_SOAK_PASS`：写章持锁期间强杀、provider `ETIMEDOUT` 注入和新进程恢复均通过；最终 `20/20` 章为 `ready-for-review`，快照 `21` 个，无残留锁。这个结果证明本地状态恢复可用，不代表真实模型质量或成本达标。

真实运行依次暴露并关闭了以下确定性问题：

- 首次尝试在建书前遇到 MiniMax `529`，章节数和 telemetry 均为 0；这推动了 transient 分类和有限 smoke retry。
- 第一份可审计单章报告中，Foundation Reviewer `90/100`。第 1 章初审 `92`，修订后 `88`，最终 `audit-failed`。根因是 claim compiler 把 memo 明确延后的“老周认识沈鸢”复合设定误编译成当章 reveal，post-write gate 又因“老周的维修笔记”命中角色名/通用词，错误要求本章同时付出“停职或住院”的代价。修复后同一失败现场离线重放不再产生 claim issue，`claim_010` 只进入 `mustHide`；新增回归同时保留显式 claim ID 揭示语义。
- 修复后的真实第 1 章最终 `1170` 字、审计 `92`、`ready-for-review`，无 critical，证明 claim 假阳性已关闭。但单章 `118790` tokens、最大 prompt `17039`、retry `2/10`，且 CanonExtractor fallback 为 1，因此生产门禁仍失败。
- 最大 prompt 来自修订后 truth 重建的 ChapterAnalyzer。它过去重复携带完整 chapter intent、全部 selected context 和 rule stack，既增加成本，也可能把计划污染成已发生事实。现在成稿是新增事实的唯一来源，Planner/Composer 产物只用于筛选工作集；用同一真实章节离线重组后，Analyzer prompt 从 `23776` 字符降至 `10650`，减少约 `55%`。
- 自动修订现在只接收 warning/critical，不再携带几十条“检查通过”的 info；review report 保存初审、每轮修订、分数、critical/blocking、具体 actionable issues 和最终选中版本。
- live runner 新增建书后不可逆 preflight。第三轮建书产生 Canon fallback 和 Architect `2/3` retry 时，脚本正确以 0 章结束，没有继续消费五章调用。retry rate 不再因 3 次调用的小样本提前阻断，完整质量门仍在运行结束后严格检查。
- CanonExtractor 的 system prompt 曾包含非法伪 JSON `{"claims":[CanonClaim...]}`，真实模型直接复制后导致解析失败。该占位符已移除；首次 JSON 直接无效或只能 salvage 部分 claim 时都会进行至多一次更小输出的有界修复，仍失败才进入 heuristic fallback。
- 第四轮 OpenRouter smoke 成功，MiniMax smoke 耗时 `359798 ms` 才返回。测试被停止，没有继续建书。两路 smoke 现已接入统一 telemetry、单尝试 timeout 和总体 abort deadline，避免“连通性已经超时却继续跑章节质量”。

当前真实门禁结论：claim 审计误报已修复，单章内容可以达到 `ready-for-review`；但双 provider 的 Canon 完整性、MiniMax 长尾、单章 100000-token 预算和五章 500000-token 总预算尚无同时通过的证据。不能通过提高预算、忽略 fallback 或反复抽样来宣称完成。下一次付费重测必须由 provider 状态变化、路由调整或新的确定性修复触发；daemon 在五章 `state-degraded=0`、最终 `audit-failed=0`、fallback=0、timeout=0、retry/长度/预算全部通过前保持关闭。

最终 `pnpm release` 通过：Core `1395`、Studio `405`、CLI `209`，共 `2009` 项确定性测试；生产依赖审计无已知漏洞，Studio E2E `10/10`。这些结果证明代码和联动链路自洽，不替代上述未通过的真实五章 provider 门禁。

### 8.12 OpenRouter-only 切换与真实五章重测（2026-07-14）

本轮将正式默认路由和隔离 live runner 统一切换为 `openrouter / deepseek/deepseek-v4-flash`，所有 Agent 不再自动使用 MiniMax override。live runner 新增 `openrouter-only` 模式：不要求 MiniMax Key、不执行 MiniMax smoke，路由探针确认 Writer、Settler、Planner、Composer、State Validator、Canon Extractor 均使用 DeepSeek Flash。严格门禁保持为五章、每章 1000 字、单章 100000 tokens、总计 500000 tokens、单次 prompt 16000 tokens、fallback/timeout 为 0、retry rate 不超过 20%，没有通过提高阈值换取结果。

真实运行依次关闭了三个确定性问题：

- 第一轮 Foundation Reviewer 只有 `50/100`，但旧 runner 的 `foundationReviewRetries=0` 会把低分结果标记为“达到最大重试后接受”，preflight 仍继续写第 1 章。Core 现在对重试耗尽且未通过的 Foundation 发出 `foundation-fallback` diagnostic，live preflight 的 fallback=0 会在章节前阻断；runner 默认提供一次有界 Foundation 重生成。信号退出也会先清理隔离 secret。
- 第二轮 Foundation 经一次重生成后以 `81/100` 通过，但 CanonExtractor 两次响应分别出现多 JSON envelope 和 malformed JSON，进入 heuristic fallback；preflight 正确以 0 章停止。解析器现在扫描完整顶层 JSON 对象并优先选取含 `claims` 的 envelope，同时拒绝缺失 `claims` 的空对象。使用同一真实 Foundation 的聚焦复测一次成功，得到 8 条 claim、`usedFallback=false`、retry/timeout 为 0、`16445` tokens、最大 prompt `14253`。
- 第三轮前置门禁通过，第 1 章初审达到 `95`，但 Reviser 三次连接 OpenRouter 失败后旧 live loop 整体退出。这暴露出 live 基线没有真正走已经实现的无人值守状态机。Scheduler 新增一次性 `runOnce()` 与章节结果回调，live 章节循环改为正式 Scheduler：provider transient、audit revise/rewrite、state repair/resync 和预算暂停都写入 `.inkos/unattended-state.json`；中文“无法连接/连接失败/网络不通”也归入 provider transient。最终质量门新增“完成章数必须等于目标”和“audit-failed 必须为 0”。

第四轮验证了新状态机和预算暂停：

- Foundation `92/100` 首轮通过；前置阶段 `33165` tokens、fallback=0、timeout=0。第 1 章 Writer 初稿约 `1869` 字，Length Normalizer 收敛到 `882` 字。
- Reviser 在发请求前被 prompt 门禁拒绝：`16565 > 16000`。Scheduler 将错误分类为 `budget`，原子持久化为 `status=paused/action=pause`，章节索引仍为 0，没有误写下一章，也没有把预算错误当 provider transient 重抽。
- 终止时总计 `115850` tokens，retry `2/14=14.3%`、timeout=0、fallback=0。五章门禁仍未通过，daemon 继续关闭。
- 根因是 Reviser 同时携带独立 claim brief/pre-write gate 和 `runtime/compiled-context` 复合缓存，后者重复了同一批控制信息。Reviser 现排除该复合缓存；用第四轮真实 plan/context/rule stack 和等长 882 字正文离线重组后，prompt 从 `25738 chars / 16565 tokens` 降为 `17727 chars / 11677 tokens`，低于 16000 且保留约 27% 余量。

随后按相同硬阈值继续执行第五至第七轮，结果进一步定位到模型默认推理模式和两个预算接线边界：

- 第五轮 Foundation `88/100`，但 Canon 两次请求虽然 transport 均成功，整体 JSON 仍损坏；解析器只救回 7 个完整 claim，preflight 以 fallback=1、`34197` tokens、0 章正确停止。OpenRouter 模型元数据表明 `deepseek-v4-flash` 默认 reasoning 为 `high`，但不是 mandatory，并原生支持 `response_format`。Canon 现仅对该 OpenRouter 模型发送 `reasoning.effort=none`、`response_format=json_object`，输出预算从 4096 提升到 8192，同时支持从冗余外层花括号中选取内部完整 envelope。复用同一真实 Foundation 的聚焦调用一次通过：8 条 claim、`usedFallback=false`、0 重试、`11664` tokens。
- 第六轮 Foundation `90/100`，前置门禁以 fallback=0、timeout=0、`27853` tokens 通过。第 1 次写章归一化到 `1052` 字、初审 `70`，Reviser prompt 已降到 `15993` 并真正发出，但 OpenRouter 三次连接失败；Scheduler 按 provider transient 重跑第 1 章。第 2 次归一化到 `987` 字后，Continuity Auditor 在发送前被 `16326 > 16000` 拒绝，最终 `142621` tokens、0 章、状态 `paused/budget`。根因是 Auditor 的预压缩只读环境变量，没有读取 Scheduler 通过 AgentContext 传入的限额；现已统一读取 AgentContext 并预留 3% 余量。
- 第七轮 Foundation `84/100`，Canon、Planner、Writer、Settler、Length Normalizer 和 Auditor 均一次通过；正文 `1732 -> 1093` 字，Auditor 实际 prompt 为 `12432`，证明上轮接线修复生效。随后 Reviser 因本轮 selected context 更大而以 `16726 > 16000` 在本地 1ms 内暂停；终止时 `84127` tokens、retry/fallback/timeout 均为 0、0 章。Reviser 现对 selected-context excerpt 做有界保留，并与 Auditor 共用预算压缩工具，在发送前优先移除或压缩低优先级摘要、卷级证据、矩阵和控制块；确定性回归验证总 prompt 不超过 `15520`，同时完整保留审稿问题、待修正文和关键状态。

没有继续执行第八次随机付费运行。当前结论是：OpenRouter-only 路由、低分 Foundation 阻断、Canon 结构化输出、无人值守状态处置、Auditor/Reviser prompt 预算都已获得真实失败证据与确定性修复；但仍没有五章全部完成的真实证据，因此不能启用 daemon，也不能宣称长篇无人值守验收完成。下一次付费五章重测必须由新的明确授权触发，并以本节代码版本为基线，不再回到 MiniMax smoke 或双 provider writer override。

本轮最终确定性门禁通过：Core `1403`、Studio `405`、CLI `209`，共 `2017` 项；生产依赖审计无已知漏洞，Studio E2E `10/10`。独立 `pnpm test:linked` 为 `1/1`，验证浏览器、Studio API、Core telemetry、持久化和 Doctor 使用同一操作链路。正式本地 `inkos.json` 已清空 `modelOverrides`，但该文件按项目安全约定被 Git 忽略，不进入提交。

### 8.13 Foundation 预检与 Studio 真实单章联动（2026-07-15）

在第八轮前先执行正式 `--foundation-only` 预检。5 章目标的 Foundation 以 `84/100` 通过，卷合同被确定性校验为单卷 `1-5` 章、3 个 KR；Canon 单次成功，fallback/timeout 均为 0，总计 `36071` tokens，最大 prompt 估算 `10400` tokens。预检期间一次 Architect transport retry 被恢复；由于该模式只有 4 个小样本调用，`1/4` 的 retry rate 仅记录而不阻断，fallback、timeout 和预算仍保持阻断。这避免了把可恢复的单次网络抖动误判成整本书不可启动。

随后执行 `pnpm test:linked:live -- --linked-chapters 1 --linked-words 1000 --linked-max-total-tokens 250000 --linked-max-prompt-tokens-per-call 16000 --linked-create-attempts 2 --linked-quality-policy strict`。本轮不是 Core 或 Studio 各自自测，而是浏览器创建书籍、Studio API/SSE、生产 Pipeline/Scheduler、真实 OpenRouter、章节持久化和 Doctor 的同一条操作链。结果如下：

- Playwright `1/1` 通过，整轮 20.9 分钟；报告状态、linked gate 和 strict quality gate 均为 passed。
- Foundation 第一版 `67/100`，一次有界重生成后 `81/100`；Canon 首次 envelope 不完整，第二次返回完整结构且没有 fallback；Planner 首次 hook ledger 引用无效，第二次通过。
- 第 1 章最终状态为 `ready-for-review`，长度 `962` 字，无 length warning；Doctor 以同一 `operationId=2f1df955-7180-49cd-8abf-e4c661a71e46` 验证通过。
- 章节只执行一次 Writer。空状态补丁不再让 Scheduler 重启正文；后续 Settler、Length Normalizer、Continuity Auditor、Chapter Analyzer 和 State Validator 均在同一 operation 下完成。
- 总计 `132930` tokens，其中建书和 Canon 阶段 `57650`，单章阶段 `75280`；最大 prompt 估算为 Writer 的 `12723`，低于 `16000` 门禁。fallback=0、timeout=0。
- 最终审计只保留两条 info 和一条节奏 warning，没有 critical；严格质量门按当前合同允许进入人工复核。隔离项目和 `.tmp-linked-acceptance/latest-live.json` 都是可清理的本地临时产物；长期证据以本节脱敏摘要和对应提交为准，不提交含真实正文的原始项目或报告。

这次结果关闭了“真实模型始终无法跑通一章联动”的旧结论，也证明前端状态与后端操作不是各自伪绿。但它仍没有关闭五章门禁：按本轮速度和调用量直接线性扩展会过慢，且 Foundation/Canon、Planner 各发生一次有界质量重试。下一阶段不应继续随机重复付费测试，而应先用 telemetry 压低每章治理调用的长尾与 token 消耗，再执行 3 章稳定性样本，最后才恢复 5 章验收。daemon 在连续多章 `state-degraded=0`、`audit-failed=0`、fallback=0、timeout=0 且预算通过前仍保持关闭。

### 8.14 DeepSeek 官方接口既有书三章样本与报告闭环（2026-07-15）

本轮不重新建书，直接在《端到端复测·雾港零号协议·0712》第 3 章之后，使用 DeepSeek 官方 `deepseek-v4-flash`、Chat、非流式连续生成第 4-6 章，目标每章 3000 字。三章最终分别为 `3022 / 3582 / 3785` 字，均为 `ready-for-review`，manifest 与快照推进到第 6 章。第 4 章首次落盘为 `state-degraded`，专用 `repair-state` 成功恢复后才继续第 5-6 章。

随后新增 `inkos analytics --chapters <range> --llm-report --save-report`，从章节索引 operationId 关联 `.inkos/runtime/llm-calls/<book>.jsonl`，并把 operation 窗口内无 operationId 的历史恢复调用纳入总成本。以总计 600000、单章 200000、单次 prompt 16000、重试率 20% 为分析阈值，本轮报告结论为 FAIL：

- 三章正文共 `10389` 字；operation telemetry 加第 4 章修复窗口共 `44` 次调用、`618663` tokens，重试率为 0。
- 章节索引只记录 `312313` tokens，约覆盖 telemetry 的一半，不能继续作为正式成本口径。
- 第 4/5/6 章各自关联 operation 为 `193882 / 229613 / 150226` tokens；第 5 章因 3 次 Auditor、2 次 Reviser、3 次 Length Normalizer 超过单章 200000 门槛。
- 最大 prompt 估算 `23992`，来自 Settler；Continuity Auditor 最大约 `23123`。全样本最大的两个 agent/phase 成本为 Auditor `126443`、Settler `114413`。
- 第 4 章 repair 的 3 次调用共 `44942` tokens，旧实现没有 operationId。Core 现已让 repair/resync 建立并返回 operationId，后续 Doctor 与报告可关联恢复成本。

状态根因也由真实快照确认：模型在“延后”旧 hook 时把大量 `lastAdvancedChapter` 统一刷新为当前章，Reducer 又曾把 defer 本身视为推进，导致无正文依据的伏笔年龄重置。修复后：

- `defer` 只改变状态，不再更新 `lastAdvancedChapter`；mention/defer 与 upsert 重叠时按非推进语义归一化。
- State Validator 会在调用模型前确定性拒绝 `deferred + lastAdvancedChapter=当前章`。
- Settler prompt 明确禁止 defer 同时写入 upsert 或刷新最近推进章。
- 新增 Core 报告、Reducer、State Validator、repair operationId 回归，以及 CLI 子进程报告落盘测试。

本轮关闭的是“既有真实三章不可复盘”和“defer 静默伪推进”两个确定性缺口，不关闭正式五章验收：它不是新书 Foundation/Canon + Studio/Scheduler 同链路，字数目标也与既定 1000 字门禁不同。下一次付费测试前应先压低 Auditor/Settler prompt 与多轮审校成本；daemon 继续保持关闭。

本轮代码完成后 `pnpm verify` 通过：Core 130 个测试文件、1422 项，Studio 34 个测试文件、405 项，CLI 36 个测试文件、210 项，共 2037 项；代码整洁、typecheck、语义审计、build、bundle 和 publish manifest 同时通过。未重复运行付费 live、生产依赖审计或 Studio E2E。

### 8.15 Settler prompt 预算压缩与三章离线重组（2026-07-15）

本轮没有继续调用付费模型。Settler 二阶段 prompt 现在读取 Scheduler 通过 `AgentContext` 传入的单次上限，并预留 3% 安全空间；独立 Settler 客户端也把同一上限传给 provider 本地预检。组装超过目标时，依次移除支线、情感弧线、角色矩阵、历史摘要、卷纲和重复长程证据，再按需压缩治理控制块与伏笔池。章节正文、Observer 日志、状态校验反馈和当前状态卡不进入删除队列。

固定语料回归以 `16000` 为上限，断言最终 prompt 不超过 `15520`，并完整保留正文、Observer 事实、状态校验反馈、当前状态和指定 hook ID。另有独立 Settler client 回归证明超限请求会在 transport 前被拒绝，不会发往网络。

使用第 4-6 章写入前 snapshot、当章 intent/context/rule-stack 和历史 Prompt Assembly Trace 做只读重组。历史日志没有保存 Observer 原文，因此以相同 chars/token 组成的占位文本替代；历史 system prompt 比当前 defer 规则少约 54 个估算 tokens。下表是 `estimateTextTokens` 离线结果，不是供应商账单 usage：

| 章节 | 历史 Settler prompt | 当前离线重组 | 估算减少 |
| --- | ---: | ---: | ---: |
| 4 | 20198 | 13010 | 35.6% |
| 5 | 20069 | 12881 | 35.8% |
| 6 | 18763 | 10960 | 41.6% |

三章重组均保留完整正文、等尺寸 Observer、当前状态、治理控制块和已有 hook ID。该结果关闭 Settler 单次 prompt 超过 `16000` 的确定性缺口，但不证明真实模型输出质量不受影响，也不减少同一章内 Auditor、Reviser、Length Normalizer 的重复调用次数。下一步应根据 operation telemetry 合并无收益的重复治理轮次，再由新的明确授权触发 Scheduler/Studio 五章付费验收；daemon 继续关闭。

本轮 `pnpm verify` 通过：Core 130 个测试文件、1424 项，Studio 34 个测试文件、405 项，CLI 36 个测试文件、210 项，共 2039 项；未调用真实 API，未运行生产依赖审计或 Studio E2E。

### 8.16 自动审校收敛与治理调用门禁（2026-07-15）

本轮继续只做确定性开发，没有调用真实 API。`runChapterReviewCycle` 过去会把“审计未通过但没有可执行问题”交给 Reviser，也会在修订内容经长度/表面归一化后回到当前正文时再次调用 Auditor；同一个问题集合只要模型分数随机上涨 3 分，也可能进入下一轮。现在新增以下提前停止条件：

- 没有 warning/critical 可执行问题时不创建 Reviser。
- Reviser 原文未变、归一化后与当前正文相同、或回到任一已审版本时，不再重复 Auditor。
- 可执行问题指纹未变化且 critical/blocking/AI-tell 数量未下降时，忽略分数波动并停止。
- Writer 的 `postWriteErrors/postWriteWarnings` 去重后合入首次 assessment；此前字段虽存在于合同中，实际未被循环消费，旧测试只因“低分零问题也修稿”而偶然通过。

章节索引新增 `reviewTelemetry`，持久化 `terminationReason`、audit/revision/normalization 调用数、已审候选数和配置的最大修订轮数。`analytics --llm-report` 还会直接从 operation telemetry 输出每章 audit/revise/normalize/settle 次数，并新增 `--max-audit-calls`、`--max-revision-calls`、`--max-normalize-calls`、`--max-settle-calls` 四个门禁。

对第 4-6 章历史样本只读复盘得到：

| 章节 | Audit | Reviser | Length Normalizer | Settler |
| --- | ---: | ---: | ---: | ---: |
| 4 | 2 | 1 | 1 | 2 |
| 5 | 3 | 2 | 3 | 1 |
| 6 | 1 | 0 | 0 | 2 |

旧章节没有持久化问题指纹和终止原因，因此这些数字只能证明第 5 章是重复审校热点，不能证明新逻辑会节省某个确定 token 数。后续新章节会直接记录终止原因，正式五章样本才能验证实际命中率与内容质量；daemon 在该门禁通过前继续关闭。

本轮 `pnpm verify` 通过：Core 130 个测试文件、1430 项，Studio 34 个测试文件、405 项，CLI 36 个测试文件、210 项，共 2045 项；代码整洁、typecheck、语义审计、build、bundle 和 publish manifest 同时通过。未调用真实 API，未运行生产依赖审计或 Studio E2E。

### 8.17 ArkPlan / Doubao 单供应商五章前置门禁（2026-07-15）

本轮获得新的明确付费授权后，将正式 live runner 扩展为 `single-provider`：端点、模型和密钥只从当前进程环境读取，不创建临时 `secrets.json`；原始报告继续位于忽略的 `.tmp-*` 目录。runner 同时记录每章 `reviewTelemetry`、audit/revise/normalize/settle 调用数，并把四类可配置调用上限纳入最终 quality gate。旧 OpenRouter/MiniMax 路由模式保持兼容。

目标路由为 ArkPlan 自定义 OpenAI chat 端点和 `doubao-seed-2.0-pro`。首次按内置 Volcengine pi-ai 适配执行 smoke 时，服务端已有 usage 但 thinking block 没有映射为最终 text；原始字段探针确认同一端点同时返回 `content` 与 `reasoning_content`。随后改用项目已有 custom native transport，优先消费最终 `content`，smoke 成功。正式运行的 Writer、Settler、Planner、Composer、State Validator 和 Canon Extractor 路由探针均指向同一 custom 服务、同一模型，且 stream=false。

正式目标保持五章、每章 1000 字、自动审校 2 轮、Foundation 有界重生成 1 次、单章 100000 tokens、总计 500000 tokens、单次估算 prompt 16000 tokens、retry rate 不超过 20%、fallback/timeout 为 0；治理调用上限为每章 audit 2、revision 1、normalize 2、settle 1。实际结果：

- 正式运行前的三次兼容诊断共使用 `1131` tokens，用于定位 pi-ai thinking 映射并验证 custom native transport；不计入下述正式 runner 汇总。
- 共 6 次正式 runner 调用，6/6 success，retry=0、timeout=0、error=0、partial=0；耗时 `706961 ms`。
- 总 usage `76195` tokens，其中 prompt `28062`、completion `48133`；最大单次估算 prompt `8302`，token 和 prompt 预算均通过。
- 第一版 Foundation 为 `70/100`，五章节奏可行性只有 40；唯一一次有界重生成后为 `77/100`，仍未通过 Foundation Reviewer。
- Canon Extractor 成功，初始 truth 和 snapshot 可用；但诊断记录 1 个 `foundation-fallback`，pre-chapter gate 因 fallback 上限为 0 阻断，Scheduler 没有生成正文，章节数为 0。
- 临时密钥文件不存在，对整个临时项目做精确扫描为 0 命中；原始报告未提交。

本次关闭的是“ArkPlan/Doubao 是否能连通并执行 Foundation/Canon 结构化链路”的未知项，不关闭正式五章门禁，也没有产生可用于评价新审校终止条件的章节 telemetry。没有确定性 Foundation 提示词修复、路由变化或 provider 状态变化时，不重复该付费样本；daemon 继续关闭。

### 8.18 紧凑篇节拍合同与 ArkPlan 两章成本阻断（2026-07-15）

针对 8.17 的确定性失败，目标不超过 12 章的紧凑完结作新增可解析的逐章节拍合同。Architect 必须为每章依次填写目标、阻碍、转折、可观察交付和因果章末钩子；尺度校验会拒绝缺章、乱序、缺字段和未替换占位符。Foundation Reviewer 在紧凑篇中直接按该合同评分，重生成反馈单列硬性阻断项，最终日志保留全部维度分数。这是 Architect 禁止章级规划的一项有界例外，不改变长篇的卷级职责边界。

完整离线门禁随后通过：Core 130 个测试文件、1432 项，Studio 34 个测试文件、405 项，CLI 36 个测试文件、210 项，共 2047 项；代码整洁、typecheck、语义审计、build、bundle 和 publish manifest 同时通过。

在新的隔离目录中以 8.17 相同 ArkPlan 路由和硬阈值重跑五章样本。结果如下：

- Foundation 首轮以 `82/100` 通过，五个维度为 `87/84/81/78/82`，没有消耗重生成；Canon 成功。pre-chapter gate 在 `44388` tokens、retry/fallback/timeout 均为 0 时通过。
- 第 1 章为 `ready-for-review`、`912` 字、审计 `96` 分，终止原因 `initial-passed`；共 6 次调用、`74542` tokens，最大估算 prompt `13248`。治理调用为 audit 1、revision 0、normalize 0、settle 1。
- 第 2 章初审 `88` 分未通过，一次 Reviser 后以 `88` 分通过，最终 `1200` 字、终止原因 `passed-after-revision`。逻辑审校记录 audit 2、revision 1、normalization 1；provider phase 实际为 audit 2、revision 1、normalize 2。
- 第 2 章最终状态校验发现 5 个 `deferred + lastAdvancedChapter=当前章` 的 hook-state contradiction，生产恢复路径只重跑结算层后恢复为 `ready-for-review`。该章因此出现 settle-observe 2、settle 2，settle 超过上限 1；整章 15 次调用、`213210` tokens，也超过单章 `100000` 上限。最大估算 prompt 只有 `12862`，说明本次失败来自调用数量和模型 completion 长尾，不是单次 prompt 膨胀。
- Scheduler 按预算错误持久化为 `paused/action=pause`，没有启动第 3 章。最终完成 2/5 章，两章均无 `audit-failed` 或未恢复的 `state-degraded`，hard-range rate 为 100%；状态 Markdown/JSON、章节索引和 0-2 快照均可读。
- 正式汇总为 25/25 success、retry/error/timeout/partial/fallback 均为 0、总计 `332140` tokens、最大估算 prompt `13248`。总量 `500000` 和 prompt `16000` 门禁通过，但完成章数、单章 token 和 settle 调用门禁失败，因此 `qualityGate.passed=false`。原始报告保留在忽略目录 `.tmp-doubao-five-chapter-beat-contract`，不提交正文或报告。

本轮证明紧凑篇 Foundation 合同修复有效，也首次获得 ArkPlan 新审校终止 telemetry；它不关闭五章验收。下一步不提高 token 或 settle 上限，而是确定性消除 defer 状态矛盾的重复结算，避免状态恢复重跑完整 Observer/Settler 链，并压低一次修订路径中的 audit、normalize 和模型 completion 成本。完成离线回放和回归后先做 3 章稳定性样本，再恢复 5 章门禁；daemon 继续关闭。

### 8.19 DeepSeek 官方对照、Windows 原子提交与小幅超长成本（2026-07-15）

在新的明确授权下，将相同五章、1000 字、自动审校、token/prompt、retry/fallback/timeout 和治理调用阈值切到 DeepSeek 官方 `deepseek-v4-flash`。项目正式配置原本已经是 `service=deepseek`、官方 base URL、Chat、非流式；密钥只通过当前进程环境注入，没有写入 `inkos.json`、`.env` 或报告。

三次隔离运行分别定位了不同问题：

- 首次运行的 4 次前置调用全部成功，Foundation 首轮 `88/100`，五维 `85/90/88/80/95`，Canon 成功；共 `35883` tokens、最大 prompt `8425`，无 retry/error/timeout/fallback。随后临时书目录提交到正式目录时，Windows `rename` 返回瞬态 `EPERM`，章节未开始，staging 被安全清理。
- 对目录提交增加有界重试后，第二次运行真实验证 rename 成功。Foundation 首轮 `80/100`，pre-chapter gate 以 `36071` tokens、retry/fallback/timeout 0 通过。第 1 章最终 `ready-for-review`、`933` 字、审计 `100`、终止原因 `initial-passed`，没有 Revision 或重复 Settler；但单章 `105338` tokens，超过 `100000` 上限 5.3%，Scheduler 正确暂停。
- 第二次运行的成本热点高度集中：Length Normalizer 为把 `1312` 字压到 `934` 字，单次使用 `32669` tokens，其中 completion `30071`；章节其他 7 次调用合计约 `72669` tokens。全程最大 prompt `13345`，所以失败不是上下文超限，而是小幅超长触发了不成比例的模型推理。
- 小幅超长现改为两级策略：仅在 compress 且超出 hard max 不超过 5% 时，先用已有的首尾因果与 required marker 保真算法确定性收敛到 hard range，provider 调用为 0；无法安全收敛或偏差更大时仍走原 LLM Normalizer，之后 Auditor 仍完整执行。
- 最终复测没有机会验证上述章节优化：首版 Foundation 为 `74/100`、节奏维度 40；唯一一次重生成后校验器未识别到节拍合同，严格门禁以 0 章停止。5/5 transport success、`48081` tokens、最大 prompt `8370`、无 retry/error/timeout，诊断为 `foundation-fallback=1`。解析器随后允许标题漂移或标题缺失时从完整逐章字段行恢复节拍段，但仍拒绝缺章、乱序、缺字段和占位符；该修复只有离线回归，未继续付费抽样。

Windows 原子 rename 现在对 `EACCES/EBUSY/ENOTEMPTY/EPERM` 做 5 次指数退避，book staging 提交与普通 atomic file rename 共用同一实现；非瞬态错误和重试耗尽仍原样抛出。最终 `pnpm verify` 通过 Core 131 个测试文件、1438 项，Studio 34 个测试文件、405 项，CLI 36 个测试文件、210 项，共 2053 项；hygiene、typecheck、语义审计、build、bundle 和 publish manifest 同时通过。

结论不是“豆包不能用、DeepSeek 一定能过”。DeepSeek 官方在前置阶段和无修订首章路径更省，正文审计质量可达 100；但 Foundation 仍有明显样本波动，治理调用也可能产生很长 completion。当前两种模型都没有通过五章门禁。下一次有效联网测试应先跑 Foundation-only，确认紧凑篇解析修复后再做 3 章，不直接重复五章；daemon 继续关闭。

### 8.20 DeepSeek 官方 Foundation 预检与三章稳定性样本（2026-07-15）

按 8.19 的顺序先执行独立 Foundation-only。目标仍为五章、每章 1000 字、Foundation 最多重生成 1 次、总量 500000 tokens、单次估算 prompt 16000、fallback/timeout 为 0；DeepSeek 官方密钥只注入当前进程。结果为 Foundation `94/100`，五维 `95/98/90/92/96`，完整逐章节拍合同被标题漂移容忍解析器识别，Canon 和 pre-chapter gate 同时通过。6/6 provider calls success、`62020` tokens、最大估算 prompt `8257`，retry/error/timeout/fallback 均为 0。该结果关闭 8.19 的 Foundation 解析复验项。

随后在新隔离目录执行三章、1000 字、auto review、最多 2 个审校修复轮次；单章/总量/prompt 门禁保持 `100000 / 500000 / 16000`，治理调用上限保持 audit 2、revision 1、normalize 2、settle 1。实际结果：

- 三章规模 Foundation 首轮 `77/100`，节奏维度 40；唯一一次重生成后以 `85/100` 通过，五维 `88/85/90/78/82`。Canon 成功，pre-chapter gate 为 `59043` tokens，fallback/timeout/provider retry 均为 0。
- 第 1 章为 `ready-for-review`、`892` 字、审计 `88`、终止原因 `initial-passed`；共 9 次调用、`82089` tokens，audit 1、revision 0、normalize 1、settle 1，全部门禁通过。Planner 有一次 hook action 解析重试诊断，但没有 provider transport retry。
- 第 2 章初稿从 1526 字归一到 824 字，初审 `82`；一次有效修订后正文为 `1049` 字、复审 `95`，但仍保留两条 critical memo 禁止事项。第二次 Reviser 返回原文，终止原因 `revision-unchanged`。provider phase 实际为 audit 2、revision 2、normalize 2，revision 已超过上限 1。
- 第 2 章首次及重试结算都删除状态卡和活跃 hooks，State Validator 正确拒绝并落为 `state-degraded`。初始章节动作已使用 15 次调用、`147533` tokens、settle 2，已同时超过单章和 settle 门禁；旧 Scheduler 只在 `ready-for-review` 路径检查预算，仍继续执行 repair。
- repair 的两次结算继续失败。原始报告把这 6 次恢复调用、`46135` tokens 记为 `unassignedTelemetry`，所以章内显示 `147533` tokens 和 settle 2；按同一运行的全局 telemetry 归属后，第 2 章真实为 21 次调用、`193668` tokens、settle 4。总运行为 36/36 success、`334800` tokens、最大估算 prompt `15519`，retry/error/timeout/fallback 均为 0；失败来自治理次数、completion 长尾和状态语义，不是连接或 prompt 超限。
- 最终只有 2/3 章，章节 2 保持 `state-degraded`，快照停在 1。Markdown/JSON truth 文件仍可读；quality gate 因完成章数、未恢复状态、单章 token、revision 和 settlement 同时失败。原始报告保留在忽略目录 `.tmp-deepseek-official-three-chapter-stability`，不提交正文或报告。

该样本同时暴露三处确定性执行缺陷，现已离线修复：

- Scheduler 在失败或恢复异常后也会检查当前章节累计 token、prompt、retry、timeout 和 fallback；硬门禁失败立即持久化 `paused/action=pause`，不再继续付费恢复。
- 恢复异常保留 pending chapter 编号并触发章节完成回调，后续 live 报告可把恢复 telemetry 归到原章节，不再误放到 `unassignedTelemetry`。
- `repairChapterState()` 在两次结算均成功返回但状态校验仍失败时返回结构化 `state-degraded`，保持原 truth 不变；Scheduler 因而可继续既有 `repair -> resync` 合同。真正的 transport/执行异常仍抛错，不会被伪装为状态降级。

结论仍不是“三章稳定”。DeepSeek 官方已经验证 Foundation 解析和健康首章，但第二章同时出现审校禁止事项残留、无变化的第二次修订、状态清空和结算 completion 长尾。下一开发目标是让 revision/settlement 治理上限成为调用前的可执行预算，并用离线状态回放验证一次结算失败后直接进入 Chapter Analyzer 的成本和真相完整性；没有这类确定性变化或新的 provider 路由时，不重复当前付费样本。daemon 继续关闭。

本轮最终 `pnpm verify` 通过：Core 131 个测试文件、1441 项，Studio 34 个测试文件、405 项，CLI 36 个测试文件、210 项，共 2056 项；hygiene、typecheck、语义审计、build、bundle 和 publish manifest 同时通过。

### 8.21 DeepSeek 官方治理预算前置执行复测（2026-07-15）

在 revision/settlement 调用前预算和 Scheduler 持久化计数完成后，使用 `deepseek-v4-flash` 官方接口在新隔离目录执行三章复测。配置保持每章 1000 字、auto review、最多 2 个审校修复轮次、Foundation 最多重生成 1 次；总量/单章/prompt 门禁为 `500000 / 100000 / 16000`，治理上限为 audit 2、revision 1、normalize 2、settlement 1。密钥只注入测试子进程，报告中未检出密钥，临时 secrets 文件不存在。

- Provider smoke、Foundation、Canon 和 pre-chapter gate 全部通过。Foundation 首轮 `87/100`，pre-chapter 阶段 `33850` tokens；全程 14/14 provider calls success，retry/error/timeout/fallback 均为 0，最大估算 prompt `14072`，证明本轮失败与模型连通性或 prompt 上限无关。
- 第 1 章初稿 2025 字，经一次 Length Normalizer 收敛到 1029 字；初审 `88`，唯一一次 Reviser 后复审 `98`，最终 `ready-for-review`、1043 字，终止原因为 `passed-after-revision`。治理计数为 audit 2、revision 1、normalize 1、settlement 1；Revision 日志明确为 `1/1`，最终报告没有治理次数违规。
- 章节正文修订后触发一次 Chapter Analyzer 重建真相，再由首次 State Validator 直接通过。因此本次没有 `resync-analyzer-fallback` 诊断；“结算预算为 1 且状态校验失败时跳过第二个 Settler、诊断记录 `settlementAttempts: 1`”仍由离线回归覆盖，不能把本次普通 Analyzer 调用误记为 resync fallback。
- 第 1 章共 10 次调用、`109101` tokens，超过单章 `100000` 门禁 9.1%。Scheduler 在章末立即持久化 `paused/action=pause`，`lastFailureKind=budget`，没有进入第 2 章或继续恢复调用；最终完成 1/3 章，总量 `142951` tokens。章节真相 Markdown/JSON 均非空，章节索引为 `ready-for-review`，快照为 `0/1`，无人值守指标持久化 revision 1、settlement 1。
- 与 8.20 样本相比，pre-chapter 成本由 `59043` 降至 `33850`；旧样本第 2 章实际 revision 2、settlement 4 的越界已不再可能。但本次第 1 章因 audit 2、revision 1 和修订后真相重建，比旧样本健康首章 `82089` 多 `27012` tokens，仍无法满足单章预算。

本轮证明调用前治理预算和失败后立即暂停都已在真实 provider 路径生效，但三章门禁仍未通过。下一开发目标不是提高 token 或治理上限，而是压缩“一次修订 + 修订后真相重建”路径：优先减少 Auditor/Reviser 重复上下文与 completion，评估正文变化后 Analyzer 和 Settler 结果能否复用，并保持 State Validator 与快照完整性。完成确定性成本变化和离线回放后再运行三章；三章通过前不恢复五章或 daemon。

本轮最终 `pnpm verify` 通过：Core 131 个测试文件、1446 项，Studio 34 个测试文件、405 项，CLI 36 个测试文件、210 项，共 2061 项；hygiene、typecheck、语义审计、build、bundle 和 publish manifest 同时通过。

### 8.22 局部修订与复核提示词降本（2026-07-15）

针对 8.21 首章“一次修订 + 二次审计 + 最终真相重建”达到 `109101` tokens 的热点，本轮先完成确定性离线降本，不提高单章、治理次数或 prompt 上限。

- 确定性写后校验现补齐 typed `repairScope`。禁用句式、破折号、疲劳词、短段和其他表面问题标记为 `local`；整章第一人称漂移保持 `structural`；书级禁忌保持 `unknown`，避免把需要场景级重写的问题强行路由为局部补丁。
- Reviser 的输出新增 `changeKind=patch|rewrite`。patch-only 只接受逐字唯一命中的 `TARGET_TEXT/REPLACEMENT_TEXT`，禁止整章重写和剧情事实变化；其提示词不再携带 ledger、hook debt、hooks、卷纲、世界设定、角色矩阵、历史摘要、正典等完整重写上下文，也不再要求生成不会被自动审校消费的 state/hooks/ledger 输出。
- 局部补丁后的第二次 Auditor 改为问题复核模式：保留最终正文、上次阻塞问题、当前 state、hooks、章节 memo、规则栈、受控上下文和上一章，只检查原问题是否关闭以及是否引入新的 critical 矛盾；支线、情绪、角色矩阵、历史摘要、正典和文风全文不再重复。结构性或未知范围的改写仍执行完整审计。
- 离线成本门禁要求同一上下文下 patch-only Reviser prompt 小于完整结构重写 prompt 的 70%，局部修订复核 prompt 小于完整 Auditor prompt 的 60%；两项均已进入回归测试。
- Chapter Analyzer 没有被删除。8.21 的 Writer 结算基于 2039 字初稿，而最终正文经历 2025→1029 的压缩和后续补丁；旧 Settler 真相不能安全复用。Analyzer 仍负责重建章节摘要、支线、情绪、角色矩阵和最终 state/hooks，State Validator、快照与失败恢复合同保持不变。

本轮 `pnpm verify` 通过：Core 131 个测试文件、1449 项，Studio 34 个测试文件、405 项，CLI 36 个测试文件、210 项，共 2064 项；hygiene、typecheck、语义审计、build、bundle 和 publish manifest 同时通过。下一有效样本是保持 8.21 全部阈值重跑三章，重点比较 Reviser 与第二次 Auditor 的 prompt/completion、单章总量、治理次数和真相完整性；三章通过前不恢复五章或 daemon。

### 8.23 DeepSeek 官方真实前后端 20 章联动（2026-07-16）

本轮使用 DeepSeek 官方 `deepseek-v4-flash`，通过 linked acceptance 的浏览器、Studio API/SSE、Core、持久化和 Doctor 全链路执行 20 章、每章 1000 字的 report-only 长跑。运行不设置总 token 或单次 prompt 硬上限，写章最多重试 3 次；目标是观察真实长距离状态稳定性，不再把写作成本作为停止条件。密钥只存在于隔离运行时配置，没有写入报告或提交文件。

- 实际运行时 telemetry 为 310/310 success、0 error、0 retry；provider 汇总的总 usage 为 `3,848,794` tokens，最大估算 prompt `23,402`。部分响应的总 usage 还包含供应商单独计入的 token 类别，因此不在本文用 prompt/completion 两列反推总量。
- 第 1-15 章全部持久化为 `ready-for-review`，字数范围为 852-1252，Doctor 均能按 operation 关联。持久化项目的章节索引为 15 条，`manifest.lastAppliedChapter=15`、`current_state.chapter=15`，快照目录为 `0..15`。
- 第 16 章在报告中出现 `audit-failed` 中间态，但实际章节文件和索引都不存在，说明事务保护没有把未完成章节提交。父进程随后被外部终止，报告仍停在 `status=running`；其顶层 `totalTokens` 和章节数组不是最终权威数据。
- 报告明细与实际运行时 JSONL 数量不同：部分恢复/重试 operation 没有被最终报告完整归并。上述 310 次和 `3,848,794` tokens 来自隔离项目 `.inkos/runtime/llm-calls/<book>.jsonl`，章节终态来自实际 index/truth/snapshot，而不是未完成报告的顶层字段。
- 第 15 章 resync fallback 生成的 `pending_hooks.md` 和 `hooks.json` 使用 `H025 (“查”字条)`、`H027 (老李的纸条)`、`H028 (陈三的旧调查)` 等复合 ID。第 16 章 Planner 输出规范 ID 后被 hook ledger 判为不存在，触发连续规划失败。这是确定性的 ID 边界错误，不是 provider 网络、模型不可用或事务丢失。

结论是“连续 15 章主链路成立，20 章尚未通过”。这轮样本首次把长期状态漂移定位到 resync 输出规范化边界；修复后必须从干净项目重跑 20 章，不能从手工改过的第 15 章继续来证明完整验收。

### 8.24 resync 后伏笔 ID 规范化修复（2026-07-16）

针对 8.23 的阻断，Core 已统一标准伏笔 ID 的输入和持久化边界：

- `H/D/L + 数字` 后附半角或全角括号标题时只保留编号，例如 `H027 (Old Li's note)` 和 `H028（陈三的旧调查）` 分别变为 `H027`、`H028`；`mentor-debt (legacy)` 等语义型 ID 不变。
- Chapter Analyzer resync 输出在完整性检查和 State Validator 之前先规范化，因此验证器、`pending_hooks.md` 和随后重建的 `hooks.json` 使用相同 ID。
- 已存在的 `hooks.json` 在加载时执行相同迁移；canonical ID 冲突时保留最后一条完整记录，写入 migration warning，不尝试拼接两个可能矛盾的记录。
- 回归覆盖 Markdown 只改第一列、半角/全角标题、语义 ID 保留、结构化状态写回、冲突去重，以及 analyzer fallback 后 Markdown/JSON 同时为 `H027`。

本轮 Core 全量测试为 131 个测试文件、1452 项通过，Core typecheck 和 `git diff --check` 通过；随后完整 `pnpm verify` 为 2067 项通过。下一有效动作是新的 20 章 linked acceptance，检查第 15→16 章是否不再出现 hook ID 阻断，并补齐外部中断时的报告终态收口。

### 8.25 Ark Plan DeepSeek V4 Pro 重跑（2026-07-16）

本轮通过 Studio 浏览器、API/SSE、Core、持久化和 Doctor 的完整 linked acceptance，在全新隔离项目中运行 20 章、每章 1000 字、`report-only` 质量策略。使用 Ark Plan `deepseek-v4-pro`，不设置总 token 或单次 prompt 硬上限；凭据仅写入隔离项目的服务密钥库。

- 运行于 11:29 至 14:17，最终报告为 `failed`，共 `2,110,778` tokens。第 1-7 章均为 `ready-for-review`，Doctor 关联通过；第 3 章的 `state-degraded` 经 `repair-state` 后由 `resync` 恢复，第 5 章的 `audit-failed` 经 `revise` 恢复。
- 第 8 章在初始写入后先为 `state-degraded`。`repair-state` 保持降级，`resync` 转为 `audit-failed`，`revise` 返回 `unchanged`，`rewrite` 再次触发 `state-degraded`，后续 `repair-state` 仍为 `audit-failed`。连续写作门禁因此停止，未启动第 9 章。
- 报告的 linked gate 明确失败：仅观察到 8 个章节，且第 8 章未恢复到 `ready-for-review`；quality gate 也保留第 8 章状态和 critical audit issue。测试正常退出并清理隔离目录，故该结果不是外部中断或部分落盘。
- 同轮还发现默认 `latest-live.json` 会被并发启动器覆盖。启动器现会拒绝复用存活 launcher 的报告路径；独立长跑必须提供独占 `--linked-report` 路径。真实重跑的下一步是修复第 8 章审计失败恢复收敛，而不是再次并行启动多个 20 章运行。
