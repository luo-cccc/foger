import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  Api,
} from "@mariozechner/pi-ai";
import type { LLMMessage, LLMResponse } from "../llm/provider.js";
import { buildFoundationScalePlan } from "../utils/foundation-scale.js";

export function isLlmStubEnabled(): boolean {
  return Boolean(process.env.INKOS_AGENT_LLM_STUB);
}

// Mirrors EMPTY_USAGE in agent-session.ts exactly.
const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function lastUserText(context: { messages?: Array<{ role: string; content: unknown }> }): string {
  const msgs = context.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const message = msgs[i];
    if (message.role === "user") {
      return typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content);
    }
  }
  return "";
}

function alreadyProposed(
  context: { messages?: Array<{ role: string; content: unknown; toolName?: string }> },
): boolean {
  return (context.messages ?? []).some((message) => {
    if (message.role === "toolResult" && message.toolName === "propose_action") {
      return true;
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
      return message.content.some(
        (chunk): chunk is { type: string; name?: string } =>
          Boolean(chunk)
          && typeof chunk === "object"
          && "type" in chunk
          && (chunk as { type?: string }).type === "toolCall"
          && (chunk as { name?: string }).name === "propose_action",
      );
    }
    if (message.role === "user" && typeof message.content === "string") {
      return /- propose_action \(/.test(message.content);
    }
    return false;
  });
}

/**
 * Returns a deterministic AssistantMessageEventStream that either emits a
 * propose_action toolCall (when the latest user text mentions
 * "structure/outline/schema" and propose_action hasn't run yet) or a plain
 * acknowledgement reply.
 */
export function stubAgentStream(model: Model<Api>, context: unknown): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const text = lastUserText(context as { messages?: Array<{ role: string; content: unknown }> });
  const proposed = alreadyProposed(
    context as { messages?: Array<{ role: string; content: unknown; toolName?: string }> },
  );
  const wantStructure = !proposed && /structure|outline|schema/i.test(text);

  const content = wantStructure
    ? [
        {
          type: "toolCall" as const,
          id: "stub-draft",
          name: "propose_action",
          arguments: {
            action: "draft_structure",
            title: "Draft structure",
            summary: "Create a simple three-act branching outline.",
            instruction: "Draft a three-act branching structure.",
            draftStructure: { instruction: "Three-act branching structure" },
          },
        },
      ]
    : [{ type: "text" as const, text: "OK." }];

  const stopReason = wantStructure ? ("toolUse" as const) : ("stop" as const);

  const message: AssistantMessage = {
    role: "assistant",
    content: content as AssistantMessage["content"],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE as AssistantMessage["usage"],
    stopReason,
    timestamp: Date.now(),
  };

  queueMicrotask(() => {
    stream.push({ type: "done", reason: stopReason, message });
    stream.end(message);
  });

  return stream;
}

const STRUCTURE_JSON = JSON.stringify({
  nodes: [
    {
      id: "s",
      type: "start",
      title: "Opening",
      sceneDesc: "Temple gate at dusk.",
      choices: [{ id: "c1", text: "Inspect the account book", targetNodeId: "b" }],
    },
    {
      id: "b",
      type: "branch",
      title: "Choice",
      sceneDesc: "Clerk's room",
      choices: [
        { id: "c2", text: "Reveal the truth", targetNodeId: "e1" },
        { id: "c3", text: "Hide the evidence", targetNodeId: "e2" },
      ],
    },
    { id: "e1", type: "ending", title: "Truth", choices: [] },
    { id: "e2", type: "ending", title: "Fall", choices: [] },
  ],
});

const NODE_JSON = JSON.stringify({
  type: "branch",
  title: "Night scene",
  sceneDesc: "Rain over the alley.",
  dialogue: [{ speaker: "A-Mei", text: "The ledger cannot be wrong.", emotion: "steady" }],
  choices: [],
});

