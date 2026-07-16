# InkOS 当前架构与开发优先级

状态：当前开发基线  
复核日期：2026-07-15

## 1. 复核结论

InkOS 已经不是原型式的单次文本生成器，而是一个本地优先的长篇小说生产系统。当前主干具备：

- 从创作简报、基础设定、卷级规划到章节生产的完整工作流。
- 结构化 truth、Markdown 可读投影、SQLite 时序记忆和章节快照。
- Planner、Composer、Writer、Auditor、Reviser、Settler 等多 agent 分工与多模型路由。
- Studio、TUI、CLI 和外部 `interact` 入口。
- 章节持久化事务、项目和书籍级并发控制、失败恢复及状态校验。
- 调用级 LLM telemetry、Studio SSE 诊断和 provider 兼容处理。

当前最主要的工程风险已经从底层持久化和跨入口写入旁路，转移到真实模型质量、成本和 provider 长尾。live 五章入口已改为生产 Scheduler 的一次性周期，真实 provider transient、审计修订/重写、状态 repair/resync 和预算暂停都会持久化到无人值守状态。DeepSeek 官方 Foundation-only 已以 `94/100`、`62020` tokens、fallback/timeout/retry 0 通过，关闭紧凑篇标题漂移解析复验；随后的三章样本只完成 2/3 章。第 1 章 `ready-for-review`、`892` 字、`82089` tokens，全部门禁通过；第 2 章初始动作已达 `147533` tokens，revision 2、settle 2，状态结算清空 state/hooks 后保持 `state-degraded`。恢复阶段另用 `46135` tokens，真实章成本为 `193668`，但旧报告将其误列为 unassigned。当前代码已让失败路径即时执行硬预算暂停、保留恢复章节归属，并让 repair 的确定性校验失败返回 `state-degraded` 以继续 resync；这些修复只有离线回归。ArkPlan/Doubao 同样只完成 2/5 章，说明不能把单次结果解释为模型绝对优劣。跨 agent token 报告和稳定上下文编译缓存已落地并有回归测试，但真实三章和五章基线均未通过。Playwright 使用独立临时根目录和动态端口；完整 Studio E2E 为 10/10，`pnpm test:linked` 单独通过；`pnpm stress:process` 通过 8 worker、400 次竞争写入和 30 轮真实强杀/恢复。发布链全绿不等于真实模型主链路已经达到无人值守稳定性。

### 1.1 实际完成度与质量矩阵

状态定义：

- **已完成**：主路径已接线，有确定性回归，可作为当前功能基线。
- **可用/持续增强**：功能可运行，但真实场景证据、统一性或性能仍不足。
- **未完成**：只有局部实现、设计或路线图，没有可验收的完整用户路径。

| 能力域 | 开发状态 | 完成质量 | 实际证据与边界 |
| --- | --- | --- | --- |
| 建书、导入与基础设定 | 已完成 | 中高 | core、CLI、Studio 均有接线；stub authoring E2E 可完成建书，但真实 provider 建书没有稳定的发布级回归 |
| `plan -> compose -> write -> audit -> revise -> settle` | 已完成 | 高（确定性）/中（真实模型） | Runner、agent、共享审计合同、确定性 resync 兜底和状态门禁有完整回归；真实 3 章暴露的问题已完成代码修复，但仍缺修复后的真实 3-5 章复验和成本基线 |
| 结构化 state、Canon、claim、volume、hook 治理 | 已完成/持续增强 | 高（结构）/中（语义） | schema、reducer、golden corpus 和门禁有回归；不能表述为完整语义证明 |
| 原子写入、章节/工作流事务、book/config lock | 已完成（本地基线） | 高 | 章节事务、workflow crash journal、跨进程书籍锁与项目配置锁均有回归；8 worker 竞争写入和 30 轮真实强杀/恢复通过 |
| rewrite、review、rollback | 已完成 | 高 | approve/reject/rewrite 共享 core mutation command；rewrite 由 PipelineRunner 持有唯一 book lock，CLI 不再手工组合回滚 |
| Studio、CLI、TUI、`interact` | 可用/持续增强 | 高（入口一致性）/中高（体验） | 高频 mutation、长操作和 sub-agent auditor 已共享 core command；revise mode 在 core/Studio/CLI 运行时校验，受控文件不能被 Chat 直接覆盖 |
| Studio telemetry 与错误诊断 | 可用/持续增强 | 中高 | SSE、Doctor、聊天和侧栏已有调用级信息与根因聚合；report v2 已支持 agent/phase、service/model 和 agent/service/model 交叉统计，尚缺修复后的真实 provider 失败样例覆盖 |
| 上下文与性能治理 | 可用/持续增强 | 中高 | 已有 Prompt Assembly Trace、per-source 统计、确定性去重、三层上下文、稳定上下文编译缓存和可配置 per-agent/per-phase 预算报告；仍缺真实多章账单、缓存命中率和质量基线 |
| 本地 API 与依赖安全 | 已完成（localhost 基线） | 高 | localhost、无 wildcard CORS、密钥遮蔽、路径校验、生产审计为 0；不覆盖公网部署认证 |
| 局部章节重写、插件、平台格式导出 | 未完成 | 低/无完整验收 | 仍属于产品路线图，不应计入当前版本完成度 |

因此，当前项目可以描述为“本地长篇生产主链路稳定可用，平台可靠性基线已完成，真实模型质量和架构收敛仍在进行”，不能描述为“所有入口、性能和长篇语义质量已经完成”。

### 1.2 2026-07-11 历史验收快照

本快照描述本地 Windows 工作区的可复验工程质量，不将 stub E2E、确定性测试或单次真实模型试运行误表述为生产模型质量保证。

