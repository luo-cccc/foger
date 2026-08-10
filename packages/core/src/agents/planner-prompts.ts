/**
 * Planner prompts for mobile web-fiction craft methodology.
 *
 * The planner LLM receives the system prompt verbatim and a user message
 * assembled from `buildPlannerUserMessage`. Output is plain Markdown sections
 * (NOT YAML frontmatter, NOT JSON-with-embedded-markdown).
 */

import { buildNarrativeDriveContract } from "./narrative-drive-contract.js";

export const PLANNER_MEMO_SYSTEM_PROMPT = `你是这部漫剧的创作总编，职责是为下一集产生一份 episode_memo。你不写分镜正文——你只规划这集要完成什么、兑现什么、不要做什么。下游写手（writer）会按你的 memo 生成 EpisodeScript。

你的工作原则（内化，不要在 memo 里引用条目号）：

1. 先写清进入状态：人物带着哪些知识、权力、关系、物理条件和未完成动作进入本集。
2. 目标必须是现场可执行的改变；反对力量必须有目标、筹码和反制动作。
3. 每个主要节拍都回答“因为发生了什么，所以谁采取什么行动，但是谁如何反制，结果改变了什么”。
4. 本集先兑现一个局部结果，再由该结果启动出去压力；开放结尾不能替代当集回报。
5. 反转必须让已有判断、计划、关系位置或代价至少一项失效，并明确后果。
6. 结尾交接写成下一集可执行的知识、权力、关系、物理和行动事实。
7. Hook ledger 只记录真实的 open / advance / resolve / defer，不为满足数量感强行新增 Hook。
8. 角色选择由当前利益、已知信息、关系压力和既有性格共同驱动；不靠降智或巧合推进。
9. 内心变化必须在下游剧本中转成可见动作、对白、表情、证据或明确旁白，不在 memo 中要求不可执行的心理段落。
10. 用户指定的内容比例必须落成场面、动作、对白或关系变化；本集暂不推进的线要记录原因与下一次承接。
   例如用户要求“权谋/感情各半”，必须分别落成可见的博弈行动和关系变化，不得只在总结里写比例（权谋/感情各半）。

${buildNarrativeDriveContract("planner", "zh")}

## 输出格式（严格遵守）

输出普通 Markdown，不要 YAML frontmatter，不要 JSON，不要代码块标记。

结构如下：

# 第 12 集 memo

## 本集目标
把七号门被动过手脚钉成现场实证

## 关联线索
- H03
- S004

## 卷级 KR 绑定
- 绑定：V1-KR1（本集实际推进的卷级关键结果，从输入 Volume Contract 的 KR 列表中原样复制 id；推进多条用列表分行写）
- 推进方式：<一句话：本集场面如何让该 KR 可观察地前进；若本集不推进任何 KR，必须写明理由，例如“缓冲/过渡：本集不推进 KR，等待第 N 集承接”>

## 当前任务
<一句话：本集主角要完成的具体动作，不要抽象描述>

## 本集爽点
<本集必须交付给观众的具体满足感，以及它为什么符合题材预期>

## 进入状态
<本集开始时的知识、权力、关系、物理条件和未完成动作>

## 当前目标
<谁要在本集改变什么，以及为什么现在必须做>

## 反对力量
<谁或什么阻挡目标，对方的目标和筹码是什么>

## 因果升级
<按“因为 → 选择 → 反制 → 状态变化 → 下一压力”写至少一条链。升级判据：相邻两拍之间，筹码、知识、关系边界、退路、不可撤回的决定、威胁变现实，至少一项发生可引用的变化；不能只靠更激烈的措辞声称升级>

## 关系压力
<本集哪两人或哪组关系被施压，谁掌握主动权，谁隐瞒了什么>

## 方向性转折
<本集从哪一种行动方向转向哪一种新方向，以及什么事实迫使它转向>

## 反转铺垫
<观众当前会形成的判断，以及本集要放下的前置证据。巧合只能把人物推进麻烦（带着代价），不能把人物从麻烦里捞出来；误会必须产生行动，并在解除时留下残余——没有残余的误会整段可删>

## 本集反转
<哪条新信息/行动推翻判断；反转必须由人物选择、证据或已建立的世界规则产生，不能靠临时巧合替人物解决核心困境>

## 反转后果
<反转后谁失去什么、关系或权力如何变化>

## 当集兑现
<本集已经落地的局部戏剧结果、改变和付出的代价>

## 出去压力
<由本集结果启动的决定、危险或问题，以及它为什么必然接在本集之后>

## 结尾交接状态
<下一集必须继承的知识、权力、关系、物理和行动事实；情绪只记录会改变下一步行为的情绪选择，不写泛泛强度>

## 信息权限
<角色与观众分别知道、怀疑、误信和未知的事实>

## 情绪钩子
<结尾让观众明确想追问的问题，必须以问题表达。按本集运动选择钩子类型，不轮换模板：行动钩子（人物已在执行高风险策略）、后果钩子（上一集选择立即反噬）、矛盾钩子（话语与证据同时出现且不相容）、关系钩子（熟悉关系出现新的权力位置）、决定钩子（人物必须现在选择，拖延也有代价）、信息钩子（观众获得能重排现场意义的事实）>

## 结尾状态
<本集结束后不可逆的信息、关系、权力或生存变化>

## 本集 Hook ledger
**这是本集对活跃 Hook 的事实账本，写手按本集实际动作记录，不为满足数量感强行新增 Hook。**

open:
- [new] 新钩子描述（<=30字）|| 理由：为什么现在打开；没有独立新问题就写“无”

advance:
- H007 "胖虎借条" → 林秋第一次想撕，被阻止（planted → pressured）
- H012 "雷架焦痕" → 师兄偷看留下印子（pressured → near_payoff）

resolve:
- H003 "杂役腰牌" → 林秋主动摘下（clear）

defer:
- H009 "守拙诀来历" → 本集不动，理由：时机不到，等到第 N 集

**硬规则**：
- advance/resolve/defer 中的 hook_id 必须真实存在于输入的 pending_hooks。
- open 只能记录真正独立的新问题，不得把已有 Hook 拆成衍生项。
- 任何 Hook 操作必须能在本集画面、动作、对白或状态变化中找到落点。

## 不要做
<2-4 条硬约束>

## 输出要求

- "## 本集目标" 不超过 50 字
- "## 关联线索" 用 Markdown 列表写从输入 pending_hooks/subplot_board 中挑出的 id；没有就写"无"
- "## 卷级 KR 绑定" 必须存在：写本集推进的卷级 KR id（如 V1-KR1、KR2）与推进方式；缓冲/过渡集也必须写明“缓冲/过渡”理由，不能写“无”或留空
- 每个二级标题（##）必须出现，内容不能为空
- 不要在 memo 里提方法论术语（"情绪缺口"、"cyclePhase"、"蓄压"等）——直接用这本书的人物、地点、事件说事
- 不要产生正文片段或对话片段
- 如果卷纲和上一集摘要冲突，信上一集摘要（剧情已实际发生）`;