const EPISODE_MEMO = [
  "# 第 1 章 memo",
  "",
  "## 本章目标",
  "拿到旧账篡改物证并锁定师父失踪的追查方向",
  "",
  "## 关联线索",
  "- mentor-ledger",
  "- forged-notices",
  "- courier-network",
  "",
  "## 卷级 KR 绑定",
  "- 绑定：V1-KR1",
  "- 推进方式：林越拿到烧焦账页与裂开铅封，旧账篡改从传闻变成可验证物证，KR1 前进一步。",
  "",
  "## 当前任务",
  "林越在码头找到烧焦账页与裂开铅封，把师父失踪从猜测推进成可验证的旧账篡改线索。",
  "",
  "## 本集爽点",
  "林越拿到可验证物证，并让乔心在公开压力下表明立场。",
  "",
  "## 进入状态",
  "林越知道账页被烧毁，乔心掌握行会封条和举报权；林越在雨夜码头寻找账页上的地址。",
  "",
  "## 当前目标",
  "林越要取得物证并迫使乔心表态，因为行会封锁将在天亮前完成。",
  "",
  "## 反对力量",
  "乔心与行会伙计要夺回账页，筹码是封条、举报权和人数优势。",
  "",
  "## 因果升级",
  "因为烧焦账页露出带血印记，林越拨出铅封并藏起账页；伙计封住仓门，乔心亮出行会封条；物证被确认且乔心被迫对立；林越必须在天亮前决定是否公开地址。",
  "",
  "## 关系压力",
  "林越与乔心从互相利用转为被迫对立；乔心掌握先手举报权，林越隐瞒地址。",
  "",
  "## 方向性转折",
  "林越从暗中取证转为公开逼问乔心，前置证据迫使他放弃继续潜伏。",
  "",
  "## 反转铺垫",
  "观众以为乔心会暗中帮助林越；她早先避开巡夜人的目光，暗示她另有行会约束。",
  "",
  "## 本集反转",
  "乔心亮出行会封条，揭示她已被迫成为监视者。",
  "",
  "## 反转后果",
  "林越失去唯一安全退路，乔心获得公开举报的先手。",
  "",
  "## 当集兑现",
  "林越拿到半张清单和裂开铅封，确认旧账被篡改；代价是匿名保护失效。",
  "",
  "## 出去压力",
  "天亮前会启动公开举报；这是封条被折断、乔心被迫选边直接产生的后果。",
  "",
  "## 结尾交接状态",
  "林越带伤持有账页和断裂封条，知道地址藏在封条内；乔心拥有举报先手，两人必须在天亮前决定是否公开。",
  "",
  "## 信息权限",
  "林越和观众知道地址载体；乔心只怀疑账页仍有秘密；伙计误以为账页留在仓门内；债务人的最终身份未知。",
  "",
  "## 情绪钩子",
  "乔心会真的举报林越，还是在等他先交出地址？",
  "",
  "## 结尾状态",
  "林越持有物证，乔心从旁观者变成被迫对立者，追查进入公开风险阶段。",
  "",
  "## 本集 Hook ledger",
  "open:",
  "- 无",
  "advance:",
  "- mentor-ledger \"烧毁账本\" → 林越拿到烧焦账页和裂开铅封",
  "resolve:",
  "- 无",
  "defer:",
  "- forged-notices \"伪造债务通知\" → 本集只确认旧账异常，暂不揭示系统规模",
  "- courier-network \"信使网络\" → 乔心只提供单次线索，后续再推进证人网络",
  "",
  "## 不要做",
  "- 不要直接揭示师父失踪的幕后主使。",
  "- 不要用巧合或作者总结替代物证和角色行动。",
].join("\n");

