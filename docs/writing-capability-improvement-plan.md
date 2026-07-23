# InkOS 写作能力提升开发方案

状态：开发方案
制定日期：2026-07-16
适用范围：Foundation、Planner、Writer、Auditor、Reviser、状态治理、Book Eval、Studio 评审体验

本文把当前写作能力评估中暴露的缺陷转成可实施的开发工作。全项目排期仍以[当前架构与开发优先级](current-architecture-and-priorities.md)为准；真实 provider 数据与历史样本见[真实 LLM 测试方法与阶段记录](live-llm-testing-and-next-goals.md)。

## 1. 目标与判断边界

InkOS 当前已经能连续生产、审校、修订和持久化长篇章节。下一阶段不应简单增加更多 prompt、更多 agent 或更高自动评分，而应回答三个不同问题：

1. **运行是否正确**：章节、truth、伏笔、快照、报告和恢复状态是否一致。
2. **编辑质量是否提高**：因果、人物、情绪、节奏、文风和信息密度是否有可定位证据。
3. **读者体验是否成立**：人类读者是否愿意继续读，能否区分角色声音，能否感受到伏笔兑现和情绪推进。

这三层必须分别记录。工程门禁通过不能自动推导出文学质量通过，模型评分也不能替代人工判断。

### 1.1 当前证据

- DeepSeek 官方真实 linked acceptance 已连续持久化 15 章，第 1-15 章均为 `ready-for-review` 且 Doctor 关联成功。
- 章节索引、manifest、current state 和 `0..15` 快照一致，证明中距离生产链路可用。
- 第 16 章因 resync 后标准伏笔 ID 携带展示标题而未提交；规范化修复已有离线回归，尚未完成新的 20/20 章复验。
- 当前章节审核采用 85 分门槛、critical 阻断、字数 hard range、有限修订和最佳版本回滚。
- 当前 `evaluateBookQuality()` 的 `qualityScore` 由审计通过率、AI 痕迹密度、短段警告、伏笔回收率和重复标题加权得到。该分数适合发现运行和表面问题，不足以代表情节吸引力、人物声音或出版质量。

### 1.2 能力缺口矩阵

| 能力 | 当前判断 | 已有优势 | 主要缺口 | 目标状态 |
| --- | ---: | --- | --- | --- |
| 成书设定与大纲 | 7.5/10 | Foundation 五维审核、卷纲、逐章节拍、规模门禁 | 样本分数波动；节拍完整不等于因果升级或人物弧成立 | 结构覆盖、因果升级和人工编辑评价同时通过 |
| 单章正文 | 7/10 | memo、受控上下文、字数治理、章节审核 | 缺少人工盲评；模型高分可能掩盖平庸、模板化和信息重复 | 章节可读性与文学维度有独立证据 |
| 连续性与伏笔 | 7.5/10 | 结构化 truth、Canon、hook ledger、快照、时序记忆 | 真实 15→16 章曾发生 ID 漂移；伏笔“存在”不等于有效推进与兑现 | 20 章零非法引用，伏笔推进和兑现可解释 |
| 审校与修订 | 7.5/10 | local/structural scope、patch/rewrite、最佳版本回滚、无变化终止 | Writer 与 Reviewer 可能同模型自评；问题证据和修订收益不够独立 | 每次修订有证据、有收益、无事实回归 |
| 文风与去 AI 味 | 6.5/10 | 题材规则、疲劳词、禁用句式、AI tell 检测 | 表面规则可能导致统一腔、过度修饰和角色声音趋同 | 作者风格可控，角色声音可区分，修订不过度抹平 |
| 长篇自主运行 | 6/10 | 15 章连续落盘、事务恢复、Doctor、telemetry；最新六章已验证有界 repair/resync/rewrite/revise；内容策略治理 fallback 已通过 linked stub | 20/20 未通过；尚缺独立 fallback provider 的真实长跑证据 | 两次独立 20 章运行完成且状态与报告一致 |

