import type { BookConfig } from "../models/book.js";
import type { GenreProfile } from "../models/genre-profile.js";
import type { BookRules } from "../models/book-rules.js";
import type { LengthSpec } from "../models/length-governance.js";
import {
  EPISODE_DURATION_HARD_MAX_SECONDS,
  EPISODE_DURATION_HARD_MIN_SECONDS,
  EPISODE_DURATION_TARGET_SECONDS,
  episodeShotBudget,
  episodeSoftDurationRange,
} from "../models/episode-script.js";
import { stripBuiltInWritingMethodology } from "../utils/writing-methodology.js";
import { buildNarrativeDriveContract } from "./narrative-drive-contract.js";

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
  episodeNumber?: number,
  mode: "full" | "creative" = "full",
  languageOverride?: "zh" | "en",
  inputProfile: "legacy" | "governed" = "legacy",
  _lengthSpec?: LengthSpec,
): string {
  const isEnglish = (languageOverride ?? genreProfile.language) === "en";
  const governed = inputProfile === "governed";
  const targetDurationSeconds = normalizeEpisodeDuration(book.episodeDurationSeconds);
  const isFinalEpisode = episodeNumber !== undefined
    && episodeNumber === book.targetEpisodes;

  // Episode v2 has one authoritative output contract. The old prose/table
  // response format is intentionally unreachable so a caller cannot bypass
  // EpisodeScript validation by selecting a legacy mode.
  const outputSection = isEnglish
    ? buildEnglishCreativeOutputFormat(genreProfile, targetDurationSeconds, isFinalEpisode)
    : buildCreativeOutputFormat(genreProfile, targetDurationSeconds, isFinalEpisode);

  const sections = isEnglish
    ? [
        buildEnglishScreenplayGenreIntro(book, genreProfile, targetDurationSeconds),
        buildScreenplayCoreRules("en"),
        buildGovernedInputContract("en", governed),
        buildEpisodeMemoContract("en", governed),
        buildNarrativeDriveContract("writer", "en"),
        buildScreenplayExecutionRules("en", targetDurationSeconds),
        buildGenreRules(genreProfile, genreBody, "en"),
        buildProtagonistRules(bookRules, "en"),
        buildNarrativePersonRule(bookRules, isEnglish ? "en" : "zh"),
        bookRules?.enableFullCastTracking ? buildFullCastTracking("en") : "",
        buildBookRulesBody(bookRulesBody, "en"),
        buildStyleGuide(styleGuide, "en", governed),
        buildStyleFingerprint(styleFingerprint, "en"),
        // Pre-write checklist moved to style_guide.md (v10)
        outputSection,
      ]
    : [
        buildGenreIntro(book, genreProfile, targetDurationSeconds),
        buildScreenplayCoreRules("zh"),
        buildGovernedInputContract("zh", governed),
        buildEpisodeMemoContract("zh", governed),
        buildNarrativeDriveContract("writer", "zh"),
        buildScreenplayExecutionRules("zh", targetDurationSeconds),
        bookRules?.enableFullCastTracking ? buildFullCastTracking("zh") : "",
        buildGenreRules(genreProfile, genreBody, "zh"),
        buildProtagonistRules(bookRules, "zh"),
        buildNarrativePersonRule(bookRules, isEnglish ? "en" : "zh"),
        buildBookRulesBody(bookRulesBody, "zh"),
        buildStyleGuide(styleGuide, "zh", governed),
        buildStyleFingerprint(styleFingerprint, "zh"),
        // Pre-write checklist moved to style_guide.md (v10)
        outputSection,
      ];

  return sections.filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------------------
// Genre intro
// ---------------------------------------------------------------------------

function normalizeEpisodeDuration(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    && value >= EPISODE_DURATION_HARD_MIN_SECONDS && value <= EPISODE_DURATION_HARD_MAX_SECONDS
    ? value
    : EPISODE_DURATION_TARGET_SECONDS;
}

function buildGenreIntro(book: BookConfig, gp: GenreProfile, targetDurationSeconds: number): string {
  return `你是一位专业的${gp.name}漫剧编剧。你为${book.platform}平台创作连续短剧，每集目标约 ${targetDurationSeconds} 秒。`;
}

function buildEnglishScreenplayGenreIntro(
  book: BookConfig,
  gp: GenreProfile,
  targetDurationSeconds: number,
): string {
  return `You are a professional ${gp.name} comic-drama screenwriter creating a continuous episodic series for ${book.platform}. Each episode targets about ${targetDurationSeconds} seconds.`;
}

function buildScreenplayCoreRules(language: "zh" | "en"): string {
  if (language === "en") {
    return `## Screenplay core rules
- Preserve established facts, character knowledge, locations, injuries, abilities, props, and world rules.
- Make every shot producible: visible action, speakable dialogue, purposeful sound, or a necessary transition.
- Convert inner thought into behavior, expression, dialogue, or concise narration.
- Keep character voices distinct and every relationship change event-driven.
- Do not add unplanned hooks or reversals merely to increase density.`;
  }
  return `## 漫剧核心规则
- 严格延续已确认的人物知情范围、位置、伤势、能力、道具和世界规则。
- 每个镜头都必须可制作：有可见动作、可说对白、有效音效或必要转场。
- 心理活动必须外化为动作、表情、对白或精简旁白。
- 角色口吻要可区分，关系变化必须由本集事件驱动。
- 不得为了追求密度擅自新增计划外 Hook 或随机反转。`;
}

function buildScreenplayExecutionRules(language: "zh" | "en", targetDurationSeconds: number): string {
  if (language === "en") {
    return `## Screenplay execution contract
- Write a production-oriented episodic screenplay, not novel prose.
- Every beat must be visible or audible: shot, action, dialogue, narration, sound, or transition.
- Each episode needs a concrete payoff, relationship pressure, a causally prepared reversal, and a specific emotional question at the end.
- Keep the visual action and dialogue short enough for a roughly ${targetDurationSeconds}-second episode.

## Beat variation (avoid same-shape episodes)
Do NOT run every episode through the same curve "opening hook → escalation → reversal → emotional question". When this episode is a slow-burn / transition / aftermath / setup episode, vary the beats:
- The reversal slot may become "pressure stalls, a new threat mounts", or "an old problem slides to a new breaking point" — do not manufacture a reversal just to fill the slot.
- The emotional question may be low-volume (silence, a withheld beat, a suspended choice) — not every episode must end on a fresh question sentence.
- Change exactly one state dimension (information / power / relationship / survival) this episode; let the others hold inertia.
- A variation episode is NOT a weaker episode: it must lean harder on concrete action and performance detail, never on exposition to fill rhythm.
- A variation episode may land anywhere in the soft duration range: do not pad a quiet episode with filler shots or actions to reach the target, and do not slow a fast episode down just for uniformity.
- Pick this episode's payoff type from the genre payoff pool and rotate: do not reuse the same payoff type (humiliation / breakthrough / payoff / reveal / trump card …) across consecutive episodes.`;
  }
  return `## 漫剧执行合同
- 输出面向制作的连续漫剧分镜稿，不写小说正文。
- 每个节拍必须能被看见或听见：镜头、动作、对白、旁白、音效或转场。
- 每集必须有具体爽点、关系压力、有铺垫的反转，以及结尾明确的情绪问题。
- 画面和对白要控制在约 ${targetDurationSeconds} 秒的可执行范围内。

## 节拍变奏（防同构模板）
不要每集都走"开场钩子 → 升级 → 反转 → 情绪问题"的同一曲线。当本集是慢热/过渡/后效/布局集时，允许变奏：
- "反转"槽位可以替换为"压力停滞 + 新威胁压顶"，或"旧问题在旧关系上滑向新的临界点"——不要为了凑槽位硬造反转。
- 情绪问题可以是低音量的静默、悬置或按下不表——不必每集都以一个新疑问句收尾。
- 一集只允许改变一个状态维度（信息/权力/关系/生存择一），其余维度保持惯性。
- 变奏集不是弱集：它必须比常规集更依赖具体动作与表演细节，禁止用说明文填节奏。
- 变奏集时长允许落在软区间（120-180 秒）任意位置：慢集不要为了凑满时长硬加镜头或动作，快集不要为了整齐强行放缓。
- 本集爽点类型从题材爽点池中选择，且要与最近几集轮换：打脸/升级/兑现/揭示/底牌等不要连续集重复同一类。`;
}

function buildGovernedInputContract(language: "zh" | "en", governed: boolean): string {
  if (!governed) return "";

  if (language === "en") {
    return `## Input Governance Contract

- Episode decisions come from the compiled episode memo; selected context supplies evidence and cannot silently replace those decisions.
- Canon, the previous handoff state, information permissions, and explicit prohibitions are authoritative.
- Follow active rule-stack overrides only at the scope they name; do not use them to re-plan the episode.
- Use only memo-approved open / advance / resolve / defer hook operations, each with a shot-level carrier.
- Treat local result, outgoing pressure, emotional hook and end state as distinct deliverables. The emotional hook MUST be a concrete audience question about a relationship, danger, identity, sacrifice, or choice (for example: "Will she hand him to the police before dawn?"); a mood label or vague promise is invalid.
- If an English Variance Brief is provided, obey its episode-level scene obligation and avoid its listed phrase, opening, and ending patterns.
- In multi-character scenes, include at least one resistance-bearing exchange that changes leverage, knowledge, or relationship pressure.
- When facts conflict, stop rather than inventing an explanation, off-screen event, new rule, or surprise character.`;
  }

  return `## 输入治理契约

- 本集剧情决策来自已编译的 episode memo；已选上下文只提供事实证据，不能静默替换本集决策。
- 正典、上一集交接状态、信息权限和显式禁令属于权威事实。
- 规则栈覆盖只在声明范围内生效，不得借此重新规划整集。
- 只执行 memo 允许的 open / advance / resolve / defer Hook 操作，每项都要有镜头证据。
- 当集兑现、出去压力、情绪钩子和结尾状态是四个不同交付项，不能互相冒充。情绪钩子必须写成具体的观众疑问，且指向关系、危险、身份、牺牲或选择（例如“她会在天亮前把他交给警察吗？”）；情绪标签或“下集揭晓”式空话无效。
- 事实冲突时不得编造解释、画外事件、新规则或突然登场人物来补洞。`;
}

// ---------------------------------------------------------------------------
// Episode memo alignment — Planner owns decisions; Writer owns prose execution.
// ---------------------------------------------------------------------------

function buildEpisodeMemoContract(
  language: "zh" | "en",
  governed: boolean,
): string {
  if (!governed) return "";

  if (language === "en") {
    return `## Episode Memo Alignment

You will receive a structured episode memo. The planner owns plot decisions; your job is to execute them as production-ready shots, actions, dialogue, sound, and transitions inside the required EpisodeScript JSON:

- Incoming state: carry knowledge, power, relationship, physical and active-action facts into the first scene.
- Objective and opposition: execute the concrete goal against an opposing goal and leverage.
- Causal escalation: realize visible choice, countermove, state change and next pressure.
- Local result: land the episode payoff before its outgoing pressure.
- Handoff and permissions: make relationship pressure, information boundaries and next-episode facts observable.
- Hook ledger: each operation must land in a shot, action, dialogue, sound or state change; do not manufacture hooks for density.
- Do not: obey every item in the memo's Do not section.

Before submission, verify that every contract field has a concrete trace in the EpisodeScript JSON.`;
  }

    return `## 剧集备忘对齐

你将收到结构化 episode memo。Planner 负责决定“本集发生什么”，你只负责把决策执行成可制作的镜头、动作、对白、音效和转场，并严格写入 EpisodeScript JSON：

- 进入状态：首场接住知识、权力、关系、物理和未完成动作。
- 当前目标与反对力量：用双方目标和筹码发动现场冲突。
- 因果升级：落实可见选择、反制、状态变化和下一压力。
- 当集兑现：先交付本集结果，再启动出去压力。
- 交接与权限：把关系压力、信息边界和下一集事实写进 contract。
- Hook 账：每项操作必须落到镜头、动作、对白、音效或状态变化，不为密度凭空开坑。
- 不要做：逐条遵守 memo 的禁令。

提交前检查每个 contract 字段是否在 EpisodeScript JSON 中有具体落点。`;
}

// ---------------------------------------------------------------------------
// Core rules (~25 universal rules)
// ---------------------------------------------------------------------------

export function buildGoldenOpeningDiscipline(
  episodeNumber: number | undefined,
  language: "zh" | "en",
): string {
  if (episodeNumber === undefined || episodeNumber > 3) return "";

  if (language === "en") {
    return `## Golden Opening Discipline — Episode ${episodeNumber}

The planner memo already decides the episode's opening-three plot obligation. Execute it without restating it: reach a dramatic or reversal beat by the end of the first phone screen, keep the episode to at most two focused scenes and two named characters in direct conflict, reveal information through action, and end on the memo's required hook or change. Do not add background preambles or extra subplots.`;
  }

  return `## 开篇三集写作纪律 — 第 ${episodeNumber} 集

Planner memo 已经决定本集在开篇三集中的剧情任务。不要复述方法论，只执行它：手机第一页结束前出现戏剧性、反差或反转节点；全集最多两个聚焦场景、两个参与正面冲突的有名角色；信息通过动作带出；结尾落实 memo 指定的 hook 或改变。不要追加背景序言和额外支线。`;
}

// ---------------------------------------------------------------------------
// Full cast tracking (conditional)
// ---------------------------------------------------------------------------

function buildFullCastTracking(language: "zh" | "en"): string {
  if (language === "en") {
    return `## Full Cast Tracking

This book enables full cast tracking. At the end of each episode, the structured state projection must additionally include:
- The list of characters who appeared this episode (name + one-sentence state change)
- Relationship changes between characters (if any)
- Characters who did not appear but were mentioned (name + reason for the mention)`;
  }
  return `## 全员追踪

本书启用全员追踪模式。每集结束时，结构化状态投影必须额外包含：
- 本集出场角色清单（名字 + 一句话状态变化）
- 角色间关系变动（如有）
- 未出场但被提及的角色（名字 + 提及原因）`;
}

// ---------------------------------------------------------------------------
// Genre-specific rules
// ---------------------------------------------------------------------------

function buildGenreRules(gp: GenreProfile, genreBody: string, language: "zh" | "en"): string {
  if (language === "en") {
    const fatigueLine = gp.fatigueWords.length > 0
      ? `- High-fatigue words (${gp.fatigueWords.join(", ")}) appear at most once per episode`
      : "";
    const episodeTypesLine = gp.episodeTypes.length > 0
      ? `Decide this episode's type before writing:\n${gp.episodeTypes.map((t) => `- ${t}`).join("\n")}`
      : "";
    const pacingLine = gp.pacingRule
      ? `- Pacing rule: ${gp.pacingRule}`
      : "";
    return [
      `## Genre rules (${gp.name})`,
      fatigueLine,
      pacingLine,
      episodeTypesLine,
      genreBody,
    ].filter(Boolean).join("\n\n");
  }
  const fatigueLine = gp.fatigueWords.length > 0
    ? `- 高疲劳词（${gp.fatigueWords.join("、")}）单集最多出现1次`
    : "";

  const episodeTypesLine = gp.episodeTypes.length > 0
    ? `动笔前先判断本集类型：\n${gp.episodeTypes.map((t) => `- ${t}`).join("\n")}`
    : "";

  const pacingLine = gp.pacingRule
    ? `- 节奏规则：${gp.pacingRule}`
    : "";

  return [
    `## 题材规范（${gp.name}）`,
    fatigueLine,
    pacingLine,
    episodeTypesLine,
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
 *    episode is tight (climaxes told, not shown).
 * Theme-independent, so this lives in the always-on writer discipline.
 */
function buildProseExecutionRules(language: "zh" | "en"): string {
  if (language === "en") {
    return `## Screenplay execution
- Stage the key beat as shots with visible action, dialogue and sound instead of narrative summary.
- Keep each shot focused on one visual change and one dramatic action.
- Use narration only when the information cannot be shown or spoken naturally.`;
  }
  return `## 漫剧镜头执行
- 关键节拍必须拆成镜头，用可见动作、对白和音效现场演出，不得用小说式总结带过。
- 每个镜头只承担一个主要画面变化和一个戏剧动作。
- 只有无法自然展示或说出的信息才使用旁白。`;
}

function buildProtagonistRules(bookRules: BookRules | null, language: "zh" | "en"): string {
  if (!bookRules?.protagonist) return "";

  const p = bookRules.protagonist;
  if (language === "en") {
    const lines = [`## Protagonist Lock (${p.name})`];
    if (p.personalityLock.length > 0) {
      lines.push(`\nPersonality lock: ${p.personalityLock.join(", ")}`);
    }
    if (p.behavioralConstraints.length > 0) {
      lines.push("\nBehavioral constraints:");
      for (const c of p.behavioralConstraints) {
        lines.push(`- ${c}`);
      }
    }
    if (bookRules.prohibitions.length > 0) {
      lines.push("\nBook prohibitions:");
      for (const prohibition of bookRules.prohibitions) {
        lines.push(`- ${prohibition}`);
      }
    }
    if (bookRules.genreLock?.forbidden && bookRules.genreLock.forbidden.length > 0) {
      lines.push(`\nStyle forbidden: ${bookRules.genreLock.forbidden.join(", ")}`);
    }
    return lines.join("\n");
  }
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

function buildBookRulesBody(body: string, language: "zh" | "en"): string {
  if (!body) return "";
  return language === "en"
    ? `## Book-Specific Rules\n\n${body}`
    : `## 本书专属规则\n\n${body}`;
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

function buildStyleFingerprint(fingerprint: string | undefined, language: "zh" | "en"): string {
  if (!fingerprint) return "";
  if (language === "en") {
    return `## Style Fingerprint (imitation target)

The following writing traits were extracted from the reference text. Your output should match them as closely as possible:

${fingerprint}`;
  }
  return `## 文风指纹（模仿目标）

以下是从参考文本中提取的写作风格特征。你的输出必须尽量贴合这些特征：

${fingerprint}`;
}

// ---------------------------------------------------------------------------
// Pre-write checklist
// ---------------------------------------------------------------------------

// Creative-only EpisodeScript output format
// ---------------------------------------------------------------------------

/**
 * Borrowed from the drama-skills craft suite: dialogue is a sequence of moves,
 * delivery is an executable strategy (not an emotion label), and every scene
 * must earn its existence through a reversible conflict change. Also encodes
 * the directionality rule for coincidence and misunderstanding.
 */
function buildDialogueAndSceneDiscipline(language: "zh" | "en"): string {
  if (language === "en") {
    return `## Dialogue is action
- Before writing each line, answer: what does the speaker want the other person to do or change right now? Lines without an action target should be compressed or turned into action.
- Subtext only exists when the speaker cannot or will not say what they want (it would expose a secret, a third party is present, a direct demand would look powerless). Give the audience inferable cues: avoiding one specific word, touching/hiding an object, a changed form of address, answering the side question first.
- Strategies get blocked: the other party sees through the move, accepts the words but refuses the relational shift, produces counter-evidence, or changes the public frame. After a block, the character changes strategy, pays a cost, or exits; do not repeat the same demand.
- Information enters through struggle, verification, exchange, accusation, correction, avoidance, or publicity. Never have characters recite background both already know for the audience.
- Distinguish voices by what they attend to, how they prove things, how they control distance, how they hide, and how they deform under pressure — not by catchphrases.
- "delivery" is an executable strategy (probing, pressuring, redrawing a boundary, stating a threat as a reminder, keeping a third party from hearing, dropping the explanation, using a first name for the first time), not an emotion word.
- A long speech is broken by an action beat only at an agenda turn; a long speech with no internal turn should be shortened, not split. delivery describes only HOW it is said; physical action belongs in the action field.
- Functional extras may use descriptive labels (a stranger, a passerby, an officer); characters who reappear must reuse a registered name or be added to roles/ first — do not introduce a new alias every episode.

## Dialogue technique failure conditions (a technique used in the wrong place hurts more than not using it)
- Subtext: when a character has no reason to conceal, let them say it; unmotivated evasion only makes the audience feel information is being withheld.
- Interruption: if the interrupted sentence carried information the audience can never recover, use action, props, or shot rhythm instead — do not hide information behind an interruption.
- Silence: silence must have a visible object — the audience should see what the character is weighing, waiting for, or judging; objectless silence is just a stalled shot.
- Partial admission: use only when the audience already senses a bigger secret; otherwise the reveal feels like a trick played on them.
- Pressure via a third party: the invoked rule or third-party leverage must be something the audience already knows; a freshly invented excuse is the author rescuing the scene.

## Scene work card (think it through before writing)
For each scene answer: what choice/evidence/relationship change is lost if it is deleted? What is the entry state? What does the focus character want someone to change? What leverage blocks them? Which visible action carries the conflict? Which fact or decision invalidates the old plan (directional turn)? What exit state forces the next scene?
- A quiet scene passes when pressure and change stay legible; good lines cannot replace scene movement.
- Key inner facts must be expressed through behavior, evidence, spatial consequence, or deliberately marked voice.
- Coincidence may push characters INTO trouble (with a cost); it must not lift them OUT of it. A misunderstanding must produce an action and leave residue when it is cleared.`;
  }
  return `## 对白即行动
- 写每一句前先回答：说话者想让对方现在做什么、改变什么？没有行动目标的句子压缩或转成动作。
- 潜台词不是人人说谜语：只有当"真正想做的事不能/不愿直说"（说出来会暴露秘密、现场有第三人、直接要求会显得没筹码）时才存在，并要给观众可推断的线索：避开某个具体词、触碰/藏起相关物件、称呼改变、先答旁枝再回避核心问题。
- 策略必须会受阻：对方看穿点破、接受字面却拒绝隐含关系、给出反证、改变公开范围。受阻后人物换策略、付代价或退出；不要重复原要求。
- 信息通过争夺、验证、交换、指控、纠正、回避或公开进入冲突，不向观众复述双方都知道的背景。
- 人物声音靠"注意什么、怎样证明、怎样控制距离、怎样隐藏、压力下怎样变形"区分，不靠口癖词。
- delivery 只写可执行策略（试探、逼问、划界、把威胁说成提醒、不让第三人听见、放弃解释、第一次直呼对方名字），不写情绪词（愤怒、平静、低声不是策略）。
- 长发言只在议程转折处用动作行断开；内部没有转折的长发言应当缩短，而不是拆开。delivery 只写"怎么说"，动作写进 action 字段。
- 功能性路人可以使用描述性标签（陌生女人、路人、警察甲等）；会继续出场的角色必须复用已注册名字，或先登记到 roles/，不要每集换新称呼。

## 对白手法的失效条件（手法用错地方比不用更伤）
- 潜台词：人物没有隐瞒理由时就直说；无故躲闪只会让观众觉得信息被扣。
- 打断：被打断的句子若携带观众此后拿不到的信息，改用动作、物件或分镜节奏承载，不要靠打断藏信息。
- 沉默：沉默必须有可见对象——观众要看得出人物在权衡、等待或判断什么；无对象的沉默只是停拍。
- 先承认一部分：只在观众已经察觉有更大秘密时使用；否则揭露时观众会觉得被耍。
- 借第三人施压：引用的规则或第三方筹码必须是观众此前已经知道的；临时发明的挡箭牌等于作者救场。

## 场景工作卡（写正文前想清楚）
每个场景回答：删掉它损失哪项选择/证据/关系变化？进入状态是什么？焦点人物想让谁在本场改变什么？反对者用什么筹码阻止？哪个可见动作承载冲突？哪项事实/决定使原计划失效（方向性转向）？退出状态给下一场留下什么？
- 场景可以静，但压力和变化必须可读；台词好听不能替代场景运动。
- 关键内在事实必须通过行为、证据、空间后果或明确标记的声音表达。
- 巧合只能把人物推进麻烦（带着代价），不能把人物从麻烦里捞出来；误会必须产生行动，解除时必须留下残余。`;
}

function buildCreativeOutputFormat(
  gp: GenreProfile,
  targetDurationSeconds: number,
  isFinalEpisode: boolean,
): string {
  const resourceRow = gp.numericalSystem
    ? "| 当前资源总量 | X | 与账本一致 |\n| 本集预计增量 | +X（来源） | 无增量写+0 |"
    : "";
  const seriesResolutionField = isFinalEpisode
    ? `  "seriesResolution": {
    "mainConflict": "主线冲突如何得到结论",
    "protagonistDesire": "主角核心欲望最终得到什么结论",
    "characterArcs": [{ "character": "主要角色", "outcome": "角色弧线终点" }],
    "relationships": [{ "parties": "关系双方", "outcome": "核心关系最终状态" }]
  },
`
    : "";
  const seriesResolutionRule = isFinalEpisode
    ? "\n- 这是最终集：seriesResolution 必须明确记录主线冲突、主角核心欲望、主要角色弧线和核心关系的结论；不能只留下续集悬念。"
    : "";

  const preWriteTable = `=== PRE_WRITE_CHECK ===
（简短输出，只确认正文执行所需的四项）
| 检查项 | 本集记录 | 备注 |
|--------|----------|------|
| 当前目标 | 复述 memo「当前目标」并写出本集执行动作 | 必须具体，不能抽象 |
| 当集兑现与出去压力 | 说明本集先兑现什么，以及由此启动的下一压力 | 必须落地 |
| 不要做 | 复述 memo「不要做」清单 | 正文不得触碰 |
${resourceRow}| Hook 执行 | 列出 advance/resolve id 及对应场景，无则写 none | 不新增 memo 外 hook |`;

  return `## 漫剧分镜输出格式（严格遵守）

${preWriteTable}

=== EPISODE_SCRIPT_JSON ===
输出一个合法 JSON 对象，不要使用注释，不要在 JSON 内使用 Markdown。结构必须是：
{
  "episode": 本集数字,
  "title": "本集标题",
  "estimatedDurationSeconds": ${targetDurationSeconds},
  "openingHook": "前 3-5 秒的视觉或关系钩子",
  "reversal": "本集有铺垫、有后果的有效反转",
  "emotionalHook": "观众在结尾最想追问的情绪问题",
  "endState": "本集结束后不可逆的人物、关系、信息、权力或生存状态变化",
${seriesResolutionField}  "contract": {
    "incomingState": { "knowledge": [], "power": [], "relationship": [], "physical": [], "activeAction": [] },
    "objective": { "character": "行动者", "desiredChange": "本集要改变什么", "whyNow": "为什么必须现在行动" },
    "opposition": { "actorOrConstraint": "阻力方", "goal": "阻力方要什么", "leverage": "阻挡目标的筹码" },
    "causalEscalation": [{
      "becauseOf": "已经成立的事实或前序结果",
      "choice": "人物采取的可见选择",
      "countermove": "对手或环境的反制",
      "stateChange": "信息、权力、关系、物理或风险变化",
      "nextPressure": "该结果制造的下一股压力"
    }],
    "localDramaticResult": { "goalOutcome": "成功/失败/转向", "stateChange": "本集已兑现的状态变化", "costPaid": "为结果付出的代价" },
    "outgoingPressure": { "startedDecisionDangerOrQuestion": "已经启动的决定、危险或问题", "whyItFollows": "为什么它由本集结果产生" },
    "handoffState": { "knowledge": [], "power": [], "relationship": [], "physical": [], "activeAction": [], "emotional": [] },
    "informationPermissions": [{ "subject": "角色或事实", "audience": "观众已知范围", "known": [], "suspected": [], "mistaken": [], "unknown": [] }]
  },
  "scenes": [
    {
      "id": "S1",
      "location": "地点",
      "time": "时间/内外景",
      "purpose": "这个场景的戏剧任务",
      "shots": [
        {
          "id": "S1-01",
          "shotSize": "景别",
          "camera": "镜头运动或固定机位",
          "durationSeconds": 8,
          "visual": "可以直接看到的画面",
          "action": "可选的角色动作",
          "dialogue": [{ "speaker": "角色", "text": "对白", "delivery": "可执行策略（试探/逼问/划界等），不是情绪词" }],
          "narration": "可选旁白",
          "sound": "可选音效",
          "transition": "可选转场"
        }
      ]
    }
  ]
}

硬性要求：
- 1-3 个场景，合计 ${episodeShotBudget(targetDurationSeconds).min}-${episodeShotBudget(targetDurationSeconds).softMax} 个镜头（上限为软约束，超出只记 warning），总时长 ${episodeSoftDurationRange(targetDurationSeconds).softMin}-${episodeSoftDurationRange(targetDurationSeconds).softMax} 秒，目标 ${targetDurationSeconds} 秒。
- 只写能够被看到或听到的内容；心理活动必须转成动作、表情、对白或旁白。
- 每集必须兑现一个熟悉爽点，持续施压一组人物关系，并产生一次有因果链的反转。
- contract 必须完整记录进入状态、目标、阻力、因果升级、当集兑现、出去压力、交接状态和信息权限。
- 当集兑现必须先于出去压力；禁止用“马上揭晓”或单纯藏信息代替本集结果。
- 结尾必须留下明确情绪问题，但不能让本集没有状态变化。
- 不得输出小说散文，不得输出 JSON 之外的正文块。${seriesResolutionRule}

${buildDialogueAndSceneDiscipline("zh")}

【重要】本次只输出 PRE_WRITE_CHECK 和 EPISODE_SCRIPT_JSON 两个区块。状态文件由系统根据 EpisodeScript 确定性投影。`;
}

function buildEnglishPreWriteTable(gp: GenreProfile): string {
  const resourceRow = gp.numericalSystem
    ? "| Current resource total | X | match the ledger |\n| This episode's gain | +X (source) | write +0 if none |\n"
    : "";

  return `=== PRE_WRITE_CHECK ===
(Keep it short. Confirm only the four items needed to execute the EpisodeScript.)
| Check | This episode | Note |
|-------|--------------|------|
| Episode objective | Restate the memo objective and the concrete action this episode takes | Be specific, not abstract |
| Local result and outgoing pressure | State the result landed here and the pressure it starts | Must land on screen |
| Do not | Restate the memo do-not list | The script must not touch these |
${resourceRow}| Hook execution | advance/resolve ids and their scene; write none if absent | Do not invent hooks outside the memo |`;
}

function buildEnglishCreativeOutputFormat(
  gp: GenreProfile,
  targetDurationSeconds: number,
  isFinalEpisode: boolean,
): string {
  const seriesResolutionField = isFinalEpisode
    ? `  "seriesResolution": {
    "mainConflict": "How the main conflict is concluded",
    "protagonistDesire": "The final outcome of the protagonist's core desire",
    "characterArcs": [{ "character": "Major character", "outcome": "Arc endpoint" }],
    "relationships": [{ "parties": "Core relationship parties", "outcome": "Final relationship state" }]
  },
`
    : "";
  const seriesResolutionRule = isFinalEpisode
    ? "\n- This is the finale: seriesResolution must explicitly conclude the main conflict, protagonist desire, major character arcs, and core relationships. A sequel hook cannot replace an ending."
    : "";
  return `## Comic-drama screenplay output format (follow strictly)

${buildEnglishPreWriteTable(gp)}

=== EPISODE_SCRIPT_JSON ===
Return one valid JSON object with this exact shape and no comments or Markdown inside the JSON:
{
  "episode": 1,
  "title": "Episode title",
  "estimatedDurationSeconds": ${targetDurationSeconds},
  "openingHook": "Visible or relational hook in the first 3-5 seconds",
  "reversal": "A prepared reversal and its consequence",
  "emotionalHook": "The concrete audience question at the ending?",
  "endState": "Observable irreversible change in relationship, information, power, or survival",
${seriesResolutionField}  "contract": {
    "incomingState": { "knowledge": [], "power": [], "relationship": [], "physical": [], "activeAction": [] },
    "objective": { "character": "Actor", "desiredChange": "What must change", "whyNow": "Why action is required now" },
    "opposition": { "actorOrConstraint": "Opposition", "goal": "Opposition goal", "leverage": "Blocking leverage" },
    "causalEscalation": [{
      "becauseOf": "Established fact or prior result",
      "choice": "Visible choice",
      "countermove": "Opposition countermove",
      "stateChange": "Information, power, relationship, physical or risk change",
      "nextPressure": "Pressure created by this result"
    }],
    "localDramaticResult": { "goalOutcome": "Success, failure or redirection", "stateChange": "Delivered state change", "costPaid": "Cost paid" },
    "outgoingPressure": { "startedDecisionDangerOrQuestion": "Started decision, danger or question", "whyItFollows": "Why it follows from the result" },
    "handoffState": { "knowledge": [], "power": [], "relationship": [], "physical": [], "activeAction": [], "emotional": [] },
    "informationPermissions": [{ "subject": "Character or fact", "audience": "Audience permission", "known": [], "suspected": [], "mistaken": [], "unknown": [] }]
  },
  "scenes": [{
    "id": "S1",
    "location": "Location",
    "time": "Time / interior or exterior",
    "purpose": "Dramatic purpose",
    "shots": [{
      "id": "S1-01",
      "shotSize": "Shot size",
      "camera": "Camera position or movement",
      "durationSeconds": 8,
      "visual": "Directly visible image",
      "action": "Optional action",
      "dialogue": [{ "speaker": "Character", "text": "Line", "delivery": "Executable strategy (probe/pressure/redraw boundary), not an emotion word" }],
      "narration": "Optional narration",
      "sound": "Optional sound",
      "transition": "Optional transition"
    }]
  }]
}

Hard requirements:
- 1-3 scenes and ${episodeShotBudget(targetDurationSeconds).min}-${episodeShotBudget(targetDurationSeconds).softMax} shots in total (the upper bound is a soft cap — exceeding it only raises a warning); target ${targetDurationSeconds} seconds, preferred ${episodeSoftDurationRange(targetDurationSeconds).softMin}-${episodeSoftDurationRange(targetDurationSeconds).softMax} seconds.
- Everything must be visible or audible. Convert internal thought into action, expression, dialogue, or concise narration.
- Deliver one familiar payoff, pressure one relationship, and land one causally prepared reversal with consequences.
- contract must record incoming state, objective, opposition, causal escalation, local result, outgoing pressure, handoff state and information permissions.
- Land the local result before outgoing pressure; withholding information is not an episode payoff.
- End on a concrete emotional audience question after changing the story state.
- Do not output novel prose or any additional content block.${seriesResolutionRule}

${buildDialogueAndSceneDiscipline("en")}

[Important] Output only PRE_WRITE_CHECK and EPISODE_SCRIPT_JSON. Runtime state is projected deterministically from the EpisodeScript.`;
}