| 验证层级 | 命令/证据 | 当前结果 | 覆盖边界 |
| --- | --- | --- | --- |
| Core 回归 | `pnpm --filter @actalk/inkos-core test` | 121 个测试文件、1253 项通过 | 状态、mutation command、章节/工作流事务恢复、配置锁、Pipeline、provider、治理门禁与路径安全 |
| Studio 回归 | `pnpm --filter @actalk/inkos-studio test` | 33 个测试文件、392 项通过 | Hono API、共享 mutation 接线、受控文件保护、SSE 状态、失败处置、Doctor、路由与前端状态 |
| Studio E2E | `pnpm --filter @actalk/inkos-studio test:e2e` | 完整套件 8/8；两种真实进程 recovery 连续 5 轮共 10/10 | 隔离根目录、动态端口、事务恢复、进程强杀/重启、committed cleanup、陈旧锁回收、锁冲突、服务探测与 shell/API smoke |
| CLI 回归 | `pnpm --filter @actalk/inkos test` | 36 个测试文件、207 项通过 | 命令、TUI、运行时解析、发布打包与集成路径 |
| 进程压力 | `pnpm stress:process` | 通过 | 8 worker；book/config 各 200 次竞争 mutation；workflow 20 轮、chapter 10 轮 preparing/committed 强杀恢复 |
| 发布链 | `pnpm release` | 通过 | typecheck、semantic audit、build、bundle、1852 项 Vitest、publish manifest、生产审计与 8 项隔离 E2E 全绿 |

质量结论：确定性主链路、跨入口 mutation、章节/工作流崩溃恢复和跨进程竞争已形成全绿本地发布基线。当前仍不能由离线测试证明真实 LLM 的输出质量、上游可用性和成本；Studio 构建仍会报告部分 chunk 超过 500 KiB。

### 1.3 2026-07-12 真实 Studio 三章复测快照

本轮使用 Studio 真实前端按钮、已配置 OpenRouter 服务和 `deepseek/deepseek-v4-pro`，复用测试书完成第 3 章写作、审计、状态修复和恢复验证。测试数据位于 Git 忽略目录，不进入产品提交。

| 检查项 | 结果 | 结论 |
| --- | --- | --- |
| 模型路由 | Planner、Writer、Normalizer、Auditor、Reviser、Analyzer、State Validator 均为 `openrouter / deepseek/deepseek-v4-pro` | 未回退到 `openrouter/auto` |
| Planner | 长 hook ID 首次被模型删去连字符，第二次按合法 ID 重试后通过；未进入 fallback | 重试可恢复，但 ID 协议仍脆弱 |
| 长度治理 | Writer 约 5115 字，归一化约 3355 字，修订后 3014 字 | 二次长度收敛有效，落入软目标区间 |
| 审计与状态 | 首轮因 gate 误报进入 `audit-failed`；独立审计后为 `state-degraded`；修复状态后恢复 `ready-for-review` | 保护和回滚有效，但不同入口审计合同不一致 |
| truth 完整性 | `manifest/currentState/snapshot = 3`，摘要 3 条，H001-H012 完整 | 状态最终可恢复 |
| hook 治理 | 结算一度因“信息”与 `information` 类型漂移创建两条重复 hook，清理后为 14 条 | 需要统一 hook 类型和稳定 ID |
| 确定性回归 | Core 121 个测试文件、1291 项通过；Core typecheck/build 通过 | 离线回归未能提前覆盖上述真实输出漂移 |

本轮证明了现有事务保护能阻止错误状态继续传播，也证明了“测试全绿”不能替代真实前端、真实模型和中断恢复组合测试。

## 2. 系统边界

| 包 | 当前职责 | 边界要求 |
| --- | --- | --- |
| `packages/core` | agent、Pipeline、状态模型、持久化、记忆、LLM/provider、领域校验 | 所有书籍和章节业务规则应在此闭环 |
| `packages/cli` | CLI/TUI/daemon、参数解析、结构化输出 | 只组装命令和展示结果，不复制 Pipeline 规则 |
| `packages/studio` | React 工作台、Hono API、会话与诊断界面 | API 路由应调用 core 用例，不直接编排多步领域写入 |

当前包划分合理，不需要拆成微服务，也不需要为了扩展性把本地文件模型整体迁移到远程数据库。

## 3. 当前章节工作流

```mermaid
flowchart LR
  A[用户指令] --> B[Planner: chapter intent]
  B --> C[Composer: governed context]
  C --> D[Writer: prose draft]
  D --> E[Audit and deterministic gates]
  E -->|critical issues| F[Reviser]
  F --> E
  E --> G[Settler: structured delta]
  G --> H[Validate and apply state]
  H --> I[Transactional persistence]
  I --> J[Snapshot, memory and UI events]
```

默认流程是 `plan -> compose -> write -> audit -> optional revise -> settle -> persist`。其中：

- 文笔模型负责正文渲染，不拥有设定和状态裁决权。
- Canon、claim、volume、hook 和 state validator 负责高风险约束。
- 结构化状态是权威真源，Markdown 是人类可读投影。
- 审计失败默认只自动修订有限次数，剩余问题交给人工审核。
- rewrite 必须由一个 core 用例在同一把 book lock 下完成回滚和再生成。

## 4. 数据、事务与并发模型

### 4.1 数据层级

| 层 | 作用 |
| --- | --- |
| `book.json`、`chapters/index.json` | 书籍配置和章节索引 |
| `story/state/*.json` | 权威结构化运行状态 |
| `story/*.md` | 可读 truth 投影和控制文档 |
| `story/runtime/*` | 每章 intent、context、rule stack、trace 和治理诊断 |
| `story/snapshots/*` | rewrite 和失败恢复使用的章节前状态 |
| `story/memory.db` | 相关事实、伏笔和摘要的时序检索 |

### 4.2 写入语义

- 章节索引、book config、结构化状态、secrets 与 Studio 项目设置通过临时文件加 rename 原子替换。
- 章节落盘使用 `.chapter-persistence.json` 事务标记记录 preparing/commit 状态。
- 事务开始前保留可恢复快照；失败时回滚，启动新写作前先恢复未完成事务。
- 同一本书的变更由 `.write.lock` 串行化。
- Studio、CLI 和配置迁移统一使用 `.inkos-project-config.lock`、原子替换和死进程陈旧锁回收，避免跨进程更新丢字段。
- transcript 追加使用内存中的序列和事件缓存，不再为每条消息重读完整 JSONL；缓存按 TTL 回收。

当前操作合同并不完全等价：

| 操作 | 锁所有权 | recovery / 事务边界 |
| --- | --- | --- |
| draft、write next、rewrite | `PipelineRunner` | 先恢复遗留章节事务；章节正文、索引和 truth 受 chapter persistence marker 保护 |
| plan、compose、audit、consolidate | core mutation command | 先恢复章节事务；再用 `.core-workflow-mutation.json` 和备份目录保护 runtime、audit 与 summary 多文件输出 |
| revise、repair-state、resync、import | `PipelineRunner` | 在同一把 book lock 内统一执行章节事务 recovery preflight |
| chapter save/patch、truth edit、book config/review mode、delete | core mutation command | 单一 book lock；delete 对不存在书籍统一返回 typed `BOOK_NOT_FOUND` |
| Studio/CLI/config migration | project config mutation | `.inkos-project-config.lock` 跨进程串行化、原子替换、死 PID 陈旧锁回收 |

