# InkOS Episode v2 架构

## 目标

InkOS 面向 100 集、单集目标 150 秒（约 2.5 分钟）的中文竖屏漫剧。系统保留原有多阶段治理、状态管理、原子持久化和多入口能力，但不再把小说章节作为创作真源。

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
- 1～3 个场景；镜头数按目标时长动态预算（150 秒目标约 8～20 个），下限硬约束、上限软告警。

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

## 设定权威化

设定分两层：散文层（`story/outline`、`roles/`、`book_rules.md`、`pending_hooks.md`）是人工可读来源；结构化层（`story/canon/claims.json` 等）是机器可校验的权威事实。canon claims 建书时由抽取器生成，之后随剧集确定性演化：

- **结算**：claim 关键词命中本集交接知识、当集兑现或结尾状态时，`status` 从 `active` 变为 `resolved` 并记录 `statusUpdatedAtEpisode`；秘密真相在读者揭示前不结算。演化零模型调用、幂等，旧 claims 文件零迁移。
- **角色知晓**：`informationPermissions` 中知道或怀疑该事实的角色自动并入 `claim.visibility.characterKnownBy`。
- **引用完整性**：确定性门禁检查剧本对白说话人与本集目标角色必须能回指 `roles/` 或 canon 角色类 claim；未知名单产生审计问题，防止剧本发明设定。
- **两段式入库**：`inkos canon refresh` 先按剧本原始表述收集 occurrence（含混指代标 `unresolved`，不猜），再与既有 claims 比对给出 `reuse / new_variant / new_asset / unresolved` 四结论；服装、伤势、临时状态只能 `new_variant`。`unresolved` 留在未认领事实池；积压达到 `PipelineConfig.unclaimedFactsBacklogThreshold`（默认 50）时，后续规划与写作以 `CANON_REFRESH_REQUIRED` 暂停，必须刷新并审阅 Canon 后继续。

资产注册表（`story/canon/asset_registry.json`）为后续出图/出视频预留角色外观、服装、道具状态与场景视图结构；`CanonClaim.assetRefs` 让设定事实可指向资产实体。当前只建结构与存储，不接入任何图片/视频生成。

## 生产优化机制

