import type { AuditIssue } from "../agents/continuity.js";
import { auditEpisodeToolDiagnostics } from "./episode-tool-diagnostics.js";
import {
  EPISODE_DURATION_HARD_MAX_SECONDS,
  EPISODE_DURATION_HARD_MIN_SECONDS,
  EPISODE_DURATION_TARGET_SECONDS,
  episodeShotBudget,
  episodeSoftDurationRange,
  hasConcreteAudienceQuestion,
  measureEpisodeScript,
  type EpisodeScript,
  type EpisodeStateBucket,
} from "../models/episode-script.js";
import type { SettingsEntityIndex } from "../state/settings-index.js";
import { factEquivalent, normalizeFacts } from "../utils/state-facts.js";

const STATE_KEYS = ["knowledge", "power", "relationship", "physical", "activeAction", "emotional"] as const;

/** Non-character dialogue sources that are always legal without a role card. */
const NARRATION_SPEAKERS = new Set([
  "旁白", "画外音", "解说", "字幕", "音效", "观众", "无",
  "narrator", "voiceover", "offscreen", "os", "vo", "sfx", "none",
]);

/** Descriptive role labels used for one-off functional extras. These are
 * legitimate speakers in a 90-second episode and must not trigger the
 * settings-index reference audit. */
const FUNCTIONAL_ROLE_SPEAKERS = new Set([
  "陌生人", "陌生女人", "陌生男人", "路人", "顾客", "群众", "人群", "警察", "民警",
  "护士", "医生", "店员", "店主", "司机", "同事", "邻居", "小孩", "孩子", "老人",
  "男人", "女人", "同学", "保安", "前台", "播音员", "服务员", "摊主", "房东",
  "老板", "经理", "工人", "记者", "律师", "主持人", "乘客", "外卖员", "快递员",
  "母亲", "父亲", "录音笔", "录音", "电话", "广播", "手机", "电视", "监控", "广播员",
  // Military / admin / workplace extras observed in vertical-drama production:
  // guards, scouts, soldiers, clerks, servants, innkeepers and named-by-role
  // speakers that have no role card of their own.
  "暗哨", "暗哨队长", "暗哨领头", "被俘暗哨", "哨兵", "斥候", "斥候队长", "金军斥候队长",
  "巡逻兵", "运粮兵", "守船兵", "传令兵", "宋军什长", "金军什长", "金军副手", "元军副将",
  "元军将领", "监军", "小吏", "伙计", "掌柜", "老民夫", "民夫领头", "老军匠", "狱卒",
  "内鬼", "上线", "主使", "主脑代理人", "外围势力头目",
  "副将", "副手", "什长", "队长", "领头", "头目", "亲兵", "前哨", "士兵", "成员",
  "探子", "暗探", "细作", "黑影", "都统制", "都统", "统制", "校尉", "都尉", "尉",
  "stranger", "passerby", "customer", "crowd", "cop", "police", "nurse", "doctor",
  "clerk", "shopkeeper", "driver", "colleague", "neighbor", "kid", "child",
  "man", "woman", "classmate", "guard", "receptionist", "announcer", "waiter",
  "vendor", "landlord", "boss", "manager", "worker", "reporter", "lawyer", "host",
]);

/** Role-like CJK suffixes that identify descriptive labels rather than names. */
const FUNCTIONAL_ROLE_SUFFIX = /(?:人|员|生|师|客|者|甲|乙|丙|母|先生|女士|小姐|阿姨|大叔|大爷|大妈|警官|医生|护士|老板|经理|店员|司机|路人|顾客|乘客|记者|尉)$/u;

/**
 * Role words that mark a speaker as a functional label regardless of length
 * ("宋军什长", "暗哨队长"). Real character names do not carry these tokens,
 * so the invention guardrail still fires for named speakers. Book-specific
 * unit names from past production runs are deliberately NOT enumerated — the
 * token stems below already cover their suffixes, and a generic table must
 * not embed one book's factions.
 */
const FUNCTIONAL_ROLE_TOKEN = /(?:哨|卒|兵|长|将|官|吏|匠|役|丁|头目|队长|领头|亲兵|前哨|什长|监军|掌柜|伙计|内鬼|上线|主使|代理人|势力|斥候|巡逻|运粮|守船|传令|民夫|军匠|成员|手下|部下|随从|侍卫|护卫|近侍|宫女|丫鬟|仆人|衙役|捕快|仵作|师爷|幕僚|谋士|军师|医官|工匠|船工|纤夫|马夫|厨子|更夫|门房|家丁|管家|使女|狱卒|探子|暗探|细作|黑影|都统|统制|校尉|都尉|尉)/u;