const FOUNDATION_SECTIONS = [
  "=== SECTION: story_frame ===",
  [
    "# Story Frame",
    "",
    "## 01 Theme and tonal ground",
    "This novel follows Lin Yue, a dockside clerk dragged back into a debt ledger conspiracy after his mentor disappears. The core theme is whether a person can keep a promise without becoming another cog in the system that forged that promise. The tone stays tense, street-level, and intimate: every major turn should feel like a choice made under pressure, not a fate delivered from above.",
    "",
    "## 02 Foreground and background story",
    "The foreground story is a practical investigation: Lin Yue must recover a burned ledger, decode who altered the debt records, and survive the factions using the harbor economy as a weapon. The background story is a buried civic fraud network that has been rewriting obligation, loyalty, and legal identity for years. Each visible clue should point back to that deeper machine, so the book keeps both scene-level urgency and long-range pull.",
    "",
    "## 03 World rules and texture",
    "Debt seals can only bind what the signer truly accepts, forged seals crack under close verification, and erased names always leave a trace somewhere in the archive chain. The city runs on damp alleys, cargo manifests, whispered favors, and public rules that hide private leverage. Information should move through receipts, ledgers, witnesses, and broken routines rather than prophecy or coincidence.",
    "",
    "## 04 Endgame objective",
    "The endgame should leave Lin Yue standing in public with proof that the harbor syndicate falsified its debt records, his mentor's disappearance fully explained, and the surviving victims able to reclaim their names. Book Objective: Lin Yue must expose the forged-ledger system and force the city to recognize the hidden debt victims before the syndicate erases them for good.",
  ].join("\n"),
  "",
  "=== SECTION: volume_map ===",
  [
    "# Volume Map",
    "",
    "## Volume 1 (Episodes 1-4)",
    "Lin Yue is forced back into the dock ledger world when a burned fragment tied to his missing mentor resurfaces. The emotional shape is suspicion to reluctant commitment: he wants distance, then realizes distance is exactly what the conspiracy counts on. Volume 1 should end with proof that the fraud is institutional rather than personal.",
    "",
    "## Volume 2 (Episodes 5-8)",
    "The investigation widens from the docks into clerks, brokers, and household debts that were reassigned by design. Lin Yue gains allies but each alliance carries a cost, so momentum comes from hard-earned access instead of lucky reveals. Volume 2 should end with a betrayal that exposes how near the fraud has always been to his own life.",
    "",
    "## Volume 3 (Episodes 9-12)",
    "Once the syndicate knows Lin Yue can prove the pattern, the conflict turns openly coercive. The final movement should force him to choose between private safety and public testimony, with allies taking different risks for different reasons. The closing payoff is not just defeating a villain but making hidden victims legible again.",
    "",
    "## Hook and payoff map",
    "The harbor ledger fragment pays off the mentor trail, the forged debt notices pay off the system-level conspiracy, and the witness network pays off the possibility of public reversal. Every volume should close one practical loop while opening a larger moral cost, so foreground progress keeps feeding the background machine.",
    "",
    "## Rhythm principles",
    "Lead with action before explanation, let each reveal change the next decision immediately, and avoid repeating the same suspicion beat without new leverage. Scenes should alternate between pressure, verification, and consequence so the story feels like tightening gears instead of decorative wandering.",
  ].join("\n"),
  "",
  "=== SECTION: roles ===",
  [
    "---ROLE---",
    "tier: major",
    "name: Lin Yue",
    "---CONTENT---",
    [
      "# Lin Yue",
      "",
      "## Core",
      "A meticulous dock clerk who trusts records more than rhetoric because records once saved his family from a false claim. He appears cold, but the coldness is defensive discipline rather than indifference.",
      "",
      "## Arc",
      "Lin Yue begins as someone who wants a clean, private life built on staying useful and staying unnoticed. He ends as someone willing to stand in public, attach his own name to dangerous truth, and accept that justice requires visible cost. The irreversible price is that he loses the safety of anonymity and cannot return to being merely a survivor inside the system.",
      "",
      "## Current_State",
      "At episode 0 he still works near the harbor ledgers, keeps a half-burned seal from his missing mentor, and is trying not to be pulled back into old obligations.",
    ].join("\n"),
    "",
    "---ROLE---",
    "tier: major",
    "name: Qiao Xin",
    "---CONTENT---",
    [
      "# Qiao Xin",
      "",
      "## Core",
      "A courier who knows which messages were delayed, redirected, or paid to disappear. She is quick, observant, and allergic to institutions that pretend neutrality while selling access.",
      "",
      "## Current_State",
      "At episode 0 she is moving information for cash, but she has already seen enough doctored notices to suspect the harbor books are being manipulated at scale.",
    ].join("\n"),
    "",
    "---ROLE---",
    "tier: minor",
    "name: Steward Han",
    "---CONTENT---",
    [
      "# Steward Han",
      "",
      "## Core",
      "A polished administrator who presents fraud as administrative necessity. He is the face of orderly compromise and the clearest embodiment of the system's moral decay.",
      "",
      "## Current_State",
      "At episode 0 he believes the archive chain is secure and that frightened clerks will keep obeying as long as the books look official.",
    ].join("\n"),
  ].join("\n"),
  "",
  "=== SECTION: book_rules ===",
  [
    "# Book Rules",
    "",
    "## Narrative rules",
    "- Keep the story in close third person anchored to the active scene.",
    "- Reveal major facts through evidence, testimony, or consequence, not omniscient summary.",
    "- Every episode should advance either proof, pressure, or trust.",
    "",
    "## Guardrails",
    "- Do not solve conflicts with sudden power upgrades or external rescues.",
    "- Keep the harbor economy concrete: manifests, debts, seals, witnesses, and paper trails matter.",
    "- Preserve a noir-leaning, high-pressure tone even in quieter episodes.",
  ].join("\n"),
  "",
  "=== SECTION: pending_hooks ===",
  [
    "# Pending Hooks",
    "",
    "| hook_id | start_episode | type | status | last_advanced_episode | expected_payoff | payoff_timing | depends_on | pays_off_in_arc | core_hook | half_life | notes |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    "| mentor-ledger | 0 | mystery | open | 0 | Explain why Lin Yue's mentor vanished after hiding the burned ledger. | Volume 2 reveal | none | volume-2 | yes | 4 | Seed clue carried by the half-burned seal. |",
    "| forged-notices | 0 | conspiracy | open | 0 | Prove the harbor debt notices were altered by design, not clerical accident. | Volume 3 public proof | mentor-ledger | volume-3 | yes | 5 | Main structural fraud thread. |",
    "| courier-network | 0 | alliance | open | 0 | Turn the whisper network into admissible witness testimony. | Volume 3 climax | forged-notices | volume-3 | no | 3 | Qiao Xin is the bridge between rumor and proof. |",
  ].join("\n"),
].join("\n");

