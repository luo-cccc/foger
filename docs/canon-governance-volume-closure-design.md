# InkOS 设定治理与卷级闭环开发方案

> 文档状态：专项设计与历史落地记录。Canon、claim、volume、current arc 和 hook gate 协议仍以本文为设计依据；全项目当前架构、可靠性边界和开发顺序以[当前架构与开发优先级](current-architecture-and-priorities.md)为准。

## 1. 背景与问题定义

InkOS 当前已经具备章级输入治理能力：建书阶段生成基础设定，规划阶段产出 `chapter_memo`，编排阶段生成 `context.json`、`rule-stack.yaml`、`trace.json`，写作后再经过审计、修订和状态结算。这个链路能显著降低单章跑偏，但要稳定写完一卷，还需要把设定和卷级目标提升为可执行协议。

本方案要解决五类风险：

- 高密度自定义设定不能只靠 prompt 消化。设定必须进入结构化、可校验、可追踪的权威层。
- 主角体系与世界体系不能混读。世界体系定义客观边界，主角体系定义主角进入、利用、对抗、偏离或重构世界规则的路径。
- 主角特例、角色认知、组织规则、隐藏真相、传言、临时状态都需要作用域判断，不能被模型默认当成全局事实。
- 稳定写完一卷需要卷级运行协议，而不是把多个合格单章简单堆叠。
- 文笔模型不能拥有设定裁决权。文笔模型只负责渲染，设定裁决权归属 `claims + gates + validators`。

## 2. 现有 InkOS 能力映射

现有系统已经提供了可演进的地基，且本文档中的多数协议层已经进入代码：

- `ArchitectAgent` 已生成 `story_frame`、`volume_map`、`roles`、`book_rules`、`pending_hooks`，其中 `story_frame` 承载世界底色与终局方向，`roles` 承载主角弧线，`volume_map` 承载卷级 OKR、卷尾不可逆事件和节奏原则。
- `PlannerAgent` 已生成章级 `chapter_memo`，把当前任务、读者期待、hook 账、章尾变化和禁区落成写作指令。
- `PlannerAgent` 已生成 `story/runtime/tier2_current_arc.md`，把活跃支线、近期情绪轨迹、叙事压力和下一章规划焦点转成运行时投影。
- `Composer` 已生成 `context.json`、`rule-stack.yaml`、`trace.json`，并注入 claim brief、卷级 contract/progress/gate、当前叙事弧等受保护上下文。
- `RuntimeStateDelta`、`applyRuntimeStateDelta` 和 `validateRuntimeState` 已提供状态闭环基础，能避免模型直接改写 truth files。
- `modelOverrides` 已支持按 agent 路由模型，包含 `canon-extractor`、`claim-validator`、`volume-auditor`、`state-validator` 等结构化治理 agent。

本方案不推翻这些能力，而是在现有 `planner -> composer -> writer -> auditor -> reviser -> state` 链路旁增加“设定协议层”和“卷级协议层”。

## 3. 当前实现状态（截至 2026-07-11）

已落地能力：

- 设定协议：`CanonClaimSchema`、`story/canon/*.json` 存储、`CanonExtractor`、`ClaimValidatorAgent` 已实现；建书、修订基础设定（`reviseFoundation`）和番外建书（`initSpinoffBook`）都会从 prose foundation 抽取结构化 claims，失败时降级为 warning，不阻断流程。
- 章级 claim 工作集：`ChapterClaimCompiler` 已写入 `chapter-XXXX.claims.json` 和 `chapter-XXXX.claim-brief.md`；Composer 会把 claim brief 作为受保护上下文注入，并运行 pre-write claim gate。
- 卷级闭环：`VolumeContract`、`volume-contracts.json`、`volume-progress.json`、`volume-dashboard.md`、`VolumeAuditorAgent` 已实现；Planner/Composer/Runner 已接入卷级 KR 绑定、pre/post gate 和可视进度记录。mini-cycle gate 每章 pre-write 运行，默认 5 章滑动窗口（`miniCycleWindow` 可配）；卷尾 critical 检查只在规划的最后一章触发一次，写作溢出后续章不再重复报。
- 当前叙事弧：Planner 已生成 `tier2_current_arc.md`；Composer 以 `runtime/current_arc` 注入上下文；trace 会记录为 protected source；回滚章节会删除该聚合投影。活跃支线判定以状态列为准，不被非状态列的活跃词误判。
- Hook 债务：Planner 已接入可回收 hook；`validateHookLedger` 已检查 memo 中 advance/resolve 的正文证据，并对 resolve 强制执行“揭 1 埋 1”底线。
- 多模型路由：Phase 7 agent 名单已进入 CLI、Studio 和 core 路由配置；`resolveOverride` 的路由决策（字符串简写 / 完整 override / 独立 baseUrl 的专属 client 缓存）已有单测覆盖。
- Studio 诊断：Studio truth browser 已以只读 runtime diagnostic 展示 claim、volume、current arc 等运行产物。

### 3.1 审查与加固记录（2026-07-08 复核）

一轮针对"文档声称 vs 实际实现"的交叉审查确认 Phase 1-9 均真实落地、接线入主链路，并修复了审查发现的全部在正常运行路径上的缺口，均带反证过的回归测试：