/** Stage/source qualifiers writers attach to speakers (e.g. "主角（画外）"). */
const SPEAKER_QUALIFIER = /[（(][^）)]*[）)]/gu;
const SPEAKER_LEADING_MODIFIER = /^(?:年轻的|年老的|中年的|此时的|画面中的|记忆中的|录音中的|电话中的|门口的|窗外的|远处的|身后的)/u;

/**
 * Separators that may join multiple actors in a shared objective, e.g.
 * "苏挽 / 顾辞" or "主角与盟友". Each segment is resolved against the settings
 * index independently.
 */
const OBJECTIVE_CHARACTER_SEPARATOR = /[\/\\、，,和与及\+]/u;

/**
 * Behavior tokens extracted from shot action/visual text to form an
 * episode-level "behavior signature". Two episodes whose action beats reuse
 * the same tokens are doing the same stage business — a filler pattern that
 * the phrase n-gram check cannot see because the sentences differ.
 */
const ZH_BEHAVIOR_TOKENS = [
  "进入", "离开", "走出", "回到", "打开", "关上", "拿出", "放下", "取出", "递上", "接过",
  "检查", "查看", "翻看", "端详", "打量", "威胁", "警告", "逼近", "后退", "抓住", "按住",
  "跪下", "起身", "转身", "抬头", "低头", "沉默", "摇头", "点头", "攥紧", "捏", "拍", "敲",
  "扔", "撕", "烧", "捡", "扶", "坐下", "站起", "对视", "拦住", "推", "拽", "拔", "指",
  "吼", "压低", "挡住", "躲开", "冲到", "转身就走", "坐下", "翻出",
];
const EN_BEHAVIOR_TOKENS = [
  "enter", "leave", "return", "open", "close", "takes out", "put down", "hand",
  "receive", "check", "examine", "inspect", "threaten", "warn", "approach",
  "step back", "grab", "kneel", "stand up", "turn around", "look up", "look down",
  "silent", "shake", "nod", "clench", "toss", "tear", "burn", "pick up", "hold",
  "sit", "rise", "glance", "stare", "block", "push", "pull", "draw", "point",
  "shout", "whisper", "duck", "rush",
];

export function shotSurfaceText(script: EpisodeScript): string {
  return script.scenes.flatMap((scene) => scene.shots.flatMap((shot) => [
    shot.visual,
    shot.action ?? "",
    shot.narration ?? "",
    ...shot.dialogue.map((line) => line.text),
  ])).join("\n");
}