### 4.3 当前限制

- book lock 会覆盖较长的 LLM 操作，保证正确性但限制同一本书的并行吞吐。
- 文件系统事务不是数据库事务；当前压力证据覆盖本地多进程竞争与强杀恢复，不覆盖网络文件系统、分布式租约或高并发服务端部署。
- 结构化 truth 与 Markdown 投影仍有双写成本，必须坚持“JSON 权威、Markdown 可重建”。
- workflow crash journal 采用备份、preparing/committed marker 与恢复清理；新增目标目录时必须同步扩展备份清单和故障注入。

## 5. API 与本地安全边界

- Studio 默认只监听 `127.0.0.1`；只有显式设置 `INKOS_STUDIO_HOST` 才扩大监听范围。
- API 不启用 wildcard CORS。
- Studio 只返回密钥是否已配置，不返回原始 API Key；空密钥更新默认保留现有值，显式 clear 才删除。
- core mutation command、agent session bookId、sessionId、revise mode 和主要章节路由均执行运行时校验；Studio Chat 对权威文件和运行时内部目录采用拒绝式 allowlist。
- destructive session 路由不能通过 traversal-shaped ID 访问 `.inkos` 或其他项目文件。
- 生产依赖通过 workspace overrides 固定到已修复版本；2026-07-11 的 `pnpm audit --prod` 为 0。

当前不需要为本地个人项目引入账号、RBAC 或远程鉴权。若默认部署目标改为局域网或公网，认证、CSRF、来源策略和速率限制必须先于远程开放完成。

## 6. 性能判断

### 6.1 主要成本

性能瓶颈按影响排序：

1. LLM 调用耗时、重试和上下文 token 体积。
2. 多 agent 串行链路和同书长时间持锁。
3. Studio 的 Mermaid、Shiki、WASM 和图形依赖体积。
4. CLI 集成测试反复启动子进程的时间。
5. 文件 JSON/Markdown 解析与原子写入。

文件系统目前不是首要性能瓶颈。除 transcript 这类高频追加路径外，不应优先做低收益微优化。

### 6.2 当前性能基线

- Studio 构建约转换 5200 个模块，入口 JS/CSS 仍在仓库 bundle 预算内。
- 页面路由已经使用 React lazy loading；Mermaid、代码高亮、数学和部分 Streamdown 插件仍在消息/摘要组件静态导入，部分 grammar 和 WASM chunk 超过 Vite 默认 500 KiB 警告线。
- 2026-07-15 完整回归为 Core 131 个测试文件、1449 项通过，Studio 34 个测试文件、405 项通过，CLI 36 个测试文件、210 项通过；当前确定性测试共 2064 项。CLI 集成测试反复启动子进程，仍是主要耗时来源。
- `scripts/live-dual-api-routing.mjs` 已升级到 report v2：同时按 agent+phase、service+model、agent+service+model 汇总耗时、token、状态、尝试与重试，并输出长度偏差、结构化 fallback、repair/resync 恢复路径、per-agent/per-phase token budget 和可配置质量门禁。Revision/Settlement 调用前预算和 Scheduler 持久化计数已完成；DeepSeek 官方复测确认两类调用均不超过 1，预算失败后立即暂停，但首章一次修订路径仍以 `109101` tokens 超过 `100000` 门禁。局部修订现使用精简 PATCHES 合同和问题复核 Auditor，真实三章成本仍待复测。
- Composer 已执行 token budget 和 verbatim/semantic/compressible 三层上下文策略；Provider telemetry 与 ChapterTrace 已记录 per-source 字符数、估算 token、tier、fingerprint、selected/compressed 状态和重复 fingerprint 组。PipelineRunner 现在按项目/书籍、模型、语言、预算和稳定 source 指纹持久化缓存稳定上下文编译结果，动态章节上下文不会进入缓存；跨实例读取、损坏恢复和 clear 已有回归，真实多章命中率和账单收益仍待验证。

## 7. 设计问题与技术债

### 7.1 多入口业务编排

Studio、CLI、Chat 和直接 API 历史上存在各自组合 rollback、write、approve、truth edit 的路径。当前已知写操作均已收敛到 core command 或 project config mutation：sub-agent auditor 使用 `audit-chapter`，Studio Chat 拒绝直接覆盖权威文件，revise mode 在运行时解析。后续新增 mutation 时应把“校验、锁、恢复、事务、事件、错误合同”作为一个完整用例提交，入口层只负责参数与展示。

### 7.2 大型模块

- `packages/studio/src/api/server.ts` 约 4860 行，同时承担路由、配置、密钥、会话、provider 探测和业务调度。
- `packages/core/src/pipeline/runner.ts` 约 4250 行，同时承担多个工作流、恢复、持久化和事件编排。

拆分时应按业务域拆分，不按“utils/helpers”堆放：books、chapters、sessions、services、project settings，以及 foundation、chapter、rewrite、persistence workflow。

### 7.3 依赖接口过宽

测试 mock 经常需要模拟完整 `StateManager`。后续应引入更小的能力接口，例如 `BookLock`、`BookRepository`、`ChapterRepository`、`RuntimeStateStore`，但只在实际拆分工作流时引入，避免先造抽象后找用途。

### 7.4 上游依赖生命周期

`@mariozechner/pi-ai` 与 `@mariozechner/pi-agent-core` 已被上游标记 deprecated。短期继续固定版本，所有 provider-specific 类型必须限制在 LLM adapter 层，并为后续替换保留合同测试。

### 7.5 已关闭：审计合同不一致

完整写作和独立审计现在共享章节评估合同，并恢复同一组正文、memo、compiled claims、hook ledger、volume contract 和 truth overrides。后续风险不再是入口逻辑分叉，而是新增 gate 时必须继续接入共享用例并明确记录来源。

### 7.6 已关闭：状态修复依赖 Settler 完整回写

resync 已按 Settler 初次结算、带校验反馈重试、Chapter Analyzer 重建的顺序执行；任何阶段无法提供完整 state、hooks 和 summary 时恢复原快照并返回单一可执行错误。下一阶段只需继续扩大真实响应 corpus，不再新增另一套状态修复路径。