## 2. 开发原则

### 2.1 证据先于分数

任何编辑问题必须尽量包含正文证据、位置、违反的合同、置信度和建议动作。禁止只返回“人物不够鲜明”“节奏一般”这类无法验证的判断。

### 2.2 评价来源分离

评价结果必须标明来源：

- `deterministic`：schema、ID、字数、重复、引用和状态一致性。
- `model`：编辑模型对因果、人物、情绪、节奏和文风的判断。
- `human`：人工盲评和明确的接受/拒绝意见。

正式文学质量结论至少需要独立 Reviewer 路由或人工证据。Writer 与 Reviewer 使用同一有效 service/model 时，报告必须标记 `independence=false`，不能伪装成独立评价。

### 2.3 正确性和文学质量双门禁

- 正确性门禁可以自动阻断：非法 hook、Canon 冲突、truth 丢失、章节事务未提交、critical 连续性问题。
- 文学质量默认进入 review：低张力、声音趋同、表达平庸等问题需要证据和人工选择，不应仅凭模型总分删除一个事实正确的章节。

### 2.4 防止为指标写作

指标用于发现候选问题，不直接规定固定句式、段落数量或每章必须出现的修辞。每个自动指标都必须有反例测试，避免 Writer 为通过检测而生成更机械的文本。

### 2.5 人工修改是高价值信号

作者接受、拒绝或重写某个建议时，应记录原因和范围，用于本书后续评审偏好；不得把用户正文自动上传或变成跨项目训练数据。

### 2.6 成本只做观测

继续记录调用数、耗时和 token，用于容量规划和异常诊断，但本方案不把降低写作成本作为文学质量迭代的完成条件。

## 3. 统一写作评价合同

### 3.1 Book Eval v2

保留现有 `BookEval.qualityScore` 以兼容 CLI 和 Studio，但将其明确重命名展示为“运行质量代理分”。新增版本化报告，不静默改变旧分数含义。

建议合同：

```ts
interface WritingEvaluationReportV2 {
  version: 2;
  bookId: string;
  scope: "foundation" | "chapter" | "arc" | "book";
  chapterRange?: { start: number; end: number };
  operational: {
    score: number;
    passed: boolean;
    checks: WritingOperationalCheck[];
  };
  editorial?: {
    score: number;
    independence: boolean;
    reviewer: EvaluationProvenance;
    dimensions: WritingDimensionResult[];
  };
  human?: {
    completedReviews: number;
    dimensions: WritingDimensionResult[];
  };
  verdict: "blocked" | "needs-review" | "accepted";
}

interface WritingDimensionResult {
  id: string;
  score: number;
  confidence: number;
  evidence: Array<{
    chapter: number;
    quote?: string;
    startOffset?: number;
    endOffset?: number;
    explanation: string;
  }>;
  suggestion?: string;
}
```

### 3.2 编辑维度

章级维度：

- `causal-progression`：事件是否由人物选择和前因推动。
- `character-agency`：主要人物是否主动决策并承担结果。
- `voice-consistency`：叙述和角色声音是否稳定且可区分。
- `scene-tension`：目标、阻力和局势变化是否存在。
- `emotional-movement`：情绪是否因事件发生可观察变化。
- `information-economy`：是否重复解释已知信息或总结刚发生的内容。
- `prose-naturalness`：语言是否具体、自然，避免模板化过渡和统一腔。
- `chapter-delivery`：章节 memo 的可观察交付和章末钩子是否完成。

弧级/书级维度：

- `escalation`：冲突是否升级而不是横向换场景。
- `character-arc`：人物信念、关系或能力是否发生累积变化。
- `hook-payoff`：伏笔推进与兑现是否具有因果意义。
- `repetition-drift`：场景结构、开头、结尾和冲突解法是否重复。
- `promise-fulfillment`：开篇承诺、题材承诺和卷级核心结果是否兑现。