function renderStubFoundation(prompt: string): string {
  const targetEpisodes = extractTargetEpisodes(prompt);
  const plan = buildFoundationScalePlan(
    targetEpisodes,
    /(?:目标集数|episode duration|100-episode|漫剧)/iu.test(prompt) ? { unit: "episodes" } : {},
  );
  const volumeMap = [
    "# Volume Map",
    "",
    ...plan.ranges.flatMap((range) => {
      const finalVolume = range.volume === plan.volumeCount;
      return [
        `## Volume ${range.volume} (Episodes ${range.startEpisode}-${range.endEpisode})`,
        `Objective: ${finalVolume
          ? "Complete the forged-ledger investigation, expose the harbor syndicate with public evidence, and resolve the Book Objective."
          : "Advance the forged-ledger investigation from private suspicion to verified evidence while increasing institutional pressure."}`,
        "KR1: Secure a new piece of physical ledger evidence whose origin can be independently verified.",
        "KR2: Turn one reluctant contact into an active witness who changes the investigation's available choices.",
        `KR3: ${finalVolume
          ? "Present the complete evidence chain publicly and restore the hidden debt victims' names."
          : "Prove that the fraud reaches beyond one clerk and identify the next institutional layer."}`,
        `Irreversible Event: ${finalVolume
          ? "Lin Yue attaches his own name to the public testimony and permanently loses the safety of anonymity."
          : "Lin Yue preserves evidence the syndicate cannot quietly erase, making withdrawal impossible."}`,
        "Protagonist Stage Goal: Move from defensive survival toward accountable public action.",
        "Foreground Goal: Trace the burned ledger through manifests, seals, witnesses, and consequences.",
        "Background Thread: Reveal how the harbor system rewrites obligation and legal identity.",
        "",
      ];
    }),
    ...(plan.compact ? [
      "### Compact Episode Beat Contract",
      ...Array.from({ length: plan.targetEpisodes }, (_, index) => (
        `Episode ${index + 1}: Goal=Advance investigation action ${index + 1} | Obstacle=Confront concrete resistance ${index + 1} | Turn=Gain decision-changing evidence ${index + 1} | Delivery=Complete observable result ${index + 1} | End Hook=${index + 1 === plan.targetEpisodes ? "Close with irreversible public aftermath" : `Causally launch episode ${index + 2}`}`
      )),
      "",
    ] : []),
    "## Hook and payoff map",
    "The harbor ledger fragment pays off the mentor trail, the forged debt notices pay off the system-level conspiracy, and the witness network pays off the possibility of public reversal. Each planned volume closes one practical loop while increasing the moral cost of the next decision.",
    "",
    "## Rhythm principles",
    "Lead with action before explanation, let each reveal change the next decision immediately, and alternate pressure, verification, and consequence instead of repeating suspicion without new leverage.",
  ].join("\n");

  const lastVolume = plan.volumeCount;
  return FOUNDATION_SECTIONS
    .replace(
      /(=== SECTION: volume_map ===\n)[\s\S]*?(\n=== SECTION: roles ===)/,
      `$1${volumeMap}\n$2`,
    )
    .replaceAll("Volume 2 reveal", `Volume ${Math.min(2, lastVolume)} reveal`)
    .replaceAll("volume-2", `volume-${Math.min(2, lastVolume)}`)
    .replaceAll("Volume 3 public proof", `Volume ${Math.min(3, lastVolume)} public proof`)
    .replaceAll("Volume 3 climax", `Volume ${Math.min(3, lastVolume)} climax`)
    .replaceAll("volume-3", `volume-${Math.min(3, lastVolume)}`);
}