### 7.7 已关闭：Hook 身份和跨语言类型漂移

新派生 hook 使用 `Dnnn` 短稳定 ID，中文/英文 type 与 status 在输入边界规范化，旧长 ID 通过确定性别名兼容。剩余工作是用真实多章 corpus 验证长期重复家族率，而不是再次改变主键协议。

### 7.8 Gate 必须以局部高置信度证据阻断

本轮 claim gate 曾把“无需维护”“无需人工复核”与全文中的世界规则关键词拼接，产生 critical 误报。硬 gate 不应通过全文词袋做跨段推断；阻断条件必须限定在同一语句/事件窗口，并要求规则主体、绕过动作和缺失成本同时出现。低置信度判断降为 warning 或交给 Auditor。

### 7.9 真实模型 E2E 覆盖不足

现有隔离 Studio E2E 已覆盖事务、stub authoring、取消、不落章、重试和 `state-degraded -> repair-state -> ready-for-review`，确定性测试覆盖长 ID、审计入口一致性、resync 失败回滚和 hook 去重。仍缺可重复的真实响应录制 corpus，以及修复后的 3-5 章小规模 provider smoke；联网测试不进入每次提交门禁。

### 7.10 单章成本（取消合同已关闭）

ArkPlan 严格样本中，第 1/2 章分别为 `74542 / 213210` tokens，第 2 章的一次修订和状态恢复同时触发单章预算与 settle 上限失败。DeepSeek 官方三章样本的第 1 章为 `82089` tokens；第 2 章初始动作为 `147533`，计入恢复后为 `193668`，其中第二次 Reviser 原文未变，四次实际 settle 都没有生成合法 state/hooks。最大 prompt 仅 `15519`，总量仍低于 `500000`。第 1 章的 `1507 -> 892` 仍使用了 1 次 Length Normalizer provider 调用，因为偏差超过小幅 hard-bound 的适用范围；零调用分支仍只有离线证据。当前优化重点是把 revision/settlement 次数和章节 token 变成调用前预算，阻断 completion 长尾，不是扩大上下文或预算。

## 8. 当前开发优先级

优先级定义：P0 是下一个稳定版本必须完成；P1 是随后一个工程迭代；P2 是产品扩展，不应抢占可靠性工作。

### P0：真实写作合同一致性（已完成）

#### P0.1 统一完整写作与独立审计（Core 合同已完成）

- 抽取共享 `evaluateChapter` 用例，由 write/review/re-audit 共用。
- 输入统一包含正文、持久化 memo、compiled claims、hook ledger、volume contract、truth overrides 和语言配置。
- 同一正文和同一 truth 快照在不同入口必须产生相同 blocking issue 集合。
- 审计结果记录 gate 来源，Studio 能区分 continuity、claim、hook、volume 和 state 问题。

完成定义：为“完整写作失败、独立审计错误通过”增加回归；Studio、CLI、Chat 和 core 直接调用返回一致状态。

2026-07-12 进展：`runChapterReviewCycle` 与 `auditDraft` 已统一调用同一个章节评估合同；独立审计会恢复历史 plan/memo、context package、rule stack、compiled claims、hook ledger 和 volume contract，并继续保留 `state-sync-required` 状态保护。新增回归已证明同一持久化正文在完整写作和独立审计中返回相同 critical 类别，且不会错误进入 `ready-for-review`。当前 Core 121 个测试文件、1293 项测试、typecheck 和 build 全部通过。剩余工作是显式记录 gate 来源，并补 Studio/CLI/Chat 的入口级状态一致性 E2E；不再阻塞 P0.2 的实现。

#### P0.2 确定性 settlement/resync 兜底（Core resync 已完成）

- Settler 输出先转成结构化 observation，再由 reducer 生成 current-state、summary 和已存在 hook 的最小 delta。
- 明确区分“模型未输出”“解析失败”“校验拒绝”“正文确实无状态变化”。
- resync 在两次模型失败后可使用章节 analyzer 的结构化结果完成 snapshot-only 重建，禁止生成空真相。
- 失败时继续保持现有快照/索引回滚合同，不允许 manifest 超前。

完成定义：注入两次缺 state/hook 的 Settler 响应后，系统能确定性重建或给出可执行错误，且不会要求人工编辑多个 truth 文件。

2026-07-12 进展：resync 现在按“Settler 首次结算 -> 携带校验反馈的 Settler 重试 -> Chapter Analyzer 重建”执行。三次输出都必须提供可用 state、hooks 和当前章 summary，并通过 State Validator；随后由现有 Markdown 解析、结构化状态重建和快照事务完成提交。缺 state、缺 hooks、缺 summary 分别产生稳定错误类别；明确返回完整投影和摘要时允许“正文无状态变化”。新增故障注入覆盖 Analyzer 成功接管、Analyzer 仍缺字段时恢复原 truth/index，以及无状态变化的合法结算。普通写章的双重校验失败仍保持 `state-degraded` 保护，由 repair/resync 负责恢复，不会静默推进 manifest。

#### P0.3 稳定 Hook ID 与跨语言规范化（Core 已完成）

- 新派生 hook 使用 `D001` 这类短 ID，不再从描述生成 slug ID。
- Planner 只看到稳定 ID/短别名；返回后再映射到真实记录。
- 在 schema 边界统一 hook type、status、payoff timing 的中英文/历史别名。
- 对候选 hook 执行跨语言重复家族检测，禁止 H004/H008 同义派生。

完成定义：长中文描述、缺连字符、中文/英文类型混用均不会进入 fallback，也不会新增重复 hook；旧书长 ID 可继续读取。

2026-07-12 进展：所有真正的新 hook 候选现在由宿主按现有账本单调分配 `D001`、`D002` 等短 ID，Settler/Planner 自造的长 ID 不再直接落盘；已有 `H001`、历史 slug 和中文长 ID 保持原值。arbiter 会将唯一的缺连字符/分隔符漂移映射回旧记录，并同步改写 chapter summary 中的临时 ID。Settler JSON 与旧 Markdown 状态入口统一规范化常见中英文 hook type/status，`信息/information`、`物件/item`、`已推进/progressing`、`待推进/deferred` 等不会再创建跨语言重复家族或在 schema 前失败。Planner hook ledger 对旧长 ID 使用分隔符无关比较，避免仅因模型删连字符进入 fallback。Core 当前 121 个测试文件、1299 项测试、typecheck 和 build 全部通过。

