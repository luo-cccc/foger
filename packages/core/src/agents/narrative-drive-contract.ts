export type NarrativeDriveStage = "foundation" | "planner" | "writer" | "auditor";

/**
 * One reader-drive model, specialized by pipeline stage. The five factors are
 * coordinated across the book instead of being repeated as a chapter checklist.
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

五项是跨章节组合，不是单章打卡。每章选择至少两项作为主驱动，其余项只在因果需要时承接；喘息章可以承接上章反转的代价，不得为了“高频”硬造新反转。

- 在“当前任务”中写清本书差异设定如何具体改变本章选择或代价，并指出谁与谁形成不能轻易退出的利益压力；确实没有同场关系冲突时，写清上一段关系压力如何继续约束行动。
- 在“该兑现的 / 暂不掀的”中指定一个读者熟悉的欲望或压抑处于铺垫、部分兑现还是完整兑现，回报必须可观察，不写抽象的“获得成长”。
- 在“章尾必须发生的改变”中指定由前文证据触发的信息、权力、关系或选择翻面，并留下具体的选择、代价、亏欠或关系余震。反转若在上一章已发生，本章就写后果，不重复翻桌。
- 禁止用巧合、临时新增规则、角色降智或故意藏住视角内已知信息制造反转；禁止用无关新敌人替代情绪钩子。`;
  }

  if (stage === "writer") {
    return `## 叙事驱动执行

把 memo 已选的驱动力写成同一条因果链，不在正文里复述方法论，也不擅自增加新反转或新 hook。让本书的差异规则在角色选择和损失中显形，用读者熟悉的欲望承接理解成本；让关系压力通过交换、拒绝、试探、背叛或被迫合作落地。反转必须能回指前文证据，并真实改变后续行动；章尾钩住具体选择、代价或关系余震，而不是只把危险音量调大。喘息/后效章优先写上次翻面的损失与新常态，不为满足频率再翻一次。`;
  }

  return `## 叙事驱动审计

只按 chapter memo 和既有铺垫中实际承诺的驱动力审计，不要求每章机械集齐五项。检查差异设定是否改变了选择或代价、熟悉欲望是否得到计划程度的可观察反馈、关系压力是否来自双方真实利益、反转是否可回指证据并改变后续行动、章尾是否留下具体选择/代价/关系余震。memo 明确承诺却缺失时才可按结构问题报告；喘息/后效章已经写出上次反转的后果时，不因没有新反转扣分。巧合翻面、临时新增规则、角色降智、隐瞒视角内信息或无关强敌断章属于结构缺陷。`;
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

The five factors form a cross-chapter portfolio, not a chapter checklist. Choose at least two as primary drivers in each chapter and carry the others only when causally needed. A breather may carry the cost of the previous reversal; never manufacture another turn merely to appear frequent.

- In Current task, state how the book's premise difference changes this chapter's choice or cost, and name the parties trapped in real interest pressure. If no relationship clash is on stage, state how earlier relationship pressure constrains the action.
- In To pay off / to keep buried, name one genre-familiar desire or pressure and whether this chapter plants, partly delivers, or fully delivers it. The feedback must be observable, not “the character grows.”
- In Required end-of-chapter change, specify an evidence-driven revaluation of information, power, relationship, or choice, then leave a concrete choice, cost, debt, or aftershock. If the prior chapter already turned the board, write consequence instead of turning it again.
- Never manufacture a turn through coincidence, a newly invented rule, convenient stupidity, or withheld viewpoint knowledge. Never substitute an unrelated stronger enemy for an emotional hook.`;
  }

  if (stage === "writer") {
    return `## Narrative Drive Execution

Render the memo's selected drivers as one causal chain. Never narrate this framework, and do not invent an extra reversal or hook. Make the premise difference visible through choice and loss; use a familiar desire to carry its learning cost; embody relationship pressure through exchange, refusal, testing, betrayal, or forced cooperation. A reversal must point back to evidence and change subsequent action. End on a concrete choice, cost, debt, or relationship aftershock rather than merely raising the volume of danger. In breather or aftermath chapters, render the last turn's loss and new normal instead of turning the board again.`;
  }

  return `## Narrative Drive Audit

Audit only the drivers actually promised by the chapter memo and existing setup; never require all five in every chapter. Check whether the premise difference changes choice or cost, familiar desire receives the planned observable feedback, relationship pressure grows from both parties' interests, a reversal points back to evidence and changes later action, and the ending leaves a concrete choice, cost, debt, or aftershock. Report a structural failure only when an explicit memo promise is missing. Do not penalize a breather or aftermath chapter that renders the prior reversal's consequences without adding a new turn. Coincidence turns, newly invented rules, convenient stupidity, withheld viewpoint knowledge, and unrelated-enemy cliffhangers are structural defects.`;
}