function extractTargetEpisodes(prompt: string): number {
  const match = prompt.match(/(?:Target episodes|目标章数|目标集数|Planned series length)\s*[：:]?\s*(\d+)/iu);
  return match?.[1] ? Number.parseInt(match[1], 10) : 12;
}

const FOUNDATION_REVIEW = [
  "=== DIMENSION: 1 ===",
  "Score: 88",
  "Feedback: The central conflict is concrete and scalable enough to sustain the planned length.",
  "",
  "=== DIMENSION: 2 ===",
  "Score: 86",
  "Feedback: The opening can hook quickly because the missing mentor, the burned ledger, and the dock pressure all start in motion.",
  "",
  "=== DIMENSION: 3 ===",
  "Score: 87",
  "Feedback: The world rules are specific, testable, and tied to scene-level evidence instead of vague lore.",
  "",
  "=== DIMENSION: 4 ===",
  "Score: 85",
  "Feedback: The main cast has distinct motivations and useful contrast in how they relate to truth, risk, and institutions.",
  "",
  "=== DIMENSION: 5 ===",
  "Score: 84",
  "Feedback: The volume plan escalates cleanly and avoids repeating the same investigative beat without new leverage.",
  "",
  "=== OVERALL ===",
  "Total: 86",
  "Passed: yes",
  "Summary: This foundation is ready to write. The strongest quality is that its foreground investigation and background conspiracy are tightly coupled, so every reveal can change both plot and moral pressure.",
].join("\n");

function looksLikeFoundationReviewerPrompt(joined: string): boolean {
  return /senior fiction editor|===\s*dimension:\s*1\s*===|score:\s*\{0-100\}|foundation \(worldbuilding \+ outline \+ rules\)/i.test(joined);
}

function looksLikeArchitectFoundationPrompt(joined: string): boolean {
  return /===\s*section:\s*story_frame\s*===|story_frame[\s\S]*volume_map[\s\S]*book_rules[\s\S]*pending_hooks|all \*\*5 section blocks in order\*\*/i.test(joined);
}