#### P0.4 真实前端恢复路径与取消合同（已完成）

- 增加“写作中止”按钮和后端 abort signal，覆盖 Planner、Writer、Normalizer、Auditor、Settler。
- `audit-failed -> state-degraded -> repair/resync -> ready-for-review` 形成明确的单一引导，不让用户猜按钮。
- 避免 `window.prompt` 承担长操作参数，改用可测试的对话框组件。
- 修复开发服务器 Core 变更后 API 重启端口漂移和孤儿进程问题。

完成定义：浏览器 E2E 可点击启动、取消、重试、修复状态并继续下一章；中断后不残留错误计划、锁或端口占用。

2026-07-12 进展：Studio 为 write、draft、rewrite、repair-state、resync 建立了每书唯一活动操作和稳定 `requestId`，统一返回 `202`，并提供取消端点及 start/cancel-requested/cancelled/complete/error SSE 生命周期。AbortSignal 已从 Studio 传入 Pipeline、Agent 和 LLM transport；草稿与完整写作会在生成、审校和每段持久化前检查取消，事务失败继续走现有回滚。即使底层非协作 Promise 在取消后正常返回，服务端也只发 cancelled，不会误发 complete。书籍页已提供统一取消按钮、取消恢复提示和 repair/resync 终态刷新，六处 `window.prompt` 已替换为可测试 Dialog + Textarea。开发脚本启用严格端口，Windows 关闭时终止完整子进程树，API server 在 SIGINT/SIGTERM 时显式关闭监听器。

验证包括：真实 OpenRouter `deepseek/deepseek-v4-pro` 书籍在浏览器中启动 resync、点击取消并恢复到原 3 章状态；隔离 Studio E2E 覆盖对话框、启动、取消、不落章、再次启动、写出第一章、注入 `state-degraded`、点击 repair-state 并恢复 `ready-for-review`，完整套件 9/9。Core 当前 121 个测试文件、1302 项，Studio 33 个测试文件、402 项；typecheck、build 和隔离端口启停检查通过。

### 历史 P0：底层可靠性与跨入口一致性（已完成）

#### 历史记录 A：稳定隔离 E2E 的恢复合同

隔离基础设施已完成：`pnpm --filter @actalk/inkos-studio test:e2e` 为每次运行分配独立临时项目根目录、临时 stub secrets 和动态 API/前端端口；teardown 仅终止本次进程并清理本次目录。该命令已纳入根目录 `pnpm release`。

修复结果：recovery 用例等待章节 1 出现非空 `operationId`，不再把预置的 `interrupted` 章节误认为后台恢复后的新章节。完整套件现为 8/8；preparing/committed 两个真实子进程强杀/重启用例合并连续运行 5 轮共 10/10；根目录 `pnpm release` 全绿。

已完成范围：

- 每次 E2E 创建独立临时项目根目录，并通过环境变量传给 seed、Studio server 和 fixture。
- teardown 只清理本次运行创建的目录和进程；运行元数据和日志不再共享工作区文件。
- authoring E2E 覆盖建书、写一章、truth diagnostics，以及中断章节事务的自动回滚、恢复提示与持久化 recovery diagnostic；真实进程 fixture 会持锁写入部分章节/索引/truth，随后被系统强杀，由新进程回收陈旧 `.write.lock` 并回滚；还覆盖自定义服务的成功探测与保存、未知服务商错误、“未保存配置不落盘”，以及锁冲突时 `409 BOOK_LOCKED` 且章节不变的合同；另有 Studio shell/API smoke。

完成定义已满足。多进程竞争压力基准也已由 `pnpm stress:process` 落地；后续工作转向真实 provider 的建书与超时/降级诊断。

#### 历史记录 B：收敛 core mutation command

本阶段目标：先收敛 Studio、CLI 的高频直接 mutation 与长操作，建立可复用的 core command 边界。

已完成范围：

- 新增 approve/reject/rewrite 统一命令合同和 typed chapter-not-found error。
- approve/reject 在 core 内持有 book lock；rewrite 委托 `PipelineRunner.rewriteChapter()`，避免双重锁。
- Studio approve/reject/rewrite 与 CLI review/rewrite 已接入；CLI rewrite 的手工文件、索引和快照编排已删除。
- `--keep-subsequent` 的旧 CLI 行为得到保留和回归覆盖。
- chapter save/patch 复用统一 edit transaction 和 manual review issue，Studio API、Studio Chat 与 interaction tools 均通过 core command 写入。
- foundation revise 由 command 持有唯一 book lock，Studio 与 architect sub-agent 不再直接调用 pipeline 编排。
- canonical truth edit 共享 allowlist、路径校验、原子写入和只读 runtime/legacy shim 错误合同。
- approve-all 在单次锁与索引写入内批量批准待审章节，CLI 不再直接改索引。
- entity rename 通过 command 复用 edit transaction，interaction 不再自行持锁编排。
- Studio/CLI book update 共享 schema 校验、时间戳、锁和原子配置写入，并返回修改前后合同。
- chapter review mode 共享 schema 校验、锁、原子配置写入与 inherit 语义；book delete 在 command-owned lock 内删除书籍，并在 core 层拒绝不安全 book ID。
- Studio/CLI plan、compose、audit、consolidate 由 command 持有唯一 book lock；执行领域回调前统一处理 preparing rollback 或 committed marker cleanup，并只在发生恢复时附加 `recovery`，原有返回字段保持兼容。
- Studio 已删除对应的外层锁包装；CLI 已删除这些命令的直接 Pipeline/Consolidator 调用和 book delete 文件删除编排。

阶段完成定义已满足：已知 mutation 只有一个领域实现，入口层只负责参数、事件与展示；sub-agent auditor、revise runtime mode 和受控文件 Chat edit 也已在 P0.4 关闭。

#### 历史记录 C：扩展恢复、checkpoint 与进程压力