### 3.3 判定规则

- `operational.passed=false` 时 verdict 必须为 `blocked`。
- 只有模型评价且 `independence=false` 时，最高只能为 `needs-review`。
- `accepted` 需要运行门禁通过，并满足独立模型评价或人工评价的配置要求。
- 编辑低分不能覆盖正确性更高的现有版本；修订循环继续使用最佳快照选择。
- 聚合分只用于排序和趋势，任何自动阻断必须指向具体 check 或 critical evidence。

## 4. 工作流 A：评价基线与质量语料

优先级：P0，所有文笔 prompt 修改的前置依赖。

### 4.1 缺陷

当前回归擅长验证 parser、状态、prompt 合同和确定性 gate，但没有稳定的文学质量基准。直接修改 Writer 或 Auditor prompt 很容易只让模型更会迎合自评分数。

### 4.2 开发项

1. 扩展现有 `packages/core/src/utils/book-eval.ts`，增加 v2 orchestration；旧接口保持兼容。
2. 新增版本化评价 model，禁止把可选模型评价塞回 `ChapterMeta.auditIssues`。
3. 建立合成或明确授权的质量语料，至少覆盖：优秀/平庸开篇、角色声音漂移、信息重复、无因果事件、有效伏笔兑现、机械去 AI 味、错误审校反例。
4. 每条语料同时保存期望维度、允许分歧范围和必须定位的证据，不保存 API Key、真实用户私稿或未经授权文本。
5. 扩展现有 `inkos eval`，增加 `--scope`、`--editorial`、`--reviewer-service`、`--reviewer-model` 和版本化 JSON 输出。
6. Studio 继续复用现有书籍评价入口，分别显示运行质量、编辑质量和人工评价，不再只显示一个 `qualityScore/100`。

### 4.3 代码边界

- Core：`utils/book-eval.ts`、新评价 model/evaluator、现有 telemetry provenance。
- CLI：`commands/eval.ts` 只解析参数和展示结果。
- Studio：现有 evaluate API 与 BookDetail 只消费 Core 报告，不重复评分公式。

### 4.4 完成条件

- 旧 `inkos eval --json` 字段保持兼容，并明确返回版本或 legacy 标记。
- v2 报告能区分 operational/model/human 来源和 Reviewer 独立性。
- 固定质量语料对每个维度至少包含一个正例、一个负例和一个容易误报的反例。
- 同一输入重复运行的确定性部分完全一致；模型部分保留 provenance 和波动范围。

## 5. 工作流 B：20 章状态与报告闭环

优先级：P0，与工作流 A 可并行；文学能力开发前必须关闭。

### 5.1 缺陷

- resync 后 canonical hook ID 修复只有离线证据。
- 外部终止时 linked report 可能停在 `running`，顶层统计与磁盘终态不一致。
- 审计与状态恢复曾分别由 Scheduler 和 linked acceptance 编排，正文变化后缺少统一的阻断证据和有界停止合同。
- provider 内容安全拒绝的独立分类、治理 agent 一次性跨 provider fallback 和失败后 pause 已完成确定性回归；尚缺新的真实 20 章复验证据。
- 伏笔“记录存在”与“在剧情中有效推进”尚未分开评价。

### 5.2 开发项

1. 在 Planner、Settler、Analyzer、state bootstrap 和 hook ledger validator 的所有输入边界统一 `HookRef` 解析，模型显示名不得进入主键。
2. 运行前把有效 hook registry 编译成 canonical ID + display label，Planner 输出只能引用 registry ID 或显式创建派生 ID。
3. linked report 每章增量写 durable checkpoint；父进程异常退出后，下次读取能生成 `interrupted` 终态而不是永久 `running`。
4. 最终报告从 index、truth、snapshots 和 runtime JSONL 重建权威汇总，报告内中间事件单独保留。
5. 为章节恢复持久化正文 fingerprint、结构化 blocking issues 和终止原因；Scheduler、Studio linked acceptance 共享有界恢复策略，证据不属于当前正文时必须先重新审计。
6. [已完成，待真实复验] 将 provider 内容安全拒绝分类为独立、不可原 provider 重试的错误；为 Planner、Settler、Analyzer 等治理 agent 提供显式配置的一次性跨 provider fallback，并保持 operationId、telemetry、预算和报告归属不变。
7. 增加弧级 hook 评价：只记录、提醒、推进、转折、兑现分层，避免用 status 变化冒充剧情推进。

