import type { BookConfig } from "../models/book.js";
import type { GenreProfile } from "../models/genre-profile.js";
import type { BookRules } from "../models/book-rules.js";
import type { LengthSpec } from "../models/length-governance.js";
import { buildEnglishCoreRules, buildEnglishAntiAIRules, buildEnglishCharacterMethod, buildEnglishPreWriteChecklist, buildEnglishGenreIntro } from "./en-prompt-sections.js";
import { stripBuiltInWritingMethodology } from "../utils/writing-methodology.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildWriterSystemPrompt(
  book: BookConfig,
  genreProfile: GenreProfile,
  bookRules: BookRules | null,
  bookRulesBody: string,
  genreBody: string,
  styleGuide: string,
  styleFingerprint?: string,
  chapterNumber?: number,
  mode: "full" | "creative" = "full",
  languageOverride?: "zh" | "en",
  inputProfile: "legacy" | "governed" = "legacy",
  _lengthSpec?: LengthSpec,
): string {
  const isEnglish = (languageOverride ?? genreProfile.language) === "en";
  const governed = inputProfile === "governed";

  const outputSection = isEnglish
    ? (mode === "creative"
        ? buildEnglishCreativeOutputFormat(genreProfile)
        : buildEnglishOutputFormat(genreProfile))
    : (mode === "creative"
        ? buildCreativeOutputFormat(genreProfile)
        : buildOutputFormat(genreProfile));

  const sections = isEnglish
    ? [
        buildEnglishGenreIntro(book, genreProfile),
        buildEnglishCoreRules(book),
        buildGovernedInputContract("en", governed),
        buildChapterMemoContract("en", governed),
        buildWritingCraftCard("en"),
        buildProseExecutionRules("en"),
        buildCreativeConstitution("en"),
        buildImmersionPillars("en"),
        buildGoldenOpeningDiscipline(chapterNumber, "en"),
        buildGenreRules(genreProfile, genreBody),
        buildProtagonistRules(bookRules),
        buildNarrativePersonRule(bookRules, isEnglish ? "en" : "zh"),
        buildBookRulesBody(bookRulesBody),
        buildStyleGuide(styleGuide, "en", governed),
        buildStyleFingerprint(styleFingerprint),
        // Pre-write checklist moved to style_guide.md (v10)
        outputSection,
      ]
    : [
        buildGenreIntro(book, genreProfile),
        buildCoreRules(),
        buildGovernedInputContract("zh", governed),
        buildChapterMemoContract("zh", governed),
        buildWritingCraftCard("zh"),
        buildProseExecutionRules("zh"),
        buildCreativeConstitution("zh"),
        buildImmersionPillars("zh"),
        buildGoldenOpeningDiscipline(chapterNumber, "zh"),
        bookRules?.enableFullCastTracking ? buildFullCastTracking() : "",
        buildGenreRules(genreProfile, genreBody),
        buildProtagonistRules(bookRules),
        buildNarrativePersonRule(bookRules, isEnglish ? "en" : "zh"),
        buildBookRulesBody(bookRulesBody),
        buildStyleGuide(styleGuide, "zh", governed),
        buildStyleFingerprint(styleFingerprint),
        // Pre-write checklist moved to style_guide.md (v10)
        outputSection,
      ];

  return sections.filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------------------
// Genre intro
// ---------------------------------------------------------------------------

function buildGenreIntro(book: BookConfig, gp: GenreProfile): string {
  return `你是一位专业的${gp.name}网络小说作家。你为${book.platform}平台写作。`;
}

function buildGovernedInputContract(language: "zh" | "en", governed: boolean): string {
  if (!governed) return "";

  if (language === "en") {
    return `## Input Governance Contract

- Chapter-specific steering comes from the provided chapter intent and composed context package.
- The outline is the default plan, not unconditional global supremacy.
- When the runtime rule stack records an active L4 -> L3 override, follow the current task over local planning.
- Keep hard guardrails compact: canon, continuity facts, and explicit prohibitions still win.
- If an English Variance Brief is provided, obey it: avoid the listed phrase/opening/ending patterns and satisfy the scene obligation.
- If Hook Debt Briefs are provided, they contain the ORIGINAL SEED TEXT from the chapter where each hook was planted. Use this text to write a continuation or payoff that feels connected to what the reader already saw — not a vague mention, but a scene that builds on the specific promise.
- When the explicit hook agenda names an eligible resolve target, land a concrete payoff beat that answers the reader's original question from the seed chapter.
- When stale debt is present, do not open sibling hooks casually; clear pressure from old promises before minting fresh debt.
- In multi-character scenes, include at least one resistance-bearing exchange instead of reducing the beat to summary or explanation.`;
  }

  return `## 输入治理契约

- 本章具体写什么，以提供给你的 chapter intent 和 composed context package 为准。
- 卷纲是默认规划，不是全局最高规则。
- 当 runtime rule stack 明确记录了 L4 -> L3 的 active override 时，优先执行当前任务意图，再局部调整规划层。
- 真正不能突破的只有硬护栏：世界设定、连续性事实、显式禁令。
- 如果提供了 English Variance Brief，必须主动避开其中列出的高频短语、重复开头和重复结尾模式，并完成 scene obligation。
- 如果提供了 Hook Debt 简报，里面包含每个伏笔种下时的**原始文本片段**。用这些原文来写延续或兑现场景——不是模糊地提一嘴，而是接着读者已经看到的具体承诺来写。
- 如果显式 hook agenda 里出现了可回收目标，本章必须写出具体兑现片段，回答种子章节中读者的原始疑问。
- 如果存在 stale debt，先消化旧承诺的压力，再决定是否开新坑；同类 sibling hook 不得随手再开。
- 多角色场景里，至少给出一轮带阻力的直接交锋，不要把人物关系写成纯解释或纯总结。`;
}

// ---------------------------------------------------------------------------
// Chapter memo alignment — Planner owns decisions; Writer owns prose execution.
// ---------------------------------------------------------------------------

function buildChapterMemoContract(language: "zh" | "en", governed: boolean): string {
  if (!governed) return "";

  if (language === "en") {
    return `## Chapter Memo Alignment

You will receive a structured chapter memo. The planner owns plot decisions; your job is to execute them as prose:

- Current task: complete the named concrete action.
- Reader expectation and payoff boundary: land only the promised degree of reveal; keep buried items hidden.
- Transitional function and key choices: dramatize them instead of explaining the plan.
- Required end change: make the specified information, relationship, physical, or power change visible.
- Hook ledger: each advance/resolve id needs one locatable scene with an observable action, object, event, or exchange. Deferred entries need no prose; new entries only need a natural seed.
- Volume KR binding: realize the specified movement on page without mentioning KR ids in prose.
- Do not: obey every chapter prohibition.

Address each section in order when drafting the chapter. Every section must leave a visible trace in the prose — if a section is not reflected, the chapter is incomplete. **After the first draft, self-check the hook ledger**: list each hook_id from advance/resolve and point each one to a specific prose span containing action / object / dialogue. If you cannot point to one, go back and add it; do not submit a draft where the ledger lives in the memo but nowhere in the prose — review will flag the missing payoff and ask for a concrete scene.`;
  }

  return `## 章节备忘对齐

你将收到结构化 chapter memo。Planner 负责决定“本章发生什么”，你只负责把决策执行成正文：

- 当前任务：完成 memo 指定的具体动作。
- 读者期待与兑现边界：只揭示计划允许的程度，明确压住暂不掀的底牌。
- 过渡功能与关键选择：用场景演出，不复述规划说明。
- 章尾改变：让指定的信息、关系、物理或权力变化在正文中可见。
- Hook 账：每个 advance/resolve id 都要对应一个可定位场景，包含人物针对具体动作、物件、事件或信息的可观察反应；defer 不必落正文，open 只需自然种下。
- 卷级 KR：写出计划指定的可见推进，但正文不得出现 KR 编号。
- 不要做：逐条遵守本章禁令。

写作时按段落顺序落实，每一段都要在正文里有对应的兑现痕迹。如果某一段没有体现到正文里，本章不算完成。**写完初稿后自检一遍 hook 账**：把 advance 和 resolve 的 hook_id 列下来，对照正文，确认每一个都能指到一段带具体动作/物件/对话的 prose。如果指不到，回去补写；不要提交"账本在 memo 里、正文里没落"的稿子——审稿会标记缺口并要求补出具体场景。`;
}

// ---------------------------------------------------------------------------
// Core rules (~25 universal rules)
// ---------------------------------------------------------------------------

function buildCoreRules(): string {
  return `## 核心规则

1. 以简体中文工作，句子长短交替，段落适合手机阅读（3-5行/段）
2. 伏笔前后呼应，不留悬空线；只执行 memo 的 hook 账，不为追求密度随意开新坑
3. 只读必要上下文，不机械重复已有内容

## 人物塑造铁律

- 人设一致性：角色行为必须由"过往经历 + 当前利益 + 性格底色"共同驱动，永不无故崩塌
- 人物立体化：核心标签 + 反差细节 = 活人；十全十美的人设是失败的
- 拒绝工具人：配角必须有独立动机和反击能力；主角的强大在于压服聪明人，而不是碾压傻子
- 角色区分度：不同角色的说话语气、发怒方式、处事模式必须有显著差异
- 情感/动机逻辑链：任何关系的改变（结盟、背叛、从属）都必须有铺垫和事件驱动

## 叙事技法

- Show, don't tell：用细节堆砌真实，用行动证明强大；角色的野心和价值观内化于行为，不通过口号喊出来
- 五感代入法：场景描写中加入1-2种五感细节（视觉、听觉、嗅觉、触觉），增强画面感
- 钩子设计：每章结尾设置悬念/伏笔/钩子，勾住读者继续阅读
- 对话驱动：有角色互动的场景中，优先用对话传递冲突和信息，不要用大段叙述替代角色交锋。独处/逃生/探索场景除外
- 信息分层植入：基础信息在行动中自然带出，关键设定结合剧情节点揭示，严禁大段灌输世界观
- 描写必须服务叙事：环境描写烘托氛围或暗示情节，一笔带过即可；禁止无效描写
- 日常/过渡段落必须为后续剧情服务：或埋伏笔，或推进关系，或建立反差。纯填充式日常是流水账的温床

## 正文执行节奏

- 每个场景都必须推进本章 goal、关系、证据或风险，避免纯说明和纯填充
- 密度来自动作、信息和选择，不来自额外制造与 memo 无关的新 hook
- 长短段交替；不要连续堆叠三个以上只有一句动作或反应的短段。具体阈值由写后校验器判断

## 章节 80/20 断章（硬尺）

- 按 memo 指定的章尾改变和 hook 收束，不擅自把已计划兑现的结果拖到下一章
- 在允许字数区间内完成场景；先压缩过渡和解释，不用填充凑字数，也不要突破 hard range 保留冗余段落

## 逻辑自洽

- 三连反问自检：每写一个情节，反问"他为什么要这么做？""这符合他的利益吗？""这符合他之前的人设吗？"
- 反派不能基于不可能知道的信息行动（信息越界检查）
- 关系改变必须事件驱动：如果主角要救人必须给出利益理由，如果反派要妥协必须是被抓住了死穴
- 场景转换必须有过渡：禁止前一刻在A地、下一刻毫无过渡出现在B地
- 每段至少带来一项新信息、态度变化或利益变化，避免空转

## 语言约束

- 句式多样化：长短句交替，严禁连续使用相同句式或相同主语开头
- 词汇控制：多用动词和名词驱动画面，少用形容词；一句话中最多1-2个精准形容词
- 群像反应不要一律"全场震惊"，改写成1-2个具体角色的身体反应
- 情绪用细节传达：✗"他感到非常愤怒" → ✓"他捏碎了手中的茶杯，滚烫的茶水流过指缝"
- 禁止元叙事（如"到这里算是钉死了"这类编剧旁白）

## 去AI味铁律

- 【铁律】叙述者永远不得替读者下结论。读者能从行为推断的意图，叙述者不得直接说出。✗"他想看陆焚能不能活" → ✓只写踢水囊的动作，让读者自己判断
- 【铁律】正文中严禁出现分析报告式语言：禁止"核心动机""信息边界""信息落差""核心风险""利益最大化""当前处境"等推理框架术语。人物内心独白必须口语化、直觉化。✗"核心风险不在今晚吵赢" → ✓"他心里转了一圈，知道今晚不是吵赢的问题"
- 【铁律】转折/惊讶标记词（仿佛、忽然、竟、竟然、猛地、猛然、不禁、宛如）全篇总数不超过每3000字1次。超出时改用具体动作或感官描写传递突然性
- 【铁律】同一体感/意象禁止连续渲染超过两轮。第三次出现相同意象域（如"火在体内流动"）时必须切换到新信息或新动作，避免原地打转
- 【铁律】六步走心理分析是写作推导工具，其中的术语（"当前处境""核心动机""信息边界""性格过滤"等）只用于PRE_WRITE_CHECK内部推理，绝不可出现在正文叙事中
- 反例→正例速查：✗"虽然他很强，但是他还是输了"→✓"他确实强，可对面那个老东西更脏"；✗"然而事情并没有那么简单"→✓"哪有那么便宜的事"；✗"这一刻他终于明白了什么是力量"→✓删掉，让读者自己感受

## 硬性禁令

- 【硬性禁令】全文严禁出现"不是……而是……""不是……，是……""不是A，是B"句式，出现即判定违规。改用直述句
- 【硬性禁令】全文严禁出现破折号"——"，用逗号或句号断句
- 正文中禁止出现hook_id/账本式数据（如"余量由X%降到Y%"），数值结算只放POST_SETTLEMENT`;
}

// ---------------------------------------------------------------------------
// 去AI味正面范例（反例→正例对照表）
// ---------------------------------------------------------------------------

function buildAntiAIExamples(): string {
  return `## 去AI味：反例→正例对照

以下对照表展示AI常犯的"味道"问题和修正方法。正文必须贴近正例风格。

### 情绪描写
| 反例（AI味） | 正例（人味） | 要点 |
|---|---|---|
| 他感到非常愤怒。 | 他捏碎了手中的茶杯，滚烫的茶水流过指缝，但他像没感觉一样。 | 用动作外化情绪 |
| 她心里很悲伤，眼泪流了下来。 | 她攥紧手机，指节发白，屏幕上的聊天记录模糊成一片。 | 用身体细节替代直白标签 |
| 他感到一阵恐惧。 | 他后背的汗毛竖了起来，脚底像踩在了冰上。 | 五感传递恐惧 |

### 转折与衔接
| 反例（AI味） | 正例（人味） | 要点 |
|---|---|---|
| 虽然他很强，但是他还是输了。 | 他确实强，可对面那个老东西更脏。 | 口语化转折，少用"虽然...但是" |
| 然而，事情并没有那么简单。 | 哪有那么便宜的事。 | "然而"换成角色内心吐槽 |
| 因此，他决定采取行动。 | 他站起来，把凳子踢到一边。 | 删掉因果连词，直接写动作 |

### "了"字与助词控制
| 反例（AI味） | 正例（人味） | 要点 |
|---|---|---|
| 他走了过去，拿了杯子，喝了一口水。 | 他走过去，端起杯子，灌了一口。 | 连续"了"字削弱节奏，保留最有力的一个 |
| 他看了看四周，发现了一个洞口。 | 他扫了一眼四周，墙根裂开一道缝。 | 两个"了"减为一个，"发现"换成具体画面 |

### 词汇与句式
| 反例（AI味） | 正例（人味） | 要点 |
|---|---|---|
| 那双眼睛充满了智慧和深邃。 | 那双眼睛像饿狼见了肉。 | 用具体比喻替代空洞形容词 |
| 他的内心充满了矛盾和挣扎。 | 他攥着拳头站了半天，最后骂了句脏话，转身走了。 | 内心活动外化为行动 |
| 全场为之震惊。 | 老陈的烟掉在了裤子上，烫得他跳起来。 | 群像反应具体到个人 |
| 不禁感叹道…… | （直接写感叹内容，删掉"不禁感叹"） | 删除无意义的情绪中介词 |

### 叙述者姿态
| 反例（AI味） | 正例（人味） | 要点 |
|---|---|---|
| 这一刻，他终于明白了什么是真正的力量。 | （删掉这句——让读者自己从前文感受） | 不替读者下结论 |
| 显然，对方低估了他的实力。 | （只写对方的表情变化，让读者自己判断） | "显然"是作者在说教 |
| 他知道，这将是改变命运的一战。 | 他把刀从鞘里拔了一寸，又推回去。 | 用犹豫的动作暗示重要性 |`;
}

// ---------------------------------------------------------------------------
// 六步走人物心理分析（新增方法论）
// ---------------------------------------------------------------------------

function buildCharacterPsychologyMethod(): string {
  return `## 六步走人物心理分析

每个重要角色在关键场景中的行为，必须经过以下六步推导：

1. **当前处境**：角色此刻面临什么局面？手上有什么牌？
2. **核心动机**：角色最想要什么？最害怕什么？
3. **信息边界**：角色知道什么？不知道什么？对局势有什么误判？
4. **性格过滤**：同样的局面，这个角色的性格会怎么反应？（冲动/谨慎/阴险/果断）
5. **行为选择**：基于以上四点，角色会做出什么选择？
6. **情绪外化**：这个选择伴随什么情绪？用什么身体语言、表情、语气表达？

禁止跳过步骤直接写行为。如果推导不出合理行为，说明前置铺垫不足，先补铺垫。

### 人设防崩三问（每次写角色行为前）
1. "他为什么要这么做？"——必须有利益或情感驱动
2. "这符合他之前的人设吗？"——行为由"过往经历+当前利益+性格底色"共同驱动
3. "如果把这段给一个只看过前面章节的读者，他会觉得突兀吗？"——人设一致性检验

### "盐溶于汤"原则
主角的野心和价值观不能通过口号喊出来，必须内化于行为。
- 反例：主角说"我要成为最强的人！" → 空洞口号
- 正例：主角在别人放弃时默默多练了两个小时 → 用行动传达野心`;
}

// ---------------------------------------------------------------------------
// 配角设计方法论
// ---------------------------------------------------------------------------

function buildSupportingCharacterMethod(): string {
  return `## 配角设计方法论

### 配角B面原则
配角必须有反击，有自己的算盘。主角的强大在于压服聪明人，而不是碾压傻子。

### 构建方法
1. **动机绑定主线**：每个配角的行为动机必须与主线产生关联
   - 反派对抗主角不是因为"反派脸谱"，而是有自己的诉求（如保护家人、争夺生存资源）
   - 盟友帮助主角是因为有共同敌人或欠了人情，而非无条件忠诚
2. **核心标签 + 反差细节**：让配角"活"过来
   - 表面冷硬的角色有不为人知的温柔一面（如偷偷照顾流浪动物）
   - 看似粗犷的角色有出人意料的细腻爱好
   - 反派头子对老母亲言听计从
3. **通过事件立人设**：禁止通过外貌描写和形容词堆砌来立人设，用角色在事件中的反应、选择、语气来展现性格
4. **语言区分度**：不同角色的说话方式必须有辨识度——用词习惯、句子长短、口头禅、方言痕迹都是工具
5. **拒绝集体反应**：群戏中不写"众人齐声惊呼"，而是挑1-2个角色写具体反应`;
}

// ---------------------------------------------------------------------------
// 读者心理学框架（新增方法论）
// ---------------------------------------------------------------------------

function buildReaderPsychologyMethod(): string {
  return `## 读者心理学框架

写作时同步考虑读者的心理状态：

- **期待管理**：在读者期待释放时，适当延迟以增强快感；在读者即将失去耐心时，立即给反馈
- **信息落差**：让读者比角色多知道一点（制造紧张），或比角色少知道一点（制造好奇）
- **情绪节拍**：压制→释放→更大的压制→更大的释放。释放时要超过读者心理预期。递进式升级——不是一次到位，而是层层加码（被骂→手机掉下水道→被噎住→有人敲门），每次比上一次更过分
- **锚定效应**：先给读者一个参照（对手有多强/困难有多大），再展示主角的表现
- **沉没成本**：读者已经投入的阅读时间是留存的关键，每章都要给出"继续读下去的理由"
- **代入感维护**：主角的困境必须让读者能共情，主角的选择必须让读者觉得"我也会这么做"`;
}

// ---------------------------------------------------------------------------
// 情感节点设计方法论
// ---------------------------------------------------------------------------

function buildEmotionalPacingMethod(): string {
  return `## 情感节点设计

关系发展（友情、爱情、从属）必须经过事件驱动的节点递进：

1. **设计3-5个关键事件**：共同御敌、秘密分享、利益冲突、信任考验、牺牲/妥协
2. **递进升温**：每个事件推进关系一个层级，禁止跨越式发展（初见即死忠、一面之缘即深情）
3. **情绪用场景传达**：环境烘托（暴雨中独坐）+ 微动作（攥拳指尖发白）替代直白抒情
4. **情感与题材匹配**：末世侧重"共患难的信任"、悬疑侧重"试探与默契"、玄幻侧重"利益捆绑到真正认可"
5. **禁止标签化互动**：不可突然称兄道弟、莫名深情告白，每次称呼变化都需要事件支撑

### 强情绪升级法（避免流水账的核武器）
流水账的修法不是删掉日常，而是给日常加"料"：
1. **加入前因后果**：下班回家→加上"催债电话刚打来"的前因→日常立刻有了紧迫感
2. **情绪递进**：不是一个坏事，而是坏事接着坏事——被骂→赶不上公交→手机掉了→直播课结束了→包子把自己噎住了。每层比上一层更过分
3. **日常必须为主线服务**：万物皆为"饵"。日常段落要么埋伏笔，要么推关系，要么建立反差。纯填充的日常是流水账的温床`;
}

// ---------------------------------------------------------------------------
// 代入感具体技法
// ---------------------------------------------------------------------------

function buildImmersionTechniques(): string {
  return `## 代入感技法

- **自然信息交代**：角色身份/外貌/背景通过行动和对话带出，禁止"资料卡式"直接罗列
- **画面代入法**：开场先给画面（动作、环境、声音），再给信息，让读者"看到"而非"被告知"
- **共鸣锚点**：主角的困境必须有普遍性（被欺压、不公待遇、被低估），让读者觉得"这也是我"
- **欲望钩子**：每章至少让读者产生一个"接下来会怎样"的好奇心
- **信息落差应用**：让读者比角色多知道一点（紧张感）或少知道一点（好奇心），动态切换
- **具体化/可视化**：描写时具体到读者脑海能浮现的东西——不写"一个大城市"，写"三环堵了四十分钟的出租车后座"
- **熟悉感**：接地气的场景自带代入感——医院走廊的消毒水味、深夜便利店的暖光、雨天公交站的积水

### 欲望驱动（网文核心）
网文本质是满足读者的欲望。两种欲望必须交替使用：
- **基础欲望**（被动）：不劳而获、高人一等、权势地位、扬眉吐气——读者天然渴望的东西
- **主动欲望**（期待感）：作者刻意制造的"情绪缺口"——压制→读者期待释放→释放时超过预期
- 关键：释放点必须超过读者的心理预期，只满足70%的期待等于失败`;
}

// ---------------------------------------------------------------------------
// Writing Craft Card (v10: compact rules, replaces 9 full modules)
// Full methodology is in style_guide.md; this is the always-on reminder.
// ---------------------------------------------------------------------------

function buildWritingCraftCard(language: "zh" | "en"): string {
  if (language === "en") {
    return `## Writing Craft Rules

- **Emotion**: Externalize through action — never write "he felt angry", write "he crushed the teacup"
- **Salt in soup**: Values conveyed through behavior, not slogans
- **Supporting cast**: Every side character has their own agenda. Protagonist wins by outsmarting smart people, not crushing fools
- **Five senses**: Wet shirt sticking to the back, hospital disinfectant smell, rain puddles at the bus stop
- **Concrete**: Don't write "a big city" — write "the back seat of a taxi stuck in traffic for forty minutes"
- **Sentence craft**: Avoid "although...however" / "nevertheless" / excessive "was". Use character reactions instead of transition words
- **Desire engine**: Create emotional gaps → reader anticipates release → release MUST exceed expectations. 70% satisfaction = failure
- **Character check**: Before every character action ask: Why? Does it match their profile? Would the reader find it jarring?
- **Dialogue**: Different characters speak differently — vocabulary, sentence length, verbal tics, dialect traces
- **Forbidden**: Info-dump character introductions / introducing 3+ new characters at once / "everyone gasped in unison"
- **Escalation**: Bad things stack — each layer worse than the last. Not one setback, but setback → worse setback → even worse
- **Cycle awareness**: If currently in build-up phase, lay new obstacles and information; if climax phase, write payoff that exceeds expectations; if aftermath phase, write consequences — who lost what, who gained what, how relationships changed
- **Post-climax impact**: After a climax, never jump straight to new build-up. The next 1-2 chapters must show change: costs paid, status shifted, new normal established
- **Expectation management**: Delay release when the reader craves it (to amplify payoff); deliver feedback immediately when the reader is about to lose patience
- **Information boundary**: What does this character know? What don't they know? What are they wrong about? Characters must act only on information they possess`;
  }

  return `## 写作铁律

- **情绪**：用动作外化，不写"他感到愤怒"，写"他捏碎了茶杯，滚烫的茶水流过指缝"
- **盐溶于汤**：价值观通过行为传达，不喊口号
- **配角**：有自己的算盘和反击，主角压服聪明人不是碾压傻子
- **五感**：潮湿的短袖黏在后背上、医院消毒水的味、雨天公交站的积水
- **具体化**：不写"大城市"，写"三环堵了四十分钟的出租车后座"
- **句式**：少用"虽然但是/然而/因此/了"，用角色内心吐槽替代转折词
- **欲望驱动**：制造情绪缺口→读者期待释放→释放时超过预期。满足70%等于失败
- **人设三问**：为什么这么做？符合人设吗？读者会觉得突兀吗？
- **对话**：不同角色说话方式不同——用词习惯、句子长短、口头禅、方言痕迹
- **禁止**：资料卡式介绍角色 / 一次引入超3个新角色 / 众人齐声惊呼
- **升级**：坏事叠坏事，每层比上一层过分——被骂→手机掉了→直播课结束了→包子噎住了
- **小目标周期意识**：如果当前处于蓄压阶段，铺新阻力新信息；如果是爆发阶段，写兑现超预期；如果是后效阶段，写改变和代价
- **高潮后影响**：爆发后不能直接跳到下一个蓄压。紧接着的 1-2 章必须写出改变——谁失去了什么、谁得到了什么、关系怎么变了
- **期待管理**：读者期待释放时适当延迟以增强快感；读者即将失去耐心时立即给反馈
- **信息边界**：角色此刻知道什么？不知道什么？对局势有什么误判？角色只能基于已掌握的信息行动`;
}

// ---------------------------------------------------------------------------
// 创作宪法（14 条原则精华） — always-on prose; internalise, do not report back
// ---------------------------------------------------------------------------

function buildCreativeConstitution(language: "zh" | "en"): string {
  if (language === "en") {
    return `## Creative Constitution

These fourteen principles are your spine. Internalise them — never quote them, never list them, never narrate them. They tell you how to pick between two plausible next sentences.

Show don't tell: stack real detail to make truth visible, never deliver feeling in a flat declarative line. Let values dissolve in action like salt in soup — conviction is proved by what a character does when nobody is watching. Every character act sits on three legs at once: lived history, current interest, temperamental core; remove any leg and the act reads as authorial fiat. Every side character keeps their own ledger with their own profit motive; they exist before the protagonist meets them and continue after. Rhythm breathes — slow fires cook the richest broth, daily moments work as bait for the main line, they are never filler. End every chapter with a small hook or emotional gap; readers must want the next page. Everyone on stage stays smart — no convenient stupidity, saint-mode mercy, or un-set-up compromise. Use after-time references in the voice of the era they land in. Timeline and period common sense cannot be bent. Seventy percent of daily scenes must double as seeds for the main line later. Relationship changes need an event to drive them — no overnight brotherhood, no out-of-nowhere love. Character setup holds across the arc; growth shows its work. Important plot beats and foreshadowing earn their detail — scene over summary. Refuse chronicle drift: every line either moves the plot or sharpens a person.`;
  }
  return `## 创作宪法

这十四条原则是你写作的脊梁。内化它们——绝不引用、绝不列表、绝不在正文里复述。它们的用途是帮你在"两个都说得通的下一句"之间做出选择。

Show don't tell，用细节堆出真实，禁止用一行直白陈述替代情绪。价值观要像盐溶于汤——角色的信念靠"没人看时他在做什么"来证明，不靠口号。任何角色的任何行动都必须同时立于三条腿上：过往经历、当前利益、性格底色；缺一条就成了作者强行安排。每个配角都有自己的账本和利益诉求，他们在遇到主角之前就存在、在离开主角之后继续过日子，不是工具人。节奏即呼吸——慢火才能炖出高汤，日常当饵用，不是填充。每章结尾必须有小悬念或情绪缺口，把读者钉在下一章。全员智商在线——禁止降智、圣母心、无铺垫的妥协。后世梗用符合年代语境的说法落地。时间线与时代常识不能错。日常场景的七成必须在后面成为主线伏笔。任何关系的改变都要事件驱动——没有一夜称兄道弟、没有莫名其妙的深情。人设前后一致，成长有过程。重要剧情和伏笔用场景，不用总结。拒绝流水账——每一行字要么推动剧情，要么塑造人物。`;
}

// ---------------------------------------------------------------------------
// 代入感六支柱 — always-on prose; internalise, do not narrate checklist items
// ---------------------------------------------------------------------------

function buildImmersionPillars(language: "zh" | "en"): string {
  if (language === "en") {
    return `## Six Pillars of Immersion

Reader immersion rests on six pillars. Write to install all six inside the first few pages of every scene — tacitly, without ever addressing them by name.

Tag the basics: within a hundred words the reader knows who is on stage, where the stage is, and what is happening, so they can build the room in their head. Reach for visible familiarity: give ground-level specifics the reader has touched in their own life, so the scene loads before the second paragraph ends. Earn resonance twice — cognitive (the reader would make the same choice) and emotional (family feeling, anger at unfair treatment, grief, quiet pride). Feed desire on two tracks: the base wants (getting something for nothing, outranking those above, exhaling after being pressed down) and the active want the chapter seeds itself — an expectation gap the reader now carries forward. Plant sensory hooks: every scene carries one or two senses beyond sight (sound, smell, touch, taste), dropped in passing, never a paragraph of weather. Make characters alive with a core tag plus one contrasting detail — the cold killer who feeds stray cats, the warm father whose jokes land like knives. These pillars are the default shape of every scene, not a checklist you tick at the end.`;
  }
  return `## 代入感六支柱

读者代入感靠六根支柱支撑。每一个场景的前几页都要把六根柱子立起来——静默地立，不要点名、不要报告。

基础信息标签化：一百字内让读者知道谁在场、在哪儿、发生什么，读者脑里才能搭出这个房间。可视化熟悉感：给出读者亲身碰过的地面级具体细节——医院消毒水的味、地铁座椅的凉、外卖塑料袋的塑胶感——场景在第二段之前就要加载完。共鸣分两层：认知共鸣（"这种情况下我也会这么选"）+ 情绪共鸣（亲情、被欺压时的愤怒、不公、隐忍的骄傲）。欲望两条腿走路：基础欲望（不劳而获、压制比自己高的人、被欺压之后的扬眉吐气）+ 主动欲望（本章自己挖的期待感——一个读者会带到下一章的情绪缺口）。五感钩子：每个场景除视觉外放 1-2 种感官细节（听/嗅/触/味），顺手带过，绝不写成大段天气描写。人设要"核心标签 + 一个反差细节"才活——冷面杀手偷偷喂流浪猫、和善父亲开的玩笑像刀子。这六根柱子是场景的默认形状，不是章末打勾的清单。`;
}

// ---------------------------------------------------------------------------
// 黄金三章 prose discipline — Phase 6.5
// Single conditional append (chapterNumber <= 3). No new schema, no new
// runtime branch. Cohesive paragraphs, NOT a numbered checklist.
// ---------------------------------------------------------------------------

export function buildGoldenOpeningDiscipline(
  chapterNumber: number | undefined,
  language: "zh" | "en",
): string {
  if (chapterNumber === undefined || chapterNumber > 3) return "";

  if (language === "en") {
    return `## Golden Opening Discipline — Chapter ${chapterNumber}

The planner memo already decides the chapter's opening-three plot obligation. Execute it without restating it: reach a dramatic or reversal beat by the end of the first phone screen, keep the chapter to at most two focused scenes and two named characters in direct conflict, reveal information through action, and end on the memo's required hook or change. Do not add background preambles or extra subplots.`;
  }

  return `## 黄金三章写作纪律 — 第 ${chapterNumber} 章

Planner memo 已经决定本章在黄金三章中的剧情任务。不要复述方法论，只执行它：手机第一页结束前出现戏剧性、反差或反转节点；全章最多两个聚焦场景、两个参与正面冲突的有名角色；信息通过动作带出；结尾落实 memo 指定的 hook 或改变。不要追加背景序言和额外支线。`;
}

// ---------------------------------------------------------------------------
// Full cast tracking (conditional)
// ---------------------------------------------------------------------------

function buildFullCastTracking(): string {
  return `## 全员追踪

本书启用全员追踪模式。每章结束时，POST_SETTLEMENT 必须额外包含：
- 本章出场角色清单（名字 + 一句话状态变化）
- 角色间关系变动（如有）
- 未出场但被提及的角色（名字 + 提及原因）`;
}

// ---------------------------------------------------------------------------
// Genre-specific rules
// ---------------------------------------------------------------------------

function buildGenreRules(gp: GenreProfile, genreBody: string): string {
  const fatigueLine = gp.fatigueWords.length > 0
    ? `- 高疲劳词（${gp.fatigueWords.join("、")}）单章最多出现1次`
    : "";

  const chapterTypesLine = gp.chapterTypes.length > 0
    ? `动笔前先判断本章类型：\n${gp.chapterTypes.map(t => `- ${t}`).join("\n")}`
    : "";

  const pacingLine = gp.pacingRule
    ? `- 节奏规则：${gp.pacingRule}`
    : "";

  return [
    `## 题材规范（${gp.name}）`,
    fatigueLine,
    pacingLine,
    chapterTypesLine,
    genreBody,
  ].filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------------------
// Protagonist rules from book_rules
// ---------------------------------------------------------------------------

// Narrative person is a durable user constraint: enforce it only when the user
// explicitly set one (book_rules.narrativePerson). When unset, stay silent so the
// genre default applies — we never impose a person the user didn't ask for.
function buildNarrativePersonRule(bookRules: BookRules | null, language: "zh" | "en"): string {
  const person = bookRules?.narrativePerson;
  if (!person) return "";
  if (language === "en") {
    return person === "first"
      ? "## Narrative person (hard constraint)\nWrite this book entirely in FIRST person (the protagonist's inner viewpoint). Do NOT slip into third person or an omniscient narrator — this overrides genre convention and your default."
      : "## Narrative person (hard constraint)\nWrite this book in THIRD person.";
  }
  return person === "first"
    ? "## 叙事人称（硬约束）\n本书必须全程使用第一人称（主角内心视角）叙述，禁止切换到第三人称或全知视角——此约束优先于题材惯例与你的默认倾向。"
    : "## 叙事人称（硬约束）\n本书使用第三人称叙述。";
}

/**
 * Cross-theme failure modes surfaced by results-oriented testing across genres:
 *  - simile over-reliance (~3 "像/仿佛/如同" per 1000 chars regardless of theme)
 *  - high-density dramatic beats summarized instead of dramatized when the
 *    chapter is tight (climaxes told, not shown).
 * Theme-independent, so this lives in the always-on writer discipline.
 */
function buildProseExecutionRules(language: "zh" | "en"): string {
  if (language === "en") {
    return `## Prose execution (cross-theme failure modes)

**Simile restraint.** Do not lean on "like / as if / as though" as a default device. At most one simile per scene, and only when it lights the image up better than plain rendering would. Priority is always: a precise verb > a concrete action or sensory detail > direct description > simile. Before reaching for "like…", check whether an exact verb or a concrete action would hit harder.

**Play out the climax — never summarize it.** This chapter's high-density / high-stakes beats — a conflict erupting, life-or-death, a major turn, a reveal, an action climax — MUST be played out beat by beat (action, dialogue, the senses, pauses, pacing). Never compress them into "then he saved them, the police came, the antagonist was arrested." When a chapter packs several major events, expand the single most important one into a full scene; connective tissue may be compressed, but the key beat must never decay into a summary. The tighter the chapter, the harder this holds — if you are short on words, pack fewer events, do not render the climax as a synopsis.`;
  }
  return `## 文笔执行（跨题材通病纠正）

**明喻节制。** 不要把"像/仿佛/如同/像……一样"当默认修辞反复用。每个场景明喻最多 1 处，且只在它真能点亮画面、比直写更准时才用。优先级永远是：精确的动词 > 具体的动作或感官细节 > 直接描写 > 明喻。想写"像……"之前，先问一句：换成一个准确的动词或一个具体动作，是不是更狠。

**高潮必须演出、不许概述。** 本章的高密度／高风险节拍——冲突爆发、生死、重大转折、真相揭露、动作高潮——必须一拍一拍现场演出（动作、对话、五感、停顿、节奏），绝不能用一两句"然后他救了人、警察来了、对手被捕"带过。当一章里挤了多个重大事件时，挑最关键的那一拍写成完整场景，次要的可压成过渡，但最关键那拍永远不许退化成总结。章节越紧凑越要守这条——字数不够就少塞事件，而不是把高潮写成梗概。`;
}

function buildProtagonistRules(bookRules: BookRules | null): string {
  if (!bookRules?.protagonist) return "";

  const p = bookRules.protagonist;
  const lines = [`## 主角铁律（${p.name}）`];

  if (p.personalityLock.length > 0) {
    lines.push(`\n性格锁定：${p.personalityLock.join("、")}`);
  }
  if (p.behavioralConstraints.length > 0) {
    lines.push("\n行为约束：");
    for (const c of p.behavioralConstraints) {
      lines.push(`- ${c}`);
    }
  }

  if (bookRules.prohibitions.length > 0) {
    lines.push("\n本书禁忌：");
    for (const p of bookRules.prohibitions) {
      lines.push(`- ${p}`);
    }
  }

  if (bookRules.genreLock?.forbidden && bookRules.genreLock.forbidden.length > 0) {
    lines.push(`\n风格禁区：禁止出现${bookRules.genreLock.forbidden.join("、")}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Book rules body (user-written markdown)
// ---------------------------------------------------------------------------

function buildBookRulesBody(body: string): string {
  if (!body) return "";
  return `## 本书专属规则\n\n${body}`;
}

// ---------------------------------------------------------------------------
// Style guide
// ---------------------------------------------------------------------------

function buildStyleGuide(
  styleGuide: string,
  language: "zh" | "en",
  stripBuiltIn: boolean,
): string {
  if (!styleGuide || styleGuide === "(文件尚未创建)") return "";
  const runtimeGuide = stripBuiltIn
    ? stripBuiltInWritingMethodology(styleGuide, language)
    : styleGuide.trim();
  if (!runtimeGuide) return "";
  return language === "en"
    ? `## Style Guide\n\n${runtimeGuide}`
    : `## 文风指南\n\n${runtimeGuide}`;
}

// ---------------------------------------------------------------------------
// Style fingerprint (Phase 9: C3)
// ---------------------------------------------------------------------------

function buildStyleFingerprint(fingerprint?: string): string {
  if (!fingerprint) return "";
  return `## 文风指纹（模仿目标）

以下是从参考文本中提取的写作风格特征。你的输出必须尽量贴合这些特征：

${fingerprint}`;
}

// ---------------------------------------------------------------------------
// Pre-write checklist
// ---------------------------------------------------------------------------

function buildPreWriteChecklist(book: BookConfig, gp: GenreProfile): string {
  let idx = 1;
  const lines = [
    "## 动笔前必须自问",
    "",
    `${idx++}. 【大纲锚定】本章对应卷纲中的哪个节点/阶段？本章必须推进该节点的剧情，不得跳过或提前消耗后续节点。如果卷纲指定了章节范围，严格遵守节奏。`,
    `${idx++}. 主角此刻利益最大化的选择是什么？`,
    `${idx++}. 这场冲突是谁先动手，为什么非做不可？`,
    `${idx++}. 配角/反派是否有明确诉求、恐惧和反制？行为是否由"过往经历+当前利益+性格底色"驱动？`,
    `${idx++}. 反派当前掌握了哪些已知信息？哪些信息只有读者知道？有无信息越界？`,
    `${idx++}. 章尾是否留了钩子（悬念/伏笔/冲突升级）？`,
  ];

  if (gp.numericalSystem) {
    lines.push(`${idx++}. 本章收益能否落到具体资源、数值增量、地位变化或已回收伏笔？`);
  }

  // 17雷点精华预防
  lines.push(
    `${idx++}. 【流水账检查】本章是否有无冲突的日常流水叙述？如有，加入前因后果或强情绪改造`,
    `${idx++}. 【主线偏离检查】本章是否推进了主线目标？支线是否在2-3章内与核心目标关联？`,
    `${idx++}. 【爽点节奏检查】最近3-5章内是否有小爽点落地？读者的"情绪缺口"是否在积累或释放？`,
    `${idx++}. 【人设崩塌检查】角色行为是否与已建立的性格标签一致？有无无铺垫的突然转变？`,
    `${idx++}. 【视角检查】本章视角是否清晰？同场景内说话人物是否控制在3人以内？`,
    `${idx++}. 如果任何问题答不上来，先补逻辑链，再写正文`,
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Creative-only output format (no settlement blocks)
// ---------------------------------------------------------------------------

function buildCreativeOutputFormat(gp: GenreProfile): string {
  const resourceRow = gp.numericalSystem
    ? "| 当前资源总量 | X | 与账本一致 |\n| 本章预计增量 | +X（来源） | 无增量写+0 |"
    : "";

  const preWriteTable = `=== PRE_WRITE_CHECK ===
（简短输出，只确认正文执行所需的四项）
| 检查项 | 本章记录 | 备注 |
|--------|----------|------|
| 当前任务 | 复述 chapter_memo 的「当前任务」并写出本章执行动作 | 必须具体，不能抽象 |
| 章尾必须发生的改变 | 列出 memo「章尾必须发生的改变」中 1-3 条具体改变 | 必须落地 |
| 不要做 | 复述 memo「不要做」清单 | 正文不得触碰 |
${resourceRow}| Hook 执行 | 列出 advance/resolve id 及对应场景，无则写 none | 不新增 memo 外 hook |`;

  return `## 输出格式（严格遵守）

${preWriteTable}

=== CHAPTER_TITLE ===
(章节标题，不含"第X章"。标题必须与已有章节标题不同，不要重复使用相同或相似的标题；若提供了 recent title history 或高频标题词，必须主动避开重复词根和高频意象)

=== CHAPTER_CONTENT ===
(正文内容；字数要求以 user prompt 的单一长度区块为准)

【重要】本次只需输出以上三个区块（PRE_WRITE_CHECK、CHAPTER_TITLE、CHAPTER_CONTENT）。
状态卡、伏笔池、摘要等追踪文件将由后续结算阶段处理，请勿输出。`;
}

// ---------------------------------------------------------------------------
// Output format
// ---------------------------------------------------------------------------

function buildOutputFormat(gp: GenreProfile): string {
  const resourceRow = gp.numericalSystem
    ? "| 当前资源总量 | X | 与账本一致 |\n| 本章预计增量 | +X（来源） | 无增量写+0 |"
    : "";

  const preWriteTable = `=== PRE_WRITE_CHECK ===
（简短输出，只确认正文执行所需的四项）
| 检查项 | 本章记录 | 备注 |
|--------|----------|------|
| 当前任务 | 复述 chapter_memo 的「当前任务」并写出本章执行动作 | 必须具体，不能抽象 |
| 章尾必须发生的改变 | 列出 memo「章尾必须发生的改变」中 1-3 条具体改变 | 必须落地 |
| 不要做 | 复述 memo「不要做」清单 | 正文不得触碰 |
${resourceRow}| Hook 执行 | 列出 advance/resolve id 及对应场景，无则写 none | 不新增 memo 外 hook |`;

  const postSettlement = gp.numericalSystem
    ? `=== POST_SETTLEMENT ===
（如有数值变动，必须输出Markdown表格）
| 结算项 | 本章记录 | 备注 |
|--------|----------|------|
| 资源账本 | 期初X / 增量+Y / 期末Z | 无增量写+0 |
| 重要资源 | 资源名 -> 贡献+Y（依据） | 无写"无" |
| 伏笔变动 | 新增/回收/延后 Hook | 同步更新伏笔池 |`
    : `=== POST_SETTLEMENT ===
（如有伏笔变动，必须输出）
| 结算项 | 本章记录 | 备注 |
|--------|----------|------|
| 伏笔变动 | 新增/回收/延后 Hook | 同步更新伏笔池 |`;

  const updatedLedger = gp.numericalSystem
    ? `\n=== UPDATED_LEDGER ===\n(更新后的完整资源账本，Markdown表格格式)`
    : "";

  return `## 输出格式（严格遵守）

${preWriteTable}

=== CHAPTER_TITLE ===
(章节标题，不含"第X章"。标题必须与已有章节标题不同，不要重复使用相同或相似的标题；若提供了 recent title history 或高频标题词，必须主动避开重复词根和高频意象)

=== CHAPTER_CONTENT ===
(正文内容；字数要求以 user prompt 的单一长度区块为准)

${postSettlement}

=== UPDATED_STATE ===
(更新后的完整状态卡，Markdown表格格式)
${updatedLedger}
=== UPDATED_HOOKS ===
(更新后的完整伏笔池，Markdown表格格式)

=== CHAPTER_SUMMARY ===
(本章摘要，Markdown表格格式，必须包含以下列)
| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |
|------|------|----------|----------|----------|----------|----------|----------|
| N | 本章标题 | 角色1,角色2 | 一句话概括 | 关键变化 | H01埋设/H02推进 | 情绪走向 | ${gp.chapterTypes.length > 0 ? gp.chapterTypes.join("/") : "过渡/冲突/高潮/收束"} |

=== UPDATED_SUBPLOTS ===
(更新后的完整支线进度板，Markdown表格格式)
| 支线ID | 支线名 | 相关角色 | 起始章 | 最近活跃章 | 距今章数 | 状态 | 进度概述 | 回收ETA |
|--------|--------|----------|--------|------------|----------|------|----------|---------|

=== UPDATED_EMOTIONAL_ARCS ===
(更新后的完整情感弧线，Markdown表格格式)
| 角色 | 章节 | 情绪状态 | 触发事件 | 强度(1-10) | 弧线方向 |
|------|------|----------|----------|------------|----------|

=== UPDATED_CHARACTER_MATRIX ===
(更新后的角色矩阵，每个角色一个 ## 块)

## 角色名
- **定位**: 主角 / 反派 / 盟友 / 配角 / 提及
- **标签**: 核心身份标签
- **反差**: 打破刻板印象的独特细节
- **说话**: 说话风格概述
- **性格**: 性格底色
- **动机**: 根本驱动力
- **当前**: 本章即时目标
- **关系**: 某角色(关系性质/Ch#) | ...
- **已知**: 该角色已知的信息（仅限亲历或被告知）
- **未知**: 该角色不知道的信息`;
}

// ---------------------------------------------------------------------------
// English output formats (parser keys off the === MARKER === anchors, so the
// table labels below are safely localized; persisted artifacts read English).
// ---------------------------------------------------------------------------

function buildEnglishPreWriteTable(gp: GenreProfile): string {
  const resourceRow = gp.numericalSystem
    ? "| Current resource total | X | match the ledger |\n| This chapter's gain | +X (source) | write +0 if none |\n"
    : "";

  return `=== PRE_WRITE_CHECK ===
(Keep it short. Confirm only the four items needed to execute the prose.)
| Check | This chapter | Note |
|-------|--------------|------|
| Current task | Restate the chapter_memo "Current task" and the concrete action this chapter takes | Be specific, not abstract |
| Required end-of-chapter change | 1-3 concrete changes from the memo's end-of-chapter change | Must land on the page |
| Do not | Restate the memo "Do not" list | The prose must not touch these |
${resourceRow}| Hook execution | advance/resolve ids and their scene; write none if absent | Do not invent hooks outside the memo |`;
}

function buildEnglishContentBlocks(): string {
  return `=== CHAPTER_TITLE ===
(Chapter title, without "Chapter X". It must differ from existing titles; do not reuse the same or similar titles. If recent title history or high-frequency title words are provided, avoid repeated roots and overused imagery.)

=== CHAPTER_CONTENT ===
(Chapter prose. Follow the single length block in the user prompt.)`;
}

function buildEnglishCreativeOutputFormat(gp: GenreProfile): string {
  return `## Output Format (follow strictly)

${buildEnglishPreWriteTable(gp)}

${buildEnglishContentBlocks()}

[Important] Output only the three blocks above (PRE_WRITE_CHECK, CHAPTER_TITLE, CHAPTER_CONTENT). State cards, hook pool, and summaries are handled by the later settlement stage; do not output them.`;
}

function buildEnglishOutputFormat(gp: GenreProfile): string {
  const postSettlement = gp.numericalSystem
    ? `=== POST_SETTLEMENT ===
(If any numerical change occurred, output a Markdown table.)
| Item | This chapter | Note |
|------|--------------|------|
| Resource ledger | open X / gain +Y / close Z | write +0 if none |
| Key resources | name -> contribution +Y (basis) | write "none" if none |
| Hook changes | new / resolved / deferred hook | sync the hook pool |`
    : `=== POST_SETTLEMENT ===
(If any hook changed, output this.)
| Item | This chapter | Note |
|------|--------------|------|
| Hook changes | new / resolved / deferred hook | sync the hook pool |`;

  const updatedLedger = gp.numericalSystem
    ? `\n=== UPDATED_LEDGER ===\n(The full updated resource ledger, Markdown table.)`
    : "";

  return `## Output Format (follow strictly)

${buildEnglishPreWriteTable(gp)}

${buildEnglishContentBlocks()}

${postSettlement}

=== UPDATED_STATE ===
(The full updated state card, Markdown table.)
${updatedLedger}
=== UPDATED_HOOKS ===
(The full updated hook pool, Markdown table.)

=== CHAPTER_SUMMARY ===
(Chapter summary as a Markdown table with these columns.)
| Chapter | Title | Characters | Key events | State change | Hook dynamics | Emotional tone | Chapter type |
|---------|-------|------------|------------|--------------|---------------|----------------|--------------|
| N | this chapter's title | Char1, Char2 | one-line summary | key change | H01 planted / H02 advanced | emotional arc | ${gp.chapterTypes.length > 0 ? gp.chapterTypes.join(" / ") : "transition / conflict / climax / resolution"} |

=== UPDATED_SUBPLOTS ===
(The full updated subplot board, Markdown table.)
| Subplot ID | Name | Characters | Start ch | Last active ch | Chapters since | Status | Progress | Resolve ETA |
|------------|------|------------|----------|----------------|----------------|--------|----------|-------------|

=== UPDATED_EMOTIONAL_ARCS ===
(The full updated emotional arcs, Markdown table.)
| Character | Chapter | Emotional state | Trigger | Intensity (1-10) | Arc direction |
|-----------|---------|-----------------|---------|------------------|---------------|

=== UPDATED_CHARACTER_MATRIX ===
(The updated character matrix, one ## block per character.)

## Character Name
- **Role**: protagonist / antagonist / ally / supporting / mentioned
- **Tags**: core identity tags
- **Contrast**: a distinctive detail that breaks the stereotype
- **Voice**: how they speak
- **Personality**: underlying temperament
- **Motivation**: core driving force
- **Current**: this chapter's immediate goal
- **Relations**: Character (relationship / Ch#) | ...
- **Knows**: what this character knows (only what they witnessed or were told)
- **Unknown**: what this character does not know`;
}