第一阶段已完成：章节持久化恢复不再静默执行。`StateManager` 会返回“无操作、清理已提交 marker、回滚未完成章节”的结构化结果，并记录只读的 `story/runtime/recovery.json`；`write next`、`draft` 与 `rewrite` 的 core 结果和 Studio SSE 完成事件会透传该结果，Studio 书籍页会在实际回滚时显示恢复提示，Truth Files 可在后续重载中打开恢复诊断。CLI 的 `write next --json` 和 `write rewrite --json` 保持原有顶层形状，但为每项结果附加稳定的 `checkpoint`（operation ID、章节、状态、恢复结果），常规输出在发生恢复时提供简要说明。每次章节操作生成 `operationId`，并将其写入 LLM telemetry、持久化 marker、恢复诊断、章节索引和完成事件；Studio 书籍章节列表中的操作 ID 可直接打开 `#/doctor?operationId=...`，只显示该次操作关联的 Doctor 调用。书籍页还会标明 write、draft、rewrite、revise 或 audit 的失败阶段，将可识别的凭据问题、状态降级和暂时性写作失败分别导向模型配置、状态修复与安全重试，并始终保留进入 Doctor 的入口。隔离 E2E 已注入 `preparing` 事务，并验证回滚、继续写章、恢复诊断与操作追踪跳转。

本轮故障注入已覆盖：部分章节/索引/truth 写入可回滚；新 `StateManager` 实例可接管 `preparing` 事务；真实 writer 子进程在 preparing 状态被强杀后，新进程可回收陈旧锁、保留 operation ID、回滚到 snapshot 0 并记录 `recovery.json`；在 committed 状态被强杀后，新进程只清理 marker，章节、索引和 truth 均保持已提交状态。`pnpm stress:process` 还覆盖 8 worker 并发、book/config 各 200 次 mutation，以及 workflow 20 轮、chapter 10 轮 preparing/committed 强杀恢复，marker、backup 和陈旧锁均完成清理。

#### 历史记录 D：关闭实际旁路与运行时合同漂移

1. sub-agent auditor 已接入 `audit-chapter` core command。
2. `ReviseModeSchema` 在 core 边界解析；legacy `local-fix` 映射为 `spot-fix`，Studio/CLI 对未知 mode 返回校验错误。
3. revise、repair-state、resync 和 import 已在锁内统一执行 recovery preflight。
4. Studio 显式 Chat edit 已拒绝 `book.json`、章节索引、事务/锁文件和 story 内部权威目录。
5. delete-book 对不存在书籍统一为 typed `BOOK_NOT_FOUND`，Studio 映射为 404。
6. CLI、Studio 与配置迁移已统一使用跨进程项目配置 mutation。
7. plan/compose/audit/consolidate 已增加 workflow crash journal，callback 失败和进程重启均可回滚或清理 committed marker。
8. 根级 `pnpm release` 已包含 typecheck、semantic audit、build、bundle、tests、publish manifest、生产依赖审计和 Studio E2E。

### P1：质量、性能与模块治理

#### P1.1 真实多章报告与质量门禁

- [实现完成] report v2 已增加 service/model 与 agent/service/model 交叉维度，并保留 agent/phase 视图。
- [实现完成] provider telemetry 已记录 attempt/retry；报告汇总超时、错误、partial、token、长度偏差、Normalizer 是否执行和可配置阈值。
- [实现完成] Planner parse retry/fallback、Canon heuristic fallback、Resync Chapter Analyzer fallback 已改为结构化诊断，不再依赖日志字符串解析。
- [实现完成] `state-degraded` 可按 `none`、`repair`、`resync`、`repair-then-resync` 策略执行，并逐次记录耗时、状态前后、遥测、诊断和错误。
- [实现完成] `inkos analytics --chapters <range> --llm-report` 可从现有书籍索引关联 operation telemetry，输出章节/agent/phase 成本、索引 token 覆盖差额、历史无 operationId 调用、重试率和可配置预算门禁，并可将脱敏 JSON 保存到 `.inkos/reports`。
- [已有三章证据，待正式五章验收] DeepSeek 官方接口在既有 3000 字书籍上完成第 4-6 章，最终均为 `ready-for-review`；但总 telemetry `618663`、第 5 章 `229613`、最大 prompt `23992` 均超过本轮分析阈值，且第 4 章发生一次 state repair。该样本用于定位成本和状态语义问题，不替代 Scheduler/Studio 五章门禁。
- [新 provider 两章证据，正式五章仍失败] ArkPlan 自定义 OpenAI 端点的 `doubao-seed-2.0-pro` 在紧凑篇节拍合同修复后让 Foundation 首轮以 `82/100` 通过，pre-chapter gate 为 fallback/timeout/retry 0。第 1/2 章均为 `ready-for-review`，终止原因分别为 `initial-passed` 和 `passed-after-revision`；但第 2 章 `213210` tokens、settle 2 次，Scheduler 按预算暂停，最终 2/5 章。全程 25/25 success、总计 `332140` tokens、最大 prompt `13248`，证明瓶颈是治理调用和 completion 长尾，不是连接或 prompt 上限。
- [DeepSeek 官方首章证据，正式五章仍失败] 同阈值新书样本中，DeepSeek 官方 Foundation 首轮 `80/100`、pre-chapter `36071` tokens；第 1 章 `ready-for-review`、`933` 字、审计 `100`、`initial-passed`，无 Revision/重复 settle，但因 Length Normalizer 长尾达到 `105338` tokens 后暂停。另两次 Foundation 分别为 `88` 首轮通过后遭遇 Windows rename 瞬态失败，以及 `74` 后重生成节拍标题/段落未识别；对应确定性修复已落地，未继续付费抽样。
- [DeepSeek 官方 Foundation 通过、三章仍失败] Foundation-only 以 `94/100`、`62020` tokens、最大 prompt `8257` 通过。三章样本的 Foundation 重生成后为 `85/100`；第 1 章 `ready-for-review`、`892` 字、`82089` tokens，第 2 章真实累计 `193668` tokens 后保持 `state-degraded`，最终 2/3 章。全程 36/36 provider success、总计 `334800` tokens、最大 prompt `15519`、transport retry/fallback/timeout 0；失败来自 revision/settle 次数、状态语义和 completion 长尾。
- [治理预算真实生效、三章仍失败] Revision/Settlement 上限已成为调用前预算并持久化到无人值守状态。DeepSeek 官方新样本的 Foundation 首轮 `87/100`，pre-chapter `33850` tokens；第 1 章一次修订后 `98` 分、`ready-for-review`、1043 字，audit 2、revision 1、normalize 1、settlement 1，治理门禁通过。单章仍达 `109101` tokens，Scheduler 立即 `paused/action=pause`，最终 1/3 章；全程 14/14 success、总量 `142951`、最大 prompt `14072`、retry/fallback/timeout 0。