### 5.3 完成条件

- 全新项目连续 20/20 章持久化，无非法 hook 引用和 canonical 冲突。
- `chapters/index.json`、manifest、current state、摘要、hooks 与 `0..20` 快照一致。
- 所有章节 Doctor operation 关联成功，无 `state-degraded` 或 `audit-failed` 最终状态。
- 正常完成、协作取消、父进程强杀三种场景都能得到稳定 terminal report。
- [确定性门禁已通过，待真实复验] 注入治理 agent 的 provider 内容安全拒绝时，同一 provider 不重试；配置的 fallback 只执行一次，并保持 operationId、telemetry、预算和报告归属一致。
- 至少两条跨 5 章以上的伏笔在正文证据中完成“铺设→推进→兑现”，不能只依赖 ledger 字段判断。

## 6. 工作流 C：Foundation 与长篇因果规划

优先级：P1，依赖工作流 A 的评价基线。

### 6.1 缺陷

Foundation 已检查冲突、开篇、世界、角色和节奏，但“逐章节拍字段齐全”仍可能产生重复任务、横向换场景或人物被剧情拖着走。

### 6.2 开发项

1. 在现有 compact beat contract 上增加 `becauseOf`、`characterChoice`、`cost` 和 `changesNextChapter`，形成章间因果链。
2. 为主角和关键配角记录每卷的欲望、错误信念、压力选择和不可逆变化，不把人物弧简化为状态枚举。
3. Foundation Reviewer 增加相邻节拍重复、冲突升级、人物主动性和最终承诺兑现检查。
4. 允许 Reviewer 返回局部结构修订建议；Architect 只重写失败区段，不因一个维度低分重新生成全部 Foundation。
5. 对原创新书和续写/系列模式分别维护评价语料，避免用原创开篇规则误伤续写作品。

### 6.3 完成条件

- 20 章节拍全部具有明确因果来源、人物选择、代价、局势变化和章末后果。
- 不允许连续两章使用相同目标、阻力和解决方式的组合。
- 第 5、10、15、20 章分别能指出冲突升级或人物弧的可观察变化。
- Foundation 总分通过之外，任何单维低于 floor 仍阻断；人工编辑抽查不出现“字段齐全但故事没有升级”的结论。

## 7. 工作流 D：单章正文与角色声音

优先级：P1，依赖工作流 A；可在工作流 B 完成后进入真实长跑。

### 7.1 缺陷

- 当前 Writer 能执行 memo 和长度合同，但没有证明文字具有稳定的作者风格和角色区分度。
- 去 AI 味主要处理表面模式，可能把不同人物修成同一种安全、工整的语言。
- 章节高分可能来自“没有明显错误”，不等于场景有张力或读者愿意继续读。

### 7.2 开发项

1. 从用户授权样本或本书已批准章节提取 `VoiceProfile`：叙述距离、句法节奏、意象偏好、幽默方式、禁用倾向和允许变化范围。
2. 为主要角色维护可执行的 `CharacterVoiceProfile`：词汇域、句长、回避话题、权力姿态、潜台词方式；不保存固定口头禅模板。
3. Writer 在场景级接收目标、阻力、选择、后果和情绪变化，不要求输出额外解释性元数据到正文。
4. 新增跨章语义重复候选检测，重点检查开头启动方式、结尾钩子、冲突解法和总结句，而不是只查重复词。
5. Auditor 对 voice 问题必须引用至少两个可比较片段；单段“不像某人”只能是低置信度建议。
6. Anti-detect 修订增加保真门禁：不得删除关键事实、改变人物立场或把有意的风格特征当成 AI 痕迹。