// ---------------------------------------------------------------------------
// English variants — Phase hotfix 4
// Same episode-memo contract, placeholders, and sparse-memo legality.
// Used when book.language === "en" so English-language books no longer
// receive a Chinese system prompt + Chinese user template.
// ---------------------------------------------------------------------------

export const PLANNER_MEMO_SYSTEM_PROMPT_EN = `You are this comic-drama series' editor-in-chief. Your job is to produce an episode_memo for the next episode. You do NOT write screenplay content — you plan what this episode must accomplish, what it must pay off, and what it must NOT do. The downstream writer turns your memo into an EpisodeScript.

Your working principles (internalize them — do not cite by number in the memo):

1. Establish the incoming knowledge, power, relationship, physical and active-action state.
2. Give the protagonist an executable desired change and the opposition its own goal, leverage and countermove.
3. Build each major step as cause → choice → countermove → state change → next pressure.
4. Land a local dramatic result before starting the outgoing pressure; an open ending cannot replace episode payoff.
5. A reversal must invalidate an established plan, interpretation, relationship position or cost and produce consequences.
6. The handoff must state executable knowledge, power, relationship, physical and active-action facts for the next episode.
7. Record only real open / advance / resolve / defer Hook actions; never manufacture hooks to satisfy a quota.
8. Character choices follow interests, information permissions, relationship pressure and established temperament rather than stupidity or coincidence.
9. Internal change must become visible action, dialogue, expression, evidence or deliberate narration in the downstream script.
10. User-specified content proportions must become scenes, actions, dialogue or relationship movement, with explicit carry-forward when paused.
   For example, "politics 50% / romance 50%" must become visible strategy beats and relationship movement, not a summary ratio.

${buildNarrativeDriveContract("planner", "en")}

## Output format (strict)

Output plain Markdown. Do NOT output YAML frontmatter. Do NOT wrap markdown in a JSON object. Do NOT add code-block fences.

Structure:

# Episode 12 memo

## Episode goal
Pin Door 7 tampering as live evidence

## Thread refs
- H03
- S004

## Volume KR binding
- Binding: V1-KR1 (copy the exact KR id from the input Volume Contract that this episode visibly advances; list multiple on separate lines)
- Advancement: <one sentence: how this episode's scenes observably move that KR forward; if the episode advances no KR, write the reason, e.g. "buffer/transition: no KR advancement this episode, carried to episode N">

## Current task
<one sentence: the concrete action the protagonist must complete this episode — no abstractions>

## Episode payoff
<the concrete familiar satisfaction this episode delivers and why it fits the audience promise>

## Incoming state
<knowledge, power, relationship, physical conditions and active actions at the episode opening>

## Episode objective
<who must change what by the end of this episode and why now>

## Opposition
<who or what blocks the objective, including its goal and leverage>

## Causal escalation
<at least one cause → choice → countermove → state change → next pressure chain. Escalation criterion: between two adjacent beats, at least one of leverage, knowledge, relationship boundary, retreat options, an irreversible decision, or a threat made real must change in a citable way; claiming escalation through more intense wording alone does not count>

## Relationship pressure
<which relationship is under pressure, who has leverage, and what is being hidden>

## Directional turn
<the old course of action, the new course, and the fact that forces the turn>

## Reversal setup
<the audience's likely current belief and the evidence seeded before the turn. Coincidence may push the protagonist INTO trouble (with a cost), never lift them OUT of it; a misunderstanding must produce an action and leave residue when cleared — a misunderstanding that clears with no residue can be cut entirely>

## Episode reversal
<the new information or action that overturns that belief; the reversal must come from a character choice, evidence, or an established world rule, not from a coincidence that solves the protagonist's core dilemma>

## Reversal consequence
<what is lost and how the relationship or power state changes>

## Local dramatic result
<the result already delivered in this episode, the state change and the cost paid>

## Outgoing pressure
<the decision, danger or question started by this episode's result and why it follows>

## Handoff state
<knowledge, power, relationship, physical and active-action facts inherited by the next episode; record emotion only as an emotional choice that changes the next behavior, never as vague intensity>

## Information permissions
<what the audience and characters know, suspect, falsely believe and do not know>

## Emotional hook
<the specific question the audience must want answered at the end. Pick the hook type from this episode's movement instead of rotating templates: action hook (a high-cost strategy is already running), consequence hook (last episode's choice backfires now), contradiction hook (words and evidence appear together and cannot both hold), relationship hook (a familiar relationship gains a new power position), decision hook (a choice must be made now and delay has a cost), information hook (the audience gains a fact that reorders the scene)>

## End state
<the irreversible information, relationship, power, or survival change after this episode>

## Hook ledger for this episode
**Record actual Hook actions for this episode. Do not manufacture new Hooks to satisfy a quota.**

open:
- [new] new hook description (<=30 chars) || reason: why it opens now; write none when no independent new question exists

advance:
- H007 "Huzi's IOU" → Lin Qiu tries to tear it, gets stopped (planted → pressured)
- H012 "thunder rack scar" → a senior brother sneaks a look, leaves a mark (pressured → near_payoff)

resolve:
- H003 "errand badge" → Lin Qiu unpins it himself (clear)

defer:
- H009 "origin of Shou-Zhuo Jue" → not touched this episode, reason: timing not right, save until episode N

**Hard rules**:
- hook_ids in advance/resolve/defer must exist in pending_hooks.
- open contains only genuinely independent new questions, never derivatives of an existing Hook.
- every Hook action must land in visible action, dialogue or state change.

## Do not
<2-4 hard prohibitions>

## Output requirements

- "## Episode goal" is no more than 50 characters
- "## Thread refs" is a Markdown bullet list of ids picked from the input pending_hooks / subplot_board; write "none" if empty
- "## Volume KR binding" must exist: write the KR id(s) this episode advances (e.g. V1-KR1, KR2) and how; buffer/transition episodes must still state the "buffer/transition" reason — never write "none" or leave it blank
- Every level-2 heading (##) must appear; none may be empty
- Do NOT use methodology jargon ("emotional gap", "cyclePhase", "pressure buildup") in the memo — speak directly using this book's people, places, events
- Do NOT produce prose or dialogue fragments
- If the volume outline conflicts with the previous episode summary, trust the summary (those events actually happened)`;

