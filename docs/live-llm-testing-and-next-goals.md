# InkOS 真实 LLM 测试方法与阶段记录

> 文档状态：真实 provider 测试方法与阶段记录。本文保留 2026-07-09 至 2026-07-14 的实验与收敛记录；当前全项目优先级以[当前架构与开发优先级](current-architecture-and-priorities.md)为准。下文旧 P0/P1 不应被理解为最新排期。

## 1. 文档目的

本文记录 InkOS 在真实上游 LLM、双 API 路由和多章连载场景下的测试逻辑。它补充 `pnpm test` 这类确定性回归测试无法覆盖的风险：模型格式漂移、状态结算丢失、跨供应商路由错误、真实 API 长耗时、长度治理失效和前后端调用路径差异。

本文面向开发者，不记录任何 API Key。真实测试时密钥只能来自环境变量或临时 `.inkos/secrets.json`，测试结束必须删除并扫描报告目录。

## 2. 当前结论

截至 2026-07-14，项目本地逻辑、持久化、确定性测试和前后端联动合同已经较稳，剩余质量风险主要集中在真实 LLM 编排、内容质量、耗时和成本：

- 正文生成和状态结算不能绑定在同一个 `writer` 模型上。实测 MiniMax-M3 写正文可用，但如果同一客户端继续承担状态结算，会产生空状态 delta，触发 `state-degraded`。
- `writer` 与 `settler` 拆分后，推荐路由为：MiniMax-M3 负责 `writer` / `reviser` / `length-normalizer`，OpenRouter DeepSeek Flash 负责 `settler` / `planner` / `composer` / `state-validator` / `canon-extractor`。
- 双 API smoke 均通过，拆分后真实连载完成 4 章并保持状态链路完整；第 5 章开始后达到 20 分钟命令窗口，被手动停止。
- Studio 的 stub 模式真实后端链路现已跑通：`POST /api/v1/books/create -> create-status -> /book/:id/settings -> 写下一章 -> truth files -> runtime diagnostic` 的 Playwright E2E 通过，且不再依赖预种子书籍绕过建书阶段。
- 为支撑这条链路，`llm-stub` 已补齐 architect 与 foundation-reviewer 两类合同响应，stub 模式下建书可以生成完整 foundation，而不是只返回结构 JSON / 单节点 JSON。
- 浏览器请求、Studio API/SSE、Core operation、LLM telemetry、章节落盘和 Doctor 筛选已经由 `pnpm test:linked` 统一验收；`audit-failed`、重复问题和提示词发送前预算也有跨层回归保护。
- 仍需解决的主要问题是：planner memo 偶发 parse retry、canon extractor 偶发 schema fallback、MiniMax 正文字数偏超、真实多章运行耗时偏长。
- 2026-07-12 的 Studio + OpenRouter DeepSeek V4 Pro 三章复测曾暴露长 hook ID、独立审计合同、Settler/resync 完整性、跨语言 hook 类型和前端取消/恢复问题；这些代码项现已关闭，下一次真实 3-5 章运行负责验证修复效果和成本。
- 2026-07-12 已完成一轮不调用真实 API 的提示词与上下文治理：Prompt Assembly Trace、确定性去重、三层上下文、Planner/Writer/Auditor 职责收口和固定语料 A/B 门禁已落地。它提供成本回归证据，但不能替代真实 3-5 章质量测试。
- 章节事务、workflow crash journal、book/config 跨进程锁、恢复前置、Session 路径校验和 Studio 本地安全边界已在平台复核中补齐；8 worker 竞争写入和 30 轮真实强杀恢复通过，这些问题不再列为真实 LLM 测试待办。

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

最低要求：

- OpenRouter `deepseek/deepseek-v4-flash` 返回短句确认。
- MiniMax `MiniMax-M3` 返回短句确认。
- 记录 `service`、`model`、`apiFormat`、`stream`、usage。
- 不把密钥写入报告。

### 3.3 路由探针

真实多模型测试前必须探测 agent 到模型的实际映射，不能只看配置文件。

当前必须检查：

- `writer` 是否路由到 MiniMax-M3。
- `settler` 是否路由到 OpenRouter DeepSeek Flash。
- `planner`、`composer`、`state-validator`、`canon-extractor` 是否按预期回落到默认模型或指定模型。

原因：`modelOverrides` 的错误服务名、错误 `apiFormat`、缓存 key 不完整都会造成“看似配置成功，实际调用错上游”。

### 3.4 多章连载实测

真实连载测试不能停在单章。最低建议：

- 新建临时项目，例如 `.tmp-dual-api-routing`。
- 使用真实 API 创建书籍。
- 连写 3-5 章，目标字数建议先用 1000 字降低成本。
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

测试结束后清理：

```powershell
Remove-Item Env:\OPENROUTER_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:\MINIMAX_API_KEY -ErrorAction SilentlyContinue
Remove-Item .tmp-dual-api-routing -Recurse -Force -ErrorAction SilentlyContinue
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