- [已修] `reviseFoundation` / `initSpinoffBook` 重写 prose foundation 后未重新抽取 canon，导致 `story/canon/*.json` 落后于设定（revise 用旧 claims、番外 claim gate 空转）。
- [已修] 当前叙事弧的活跃支线判定误用整行关键词扫描，"进度概述/压力"列出现活跃词会把已完结支线误判为活跃；改为以状态列为准。
- [已修] 卷尾 critical 检查用 `>=` 判定，写作溢出卷范围后每章重复报卷尾问题；改为只在规划最后一章触发一次。
- [已修] `PostWriteClaimGate` 的绕过检测把"直接/照样/仍然"等常见叙事副词当作绕过信号，正常正文误报 hard/institution-rule-bypass critical；收紧为只认强环节词。
- [已补] Phase 7 路由的决策逻辑（`resolveOverride` 各分支 + client 缓存）此前只测常量名单，现有单测覆盖。
- [已补] CanonExtractor 抽取质量基准（golden-corpus 召回率下限 + 硬不变量），覆盖中文标准/英文/中文变体标题三类语料。
- [已补] hook ledger "揭 1 埋 1" critical 经 Runner post-write 汇入审计结果的端到端测试（与 claim gate 端到端路径对称，此前只有单元测试）。
- [已补] volume gate `volume-kr-not-visible` warning 经 Runner post-write 汇入审计结果的端到端测试。至此三大 post-write 门禁（claim / hook-ledger / volume）均有"issue 经 Runner 汇入审计结果"的端到端覆盖。
- [已修] `runtime/canon_validator`（确定性 canon schema/治理问题，reason 为"起草前必须遵守"）此前不在受保护上下文源列表，与同源同级的 `runtime/pre_write_claim_gate` 不一致，预算紧张时可能被压缩丢弃；已加入 `isProtectedContextSource` 并补断言。

截至 2026-07-08 该轮专项复核，当时审查范围内可安全闭环的代码缺口与集成测试缺口均已处理；这条结论只针对该轮 canon/volume 审查范围，不代表全项目没有后续技术债。

### 3.2 开发进度与质量复核（2026-07-09）

一轮面向当时工作区的实现审查再次确认：本文档声明的 Phase 1-9 不是纯设计稿，关键能力均能在 `packages/core`、`packages/cli`、`packages/studio` 的源码、测试和构建产物中找到对应落点。该次复核按文档目标、源码接线、测试覆盖和构建结果判断；当前仓库状态与后续优先级统一以 `current-architecture-and-priorities.md` 为准。

复核结果：