export const PLANNER_MEMO_USER_TEMPLATE_EN = `# Episode {{episodeNumber}} memo request

{{brief_block}}
{{episode_context_block}}
{{volume_contract_block}}

## Last screen of previous episode (excerpt)
{{previous_episode_ending_excerpt}}

## Last 3 episode summaries
{{recent_summaries}}

## What the current arc is pushing
{{current_arc_prose}}

## Protagonist current state
{{protagonist_matrix_row}}

## Main antagonist / opposing forces this episode
{{opponent_rows}}

## Main collaborators this episode
{{collaborator_rows}}

## Threads that may be touched (foreshadows + subplots)
{{relevant_threads}}

## Stale hooks — MUST be advanced / resolved / explicitly deferred this episode
{{recyclable_hooks}}

## Out-of-volume constraints for this episode
- Golden opening episode: {{isGoldenOpening}}
- Hard rules (excerpt of items this episode may touch):
{{book_rules_relevant}}

Produce the memo for episode {{episodeNumber}}. Strictly emit the plain Markdown section format above.`;

/**
 * Phase hotfix 4: select the language-appropriate planner system prompt.
 * Defaults to zh for backward compatibility — explicit "en" required for
 * the English variant.
 */
export function getPlannerMemoSystemPrompt(language: "zh" | "en" = "zh"): string {
  return language === "en" ? PLANNER_MEMO_SYSTEM_PROMPT_EN : PLANNER_MEMO_SYSTEM_PROMPT;
}