### 7.3 完成条件

- 对至少三名主要角色进行匿名对白归属测试，人工识别率达到 75% 以上。
- 第 1、5、10、15、20 章人工盲评中，因果推进、人物主动性、声音、场景张力、语言自然度五项均值不低于 4/5，且没有单项低于 3.5。
- 20 章内没有连续三章使用相同开头结构、冲突解法或结尾句式。
- 去 AI 味修订后的事实和 claim 集合与修订前一致，人工评价不得出现明显“统一腔”回归。

## 8. 工作流 E：独立审校与修订收益

优先级：P1，依赖工作流 A 和 D 的维度合同。

### 8.1 缺陷

- 同模型 Writer/Auditor 容易共享盲点或互相迎合评分格式。
- 当前修订循环能识别无变化和回滚最佳版本，但“分数上涨”仍不等于读者体验提升。
- 模型问题可能缺少准确位置，导致 Reviser 扩大修改范围。

### 8.2 开发项

1. 在 agent model routing 中增加可选 `editorial-reviewer` 路由；默认复用现有模型时明确标记非独立。
2. AuditIssue v2 增加 evidence range、confidence、contractId 和 `verificationMethod`。
3. Reviser 只接收被选中的问题及其证据；local issue 继续使用精确 PATCHES，structural issue 才获得完整场景上下文。
4. 修订后先验证原问题是否关闭，再运行事实、claim、hook 和 voice 回归；不因为总分随机上涨自动接受。
5. 保存初稿、候选修订、机器选择理由和人工最终选择，用于本书偏好统计。
6. Studio 提供并排 diff、问题证据、接受/拒绝原因和恢复最佳版本入口。

### 8.3 完成条件

- 每个自动修订问题都有可定位证据；没有证据的文学意见只进入人工建议区。
- 修订候选只有在 blocker 减少、独立编辑维度改善或人工接受时才能替换当前最佳版本。
- `revision-unchanged`、问题指纹不变和正文循环路径不再产生额外 Reviser 调用。
- 固定语料中，事实正确章节不会因低置信度风格意见被自动结构重写。
- 人工拒绝原因能影响本书后续建议排序，但不改变其他书籍。

## 9. 工作流 F：长篇自主性与卷级验收

优先级：P2，依赖 B-E。

### 9.1 缺陷

当前只证明 15 个连续持久化章节，没有证明完整 20 章、卷级承诺兑现、长期角色弧和第二次独立运行的稳定性。

### 9.2 开发项

1. 在第 5、10、15、20 章生成 arc checkpoint，记录核心冲突、人物弧、已兑现承诺、活跃伏笔和重复风险。
2. Volume Auditor 从只检查字段进度升级为检查正文证据和章节因果链。
3. Scheduler 在 checkpoint 失败时暂停并给出单一建议：继续、局部修订、重写本章或回滚到弧起点。
4. 20 章报告增加跨章重复、角色声音、伏笔推进、承诺兑现和人工抽查结果，不只汇总 token 与状态。
5. 使用不同题材或不同随机种子执行第二次独立 20 章验收，避免对单本书过拟合。

### 9.3 完成条件

- 两次独立运行均达到 20/20 持久化和正确性门禁全绿。
- 每次运行的第 5、10、15、20 章 arc checkpoint 都有正文证据。
- 核心冲突在第 20 章按 Foundation 承诺闭合或达到明确的卷级阶段结果。
- 人工盲评不出现后半程人物声音显著趋同、冲突强度持续下降或大面积重复解释。
- 满足以上条件后，才能把 daemon 从“工程可运行”提升为“长篇写作可推荐”。

## 10. 实施顺序