#### P1.2 上下文和 token 性能

- [已完成] Prompt Assembly Trace 已记录每条 message 和每个 source 的字符数、估算 token、fingerprint、tier、稳定性、选取和压缩状态；telemetry summary 可按 prompt source 聚合，ChapterTrace 持久化 `sourceStats`。
- [已完成] Writer/Composer 已删除确定性重复：chapter memo 不再同时进入 narrative brief 和通用 evidence；标题、情绪、摘要、hook、canon 使用单一语义证据块；结构化 current-state facts 存在时不再附带完整 `current_state.md`。
- [已完成] 上下文明确分为 `verbatim`、`semantic`、`compressible`：用户方向、memo、claim/hook 原文保护；事实、ID、禁令和优先级允许语义编译；历史摘要和噪声按相关性压缩。
- [已完成] Planner 负责剧情和 memo 决策，Writer 负责正文执行，Auditor 只核对已填承诺的正文证据；长度数字阈值由 Writer user prompt 和确定性写后校验持有，不在多个 system prompt 重复。
- [已完成] 固定语料 A/B 门禁约束 Writer 提示词成本和关键质量合同，并验证 memo、标题、情绪、canon、hook、结构化状态事实只组装一次。
- [已完成代码落地] `buildLLMTokenBudgetReport` 和 live script budget options 已建立总章、agent、phase、单次 prompt 的可配置预算报告；PipelineRunner 已缓存稳定 foundation、角色、正典和卷级摘要的编译结果，章节状态、hook 和近期摘要仍动态编排。
- [已完成确定性压缩，待真实验收] Continuity Auditor、Reviser 和 Settler 均读取 AgentContext 的单次 prompt 预算并预留 3% 安全空间。Settler 优先移除支线、情感、矩阵、历史摘要、卷纲和重复证据，完整保留正文、Observer、校验反馈和当前状态；独立 Settler client 同时执行 provider preflight。
- [已完成代码落地，待真实验收] 自动审校会在没有可执行问题、Reviser 未改变正文、长度/表面归一化还原当前正文、回到已审版本或问题指纹未变化时提前停止；仅分数随机上涨不再触发下一轮。Writer 的确定性 post-write issues 现真正合入首次 assessment，不再依赖“低分但零问题也修稿”的旧副作用。
- [已完成报告门禁] 章节索引持久化 `reviewTelemetry`，记录终止原因以及 audit/revise/normalize 调用数；`analytics --llm-report` 同时从 operation telemetry 统计 audit/revise/normalize/settle，并支持四类 per-chapter 最大调用门禁。
- [已完成确定性降本，待真实验收] 写后表面问题使用 typed local PATCHES；patch-only Reviser 不再携带或输出完整 truth/history，上次阻塞问题在精简 Auditor 复核模式中验证。离线门禁要求 Reviser/复核 Auditor prompt 分别低于完整合同的 70%/60%。Analyzer 仍保留，因为长度归一和修订后的正文不能复用初稿 Settler 真相。
- [下一步] 保持 `100000 / 500000 / 16000` 与 audit 2、revision 1、normalize 2、settlement 1 的原门禁重跑三章，比较 Reviser、第二次 Auditor 和章总成本，并复核 state/hooks/摘要/快照。三章通过后才恢复五章验收。

既有第 4-6 章 snapshot 的 Settler 离线重组结果为 `20198 -> 13010`、`20069 -> 12881`、`18763 -> 10960` 估算 tokens，降幅 `35.6%-41.6%`。历史 Observer 原文未持久化，重组使用相同 chars/token 组成的占位文本；该数据只证明组装预算和关键信息保留，不代表真实供应商账单或内容质量。

同一历史样本的 operation telemetry 显示：第 4/5/6 章分别发生 `audit 2/3/1`、`revise 1/2/0`、`normalize 1/3/0`、`settle 2/1/2`。旧章节没有 `reviewTelemetry`，因此只能定位热点，不能反推新终止条件一定会命中或宣称具体账单节省。

固定提示词语料的离线测量如下。token 为 `estimateTextTokens` 估算值，不是供应商账单 usage：

| 固定语料 | 优化前 chars / tokens | 当前 chars / tokens | token 变化 |
| --- | ---: | ---: | ---: |
| Writer 中文开篇 | 8693 / 6422 | 5887 / 4405 | -31.4% |
| Writer 中文常规章 | 7476 / 5452 | 5727 / 4281 | -21.5% |
| Writer 英文开篇 | 18104 / 4584 | 14006 / 3520 | -23.2% |
| Planner 中文 | 3293 / 2113 | 3293 / 2113 | 0% |
| Planner 英文 | 8121 / 2031 | 8121 / 2031 | 0% |

Planner 未缩短，因为本轮目标是删除 Writer/Auditor 的重复职责，不是压缩规划合同。上述结果只能证明离线提示词降本和合同保留，不能证明真实正文质量提升。

#### P1.3 拆分大型模块

- 将 Studio server 按 books、chapters、sessions、services、settings 路由拆分。
- 将 PipelineRunner 按 foundation、chapter、rewrite 和 persistence workflow 拆分。
- 在拆分过程中引入小能力接口，减少宽 mock。

#### P1.4 Studio 重依赖延迟加载

- 保留已完成的页面级 lazy loading；进一步让 Mermaid 仅在渲染图表消息时加载。
- Shiki 仅加载实际语言 grammar 和当前主题。
- 保持现有入口 bundle 预算，并增加关键页面加载时间基线。

#### P1.5 测试分层提速

- 提交级运行 core、Studio API 和 CLI smoke。
- 合并级运行完整 Vitest。
- 发布级运行 build、bundle、audit、publish manifest 和隔离 E2E。
- 根级 `pnpm release` 已覆盖 workspace typecheck、semantic audit、build、Studio bundle、Vitest、publish manifest、生产依赖审计和 Studio E2E；下一步是把快速 smoke 与完整门禁在 CI 中分层，降低日常反馈时间。

### P2：产品扩展

- 局部章节重写和受控级联更新。
- 自定义 agent/plugin 合同。
- 起点、番茄等平台格式导出。
- 更完整的治理仪表板和诊断跳转。

## 9. 当前不优先做