function behaviorSignature(script: EpisodeScript, language: "zh" | "en"): Set<string> {
  const tokens = language === "en" ? EN_BEHAVIOR_TOKENS : ZH_BEHAVIOR_TOKENS;
  const surface = shotSurfaceText(script).toLowerCase();
  const signature = new Set<string>();
  for (const token of tokens) {
    if (surface.includes(token)) signature.add(token);
  }
  return signature;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

/**
 * Deterministic cross-episode shot-fill detection (screenplay format). The
 * legacy free-text check (detectCrossEpisodeRepetition) is short-circuited for
 * screenplay output, and a 150s target invites the model to pad beats by
 * reusing the previous episode's stage business. Two signals are checked
 * against recent episodes:
 *
 *  1. shot-surface phrase repetition (zh 6-gram / en 3-word), reusing the
 *     legacy n-gram approach on the *shots* rather than the whole projection;
 *  2. behavior-signature overlap (Jaccard on extracted action tokens).
 *
 * Warning only — a shared location or one repeated beat can be legitimate.
 */
export function auditCrossEpisodeShotRepeat(
  current: EpisodeScript,
  previousScripts: ReadonlyArray<EpisodeScript>,
  language: "zh" | "en" = "zh",
): AuditIssue[] {
  if (previousScripts.length === 0) return [];
  const issues: AuditIssue[] = [];

  const currentSurface = shotSurfaceText(current);
  const repeatCounts = previousScripts.map((previous) => {
    const previousSurface = shotSurfaceText(previous);
    if (language === "en") {
      const words = currentSurface.toLowerCase().replace(/[^\w\s']/g, "").split(/\s+/).filter((w) => w.length > 2);
      const phrases = new Set<string>();
      for (let i = 0; i < words.length - 2; i += 1) {
        phrases.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
      }
      const previousLower = previousSurface.toLowerCase();
      let count = 0;
      for (const phrase of phrases) {
        if (previousLower.includes(phrase)) count += 1;
      }
      return count;
    }
    const chars = currentSurface.replace(/[\s\n\r]/g, "");
    const ngrams = new Set<string>();
    for (let i = 0; i < chars.length - 5; i += 1) {
      const ngram = chars.slice(i, i + 6);
      if (/^[\u4e00-\u9fff]{6}$/u.test(ngram)) ngrams.add(ngram);
    }
    const previousClean = previousSurface.replace(/[\s\n\r]/g, "");
    let count = 0;
    for (const ngram of ngrams) {
      if (previousClean.includes(ngram)) count += 1;
    }
    return count;
  });

  const worstRepeat = Math.max(...repeatCounts);
  if (worstRepeat >= 3) {
    issues.push({
      severity: "warning",
      category: language === "en" ? "cross-episode-shot-repeat" : "跨集镜头重复",
      repairScope: "structural",
      ruleClass: "reviewed_invariant",
      evidenceRefs: [
        `episode:${current.episode}:scenes[].shots[]`,
        `episode:${current.episode - 1}:scenes[].shots[]`,
      ],
      description: language === "en"
        ? `${worstRepeat} shot-surface phrases in this episode also appear in a recent episode — beats are being padded with the previous episode's shots.`
        : `本集有 ${worstRepeat} 个镜头表面短语与近期剧集重复——镜头正被上一集的旧镜头写法凑时长填充。`,
      suggestion: language === "en"
        ? "Rewrite the shots around new actions, props, or spatial positions; keep the episode's beats distinct from the previous one."
        : "重写镜头：换新的动作、道具或空间关系，让本集节拍与上一集明显不同。",
    });
  }

  const currentSignature = behaviorSignature(current, language);
  const overlaps = previousScripts.map((previous) => jaccard(currentSignature, behaviorSignature(previous, language)));
  const worstOverlap = Math.max(...overlaps);
  if (currentSignature.size >= 3 && worstOverlap >= 0.6) {
    issues.push({
      severity: "warning",
      category: language === "en" ? "episode-behavior-repeat" : "行为同构",
      repairScope: "structural",
      ruleClass: "reviewed_invariant",
      evidenceRefs: [
        `episode:${current.episode}:scenes[].shots[].action`,
        `episode:${current.episode - 1}:scenes[].shots[].action`,
      ],
      description: language === "en"
        ? `This episode's action beats share ${Math.round(worstOverlap * 100)}% of behavior tokens with a recent episode — the same stage business (${[...currentSignature].slice(0, 5).join(", ")}...) repeats.`
        : `本集动作节拍与近期剧集有 ${Math.round(worstOverlap * 100)}% 的行为词重合（${[...currentSignature].slice(0, 5).join("、")}…）——同一套动作/场景在重复。`,
      suggestion: language === "en"
        ? "Vary the stage business: different locations, props, confrontation geometry, or a character whose behavior flips — not the same sequence re-shot."
        : "换掉重复的舞台调度：换地点、换道具、换对峙几何，或让某个角色行为反转——不要用同一套动作换个镜头再拍一遍。",
    });
  }

  return issues;
}

// Emotion labels cannot direct performance. A delivery that names only a mood
// ("愤怒", "平静", "低声") gives the actor nothing to do; an executable
// delivery names the strategy ("试探", "逼问", "划界", "把威胁说成提醒").
const EMOTION_ONLY_DELIVERY = /^(?:愤怒|生气|激动|平静|冷静|冷漠|温柔|严肃|委屈|尴尬|得意|轻蔑|嘲讽|哽咽|颤抖|震惊|疑惑|害怕|恐惧|紧张|高兴|开心|伤心|难过|崩溃|不耐烦|无奈|苦笑|冷笑|淡淡|冷冷|缓缓|低声|轻声|大声|急促|失神|犹豫|坚定|坚决|迟疑|愤怒地|平静地|冷冷地|低声地|轻声地)[，。！？、\s]*$/u;

function stateBucketEquals(left: EpisodeStateBucket, right: EpisodeStateBucket): boolean {
  return STATE_KEYS.every((key) =>
    JSON.stringify(normalizeFacts(left[key])) === JSON.stringify(normalizeFacts(right[key])),
  );
}

function causalEvidence(script: EpisodeScript): string {
  return script.contract.causalEscalation
    .flatMap((step) => [step.becauseOf, step.choice, step.countermove, step.stateChange, step.nextPressure])
    .join(" ");
}

function episodeSurface(script: EpisodeScript): string {
  return script.scenes.flatMap((scene) => scene.shots.flatMap((shot) => [
    shot.visual,
    shot.action ?? "",
    shot.narration ?? "",
    shot.sound ?? "",
    ...shot.dialogue.map((line) => `${line.speaker} ${line.text}`),
  ])).join(" ").toLowerCase();
}

function hasSurfaceEvidence(value: string, surface: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  if (surface.includes(normalized)) return true;
  const english = normalized.match(/[a-z][a-z0-9'-]{2,}/g) ?? [];
  const hanChunks = normalized.match(/[\u4e00-\u9fff]{2,}/gu) ?? [];
  const han = hanChunks.flatMap((chunk) => {
    if (chunk.length <= 4) return [chunk];
    const terms: string[] = [];
    for (let size = 2; size <= Math.min(4, chunk.length); size += 1) {
      for (let index = 0; index + size <= chunk.length; index += 1) {
        terms.push(chunk.slice(index, index + size));
      }
    }
    return terms;
  });
  const terms = [...new Set([...english, ...han])];
  if (terms.length === 0) return false;
  const hits = terms.filter((term) => surface.includes(term)).length;
  if (english.length > 0) return hits >= Math.max(1, Math.ceil(Math.min(terms.length, 3) / 2));
  return hits >= Math.min(2, terms.length);
}

function auditContractSurfaceEvidence(script: EpisodeScript): AuditIssue[] {
  const surface = episodeSurface(script);
  const issues: AuditIssue[] = [];
  const check = (value: string, ref: string, label: string): void => {
    if (hasSurfaceEvidence(value, surface)) return;
    issues.push({
      severity: "warning",
      category: "contract-without-screen-evidence",
      repairScope: "structural",
      ruleClass: "reviewed_invariant",
      evidenceRefs: [ref, `episode:${script.episode}:scenes[].shots[]`],
      description: `${label} is declared in the episode contract but has no visible or audible carrier in the shots.`,
      suggestion: "Bind this commitment to a concrete action, dialogue, narration, sound, or visible state change.",
    });
  };
  for (const [index, step] of script.contract.causalEscalation.entries()) {
    check(step.choice, `episode:${script.episode}:contract.causalEscalation[${index}].choice`, "Causal choice");
    check(step.countermove, `episode:${script.episode}:contract.causalEscalation[${index}].countermove`, "Causal countermove");
    check(step.stateChange, `episode:${script.episode}:contract.causalEscalation[${index}].stateChange`, "Causal state change");
  }
  check(script.contract.localDramaticResult.stateChange, `episode:${script.episode}:contract.localDramaticResult.stateChange`, "Local dramatic result");
  check(script.contract.outgoingPressure.startedDecisionDangerOrQuestion, `episode:${script.episode}:contract.outgoingPressure.startedDecisionDangerOrQuestion`, "Outgoing pressure");
  // Handoff commitments are continuity boundaries, not creative choices: each
  // should have a visible carrier so the next episode's incoming state is not
  // a dangling promise. Only *screenable* handoff promises are checked: a
  // concrete physical object (玉/剑/卡/铃/信/丹/棺/灯…) that the contract says
  // exists but the shots never show. Cognitive knowledge, abstract power /
  // relationship shifts, and negative states ("无修为", "裂纹未新增") are
  // continuation notes for the planner, not promises that need a shot, and
  // would otherwise spam the audit.
  for (const [index, fact] of script.contract.handoffState.physical.slice(0, 4).entries()) {
    if (!isScreenableHandoffFact(fact)) continue;
    if (hasSurfaceEvidence(fact, surface)) continue;
    issues.push({
      severity: "warning",
      category: "contract-without-screen-evidence",
      repairScope: "structural",
      ruleClass: "reviewed_invariant",
      evidenceRefs: [`episode:${script.episode}:contract.handoffState.physical[${index}]`, `episode:${script.episode}:scenes[].shots[]`],
      description: `Handoff physical fact "${fact.slice(0, 40)}" is declared in the episode contract but has no visible or audible carrier in the shots.`,
      suggestion: "Either show this object on screen this episode, or keep it in incoming state carried from an earlier episode.",
    });
  }
  return issues;
}

/**
 * A handoff physical fact qualifies for the on-screen check only when it names
 * a concrete prop or location and is not a negative/abstract state. "裂纹未增"
 * and "他在门外" are states, not promises; "他掌心多了一张实体卡片" is a
 * promise that must be shown.
 */
const HANDOFF_PROP_WORDS = /(?:玉|剑|卡|铃|信|遗书|丹|棺|灯|面具|符|镜|舟|印|珠|塔|门|渊|崖|冢|城|宫)/u;
function isScreenableHandoffFact(fact: string): boolean {
  if (fact.length < 4 || fact.length > 48) return false;
  if (!HANDOFF_PROP_WORDS.test(fact)) return false;
  // Negative / zero states cannot be shown as a beat.
  if (/(?:无|未|没有|尚未|还未|仍未|不|维持|归零|见底|未复|耗尽)/u.test(fact)) return false;
  // Cognitive / volitional phrasing is a mental state, not a screen event.
  if (/(?:知道|确认|掌握|认为|决定|打算|意识到|记得|怀疑|清楚|明白|拥有|失去|获得|保有|握着|带着|揣着|藏着|转为|主动权|话语权|隐瞒|消耗|张力|只剩|关联)/u.test(fact)) return false;
  return true;
}

/**
 * Deterministic early-payoff guard. Each ledger hook records an intended
 * payoff episode (e.g. "第29集"). If the current episode is *before* that
 * payoff and its shots already surface the hook's named facts, the reveal was
 * consumed early — the exact failure mode observed across paid production
 * runs (e.g. a tomb that was scheduled for episode 29 appearing at episode 6).
 *
 * Warning severity on purpose: a named mention can be legitimate setup, and the
 * heuristic keys on explicit nouns, so we flag rather than block.
 */
export function auditEarlyHookPayoff(
  script: EpisodeScript,
  hooks: ReadonlyArray<{
    readonly hookId: string;
    readonly expectedPayoff?: string;
    readonly targetPayoffEpisode?: number;
    readonly notes?: string;
    readonly audienceQuestion?: string;
    readonly payoffEvidence?: ReadonlyArray<string>;
  }>,
): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const surface = episodeSurface(script);
  for (const hook of hooks) {
    // Never infer a production blocker from free-form prose. Legacy hooks are
    // still eligible for a soft diagnostic, but only an explicit lifecycle
    // target plus terminal evidence represents a deterministic promise.
    const payoffEpisode = hook.targetPayoffEpisode;
    if (!payoffEpisode || script.episode >= payoffEpisode) continue;
    const keywords = hook.payoffEvidence?.map((value) => value.trim()).filter(Boolean) ?? [];
    if (keywords.length === 0) continue;
    const hits = keywords.filter((keyword) => surface.includes(keyword));
    if (hits.length !== keywords.length) continue;
    issues.push({
      severity: "critical",
      category: "early-hook-payoff",
      repairScope: "structural",
      ruleClass: "reviewed_invariant",
      evidenceRefs: [
        `hooks:${hook.hookId}`,
        `episode:${script.episode}:scenes[].shots[]`,
      ],
      description: `Hook ${hook.hookId} is scheduled to pay off at episode ${payoffEpisode}, but its terminal evidence (${hits.join("、")}) already appears on screen in episode ${script.episode}.`,
      suggestion: "Move the terminal evidence to the scheduled episode, or formally revise the hook lifecycle before publishing this episode.",
    });
  }
  return issues;
}

function hasWithholdingOnlyResult(text: string): boolean {
  return /(马上|即将|究竟|将要|待揭晓|下集|soon|about to|who is|to be revealed)/iu.test(text)
    && !/(得到|失去|确认|拒绝|公开|改变|完成|失败|暴露|付出|gains?|loses?|confirms?|refuses?|reveals?|changes?|fails?)/iu.test(text);
}

function compareHandoff(previous: EpisodeScript, current: EpisodeScript): AuditIssue[] {
  const issues: AuditIssue[] = [];
  for (const key of STATE_KEYS) {
    const expected = normalizeFacts(previous.contract.handoffState[key]);
    const actual = normalizeFacts(current.contract.incomingState[key]);
    if (expected.length === 0 && actual.length === 0) continue;
    const missing = expected.filter((fact) => !factEquivalent(fact, actual));
    if (missing.length === 0) continue;
    issues.push({
      severity: "critical",
      category: "handoff-state-mismatch",
      repairScope: "structural",
      ruleClass: "structural_invariant",
      evidenceRefs: [`episode:${previous.episode}:contract.handoffState.${key}`, `episode:${current.episode}:contract.incomingState.${key}`],
      description: `Episode ${current.episode} incoming ${key} does not match episode ${previous.episode} handoff state.`,
      suggestion: "Carry the previous episode's exact handoff facts into the next incoming state or record the intervening event explicitly.",
    });
  }

  const evidence = causalEvidence(current);
  for (const previousPermission of previous.contract.informationPermissions) {
    const currentPermission = current.contract.informationPermissions.find(
      (permission) => permission.subject === previousPermission.subject,
    );
    if (!currentPermission) continue;
    for (const fact of previousPermission.unknown) {
      if (!currentPermission.known.includes(fact) || evidence.includes(fact)) continue;
      issues.push({
        severity: "critical",
        category: "information-permission-leak",
        repairScope: "structural",
        ruleClass: "reviewed_invariant",
        evidenceRefs: [`episode:${previous.episode}:contract.informationPermissions`, `episode:${current.episode}:contract.informationPermissions`],
        description: `${fact} becomes known in episode ${current.episode} without a causal evidence carrier.`,
        suggestion: "Add the visible action, evidence, dialogue, or consequence that grants this knowledge, or keep the fact unknown.",
      });
    }
  }
  return issues;
}

export function auditEpisodeScript(
  script: EpisodeScript,
  previousScript?: EpisodeScript,
  targetDurationSeconds = EPISODE_DURATION_TARGET_SECONDS,
  settingsIndex?: SettingsEntityIndex,
  recentScripts?: ReadonlyArray<EpisodeScript>,
  language: "zh" | "en" = "zh",
): AuditIssue[] {
  const issues: AuditIssue[] = [];

  // Cross-episode shot-fill check (screenplay format): the legacy free-text
  // repetition check is short-circuited for screenplay output, so the only
  // deterministic guard against reusing the previous episode's stage business
  // lives here.
  if (recentScripts && recentScripts.length > 0) {
    issues.push(...auditCrossEpisodeShotRepeat(script, recentScripts, language));
  }
  const metrics = measureEpisodeScript(script, targetDurationSeconds);
  const { softMin, softMax } = episodeSoftDurationRange(targetDurationSeconds);

  if (
    metrics.estimatedDurationSeconds < EPISODE_DURATION_HARD_MIN_SECONDS
    || metrics.estimatedDurationSeconds > EPISODE_DURATION_HARD_MAX_SECONDS
  ) {
    issues.push({
      severity: "critical",
      category: "screenplay-duration",
      repairScope: "structural",
      ruleClass: "structural_invariant",
      evidenceRefs: [`episode:${script.episode}:shots.durationSeconds`],
      description: `Estimated duration ${metrics.estimatedDurationSeconds}s is outside the hard ${EPISODE_DURATION_HARD_MIN_SECONDS}-${EPISODE_DURATION_HARD_MAX_SECONDS}s range.`,
      suggestion: "Adjust shot durations and dialogue density while preserving the episode turn.",
    });
  } else if (metrics.durationWarnings.length > 0) {
    issues.push({
      severity: "warning",
      category: "screenplay-duration",
      repairScope: "structural",
      ruleClass: "craft_default",
      evidenceRefs: [`episode:${script.episode}:shots.durationSeconds`],
      description: `Estimated duration ${metrics.estimatedDurationSeconds}s is outside the preferred ${softMin}-${softMax}s range.`,
      suggestion: `Move the episode closer to the ${targetDurationSeconds}-second target.`,
    });
  }

  const shotBudget = episodeShotBudget(targetDurationSeconds);
  if (metrics.shotCount > shotBudget.softMax) {
    issues.push({
      severity: "warning",
      category: "screenplay-shot-count",
      repairScope: "structural",
      ruleClass: "craft_default",
      evidenceRefs: [`episode:${script.episode}:scenes.shots`],
      description: `Shot count ${metrics.shotCount} exceeds the soft budget of ${shotBudget.min}-${shotBudget.softMax} shots for a ${targetDurationSeconds}s episode.`,
      suggestion: "Merge or trim low-information shots; the episode is not rejected for exceeding the soft cap.",
    });
  }

  if (!hasConcreteAudienceQuestion(script.emotionalHook)) {
    issues.push({
      severity: "critical",
      category: "emotional-hook",
      // A single top-level field: the local patch applier can rewrite it
      // without a full screenplay rewrite, so classify it as locally fixable.
      repairScope: "local",
      ruleClass: "structural_invariant",
      evidenceRefs: [`episode:${script.episode}:emotionalHook`],
      description: "The ending emotional hook is not phrased as a concrete audience question.",
      suggestion: "End on a specific relationship, danger, identity, sacrifice, or choice question.",
    });
  }

  if (script.contract.causalEscalation.length === 0 || script.reversal.trim().length < 12) {
    issues.push({
      severity: "critical",
      category: "unprepared-reversal",
      repairScope: "structural",
      ruleClass: "reviewed_invariant",
      evidenceRefs: [`episode:${script.episode}:contract.causalEscalation`],
      description: "The reversal is not anchored to a concrete cause → choice → countermove → state change → next pressure chain.",
      suggestion: "Add the established cause, visible choice, countermove, changed state and resulting pressure.",
    });
  }

  if (script.contract.localDramaticResult.stateChange.trim().length < 6
    || hasWithholdingOnlyResult(script.contract.localDramaticResult.stateChange)) {
    issues.push({
      severity: "critical",
      category: "missing-local-payoff",
      repairScope: "structural",
      ruleClass: "reviewed_invariant",
      evidenceRefs: [`episode:${script.episode}:contract.localDramaticResult`],
      description: "The episode does not land a concrete local dramatic result before its outgoing pressure.",
      suggestion: "State what the protagonist gains, loses, proves, refuses, completes, or irreversibly changes in this episode.",
    });
  }

  if (script.contract.localDramaticResult.costPaid.trim().length < 4) {
    issues.push({
      severity: "critical",
      category: "reversal-without-consequence",
      repairScope: "structural",
      ruleClass: "reviewed_invariant",
      evidenceRefs: [`episode:${script.episode}:contract.localDramaticResult.costPaid`],
      description: "The episode result does not record a concrete cost or consequence.",
      suggestion: "Make the turn cost information, power, trust, safety, time, resources, or a protected relationship.",
    });
  }

  if (script.contract.outgoingPressure.startedDecisionDangerOrQuestion.trim().length < 6
    || script.contract.outgoingPressure.whyItFollows.trim().length < 6) {
    issues.push({
      severity: "critical",
      category: "missing-outgoing-pressure",
      repairScope: "structural",
      ruleClass: "reviewed_invariant",
      evidenceRefs: [`episode:${script.episode}:contract.outgoingPressure`],
      description: "The outgoing pressure is missing or is not caused by this episode's result.",
      suggestion: "Start a specific decision, danger, or question and state why it follows from the local result.",
    });
  }

  if (script.openingHook.trim().length < 6) {
    issues.push({
      severity: "critical",
      category: "opening-hook",
      repairScope: "structural",
      ruleClass: "structural_invariant",
      evidenceRefs: [`episode:${script.episode}:openingHook`],
      description: "The opening hook is too vague to define a visible first 3-5 seconds.",
      suggestion: "Specify a concrete visual anomaly, threat, confrontation, or irreversible action.",
    });
  }

  if (script.endState.trim().length < 8) {
    issues.push({
      severity: "critical",
      category: "episode-state-change",
      repairScope: "structural",
      ruleClass: "reviewed_invariant",
      evidenceRefs: [`episode:${script.episode}:endState`],
      description: "The episode end state does not describe an observable irreversible change.",
      suggestion: "State what changed in the relationship, information, power, or survival situation.",
    });
  }

  if (stateBucketEquals(script.contract.incomingState, script.contract.handoffState)) {
    issues.push({
      severity: "critical",
      category: "stagnant-episode",
      repairScope: "structural",
      ruleClass: "reviewed_invariant",
      evidenceRefs: [`episode:${script.episode}:contract.incomingState`, `episode:${script.episode}:contract.handoffState`],
      description: "The episode exits with the same structured state it entered with.",
      suggestion: "Change at least one knowledge, power, relationship, physical, active-action, or emotional-decision fact.",
    });
  }

  for (const scene of script.scenes) {
    const hasDramaticCarrier = scene.shots.some((shot) =>
      Boolean(shot.action?.trim() || shot.dialogue.length > 0 || shot.narration?.trim() || shot.sound?.trim()),
    );
    if (hasDramaticCarrier) continue;
    issues.push({
      severity: "critical",
      category: "scene-without-dramatic-result",
      repairScope: "structural",
      ruleClass: "reviewed_invariant",
      evidenceRefs: [`episode:${script.episode}:scene:${scene.id}`],
      description: `${scene.id} contains images but no action, dialogue, narration, or sound that changes the situation.`,
      suggestion: "Give the scene an observable agenda collision, turn, and exit result, or merge it into another scene.",
    });
  }

  for (const scene of script.scenes) {
    for (const shot of scene.shots) {
      for (const line of shot.dialogue) {
        if (line.text.length > 80) {
          issues.push({
            severity: "warning",
            category: "dialogue-length",
            repairScope: "local",
            ruleClass: "craft_default",
            evidenceRefs: [`episode:${script.episode}:shot:${shot.id}:dialogue`],
            description: `${shot.id} contains a dialogue line longer than 80 characters.`,
            suggestion: "Split the line across actions or remove explanatory dialogue.",
          });
        }
      }
    }
  }

  // SCR-09 approximation: a long uninterrupted speech only earns its length
  // when an action beat breaks it at an agenda turn. The deterministic layer
  // can only detect the shallow signal — one speaker talking at length in a
  // shot with no action carrier. Whether an internal turn truly exists stays
  // with the auditor (reviewed_invariant), so this never blocks.
  for (const scene of script.scenes) {
    for (const shot of scene.shots) {
      if (shot.action?.trim()) continue;
      const speakerTotals = new Map<string, number>();
      for (const line of shot.dialogue) {
        const speaker = line.speaker.trim();
        if (!speaker) continue;
        speakerTotals.set(speaker, (speakerTotals.get(speaker) ?? 0) + line.text.length);
      }
      for (const [speaker, totalLength] of speakerTotals) {
        if (totalLength <= 160) continue;
        issues.push({
          severity: "warning",
          category: "long-speech-without-action",
          repairScope: "local",
          ruleClass: "craft_default",
          evidenceRefs: [`episode:${script.episode}:shot:${shot.id}:dialogue`],
          description: `${shot.id} lets ${speaker} speak ${totalLength} characters with no action beat in the shot.`,
          suggestion: "Break the speech with an action line at an agenda turn, or shorten it — an unbroken long speech without an internal turn should be compressed, not split.",
        });
      }
    }
  }

  for (const scene of script.scenes) {
    for (const shot of scene.shots) {
      for (const line of shot.dialogue) {
        const delivery = line.delivery?.trim() ?? "";
        if (delivery && EMOTION_ONLY_DELIVERY.test(delivery)) {
          issues.push({
            severity: "warning",
            category: "delivery-emotion-word",
            repairScope: "local",
            ruleClass: "craft_default",
            evidenceRefs: [`episode:${script.episode}:shot:${shot.id}:dialogue.delivery`],
            description: `${shot.id} delivery "${delivery}" names an emotion/mood, which cannot direct performance.`,
            suggestion: "Replace it with an executable strategy (probing, pressuring, redrawing a boundary, stating a threat as a reminder, keeping a third party from hearing, dropping the explanation, using a first name for the first time).",
          });
        }
      }
    }
  }

  // Reference integrity: only enforced when the book actually has a settings
  // index (role cards or character/org canon claims). Empty books skip so
  // legacy/fixture projects without settings are not blocked.
  if (settingsIndex && settingsIndex.characterNames.size > 0) {
    const unknownSpeakers = new Set<string>();
    for (const scene of script.scenes) {
      for (const shot of scene.shots) {
        for (const line of shot.dialogue) {
          const speaker = line.speaker
            .trim()
            .replace(SPEAKER_QUALIFIER, "")
            .replace(SPEAKER_LEADING_MODIFIER, "")
            .trim();
          if (!speaker || NARRATION_SPEAKERS.has(speaker.toLowerCase())) continue;
          if (settingsIndex.characterNames.has(speaker)) continue;
          // Speakers established by earlier persisted episodes are no longer
          // inventions; only their first appearance is flagged.
          if (settingsIndex.episodeSeenSpeakers?.has(speaker)) continue;
          if (FUNCTIONAL_ROLE_SPEAKERS.has(speaker)
            || FUNCTIONAL_ROLE_TOKEN.test(speaker)
            || (speaker.length <= 4 && FUNCTIONAL_ROLE_SUFFIX.test(speaker))) continue;
          unknownSpeakers.add(speaker);
        }
      }
    }
    for (const speaker of [...unknownSpeakers].sort()) {
      issues.push({
        severity: "warning",
        category: "unknown-character-reference",
        repairScope: "structural",
        ruleClass: "reviewed_invariant",
        evidenceRefs: [`episode:${script.episode}:dialogue.speaker:${speaker}`],
        description: `Speaker "${speaker}" has no matching character in the settings index (roles/ or canon claims).`,
        suggestion: "Register the character in roles/ or reuse an existing name so settings stay authoritative.",
      });
    }

    const protagonist = script.contract.objective.character.trim();
    if (protagonist
      && !NARRATION_SPEAKERS.has(protagonist.toLowerCase())) {
      // Multi-character objectives are legitimate: "苏挽 / 顾辞" or "主角与盟友"
      // name more than one actor. Any single named segment that resolves to the
      // settings index is enough — do not flag a shared goal as an invented
      // character just because it was written as a compound.
      const protagonistNames = protagonist
        .split(OBJECTIVE_CHARACTER_SEPARATOR)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      const known = protagonistNames.some((part) => settingsIndex.characterNames.has(part));
      if (!known) {
        issues.push({
          severity: "critical",
          category: "unknown-character-reference",
          repairScope: "structural",
          ruleClass: "reviewed_invariant",
          evidenceRefs: [`episode:${script.episode}:contract.objective.character`],
          description: `Episode objective names "${protagonist}", which has no matching character in the settings index.`,
          suggestion: "Bind the episode to an existing character in roles/ or canon claims.",
        });
      }
    }
  }

  if (previousScript) issues.push(...compareHandoff(previousScript, script));
  issues.push(...auditContractSurfaceEvidence(script));
  issues.push(...auditEpisodeToolDiagnostics(script, previousScript));

  return issues;
}