- **钩子账本确定性落账**：planner memo 的 `advance` / `resolve` / `defer` 注解在写作、修订与状态重放路径中统一消费（重放缺失 memo 时回退读取持久化 plan，兼容 `**advance:**` 加粗小节），`hooks.json` / `pending_hooks.md` 随集推进或回收；Hook 可记录 `targetPayoffEpisode`、铺设/推进/终局证据和最后验证集。新增或推进的 memo 必须用 `证据：` / `evidence:` 声明可见载体；旧 Markdown 账本仍可读，只有存在生命周期数据时才扩列投影。
- **提前回收门禁**：只在当前集早于 `targetPayoffEpisode` 且声明的全部 `payoffEvidence` 同时出现在剧本时报告 critical。不再根据角色名、notes 或其他自由文本推测，避免账本与正文脱节后持续产生伪阳性。
- **Writer 边界阻断**：结构化剧本在落盘前校验结尾情绪钩子必须是关于关系、危险、身份、牺牲或选择的具体观众疑问句；模糊承诺直接返回 `INVALID_EMOTIONAL_HOOK`。命中禁止发布的政治敏感词直接返回 `BLOCKED_SENSITIVE_CONTENT`，不进入审计或修订循环。
- **时长归一化**：写后按比例缩放镜头秒数，把整集估算收敛到目标时长（±5 秒内不动，单镜头夹 2-45 秒，结果必须仍在 90-210 秒硬区间内才应用）；不改变镜头数量与内容，审计与持久化看到同一份权威时长。
- **Writer 输出解析兜底**：解析前剥离 `=== ... ===` 前导区块再提取剧本 JSON；时长越界草稿先做确定性镜头时长归一化（含 90-210 秒硬区间校验）再判定，避免无效修复调用与批次中断。writer 内部修复一次仍失败时由 runner 重新生成一次，最终失败把原始输出留存到 `story/runtime/episode-XXXX-writer-raw-fail.txt` 并在错误信息中给出路径；失败 attempt 消耗的 token 并入该集用量。
- **角色引用完整性**：确定性门禁把对白说话人剥离括号限定语（如"顾维远（画外）"）与常见修饰前缀后，回指 `roles/` 或 canon 角色类 claim；功能性角色标签（陌生女人/路人/哨兵/斥候队长/狱卒/校尉等，含任意长度角色词判定）与家庭角色、发声设备标签豁免；已出场说话人（更早持久化剧集引入）不再跨集重复告警，正式人名式新角色首次出现仍告警。
- **卷合同覆盖**：待写集号超出当前卷合同 `episodeEnd` 时给出非阻断警告，提示 `inkos foundation extend`（只重写 volume_map，保留 story_frame/roles/book_rules/pending_hooks）。
- **修订补丁模式**：reviser 在全部 finding 为局部时允许输出 `REVISED_PATCH`（replaceShots / updateContract / title / openingHook / reversal / emotionalHook / endState），确定性应用器校验失败自动回退完整改写；有 critical 时只向 Reviser 传递其有权处理的 critical，其他 finding 保留为审计证据，避免局部问题被无关 warning 扩大为整集重写。手动 `revise` 重审会合并确定性剧本门禁结果，结构性问题不再被误判为"无可执行阻断证据"。
- **容量可行性提示（STY-16）**：`episode-capacity-estimate.ts` 从本书已接受集采样每镜头平均承载的字数与秒数，把单集 memo 体量换算成镜头数与时长；只在 ≥2 倍量级偏差时输出非阻断提示（已接受集不足 3 集时跳过），接入 `inkos plan episode` 输出，另附 memo 承诺节拍数（场景意图 + 因果升级链）辅助度量。纯提示，不是质量门槛。
- **上游修订反馈回路**：审查循环因 planner/canon 类阻塞问题停在 `requires-upstream-revision` 时，这些 finding 持久化到 `story/runtime/upstream-revision-feedback.json`；下一次对同集规划时注入 memo 请求要求规划层自行修正（Hook 账、KR 绑定或决策本身），规划成功后清除。修稿环节始终无权触碰上游决策。
- **修订回归复核**：局部补丁与完整改写两条修订路径都必须通过携带回归检查表的复核（原文覆盖、镜头目的与 Hook 落点、时长预算、资产连续性、对白逐字、memo 约束）；确定性门禁干净不再短路掉修订候选的复核调用。
- **世界命名约束（建书）**：architect 提示词强制为世界起与标题/核心设定派生的专名，禁止"XX界/XX大陆/XX域"占位命名；brief 指定世界名必须沿用；确立后全剧统一不得改名。属提示词层硬规则，foundation-reviewer 的"世界一致性"维度在审核层呼应。
- **节拍变奏指令（防同构）**：writer 提示词允许慢热/过渡/后效/布局集变奏——反转槽位可替换为"压力停滞+新威胁"、情绪问题允许低音量、一集只改一个状态维度、时长允许落在软区间任意位置（不硬凑镜头），爽点类型须与最近几集轮换。
- **标题句式轮换检测**：`detectTitleShapeRepeat` 对连续 3 集共用同一句式壳（中文"X的Y"/双字，英文 "X of Y"/双词）报 warning 并自动从正文换新意象改名，与既有重复/折叠检测并列。
- **题材配置去模板化**：15 个内置题材的 `fatigueWords` 全部唯一——通用 AI 味词由 auditor 统一硬编码检查（中英文各一份），题材文件只保留题材特有词；爽点池统一 ≥8 类支撑长卷轮换；`auditDimensions` 按题材差异化（关系动态/读者期待等专用维度）。
- **污染守卫**：`scripts/audit-contamination.mjs` 维护付费测试书专名词表（角色/门派/地名/书名），拒绝其出现在生产源码、提示词与 Studio 文案中，作为 `pnpm verify` 门禁。所有历史污染均源自"付费书剧情 → 回归测试夹具 → 抄入生产代码"的同一条链；新付费书角色须先登记词表，再保持不进提示词与管线代码。
- **跨集镜头重复检测（防凑时长）**：`auditCrossEpisodeShotRepeat` 用两个确定性信号检测剧本复用上一集舞台调度来填充时长——① 镜头表面短语跨集重复（zh 6-gram / en 3-word）；② 行为签名 Jaccard 重合（从镜头 action/visual 抽取动作词，≥60% 报 warning）。接入 `auditEpisodeScript` 的可选 `recentScripts` 参数，runner 的 4 个审计点（standalone audit、revise 门禁合并、review 循环、write 落盘）统一传最近 3 集。补上了旧自由文本跨集重复检查在分镜格式下被短路的缺口。
- **输出上限跟随模型能力**：writer / reviser / canon-extractor 的 per-call `maxTokens` 从硬编码 8192 改为 `min(32768, 模型卡片 maxOutput)`——大模型（deepseek-v4-flash maxOutput 393216）用满 32768，小模型自动回落自身上限，避免 API 的 max_tokens 超限；`INKOS_MAX_OUTPUT_TOKENS_PER_CALL` 仍可对整体输出收紧。composer 的 8192 是上下文压缩输出，保持不动。
- **AI 味检测分镜短路修复**：`analyzeAITells`（套话密度/转折词重复/列表式）与英文 AI-tell 词密度此前只在自由文本分支运行（`creative.episodeScript ? [] : ...`），剧本格式下完全失效。现在分镜对镜头表面（visual/action/narration/dialogue）跑 `analyzeAITells`，英文场景额外跑 `detectEnglishAITellWordDensity`；英文 AI-tell 词表收敛为单一权威 `EN_AI_TELL_WORDS`（auditor 复用），删除三份不一致副本。

## 审计分级

- `structural_invariant`：schema、引用、ID、时长算术和直接状态矛盾，可阻断。
- `reviewed_invariant`：因果、兑现、关系变化和信息权限，需要证据，可阻断。
- `craft_default`：晚进早出、动作经济和反应落点，只产生建议。
- `taste_option`：钩子类型、旁白、沉默、视角和节奏，不阻断。

审计报告保存完整描述、建议、证据定位、责任方和源文件哈希。源文件变化后旧 finding 标记为 `stale`。

审计失败或运行状态降级的剧集不能作为默认交付物导出，必须先完成修订和状态恢复。

## 恢复与持久化

每集保存 JSON、Markdown、索引、结构化状态、摘要、Hook、审计证据、性能报告和 handoff capsule。多文件事务先写 staging，校验后提交；失败时恢复受影响文件。

handoff capsule 保存剧本哈希和最小交接状态。恢复时 hash 不一致会丢弃旧胶囊并从 Episode JSON 重新推导。

## 完本门禁

最终集必须解决主线冲突、主角核心欲望、主要人物弧线、关键 plot hook、关键 emotion hook 和核心关系冲突。存在核心未解决项时，`series complete` 拒绝将项目标记为 `completed`。