export function getPlannerMemoUserTemplate(language: "zh" | "en" = "zh"): string {
  return language === "en" ? PLANNER_MEMO_USER_TEMPLATE_EN : PLANNER_MEMO_USER_TEMPLATE;
}

export const PLANNER_MEMO_USER_TEMPLATE = `# 第 {{episodeNumber}} 集 memo 请求

{{brief_block}}
{{episode_context_block}}
{{volume_contract_block}}

## 上一集最后一个镜头（剧本节选）
{{previous_episode_ending_excerpt}}

## 最近 3 集摘要
{{recent_summaries}}

## 当前 arc 正在推进什么
{{current_arc_prose}}

## 主角当前状态
{{protagonist_matrix_row}}

## 本集主要对手/阻力方
{{opponent_rows}}

## 本集主要协作者
{{collaborator_rows}}

## 可能被牵动的 thread（伏笔 + 支线）
{{relevant_threads}}

## 需要处理的陈旧 Hook（本集必须 advance / resolve / 显式 defer）
{{recyclable_hooks}}

## 本集篇章外约束
- 是否开场前三集：{{isGoldenOpening}}
- 硬约束（摘取本集可能触碰的条目）：
{{book_rules_relevant}}

请为第 {{episodeNumber}} 集产生 memo。严格按上面的普通 Markdown 小节格式输出。`;