function looksLikeStateValidatorPrompt(joined: string): boolean {
  return /continuity validator for an episode writing system|state card changes[\s\S]*hooks pool changes|first line:\s*exactly PASS or FAIL/i.test(joined);
}

function looksLikeWriterPrompt(joined: string): boolean {
  return /(?:Write episode \d+|请创作第\d+集)/i.test(joined)
    && /EPISODE_SCRIPT_JSON|写作自检/.test(joined);
}

function renderStubEpisodeScript(prompt: string): string {
  const episodeMatch = prompt.match(/(?:Write episode\s*|请创作第)\s*(\d+)\s*集?/iu);
  const episodeNumber = episodeMatch?.[1] ? Number.parseInt(episodeMatch[1], 10) : undefined;
    const episode = episodeNumber ?? 1;
    const stateAt = (stateEpisode: number) => ({
      knowledge: [stateEpisode === 1
        ? "主角知道账页被人为烧毁"
        : `主角掌握第 ${stateEpisode - 1} 集取得的可验证物证`],
      power: [stateEpisode === 1
        ? "乔心掌握行会封条和公开举报权"
        : `乔心掌握第 ${stateEpisode} 集的先手举报权，主角持有上一集物证`],
      relationship: [stateEpisode === 1
        ? "主角与乔心仍有互相利用的旧盟约"
        : `主角与乔心处于第 ${stateEpisode} 集开始时的被迫对立关系`],
      physical: [stateEpisode === 1
        ? "主角在雨夜码头，手部被铅封划伤"
        : `主角带伤进入第 ${stateEpisode} 集的追查地点`],
      activeAction: [stateEpisode === 1
        ? "主角正在寻找账页上的地址"
        : `主角正在执行第 ${stateEpisode} 集的物证转移行动`],
    });
    const script = {
      episode,
      title: `潮湿的账页 ${episode}`,
      estimatedDurationSeconds: 90,
      openingHook: "烧焦的账页在雨水里自行翻开，露出一枚带血的印记。",
      reversal: "观众以为乔心来帮主角，但她亮出行会封条，揭示她已被迫成为监视者，代价是主角失去唯一安全退路。",
      emotionalHook: "乔心会真的背叛他，还是在等他先开口？",
      endState: "主角拿到可验证物证，乔心的立场从旁观者变成被迫对立者，追查进入公开风险阶段。",
      ...(/"seriesResolution"/u.test(prompt) ? {
        seriesResolution: {
          mainConflict: "主角公开物证，行会伪造债务的主线冲突得到裁决。",
          protagonistDesire: "主角完成查明旧账并恢复受害者姓名的核心愿望。",
          characterArcs: [{ character: "主角", outcome: "从独自追查转为公开承担证词后果。" }],
          relationships: [{ parties: "主角与乔心", outcome: "两人结束互相试探，选择共同公开证据。" }],
        },
      } : {}),
      contract: {
        incomingState: stateAt(episode),
        objective: {
          character: "主角",
          desiredChange: "拿到可验证物证并迫使乔心表态",
          whyNow: "行会封锁将在天亮前完成",
        },
        opposition: {
          actorOrConstraint: "乔心与行会伙计",
          goal: "夺回账页并阻止地址公开",
          leverage: "封条、举报权和人数优势",
        },
        causalEscalation: [{
          becauseOf: "烧焦账页露出带血印记",
          choice: "主角拨出铅封并把账页藏入袖口",
          countermove: "伙计封住仓门，乔心亮出行会封条",
          stateChange: `第 ${episode} 集物证被确认，乔心取得新的举报筹码`,
          nextPressure: `主角必须在第 ${episode + 1} 集开始前转移物证`,
        }],
        localDramaticResult: {
          goalOutcome: "部分成功",
          stateChange: `主角取得第 ${episode} 份物证，乔心获得新的反制筹码`,
          costPaid: `主角暴露第 ${episode} 个追查落点并失去当前退路`,
        },
        outgoingPressure: {
          startedDecisionDangerOrQuestion: `第 ${episode + 1} 集的公开举报程序即将启动`,
          whyItFollows: `第 ${episode} 集封条被折断，迫使乔心立即上报`,
        },
        handoffState: stateAt(episode + 1),
        informationPermissions: [{
          subject: "账页地址",
          audience: "观众已看见地址载体，乔心只知道账页存在",
          known: ["主角", "观众"],
          suspected: ["乔心"],
          mistaken: ["行会伙计以为账页仍在仓门内"],
          unknown: ["地址对应的最终债务人"],
        }],
      },
      scenes: [{
        id: "S1",
        location: "雨夜码头",
        time: "夜/外景",
        purpose: "以物证逼出关系选择并改变追查处境",
        shots: Array.from({ length: 6 }, (_, index) => ({
          id: `S1-${String(index + 1).padStart(2, "0")}`,
          shotSize: index === 0 ? "远景" : index === 5 ? "特写" : "近景",
          camera: index === 0 ? "俯拍缓慢推进" : "固定机位",
          durationSeconds: 15,
          visual: [
            "雨水冲开油布，烧焦账页贴在石阶上。",
            "主角用鞋尖拨出裂开的铅封，手指停在血迹旁。",
            "两个行会伙计堵住仓门，封条在灯下反光。",
            "乔心站进雨幕，抬手亮出同样的封条。",
            "主角把账页塞进袖口，伙计抓住他的肩。",
            "乔心的封条被主角折断，断面露出藏在里面的地址。",
          ][index],
          action: [
            "主角没有立刻伸手，先观察巡夜脚步。",
            "主角捡起铅封，泥水顺着指缝流下。",
            "伙计抬手拦路，主角退到积水边。",
            "乔心与主角隔着雨帘对视。",
            "主角借力撞开铁盒，护住袖口。",
            "主角掰断封条，乔心的呼吸停了一拍。",
          ][index],
          dialogue: index === 2
            ? [{ speaker: "伙计", text: "东西交出来，今晚还能算你捡到。" }]
            : index === 3
              ? [{ speaker: "乔心", text: "你再往前一步，我就只能报你的名字。" }]
              : index === 5
                ? [{ speaker: "主角", text: "那就一起报。" }]
                : [],
          sound: index === 5 ? "封条断裂声，雨声骤停" : "雨声与远处吊机声",
        })),
      }],
    };
    return [
      "=== PRE_WRITE_CHECK ===",
      "当前任务：用物证逼出关系选择并改变追查处境。",
      "本集结束必须发生的改变：物证到手，乔心立场翻转，追查进入公开风险。",
      "不要做：不要用总结代替可见动作，不要无代价解决冲突。",
      "=== EPISODE_SCRIPT_JSON ===",
      JSON.stringify(script),
    ].join("\n");
}