- 不迁移到微服务。
- 不把全部状态迁移到远程数据库。
- 不为默认 localhost 场景建设完整账号和 RBAC。
- 不在 command 和恢复模型收敛前扩展插件系统。
- 不用增加重试次数掩盖真实 provider 格式不稳定。

## 10. 当前验证基线

2026-07-15 当前工作区完整离线验证基线：

- `pnpm typecheck`：通过。
- `pnpm verify`：2064 个测试通过（Core 1449、Studio 405、CLI 210），并通过代码整洁、typecheck、语义审计、build、bundle 和 publish manifest 检查。
- `pnpm build`：通过。
- `pnpm check:studio-bundle`：通过。
- `pnpm verify:publish-manifests`：通过。
- `pnpm audit:semantic-patterns`：0 个候选。
- `pnpm audit --prod`：0 vulnerabilities。
- `pnpm --filter @actalk/inkos-studio test:e2e`：完整套件 10/10；preparing/committed 真实进程 recovery 连续 5 轮共 10/10。
- `pnpm stress:process`：通过；8 worker，book/config 各 200 次竞争 mutation，workflow 20 轮与 chapter 10 轮强杀恢复。
- `pnpm test:linked`：浏览器、Studio API、Core、持久化和 Doctor 联动链路通过；运行结束后项目临时目录和运行时目录均为 0。
- `pnpm release`：上次记录为通过；本轮未重复运行 release。当前 `pnpm verify` 已通过 2064 项测试，release 历史记录中的测试数量不再是当前测试计数。

Playwright E2E 与进程压力测试已具备安全隔离、preparing/committed 真实进程死亡、竞争写入和重复稳定性证据。持久化无人值守状态机和 `pnpm stress:unattended` 的 20 章强杀/超时/重启恢复已经通过。P1.1 报告和 P1.2 的 Prompt Assembly Trace、三层上下文、确定性去重、职责清理、固定语料门禁、跨 agent token budget 报告和稳定上下文编译缓存代码均已完成。真实 auto 基线已证明单章可在修复后达到 `ready-for-review`，也暴露了 Canon fallback、MiniMax 长尾、单章 token 和 prompt 预算阻断；五章门禁尚未通过，daemon 不应启用。

## 11. 项目审阅意见

### 11.1 产品方向

项目已经拥有足够多的产品入口和治理能力。下一版本不应继续横向增加插件、平台导出或新的 agent 类型，而应把“本地写作一次成功、失败可解释、重启可恢复”做成稳定体验。对个人项目而言，这比增加更多功能更能提升实际可用性。

### 11.2 架构方向

不要先做纯粹的大文件拆分。两轮 mutation 迁移已经证明，更有效的顺序是按垂直动作把校验、锁、事务、事件和返回合同收敛成 core command，再沿同一模式迁移其他 mutation。这样模块拆分会由真实边界驱动，而不是把大文件机械切成多个相互调用的文件。

### 11.3 质量方向

2064 个确定性测试、全绿离线门禁和真实多进程压力基准是明显优势，但测试数量仍不能替代真实模型质量证据。事务、锁和进程恢复的本地可靠性 P0 可以关闭；下一阶段应把精力转向多章 telemetry 热点压缩、正式五章失败样例归档和测试分层耗时。

### 11.4 性能方向

优先优化 LLM 阶段耗时、上下文 token 和消息渲染重依赖，不要优先改造普通 JSON 文件读写。Studio 已有页面级 lazy loading，下一步应针对 Mermaid、Shiki、WASM 和 Streamdown 插件做真正的使用时加载，并用页面加载基线验证收益。

### 11.5 建议的执行顺序

1. [Core 已完成，入口 E2E 待补] 统一完整写作与独立审计合同，消除同章不同入口结果漂移。
2. [Core 已完成] 为 settlement/resync 增加确定性重建兜底，确保模型漏字段时仍可安全恢复。
3. [Core 已完成] 迁移短稳定 hook ID，并完成跨语言类型/status 规范化和重复家族检测。
4. [已完成] 补齐前端取消、恢复引导和状态机 E2E，修复开发服务器重启端口漂移。
5. [已完成] live report 增加 service/model、token、重试、fallback、repair/resync 统计；Prompt Assembly Trace、三层上下文、确定性去重、职责清理和固定语料门禁已经接入。
6. [进行中] DeepSeek Foundation-only 已通过，三章样本在 2/3 章暴露第二次无变化 Reviser、状态清空、恢复成本漏归属和失败路径预算检查过晚；先完成调用前治理预算和离线状态回放，再基于实质代码/路由变化复测三章，不能重复抽样追绿。
7. [门禁后执行] 五章质量、状态、fallback、timeout、retry、长度和预算同时通过后再启用 daemon；随后才校准默认预算并推进重依赖延迟加载、大模块拆分和 CI 测试分层。

### 11.6 2026-07-11 全项目自洽审查关闭记录

| 原严重度 | 发现 | 当前状态 |
| --- | --- | --- |
| P1 | sub-agent auditor 绕过 command-owned lock/recovery | 已关闭：统一调用 `audit-chapter` core command |
| P1 | revise mode 只有 TypeScript cast，legacy 使用非法 `local-fix` | 已关闭：core runtime schema + Studio/CLI 校验 + `spot-fix` 映射 |
| P1 | revise、repair-state、resync、import 缺 recovery preflight | 已关闭：在 book lock 内统一恢复 |
| P1 | Studio Chat 可直接覆盖权威 JSON/YAML | 已关闭：受控文件和内部目录拒绝式保护 |
| P2 | delete-book not-found 合同不一致 | 已关闭：typed `BOOK_NOT_FOUND`，Studio 404 |
| P2 | CLI config 与 migration 直接覆盖 `inkos.json` | 已关闭：跨进程项目配置锁和原子替换 |
| P2 | 根级 release 门禁不完整 | 已关闭：typecheck、semantic、manifest、prod audit 全部纳入 |
| P2 | plan/compose/audit/consolidate 缺自身崩溃事务 | 已关闭：workflow journal、备份、rollback/committed cleanup 与真实强杀压力覆盖 |

本地优先、JSON 权威状态、Markdown 投影、章节快照和失败回滚方向仍然成立，不需要推翻重做。但 2026-07-12 的真实前端测试确认：审计合同、状态重建、hook 身份和取消体验已经是明确的下一步开发问题，不能再只归类为抽象的“真实模型语义质量”。
