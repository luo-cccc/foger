export type NarrativeDriveStage = "foundation" | "planner" | "writer" | "auditor";

/**
 * One reader-drive model, specialized by pipeline stage. The five factors are
 * coordinated across the series instead of being repeated as an episode checklist.
 */
export function buildNarrativeDriveContract(
  stage: NarrativeDriveStage,
  language: "zh" | "en",
): string {
  if (language === "en") return buildEnglishContract(stage);
  return buildChineseContract(stage);
}

function buildChineseContract(stage: NarrativeDriveStage): string {
  if (stage === "foundation") {
    return `## 叙事驱动乘法合同

把整本书设计成“新颖设定 x 熟悉爽点 x 高压关系 x 因果反转 x 情绪钩子”的组合。乘法意味着任何一项长期为零都会拖垮追读，但不是要求每章机械集齐五项。

- 新颖设定只保留 1-2 个可复述的差异点，并写清它如何改变人物选择、资源分配和失败代价；只换术语、不改变因果，不算新颖。
- 熟悉爽点锚定该题材读者已经理解的欲望、压抑和回报，再让新设定改变兑现路径；不要同时教育读者理解新世界和新欲望。
- 高压关系必须写成双方都不能轻易退出的利益冲突：各自想要什么、握有什么、离开或妥协会失去什么。
- 因果反转来自已埋证据对信息、权力、关系或选择的重新定价；先有种子再翻面，禁止靠巧合、临时新增设定或故意隐瞒视角内信息。
- 情绪钩子让读者带着一个具体的选择、代价、亏欠或关系余震进入下一章，不把“突然出现更强敌人”当成唯一断章方式。

结构归位：差异点及其代价写进 story_frame，熟悉回报与反转节奏写进 volume_map，高压关系写进核心冲突与 roles，情绪钩子和兑现承诺进入 rhythm principles 与 pending_hooks。`;
  }

  if (stage === "planner") {
    return `## 叙事驱动编排

五项是跨剧集组合，不是单集打卡。当前集只选择因果真正需要的主驱动；承接集可以兑现上一集反转的代价，不得为了“高频”硬造新反转。

- 在“当前目标”和“关系压力”中写清差异设定如何改变本集选择或代价，以及谁与谁形成不能轻易退出的利益压力。
- 在“当集兑现”中指定观众熟悉的欲望或压抑得到怎样的可观察结果，不写抽象的“获得成长”，也不把结果拖成“马上揭晓”。
- 在“反转铺垫—本集反转—反转后果”中写清由已有证据触发的判断翻面；若翻面已在上一集发生，本集就写后果，不重复翻桌。
- 在“出去压力”和“结尾交接状态”中写清本集结果如何启动下一股决定、危险或关系余震。
- 禁止用巧合、临时新增规则、角色降智或故意藏住视角内已知信息制造反转；禁止用无关新敌人替代情绪钩子。`;
  }

  if (stage === "writer") {
    return `## 叙事驱动执行

把 memo 已选的驱动力写成同一条因果链，不在剧本里复述方法论，也不擅自增加新反转或新 Hook。让差异规则在角色选择和损失中显形，让关系压力通过交换、拒绝、试探、背叛或被迫合作落地。反转必须能回指前置证据并改变后续行动；当集兑现必须先落地，再用出去压力交接下一集。承接/后效集优先写上次翻面的损失与新常态，不为满足频率再翻一次。`;
  }

  return `## 叙事驱动审计

只按 episode memo 和既有铺垫中实际承诺的驱动力审计，不要求每集机械集齐五项。检查差异设定是否改变选择或代价、熟悉欲望是否得到可观察的当集兑现、关系压力是否来自双方真实利益、反转是否可回指证据并产生后果、出去压力是否由本集结果启动、交接状态是否可供下一集继承。承接集已经写出上次反转的后果时，不因没有新反转扣分。巧合翻面、临时新增规则、角色降智、信息权限泄漏或无关强敌断集属于结构缺陷。`;
}

function buildEnglishContract(stage: NarrativeDriveStage): string {
  if (stage === "foundation") {
    return `## Narrative Drive Multiplication Contract

Design the book as Novel Premise x Familiar Payoff x High-Pressure Relationship x Causal Reversal x Emotional Hook. Multiplication means that leaving any factor at zero for too long collapses reader momentum; it does not mean mechanically checking all five in every chapter.

- Keep one or two repeatable premise differences and show how they alter choice, resource allocation, and the cost of failure. Renaming familiar mechanics is not novelty.
- Anchor payoff in genre-familiar desire, pressure, and reward, then let the novel premise change the route to delivery. Do not teach a new world and a new desire at the same time.
- Build high-pressure relationships between parties who cannot simply walk away: define what each wants, what leverage each holds, and what exit or compromise costs.
- Make reversals reprice information, power, relationship, or choice through planted evidence. Seed before the turn; never rely on coincidence, a newly invented rule, or withheld viewpoint knowledge.
- Carry readers forward with a concrete choice, cost, debt, or relationship aftershock, not only a stronger enemy appearing at the cut.

Place premise and cost in story_frame; payoff and reversal cadence in volume_map; pressure relationships in core conflict and roles; emotional hooks and delivery promises in rhythm principles and pending_hooks.`;
  }

  if (stage === "planner") {
    return `## Narrative Drive Orchestration

The five factors form a cross-episode portfolio, not an episode checklist. Select only the drivers the current causal chain needs. A recovery episode may carry the cost of the previous reversal; never manufacture another turn merely to appear frequent.

- In Episode objective and Relationship pressure, state how the premise difference changes this episode's choice or cost and name the parties trapped in real interest pressure.
- In Local dramatic result, deliver an observable result for a familiar desire or pressure; never replace payoff with “soon” or “to be revealed.”
- In Reversal setup, Episode reversal, and Reversal consequence, specify the prior evidence, overturned belief, and resulting cost. If the prior episode already turned the board, write consequence instead of turning it again.
- In Outgoing pressure and Handoff state, state how the delivered result starts the next decision, danger, or relationship aftershock.
- Never manufacture a turn through coincidence, a newly invented rule, convenient stupidity, or withheld viewpoint knowledge. Never substitute an unrelated stronger enemy for an emotional hook.`;
  }

  if (stage === "writer") {
    return `## Narrative Drive Execution

Render the memo's selected drivers as one causal chain. Never narrate this framework, and do not invent an extra reversal or hook. Make the premise difference visible through choice and loss; use a familiar desire to carry its learning cost; embody relationship pressure through exchange, refusal, testing, betrayal, or forced cooperation. A reversal must point back to evidence and change subsequent action. End on a concrete choice, cost, debt, or relationship aftershock rather than merely raising the volume of danger. In breather or aftermath chapters, render the last turn's loss and new normal instead of turning the board again.`;
  }

  return `## Narrative Drive Audit

Audit only the drivers actually promised by the chapter memo and existing setup; never require all five in every chapter. Check whether the premise difference changes choice or cost, familiar desire receives the planned observable feedback, relationship pressure grows from both parties' interests, a reversal points back to evidence and changes later action, and the ending leaves a concrete choice, cost, debt, or aftershock. Report a structural failure only when an explicit memo promise is missing. Do not penalize a breather or aftermath chapter that renders the prior reversal's consequences without adding a new turn. Coincidence turns, newly invented rules, convenient stupidity, withheld viewpoint knowledge, and unrelated-enemy cliffhangers are structural defects.`;
}