- 完成度判断：核心治理协议和确定性门禁已经进入可运行基线；结构与接线质量较高，真实模型语义质量仍属持续增强。全项目不再使用单一百分比描述完成度，按能力域的实际状态和质量边界见[当前架构与开发优先级](current-architecture-and-priorities.md#11-实际完成度与质量矩阵)。
- 验证命令：`pnpm build` 通过；`pnpm test` 全工作区通过；`pnpm --filter @actalk/inkos-core typecheck` 通过；`pnpm --filter @actalk/inkos-studio typecheck` 通过。
- 定向治理验证：core 9 个相关测试文件共 108 个测试通过，覆盖 canon schema/extractor/quality、claim gate、composer 注入、volume contract、hook ledger、model override routing、long-form governance corpus；Studio 5 个相关测试文件共 126 个测试通过，覆盖 runtime diagnostic、truth display、governance overview、模型配置展示；CLI 集成 45 个测试通过，覆盖 Phase 7 agent 配置展示和 plan/compose 基础路径。
- 主链路一致性：Canon 抽取、章级 claim working set、pre/post claim gate、卷级 gate、current arc protected context、hook ledger gate、多模型路由和 Studio 只读诊断均有源码实现与回归测试对应。
- 构建质量信号：Studio 生产构建通过，但 Vite 报出部分 chunk 超过 500 kB 的体积警告；测试输出中仍有 Node `punycode` deprecation warning 和 SQLite experimental warning。这些不是功能失败，但属于后续工程治理项。

本次复核结论：项目不再处于“等待实现”的阶段，已经具备可运行、可回归的设定治理与卷级闭环主干。当前质量边界应描述为“高风险治理与结构化协议已可用”，不能描述为“完整语义证明已完成”。

仍需增强的部分：

- Canon 抽取和 claim gate 目前是"结构化协议 + 高风险检测"，不是完整语义证明。
- 卷级 / claim / hook gate 的阈值与抽取质量基准已有确定性回归、golden-corpus 覆盖和轻量 long-form governance corpus 测试，但仍缺跨多章、跑完整 planner→writer→auditor 链路的真实长篇 corpus 回归（需要独立的多章 fixture 基建）。
- Studio 已能展示诊断文件，但更友好的图形化治理面板仍是后续 UX 工作。
- Studio 前端构建仍有较大的 chunk，需要后续按高亮/图表/mermaid 等重依赖做更细粒度 code splitting。

### 3.3 真实 LLM 路由复核（2026-07-10）

新增开发测试记录见 `docs/live-llm-testing-and-next-goals.md`。本次复核重点不是确定性单测，而是真实 OpenRouter + MiniMax 双 API、多 agent 路由和多章连载。

复核结论：

- 本地确定性质量仍通过：`pnpm typecheck` 全工作区通过，`pnpm test` 全工作区通过；定向 `model-override-routing` 与 `writer` 测试通过。
- 双 API smoke 通过：OpenRouter `deepseek/deepseek-v4-flash` 和 MiniMax `MiniMax-M3` 均可用 OpenAI-compatible Chat 非流式调用。
- 路由能力已增强：`modelOverrides` 支持 `service` / `apiFormat`，可避免不同上游共用错误 client；`writer` 和 `settler` 已拆成可独立路由的调用阶段。
- 实测推荐分工：MiniMax-M3 负责正文相关的 `writer` / `reviser` / `length-normalizer`，OpenRouter DeepSeek Flash 负责结构和状态相关的 `settler` / `planner` / `composer` / `state-validator` / `canon-extractor`。
- 真实连载结果：拆分 `settler` 后完成 4 章并保持 `current_state.md`、`pending_hooks.md`、`chapter_summaries.md`、结构化 state JSON、hook JSON 和 `0..4` 快照完整；第 5 章开始后达到 20 分钟测试窗口，被手动停止。

本次暴露的核心风险：

- 正文模型不能默认承担状态裁决。MiniMax-M3 正文可用，但若同一 writer 客户端继续做状态结算，会产生空状态 delta 并触发 `state-degraded`。
- planner memo 和 canon extractor 在真实模型下仍会出现格式漂移，当前依靠 retry / fallback 承接，但需要样例库和报告化。
- MiniMax-M3 在 1000 字目标下有偏超倾向，长度归一化需要升级为更硬的门禁和二次修正。
- 多章真实运行耗时不可忽略，需要调用级 timeout、阶段级 telemetry、可恢复报告，以及 Studio 在真实服务配置/错误诊断/长耗时反馈层面的进一步 E2E。

### 3.4 Studio 实际进度补充（2026-07-10）

对 `packages/studio` 与其 E2E 的进一步复核显示：Studio 已不只是“能展示诊断文件”，而是已经具备一条可回归的真实后端 authoring 主链路。

- `playwright.config.ts` 已支持在 Playwright 浏览器下载失败时回退到本机 Chrome/Edge，避免环境问题阻塞前端验收。
- `BookDetail.tsx`、`TruthFiles.tsx` 已补足稳定的 `data-testid`，可用于“写下一章”“打开 truth files”“定位 chapter row / runtime diagnostic”这类高价值交互。
- `authoring.spec.ts` 已从预种子书工作台流程切回真实建书流程：调用 `/api/v1/books/create`、轮询 `/create-status`、进入 `/book/:id/settings` 写第 1 章，再打开 truth files 与 runtime diagnostic。
- 为支撑该流程，`packages/core/src/agent/llm-stub.ts` 已补齐 architect 与 foundation-reviewer 的合同响应，stub 模式下也能完成完整 foundation 落盘，不再需要靠 `e2e-seeded-book` 绕过建书。

这使得本文档原先把“Studio 真实后端 E2E”视作纯待办的表述需要收缩。当前更准确的表述应是：Studio 的 stub-mode 真实后端 authoring E2E 已完成，下一步应聚焦真实服务配置、测试连接、错误诊断面板与长耗时反馈，而不是重复补主链路。

### 3.5 Studio LLM 诊断与遥测进度补充（2026-07-10）

在 3.4 所述“stub-mode 真实后端 authoring E2E 已完成”的基础上，`packages/studio` 又向前推进了一层：Studio 不只是能打开 truth files 和 runtime diagnostic，而是已经开始把真实 LLM 调用过程本身变成可读的诊断界面。

- `packages/core` 已统一产出调用级 telemetry：阶段名、agent、service、model、duration、timeout、token usage、partial content length、error message 等字段可被 CLI / Studio 共用。
- `packages/cli` 与 `packages/studio` 已接入 `INKOS_LLM_TIMEOUT_MS` 默认超时配置，真实多章长跑时不再只能依赖单次调用硬编码。
- Studio server 已把 `llm:telemetry` 通过 SSE 推给前端；前端 store 已能在会话流中持续吸收这些事件。
- Doctor 页面、书籍侧边栏、聊天页会话条、工具执行卡都已展示最近 LLM 调用，不再只在失败后靠一条最终 error string 反推上下文。
- Studio 已为常见上游问题提供根因摘要与问题类型聚合，当前可识别：timeout、partial stream、thinking/reasoning 兼容问题、malformed function call、empty response、context limit、content policy、provider unavailable、rate limit、auth、slow success。
- 诊断信息已从“单条错误可见”提升到“最近主要问题类型可见”：Doctor、侧边栏与聊天页会展示最近最常见的根因类别及次数，适合真实 API 长耗时与间歇失败的现场定位。

因此，本文后续关于 Studio 的待办表述需要更精确地理解为：

- 已完成的不是“最终形态诊断中心”，而是 Studio LLM 诊断的第一层可用能力。
- 下一步不应重复建设“是否显示 telemetry”，而应聚焦“按 service/model/agent 聚合热点”“真实服务配置与测试连接 E2E”“诊断与治理产物联动跳转”。

### 3.6 平台可靠性复核（2026-07-11）

本轮全项目审阅补齐了治理协议之外的持久化、并发和本地 API 边界：

- 章节索引、运行状态、secrets、book config 与项目配置均使用原子替换；Studio、CLI 和 config migration 共享跨进程 `.inkos-project-config.lock`，支持死 PID 陈旧锁回收。
- 章节多文件持久化已增加事务 marker、提交、失败回滚和启动前恢复，避免正文、索引、结构化 state 与投影出现部分落盘。
- Studio、CLI、Chat 和 sub-agent 的章节、truth、审批、书籍设置和长操作均接入 core mutation/book lock；sub-agent auditor 不再直接调用 Pipeline。
- rewrite 已收敛为 core 的单锁用例，在同一临界区内完成回滚与再生成。
- book config 在 load/save 和 Studio 更新时执行完整 schema 校验；不存在章节的 approve 与不存在书籍的 delete 均返回统一 typed not-found 合同。
- sessionId 进入路径前统一校验；transcript 追加改为增量缓存和 TTL 回收。
- Studio 默认监听 `127.0.0.1`，移除 wildcard CORS，并停止向前端返回原始服务密钥。
- revise mode 已在 core 边界运行时校验，legacy `local-fix` 映射为 `spot-fix`；Studio Chat 不能直接覆盖 book config、章节索引、事务/锁文件或 story 内部权威目录。
- revise、repair-state、resync 和 import 在持锁后统一执行章节事务 recovery preflight；plan/compose/audit/consolidate 使用独立 workflow crash journal 和备份目录保护 runtime、audit 与 summary 输出。
- 生产依赖审计由 84 条公告降至 0；全量 1852 个确定性测试（core 1253、Studio 392、CLI 207）、类型检查、构建与发布清单检查通过。隔离 Studio E2E 完整套件为 8/8，preparing/committed 真实进程 recovery 场景连续 5 轮共 10/10，`pnpm release` 全绿。
- `pnpm stress:process` 通过：8 worker 完成 book/config 各 200 次竞争 mutation，并完成 workflow 20 轮、chapter 10 轮 preparing/committed 真实强杀恢复，验证回滚、提交保留、marker/backup 清理和陈旧锁回收。

这些修改不改变本文的设定治理协议，但明确了协议产物的提交语义：治理结果只有在章节事务提交后才成为新的可见 truth；失败恢复不能留下“章节已写、治理状态未推进”的半完成状态。

## 4. 设定治理核心模型

### 4.1 CanonClaim

引入 `CanonClaim` 作为所有设定判断的统一抽象。每条设定都必须回答：

1. 这是什么？
2. 对谁成立？
3. 在什么时候成立？
4. 它和其他设定冲突时谁优先？
5. 当前读者或角色是否知道？
6. 它能否被泛化给其他角色或世界整体？

建议最小结构：

```ts
type CanonClaim = {
  id: string;
  domain:
    | "world"
    | "protagonist"
    | "character"
    | "organization"
    | "power"
    | "relationship"
    | "history"
    | "style";
  claimType:
    | "objective_rule"
    | "institution_rule"
    | "character_exception"
    | "belief"
    | "rumor"
    | "secret_truth"
    | "temporary_state"
    | "prohibition";
  content: string;
  scope: {
    appliesTo: string[];
    excludes?: string[];
    geography?: string[];
    timeRange?: string;
  };
  authority: {
    source: string;
    priority: "hard" | "strong" | "soft";
  };
  visibility: {
    readerKnownFrom?: number;
    characterKnownBy?: string[];
    hiddenFrom?: string[];
  };
  relations?: {
    conflictsWith?: string[];
    resolvesBy?: string;
    dependsOn?: string[];
  };
  constraints?: {
    nonGeneralizable?: boolean;
    requiresCost?: string[];
    forbiddenUses?: string[];
  };
};
```

### 4.2 Claim 类型

- `objective_rule`：世界客观规则，默认全局成立。
- `institution_rule`：组织、制度、地区、阶层内部规则，只在指定作用域内成立。
- `character_exception`：角色特例，默认不可泛化。
- `belief`：角色相信的事，可能为假。
- `rumor`：流言，低可信，不能当作客观事实使用。
- `secret_truth`：客观真相，但在指定章节前不能泄露给读者或角色。
- `temporary_state`：当前状态，允许随章节推进变化。
- `prohibition`：禁止事项，拥有最高门禁优先级。

### 4.3 主角体系、世界体系与关系层

三者必须分离：

- 世界体系：这个世界允许什么。它定义力量、资源、组织、阶层、技术、法则、上限、代价和禁忌。
- 主角体系：主角如何进入、利用、对抗、偏离或重构世界体系。它描述起点、特殊性、成长路径、代价和不可泛化项。
- 关系层：主角体系与世界体系如何发生冲突。它说明主角是顺应体系、钻体系漏洞、被体系排斥、对抗体系，还是最终重构体系。

主角体系不一定适配世界体系，这种“不适配”本身常常是长篇的核心张力。模型必须被明确告知：主角例外不是世界通用规则，主角绕开规则不等于规则失效。

关系层建议记录：

```text
system_relation:
  mode: obey | exploit | resist | excluded | hybrid | rewrite
  conflict_points:
    - 主角体系与世界体系冲突在哪里
  non_generalizable:
    - 哪些主角能力、经验、资源不能推广给其他角色
  audit_rules:
    - 写作时必须检查的越界项
```

## 5. 数据落盘形态

新增设定治理目录：

```text
story/canon/claims.json
story/canon/world_system.json
story/canon/protagonist_system.json
story/canon/system_relations.json
```

新增章级运行产物：

```text
story/runtime/chapter-XXXX.claims.json
story/runtime/chapter-XXXX.claim-brief.md
story/runtime/tier2_current_arc.md
story/runtime/volume-contracts.json
story/runtime/volume-progress.json
story/runtime/volume-dashboard.md
```

新增卷级运行产物：

```text
story/runtime/volume-XXX.contract.json
story/runtime/volume-XXX.dashboard.md
```

原则：

- prose 设定仍然保留在 `story_frame`、`volume_map`、`roles`、`book_rules` 中，不能被纯 JSON 替代。
- `story/canon/*.json` 是机器可校验的设定协议。
- `chapter-XXXX.claims.json` 是本章可使用的设定工作集。
- `chapter-XXXX.claim-brief.md` 是给 writer/auditor 读取的人类可读投影。
- `tier2_current_arc.md` 是 planner 从 `subplot_board.md` 和 `emotional_arcs.md` 生成的当前叙事弧投影，供 Composer 作为受保护运行时上下文注入。
- `volume-contracts.json` 是从 `volume_map.md` 抽取的全卷合同集合。
- `volume-progress.json` 是章级 KR 计划、可见推进和尝试推进记录。
- `volume-dashboard.md` 是全卷治理状态的人类可读诊断投影。
- `volume-XXX.contract.json` 是卷级目标、阶段供给和门禁依据。
- `volume-XXX.dashboard.md` 是给作者和 Studio 展示的卷级状态投影。

## 6. 运行数据流

### 6.1 建书与设定抽取

```text
Architect 生成 prose foundation
-> CanonExtractor 抽取 CanonClaim（LLM 抽取，失败时启发式降级并记录 warning）
-> CanonValidator / ClaimValidatorAgent 校验 claim 作用域、优先级、冲突、隐藏信息、不可泛化项
-> 写入 story/canon/*.json
-> 渲染必要的 Markdown 投影
```

Architect 继续负责“有灵气的设定 prose”。结构化 claim 不应该强塞进 Architect 的一次性输出中，否则会稀释基础设定质量。更稳妥的做法是通过后处理 extractor 从 prose 中抽取 claim。

canon 抽取现覆盖三个会重写 prose foundation 的触发点，保证 `story/canon/*.json` 不落后于设定：建书（`PipelineRunner.createBook`）、修订基础设定（`reviseFoundation`，抽取会覆盖旧 claims）、番外建书（`initSpinoffBook`，为番外生成独立 canon 供其 claim gate 使用）。三处均复用同一 `extractInitialCanon()`，抽取失败非致命，只记录 warning。

### 6.2 章级写作

```text
Planner 生成 chapter_memo
-> Planner 写入 tier2_current_arc.md，记录当前叙事压力、活跃支线、近期情绪轨迹和下一章规划焦点
-> ChapterClaimCompiler 根据 memo、POV、当前卷、当前状态选出本章 claim working set
-> PreWriteClaimGate 检查 memo 是否越权使用设定
-> Composer 写入 chapter-XXXX.claims.json / claim-brief.md，并把 runtime/current_arc、runtime/chapter_claim_brief、runtime/canon_validator、runtime/pre_write_claim_gate、runtime/volume_contract、runtime/volume_progress、runtime/volume_gate 注入 context.json / trace.json（均为受保护源，预算紧张时不参与压缩）
-> Writer 只基于可用 claim 渲染正文
-> PostWriteClaimGate / HookLedgerGate / VolumeGate 检查正文是否误用设定、是否兑现 hook 账和卷级 KR
-> Auditor / Reviser / StateValidatorAgent 处理问题
-> State delta 只更新运行态，不直接改硬设定
```

### 6.3 卷级闭环

```text
VolumeContract 从 volume_map 抽取本卷 Objective / KR / 卷尾不可逆事件
-> 每章 memo 必须绑定至少一个卷级 KR 或明确说明本章承担的缓冲功能
-> 每章 pre-write 运行 mini-cycle gate：默认滑动窗口为 5 章（`miniCycleWindow`，可配置），当含当前章在内的整个窗口都没有可见 KR 推进时告警
-> 卷尾运行 VolumeGate
-> 未达成关键 KR 或硬约束破坏时阻止进入下一卷或要求人工确认
```

卷级闭环不是章级审计的重复。它检查的是：这一组章节是否让本卷向终点移动，是否持续供给主角阶段、世界揭示、关系张力、前台目标、后台暗线和 hook 回收。

## 7. 开发模块设计

### 7.1 CanonExtractor

状态：已落地。

职责：

- 从 `story/outline/story_frame.md` 抽取世界体系、世界铁律、终局方向、客观限制。
- 从 `story/roles/**/*.md` 抽取主角体系、角色特例、行为边界、关系动态。
- 从 `story/book_rules.md` 抽取硬禁令、主角性格锁、题材锁、能力上限。
- 从 `story/outline/volume_map.md` 抽取卷级目标、阶段限制、世界揭示计划。

输出：

- `claims.json`
- `world_system.json`
- `protagonist_system.json`
- `system_relations.json`

当前实现由 `PipelineRunner.extractInitialCanon()` 在三个会重写 prose foundation 的触发点调用：建书、`reviseFoundation`、`initSpinoffBook`；抽取失败时不阻断流程，但会记录 warning，保证旧项目和不完整输入仍可继续。

### 7.2 CanonValidator

状态：已落地核心能力。

职责：

- 校验 claim 是否具备必要字段。
- 校验 `character_exception` 是否默认带 `nonGeneralizable` 或明确解释可泛化条件。
- 校验 `secret_truth` 是否具备 reader/character 可见性边界。
- 校验冲突关系是否有 `resolvesBy`。
- 校验硬禁令和世界客观规则是否不会被低优先级 claim 覆盖。

`ClaimValidatorAgent` 已作为 agent wrapper 接入 Runner/Composer，用于 claim 校验和 pre-write gate；当前目标是高风险检测，不宣称完整语义证明。

### 7.3 ChapterClaimCompiler

状态：已落地，并补齐揭示意图桥接。

职责：

- 根据本章 `chapter_memo`、POV、当前卷、当前状态和近期 hook 选择相关 claims。
- 将 claims 分为可使用、必须隐藏、禁止泛化、需要代价、冲突解析五组。
- 生成 `chapter-XXXX.claims.json` 和 `chapter-XXXX.claim-brief.md`。
- `revealNow`：当 memo 以揭示类线索词（+主题点名）提交本章揭示承诺时，把对应隐藏 claim 提升为「必须揭示」义务（推迟类线索词显式抑制），供 PostWriteClaimGate 校验揭示是否真的落台面。

Writer 看到的不是全量设定，而是本章可用设定工作集。

### 7.4 PreWriteClaimGate

状态：已落地高风险版本。

职责：

- 检查 memo 是否引用了当前时间点不可用的 claim。
- 检查 memo 是否要求角色知道其不该知道的信息。
- 检查 memo 是否把主角特例当成世界通用规则。
- 检查 memo 是否违反硬禁令或世界硬上限。

### 7.5 PostWriteClaimGate

状态：已落地高风险版本。

职责：

- 从正文中抽取高风险 claim usage。
- 检查主角特例是否被泛化给配角、组织或反派。
- 检查世界规则是否被无代价绕过。绕过信号只认强环节词（无视 / 绕过 / 越过 / 破例 / 失效 / 无需代价 / bypass / ignore 等），不把「直接 / 照样 / 仍然」这类常见叙事副词当作绕过信号，避免正常正文触发误报 critical。
- 检查隐藏真相是否提前泄露。
- 检查角色是否出现信息越界。
- 检查组织规则是否无原因失效。

v1 只需要覆盖高风险误用，不要求完整语义证明。

### 7.6 VolumeContract 与 VolumeGate

状态：已落地。

`VolumeContract` 维护：

- 本卷 Objective。
- 3 个 Key Results。
- 卷尾不可逆事件。
- 主角阶段目标。
- 世界规则释放计划。
- 核心关系张力。
- 前台目标与后台暗线。
- 本卷必须推进或回收的 hook 债。

`VolumeGate` 检查：

- 每个 mini-cycle 窗口（默认 5 章，`miniCycleWindow` 可配置）是否推进至少一个 KR。
- 主角体系阶段是否发生可观察变化，并支付相应代价。
- 世界体系是否按计划揭示，且没有提前泄露。
- 核心关系张力是否持续供给，而不是停留在标签关系。
- hook 债是否失控膨胀。
- 卷尾不可逆事件是否落地。

卷尾类 critical 检查（KR 完整性、不可逆事件、供给项落地）只在本卷规划的最后一章（`chapterNumber === chapterEnd`）触发一次；写作溢出卷范围的后续章节（回退到最后一卷的 contract）不会再重复报卷尾问题。

当前实现会生成 `volume-contracts.json`、`volume-progress.json`、`volume-dashboard.md`、`volume-XXX.contract.json`、`volume-XXX.dashboard.md`，并在 Composer 中注入卷级 contract/progress/gate 作为 protected context。

### 7.7 CurrentArcSnapshot

状态：已落地。

职责：

- 从 `subplot_board.md` 选择活跃支线，识别最近触达章节、沉默章数、状态和压力说明。活跃判定以状态列（标准布局的第 7 列 `状态`）为准，只有状态列为空的非标准/旧布局才回退到整行关键词扫描，避免"进度概述/压力"列里的活跃词把已完结支线误判为活跃。
- 从 `emotional_arcs.md` 选择当前章之前的近期情绪记录，过滤未来章节，按角色合并情绪轨迹。
- 生成当前叙事压力摘要和下一章规划焦点，避免 planner 只看到原始表格行。
- 写入 `story/runtime/tier2_current_arc.md`，并由 Composer 作为 `runtime/current_arc` 注入 `context.json`。
- 在 `trace.json` 中把 `runtime/current_arc` 记录为 protected source，便于审查当前章节为什么选中某条支线或情绪压力。

边界：

- `tier2_current_arc.md` 是运行时诊断投影，不替代 `subplot_board.md` 或 `emotional_arcs.md`。
- 回滚章节后必须删除该聚合投影，由下一次 planner 重新生成，避免旧章节 arc 泄漏到新规划。
- Studio 可以展示该文件，但应作为只读 runtime diagnostic，不允许外部编辑覆盖。

### 7.8 HookLedgerGate 与 Hook 债务回收

状态：已落地。

职责：

- Planner 从记忆检索中接收可回收 hook，避免旧 hook 长期沉默。
- `chapter_memo` 的 hook ledger 区分 `open`、`advance`、`resolve`、`defer`。
- `validateHookLedger` 检查 `advance` / `resolve` 中声明处理的 hook 是否在正文中出现可观察证据。
- 当本章 resolve hook 时，强制要求同章至少 open 同等数量的新 hook，执行“揭 1 埋 1”底线。

边界：

- 当前证据检查是确定性关键词/描述符匹配，用于发现高风险遗漏；已实际推进但表达差异较大时可能需要人工复核。
- “揭 1 埋 2”保留为 planner 提示建议，不作为硬门禁，避免与单章新 hook 上限冲突。

## 8. 多模型协议编排

模型分工原则：

- `planner`、`claim-validator`、`volume-auditor`、`state-validator` 使用指令遵循强、结构输出稳定的模型。
- `writer` 使用文笔强的模型，但只负责渲染，不拥有设定裁决权。
- `reviser` 使用平衡模型，只做局部修复，不重开剧情方向。
- `auditor` 使用稳定模型，负责审查正文是否违反 memo、claims 和 volume contract。

当前 agent 级模型路由名单：

```text
writer
planner
composer
auditor
reviser
architect
canon-extractor
claim-validator
volume-auditor
state-validator
chapter-analyzer
```

核心约束：

- 文笔模型不能决定设定是否成立。
- Writer 不能自动升级硬设定、修改世界规则或把主角例外泛化。
- Auditor 和 deterministic validators 拥有门禁权。
- 设定变更必须走显式设定迁移或人工确认。

## 9. 历史分阶段落地路线

### [已落地] Phase 1：Schema 与存储

- 新增 `CanonClaimSchema` 和相关类型。
- 新增 `story/canon/` 读写工具。
- 支持手工或测试 fixture 写入 claims。

### [已落地] Phase 2：CanonExtractor

- 从现有 prose foundation 抽取初版 claims。
- 输出 `claims.json`、`world_system.json`、`protagonist_system.json`、`system_relations.json`。
- 增加 extractor 失败降级：不阻断建书，但记录 warning。

### [已落地] Phase 3：章级 claim working set

- 在 Composer 中调用 `ChapterClaimCompiler`。
- 写入 `chapter-XXXX.claims.json` 和 `chapter-XXXX.claim-brief.md`。
- `trace.json` 记录选入 claim 来源。

### [已落地] Phase 4：Writer 注入 claim brief

- Writer governed prompt 增加“本章设定工作集”。
- 明确可用规则、隐藏信息、不可泛化项、代价要求和冲突解析。

### [已落地/持续增强] Phase 5：高风险 ClaimGate

- `PreWriteClaimGate` 检查 memo。
- `PostWriteClaimGate` 检查正文。
- v1 优先覆盖主角特例泛化、隐藏信息提前泄露、世界硬规则破坏、信息越界。
- 当前仍按高风险检测定位，不追求完整语义证明。

### [已落地] Phase 6：卷级合同

- 从 `volume_map` 抽取 `VolumeContract`。
- Planner 每章绑定卷级 KR。
- 每章 pre-write 运行 mini-cycle gate（默认 5 章滑动窗口，可配 `miniCycleWindow`）。
- 卷尾运行 `VolumeGate`。
- 生成 `volume-progress.json` 和 `volume-dashboard.md`，用于审查卷级推进是否可见。

### [已落地] Phase 7：多模型路由扩展

- 扩展 agent 名单。
- 为 `canon-extractor`、`claim-validator`、`volume-auditor`、`state-validator` 支持独立模型配置。
- 在 `doctor` 或配置展示中显示这些 agent 的 effective model。

### [已落地] Phase 8：当前叙事弧运行时投影

- Planner 生成结构化 `CurrentArcSnapshot`，把活跃支线、近期情绪轨迹、叙事压力和下一章规划焦点渲染为 `tier2_current_arc.md`。
- Composer 读取 `tier2_current_arc.md`，以 `runtime/current_arc` 形式加入 governed context。
- `runtime/current_arc` 在 trace 中归入 protected source，不参与低优先级上下文压缩。
- Studio truth browser 将 `runtime/tier2_current_arc.md` 作为只读 runtime diagnostic 展示。
- 回滚章节时删除聚合投影，确保后续规划重新生成。

### [已落地] Phase 9：Hook 债务与账本硬门禁

- Planner 接收可回收 hook，避免长期沉默的 hook 被遗忘。
- `validateHookLedger` 对 memo 中 `advance` / `resolve` 的 hook 进行正文证据检查。
- resolve hook 时强制同章至少 open 同等数量的新 hook，执行“揭 1 埋 1”底线。
- 证据检查保持确定性和可解释，语义差异较大时交给人工复核。

### 后续建议

以下建议是本专项协议的后续增强项；跨模块的实施顺序以[当前架构与开发优先级](current-architecture-and-priorities.md)为准。

- 建立真实长篇多章 fixture，跑完整 planner → composer → writer → auditor → reviser → state 链路，回归 CanonExtractor、ClaimGate、VolumeGate、HookLedgerGate 的阈值和误报/漏报；真实 API 测试方法与下一阶段目标见 `docs/live-llm-testing-and-next-goals.md`。
- 将 `writer` / `settler` 拆分后的双 API 路由作为默认推荐测试矩阵：正文模型只负责渲染，状态结算模型负责事实观察、delta 生成和 truth files 推进。
- 为真实 LLM 调用增加 agent/model/service/apiFormat/stream/阶段名/耗时/超时的 telemetry，并让长调用中断后保留可读报告。
- 扩充 `long-form-governance-corpus.test.ts` 与 `canon-extraction-quality.test.ts` 的语料：覆盖更多题材、更复杂设定、跨章泄密、主角特例泛化、卷级 KR 延迟兑现、hook 回收表达差异等案例。
- 在 Studio 中把 claim、volume、current arc、hook ledger 从文件视图升级为更直观的治理面板。
- 为抽取质量和门禁误报率增加 corpus-level 评估。
- 优化 Studio 构建体积，优先拆分代码高亮、图表/mermaid、关系图等重依赖，减少首屏 chunk 压力。

## 10. 不做的事

- 不把 prose 设定替换成纯 JSON。prose 仍然是作者和模型理解故事质感的主要材料。
- 不允许章节写作自动修改硬设定。硬设定变更必须走设定迁移或人工确认。
- 不把主角例外提升为世界通用规则。
- 不要求 v1 一次性完成所有设定类型的精细校验。
- 不在 v1 追求对正文进行完整形式化证明，只做高风险误用检测和门禁。

## 11. 验收与测试建议

### 文档验收

- 文件存在于 `docs/canon-governance-volume-closure-design.md`。
- 包含问题背景、设计目标、核心模型、数据流、模块拆分、落地阶段、风险边界。
- 明确主角体系、世界体系、关系层三者的区别。
- 明确 claim 的作用域、可见性、优先级和不可泛化设计。
- 明确卷级闭环不是章级闭环的简单重复。

### 已覆盖的实现验收

- 单测覆盖 `CanonClaimSchema` 合法和非法样例。
- 单测覆盖 `CanonExtractor` 抽取、降级和输出结构。
- 单测覆盖主角特例不可泛化、POV 不可见信息不能进入 writer brief、claim gate 高风险检测。
- 集成测试覆盖 Composer 生成 chapter claim working set，并注入 claim brief 作为 protected context。
- 测试覆盖 `VolumeContract` 抽取、`VolumeGate`、`VolumeAuditorAgent`、`volume-progress.json` 和 `volume-dashboard.md`；并回归覆盖卷尾 critical 检查只在规划最后一章触发、溢出后续章不重复报；另有端到端测试验证 memo 绑定 KR 但正文未可见推进时，`volume-kr-not-visible` warning 经 Runner 的 post-write 检查汇入审计结果（三大 post-write 门禁 claim / hook-ledger / volume 均有端到端汇入审计的测试）。
- 测试覆盖 Phase 7 agent 路由：既有 agent 名单常量校验，也覆盖 `resolveOverride` 的路由决策（无 override 回退全局、字符串简写、无 baseUrl 复用基础 client、独立 baseUrl 构造专属 client 并按 cacheKey 缓存复用、`apiKeyEnv` 取密钥），以及 CLI doctor 和 Studio 模型配置展示。
- 集成测试覆盖 `tier2_current_arc.md` 生成、进入 Composer context、出现在 trace protectedSources，并在章节回滚后清理；并回归覆盖活跃支线判定以状态列为准，不被非状态列的活跃词误判。
- 测试覆盖 HookLedgerGate 对 advance/resolve 的正文证据检查和“揭 1 埋 1”底线；并有端到端测试验证 memo 的“揭 1 埋 1”违规经 Runner 的 post-write 检查汇入审计结果（与 claim gate 端到端测试同一路径）。
- 回归测试确认没有 claims 的旧书仍能走现有写作链路。
- 回归测试覆盖 `reviseFoundation` 和 `initSpinoffBook` 在重写 prose foundation 后重新抽取 canon（含抽取失败非致命降级）。
- 抽取质量基准：`canon-extraction-quality.test.ts` 用 golden-corpus 度量启发式抽取器的召回覆盖（世界铁律、禁令、主角特例），按召回率下限断言而非逐字匹配，并锁定 hard 优先级、主角特例 nonGeneralizable 且限定作用域等硬不变量；corpus 以数组结构预留扩充，当前覆盖中文标准标题、英文（Iron Laws/Prohibitions/Special）、中文变体标题（客观规则/本书禁忌/异常）三类语料，阈值按实测召回校准并留有余量。

### 后续建议验收

- 增加更接近真实长篇项目的端到端 corpus 回归，至少覆盖 1 个 8-15 章 fixture，并断言 runtime artifact、trace protectedSources、审计 issue 汇入和状态结算结果。
- 增加真实 API 多章连载验收：双 API smoke 通过；路由探针确认 `writer` 与 `settler` 分离；至少完成 5 章；`current_state.md`、`pending_hooks.md`、`chapter_summaries.md`、结构化 JSON 和快照全部推进；报告中无密钥残留。
- [已完成基础主链路] Studio 真实后端 E2E 已覆盖 stub-mode 的“创建书籍、写下一章、查看 truth files 和 runtime diagnostic”。
- 下一步补齐 Studio 真实后端 E2E 的服务与诊断层：配置服务、测试连接、创建失败/超时/降级时的错误面板，且展示 agent/model/service/阶段名但不泄露 API Key。
- 扩充 `canon-extraction-quality.test.ts` 的 golden-corpus（更多题材、更复杂设定、LLM 抽取路径），并随之校准召回率下限。
- 为 ClaimGate、VolumeGate、HookLedgerGate 记录误报/漏报样例，反向调整阈值和提示。
- Studio 诊断面板完成后补充交互和只读权限测试。
- Studio 构建体积优化完成后，补充 bundle 检查或构建阈值，避免重依赖重新进入首屏主包。

## 12. 默认假设

- 本文档作为中文架构方案落地，不同步创建英文版。
- 本文档会随实现进展更新，记录 runtime 产物、上下文注入和门禁链路的当前事实。
- 默认目标是服务后续实现者和产品/架构讨论，而不是写成终端用户说明。
- 默认路径使用 `docs/`，新增目录比把设计内容塞入 README 更清晰。