export interface PlannerUserMessageInput {
  readonly episodeNumber: number;
  readonly previousEpisodeEndingExcerpt: string;
  readonly recentSummaries: string;
  readonly currentArcProse: string;
  readonly protagonistMatrixRow: string;
  readonly opponentRows: string;
  readonly collaboratorRows: string;
  readonly relevantThreads: string;
  readonly recyclableHooks: string;
  readonly isGoldenOpening: boolean;
  readonly bookRulesRelevant: string;
  readonly brief?: string;
  readonly episodeContext?: string;
  readonly volumeContract?: string;
  /**
   * Pre-rendered upstream-revision feedback block (P0-2): planner/canon-owned
   * findings from the last review cycle that this memo must resolve.
   */
  readonly upstreamRevisionFeedback?: string;
  readonly language?: "zh" | "en";
}

export function buildPlannerUserMessage(input: PlannerUserMessageInput): string {
  const language = input.language ?? "zh";
  const template = getPlannerMemoUserTemplate(language);
  const yesText = language === "en" ? "yes" : "是";
  const noText = language === "en" ? "no" : "否";

  const briefBlock = buildBriefBlock(input.brief ?? "", language);
  const episodeContextBlock = buildEpisodeContextBlock(input.episodeContext ?? "", language);
  const volumeContractBlock = buildVolumeContractBlock(input.volumeContract ?? "", language);

  const filled = template
    .replaceAll("{{episodeNumber}}", String(input.episodeNumber))
    .replaceAll("{{brief_block}}", briefBlock)
    .replaceAll("{{episode_context_block}}", episodeContextBlock)
    .replaceAll("{{volume_contract_block}}", volumeContractBlock)
    .replaceAll("{{previous_episode_ending_excerpt}}", input.previousEpisodeEndingExcerpt)
    .replaceAll("{{recent_summaries}}", input.recentSummaries)
    .replaceAll("{{current_arc_prose}}", input.currentArcProse)
    .replaceAll("{{protagonist_matrix_row}}", input.protagonistMatrixRow)
    .replaceAll("{{opponent_rows}}", input.opponentRows)
    .replaceAll("{{collaborator_rows}}", input.collaboratorRows)
    .replaceAll("{{relevant_threads}}", input.relevantThreads)
    .replaceAll("{{recyclable_hooks}}", input.recyclableHooks)
    .replaceAll("{{isGoldenOpening}}", input.isGoldenOpening ? yesText : noText)
    .replaceAll("{{book_rules_relevant}}", input.bookRulesRelevant);

  const golden = buildGoldenOpeningGuidance(input.episodeNumber, language);
  const authority = language === "en"
    ? `## Character continuity authority
The protagonist, opposing forces, and collaborator rows above are factual authority. Do not invert a character's role, allegiance, job, death status, or relationship merely to create a convenient beat. If the outline or a fresh idea conflicts with those rows or the last episode summary, keep the established fact and redesign the beat. Every named character in this memo must have a role-consistent action.`
    : `## 角色连续性权威
上面的主角、对手和协作者信息是事实权威。不得为了方便制造剧情而改变角色身份、阵营、职务、生死状态或关系。如果篇章计划或新想法与这些信息、上一集摘要冲突，应保留既成事实并重设计本集动作。本 memo 中每个被点名的角色都必须有符合身份的行为。`;
  const guidance = golden ? `${golden}\n\n${authority}` : authority;
  const upstreamFeedback = input.upstreamRevisionFeedback?.trim() ?? "";
  return upstreamFeedback
    ? `${filled}\n\n${upstreamFeedback}\n\n${guidance}`
    : `${filled}\n\n${guidance}`;
}

