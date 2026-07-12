# InkOS 真实 LLM 测试方法与阶段记录

> 文档状态：真实 provider 测试方法与阶段记录。本文保留 2026-07-09 至 2026-07-12 的实验数据；当前全项目优先级以[当前架构与开发优先级](current-architecture-and-priorities.md)为准。下文旧 P0/P1 不应被理解为最新排期。

## 1. 文档目的

本文记录 InkOS 在真实上游 LLM、双 API 路由和多章连载场景下的测试逻辑。它补充 `pnpm test` 这类确定性回归测试无法覆盖的风险：模型格式漂移、状态结算丢失、跨供应商路由错误、真实 API 长耗时、长度治理失效和前后端调用路径差异。

本文面向开发者，不记录任何 API Key。真实测试时密钥只能来自环境变量或临时 `.inkos/secrets.json`，测试结束必须删除并扫描报告目录。

## 2. 当前结论

截至 2026-07-12，项目本地逻辑、持久化和确定性测试已经较稳，剩余质量风险主要集中在真实 LLM 编排和不同操作入口的合同一致性：

- 正文生成和状态结算不能绑定在同一个 `writer` 模型上。实测 MiniMax-M3 写正文可用，但如果同一客户端继续承担状态结算，会产生空状态 delta，触发 `state-degraded`。
- `writer` 与 `settler` 拆分后，推荐路由为：MiniMax-M3 负责 `writer` / `reviser` / `length-normalizer`，OpenRouter DeepSeek Flash 负责 `settler` / `planner` / `composer` / `state-validator` / `canon-extractor`。
- 双 API smoke 均通过，拆分后真实连载完成 4 章并保持状态链路完整；第 5 章开始后达到 20 分钟命令窗口，被手动停止。
- Studio 的 stub 模式真实后端链路现已跑通：`POST /api/v1/books/create -> create-status -> /book/:id/settings -> 写下一章 -> truth files -> runtime diagnostic` 的 Playwright E2E 通过，且不再依赖预种子书籍绕过建书阶段。
- 为支撑这条链路，`llm-stub` 已补齐 architect 与 foundation-reviewer 两类合同响应，stub 模式下建书可以生成完整 foundation，而不是只返回结构 JSON / 单节点 JSON。
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
Remove-Item .tmp-dual-api-routing\.inkos\secrets.json -Force -ErrorAction SilentlyContinue
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
- `prompt-optimization-gate.test.ts` 固化成本与质量门禁：Writer 三组系统提示词至少比记录基线低 15%，用户方向、章节任务、禁令、hook、章尾改变、Volume KR、长度 hard range 和输出合同必须保留。

离线测量结果：

| 固定语料 | 优化前估算 tokens | 当前估算 tokens | 变化 |
| --- | ---: | ---: | ---: |
| Writer 中文开篇 | 6422 | 4405 | -31.4% |
| Writer 中文常规章 | 5452 | 4281 | -21.5% |
| Writer 英文开篇 | 4584 | 3520 | -23.2% |

Planner 中文/英文仍为 2113/2031 估算 tokens，本轮没有为了追求数字而压缩其规划合同。以上只证明提示词体积下降、确定性重复被删除、关键合同仍在；真实 prose 质量、供应商 usage、缓存命中率和整章成本必须由下一次明确成本范围的 3-5 章运行验证。

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
- 将 `scripts/live-dual-api-routing.mjs` 固化为可重复的开发验收脚本，支持 `--chapters`、`--words`、`--route-mode`、`--timeout-ms`。
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
- [确定性已完成] Prompt Assembly Trace、per-source 统计、三层上下文、确定性去重、职责清理和固定语料 A/B 门禁已通过；真实 3-5 章质量与账单成本仍待验收。
- 真实 3000 字章节的 agent/phase token 成本进入报告，并建立可接受预算。

## 8. 2026-07-12 复核后的使用方式

本文第 7 节仍可作为“真实多章 LLM 质量”的专项完成定义，但不再代表整个项目的下一版本完成定义。

当前开发顺序调整为：

1. 可靠性 P0 已关闭：core command 迁移、sub-agent auditor、revise mode、受控文件 Chat edit、recovery preflight、配置锁与 workflow crash journal 均已完成。
2. 统一审计、确定性 settlement/resync、稳定 hook ID 和前端取消/恢复路径已经完成。
3. P1.1 report v2 代码已完成：service/model、token、provider retry、结构化 fallback、repair/resync、长度偏差和质量门禁均已接入。
4. Prompt Assembly Trace、per-source 统计、三层上下文、确定性去重、职责清理和固定语料门禁已经完成。
5. 当前待办是一次明确成本范围的真实 3-5 章基线；使用新 trace 建立跨 agent token 预算，并归档 provider 失败和质量样例。

当前本轮确定性基线为：Core 123 个测试文件、1314 项，Studio 33 个测试文件、402 项，CLI 36 个测试文件、207 项；根级 `pnpm release` 已完整通过，隔离 Studio E2E 为 9/9，生产依赖审计为 0。此前 preparing/committed 真实进程 recovery 连续 5 轮共 10/10、`pnpm stress:process` 的 8 worker/400 次竞争 mutation/30 轮强杀恢复结果仍有效。真实 LLM 测试必须单独报告，不得与确定性测试结果合并表述。

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
- Planner/Writer/Auditor 合同已收口，旧“7 段 memo”措辞从运行提示词和相关代码说明中移除。
- 固定语料门禁已覆盖成本、职责和关键质量合同；真实 3-5 章验证仍是独立完成条件，不得由 stub 证据替代。