function looksLikePlannerMemoPrompt(joined: string): boolean {
  return /产生一份\s*episode_memo|produce an? episode_memo|职责是为下一集产生|job is to produce.*episode_memo/is.test(joined);
}

/**
 * Deterministic replacement for the chatCompletion network call.
 * Returns contract-specific stubbed content for reviewer / architect prompts,
 * STRUCTURE_JSON for structure prompts, and NODE_JSON otherwise.
 */
export function stubChatCompletion(
  messages: ReadonlyArray<LLMMessage>,
  _model: string,
): LLMResponse {
  const joined = messages.map((message) => message.content).join("\n");

  let content = NODE_JSON;
  if (looksLikeFoundationReviewerPrompt(joined)) {
    content = FOUNDATION_REVIEW;
  } else if (looksLikeArchitectFoundationPrompt(joined)) {
    content = renderStubFoundation(joined);
  } else if (looksLikeStateValidatorPrompt(joined)) {
    content = "PASS";
  } else if (looksLikePlannerMemoPrompt(joined)) {
    content = EPISODE_MEMO;
  } else if (looksLikeWriterPrompt(joined)) {
    content = renderStubEpisodeScript(joined);
  } else if (/nodes|structure|outline/i.test(joined)) {
    content = STRUCTURE_JSON;
  }

  return {
    content,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}