阶段 0 与阶段 1 可以并行：20 章正确性复验不等待 Book Eval v2；但任何以“提升文笔”为目标的 Writer、Auditor 或 Reviser 调整必须等待阶段 0 建立基线，避免在没有比较标准时修改 prompt。

### 阶段 0：建立真实质量基线

1. Book Eval v2 schema 与来源分离。
2. 固定质量语料和人工评分表。
3. CLI/Studio 兼容展示。

退出条件：可以在不修改 Writer 的前提下，重复得到一份可解释、可比较的质量报告。

### 阶段 1：关闭 20 章正确性

1. HookRef 全边界规范化与 registry。
2. durable report terminalization。
3. 全新 DeepSeek 20 章复验。

退出条件：20/20 运行正确性全绿，报告和磁盘终态一致。

### 阶段 2：提升规划、正文和修订

1. 因果化 Foundation beat。
2. VoiceProfile 与语义重复检查。
3. 独立 Reviewer 和 evidence-based revision。

退出条件：固定语料无回归，人工盲评分达到本方案阈值。

### 阶段 3：卷级和第二次长跑

1. arc checkpoint 与 Volume Auditor 正文证据。
2. Studio 人工评审闭环。
3. 第二题材/种子的 20 章验收。

退出条件：两次独立 20 章运行同时通过工程和人工质量门禁。

## 11. 测试策略

### 11.1 提交级

- evaluator schema、评分兼容、provenance、证据 offset 和反例 corpus。
- HookRef、claim、voice、revision 事实保真和报告 checkpoint 的定向 Vitest。
- Core package typecheck 和相关 Studio API/component 测试。

### 11.2 合并级

- `pnpm verify` 全量门禁。
- 固定质量语料回归；模型评价使用录制或 stub，不调用真实 provider。
- linked stub 验证浏览器、API、Core、报告、Doctor 和人工评价持久化。

### 11.3 发布候选级

- 全新隔离项目真实 20 章。
- 第 1、5、10、15、20 章双人盲评。
- 运行结束后归档脱敏汇总并清理原始报告、正文副本和临时 secrets。

## 12. 风险与非目标

### 12.1 风险

- **基准投机**：模型可能学会迎合固定语料。需要保留隐藏反例和新增真实样本。
- **Reviewer 偏差**：不同模型评分尺度不同。必须保留 provenance、置信度和人工校准。
- **过度修订**：更多评价维度可能抹平个性。最佳版本回滚和人工选择必须保留。
- **版权与隐私**：质量语料只能使用合成、开源许可或明确授权文本。
- **中英文不等价**：中文短段、英文句长和对话节奏不能共享一套机械阈值。
- **长跑偶然性**：单次 20 章成功不代表稳定，至少需要第二次独立运行。

### 12.2 非目标

- 不承诺商业成功、出版通过或替代职业编辑。
- 不为了提高自动分数强制统一段落、修辞或章节模板。
- 不在本阶段新增更多无明确职责的 agent。
- 不把真实用户正文提交进仓库或跨书聚合训练。
- 不以降低 token 成本作为写作能力完成条件。

## 13. 最终完成定义

本方案只有在以下条件同时满足时才算完成：

1. Book Eval v2 能区分运行质量、独立编辑质量和人工质量，旧接口保持兼容。
2. 固定质量语料覆盖六项能力的正例、负例和误报反例。
3. 两次独立真实 20 章运行均为 20/20，truth、快照、Doctor 和报告终态一致。
4. 第 1、5、10、15、20 章人工盲评达到约定阈值，角色声音归属测试达到 75%。
5. 修订候选有可定位证据和可证明收益，事实、claim、hook 与 voice 不回归。
6. 卷级核心冲突、人物弧和关键伏笔具有正文证据，而不是只在结构化 ledger 中标记完成。

达到上述条件后，InkOS 才能从“可用的长篇协作写作工作台”升级为“经过证据验证的半自动成书系统”。