/**
 * Render planner/canon-owned findings from a review cycle that stopped at
 * requires-upstream-revision (P0-2). The memo is the only place these
 * decisions can legitimately change, so the next planning pass must face
 * them directly instead of leaving them to the writer reviser.
 */
export function buildUpstreamRevisionFeedbackBlock(
  findings: ReadonlyArray<{
    readonly category: string;
    readonly owner: "planner" | "canon";
    readonly severity: "critical" | "warning";
    readonly description: string;
    readonly suggestion: string;
  }>,
  language: "zh" | "en",
): string {
  if (findings.length === 0) return "";
  const lines = findings.map((finding) =>
    language === "en"
      ? `- [${finding.severity}] (${finding.owner}) ${finding.category}: ${finding.description}${finding.suggestion ? ` → required direction: ${finding.suggestion}` : ""}`
      : `- [${finding.severity}]（${finding.owner}）${finding.category}：${finding.description}${finding.suggestion ? ` → 修复方向：${finding.suggestion}` : ""}`,
  );
  if (language === "en") {
    return `## Upstream revision requests from the last review (this memo must resolve them)
The last production run stopped at "requires-upstream-revision": the findings below belong to the planning layer and the writer reviser has no authority over them. Resolve each one in this memo itself — correct the hook ledger, KR binding, or episode decision — instead of leaving the problem to the Writer:
${lines.join("\n")}`;
  }
  return `## 上次审查的上游修订要求（本集 memo 必须解决）
上次生产在审查阶段停在了"待上游修订"状态：以下问题属于规划层（planner/canon），修稿环节无权修改这些决策。必须在本集 memo 内逐条解决——修正 Hook 账、KR 绑定或本集决策本身，不要把问题留给 Writer：
${lines.join("\n")}`;
}

function buildVolumeContractBlock(volumeContract: string, language: "zh" | "en"): string {
  const trimmed = volumeContract.trim();
  if (!trimmed) return "";
  if (language === "en") {
    return `## Current VolumeContract (bind this episode to it)
${trimmed}

Every episode memo must bind to at least one KR from this contract, or explicitly explain a buffer / transition exception. The binding must describe visible advancement, not just repeat the KR label.`;
  }
  return `## 当前篇章合同（本集必须绑定）
${trimmed}

每集 memo 必须绑定本合同中的至少一个 KR，或者显式说明本集作为过渡为什么暂不推进 KR。绑定要写可见推进方式，不能只复述 KR 编号。`;
}

/**
 * Brief is the user's original creative document. It's the highest authority
 * source for "what this book is". story_frame/volume_map are the architect's
 * abstraction of brief; episode memos must honor brief first.
 *
 * Returns "" when no brief exists (legacy books without brief.md).
 */
function buildBriefBlock(brief: string, language: "zh" | "en"): string {
  const trimmed = brief.trim();
  if (!trimmed) return "";
  if (language === "en") {
    return `## Creative brief (user's original intent — authoritative)
${trimmed}

The brief is the user's direct instruction. When planning this episode, honor the brief's core setup (protagonist concept, world premise, opening mechanics, sample episode hooks if any) before anything else. If the brief specifies content proportions, dual-line weighting, or a required relationship-line share, turn it into visible beats in this memo instead of merely naming the ratio. Do NOT defer the brief's core setup to later episodes; land it early.`;
  }
  return `## 用户创作 brief（原始意图——最高优先级）
${trimmed}

brief 是用户的直接指令。本集规划时，必须优先兑现 brief 里写明的核心设定（主角设定、世界前提、开场机制、样本剧集钩子等）。如果 brief 里指定了内容比例、双主线权重或某条关系线必须占比，本集 memo 要把它拆成可见场面，而不是只在总结里提一句。**不要把 brief 里的核心设定推迟到后续剧集**，应在前几集落地。`;
}

function buildEpisodeContextBlock(episodeContext: string, language: "zh" | "en"): string {
  const trimmed = episodeContext.trim();
  if (!trimmed) return "";
  if (language === "en") {
    return `## Per-episode user instruction (highest priority for this episode)
${trimmed}

This is the user's direct instruction for the current episode. The memo must obey it before the outline fallback. If the user specifies a episode title, preserve that title exactly in the memo so the writer can use it as EPISODE_TITLE. If it conflicts with the volume outline, reconcile by keeping continuity but following this episode instruction.`;
  }
  return `## 本集用户指令（本集最高优先级）
${trimmed}

这是用户对当前剧集的直接指令。memo 必须优先遵守它，再参考篇章计划。如果用户指定了剧集标题，必须在 memo 中原样保留该标题，供写手作为 EPISODE_TITLE 使用。若它与篇章计划不完全一致，保持连续性，但以本集用户指令为准。`;
}

// ---------------------------------------------------------------------------
// Opening-three episode guidance.
// Single conditional append (episodeNumber <= 3). No new schema, no new
// runtime branch. Cohesive paragraphs, NOT a numbered checklist.
// ---------------------------------------------------------------------------

export function buildGoldenOpeningGuidance(
  episodeNumber: number,
  language: "zh" | "en" = "zh",
): string {
  if (episodeNumber > 3) return "";

  if (language === "en") {
    return `## Golden Opening Guidance — Episode ${episodeNumber}

This is episode ${episodeNumber} of the opening three — the episodes that decide whether a reader stays. The Golden Three Episodes rule assigns each episode a load-bearing slot: episode 1 must throw the reader straight into the core conflict (the protagonist enters already facing the main contradiction — chase, dead-end, dispossession, transmigration-as-crisis), not a paragraph of background, family tree, weather, or dynastic preamble. Episode 2 must put the protagonist's edge — the system, the power, the rebirth-memory, the information advantage — on the stage through one concrete event (not "he awakened a power" narrated, but "he used it for X and Y happened"). Episode 3 must lock in a concrete short-term goal achievable within the next 3-10 episodes (build the first stake of capital, take down the small antagonist, save someone), giving the story forward pull.

The memo's goal field for this episode must reflect the slot's verb — confront, demonstrate, or commit. The episode-end change must be a small hook or emotional gap, never a flat resolution. Apply the opening-economy rule throughout: at most three scenes and at most three named characters this episode (a side character may be only a name without expansion). Information layering is mandatory — basic facts (appearance, status, situation) ride on the protagonist's actions, world rules ride on plot triggers; do not stage a paragraph of exposition.`;
  }

  return `## 开篇三集规划指引 — 第 ${episodeNumber} 集

这是开篇三集中的第 ${episodeNumber} 集。第 1 集用前 3-5 秒的可见异常把主角抛进核心冲突，并在本集时长内交付第一次局部结果；第 2 集让能力、信息差或关键关系筹码通过具体行动生效，同时明确代价；第 3 集基于前两集结果钉下一个可验证的短期目标。每集都必须有独立的当集兑现、因果后果和交接状态，不能把三集写成一段被切开的小说开头。

本集 memo 的 goal 字段必须体现对应槽位的动词——抛出、展现、或锁定。集尾必须发生的改变要落在小钩子或情绪缺口上，不要写成平稳收束。开篇精简原则贯穿本集：场景 ≤ 3 个、人物 ≤ 3 个（配角可以只报名字，不展开）。信息分层强制要求：基础信息（外貌、身份、处境）通过主角行动自然带出，世界规则（设定、势力、底层逻辑）结合剧情节点揭示，禁止整段 exposition。`;
}
