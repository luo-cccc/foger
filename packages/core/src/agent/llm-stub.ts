import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  Api,
} from "@mariozechner/pi-ai";
import type { LLMMessage, LLMResponse } from "../llm/provider.js";

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

const CHAPTER_DRAFT = [
  "=== PRE_WRITE_CHECK ===",
  "当前任务：让林越在码头压力下确认烧毁账页并决定继续追查。",
  "章尾必须发生的改变：林越拿到新的账页线索，债务追查从个人猜测变成有证据的目标；乔心被迫表明立场，行会也开始注意到林越。",
  "不要做：不要用作者总结替代行动，不要让冲突在没有代价的情况下结束。",
  "=== CHAPTER_TITLE ===",
  "潮湿的账页",
  "=== CHAPTER_CONTENT ===",
  [
    "潮水退到石阶下面时，林越才看见那只被油布包住的铁盒。盒角卡在两块缆桩之间，外壳已经锈得发黑，缝里却没有海水。码头的夜班规矩是先报物、再报人，谁捡到来路不明的东西，第二天都要在值簿上留下名字。林越站在昏黄的灯下没有伸手，先看了看远处的吊机和仓门，确认巡夜的脚步还在第三个弯口之外。",
    "铁盒旁边压着一片烧焦的纸，纸边卷成细硬的黑翅。林越用鞋尖把它拨出来，露出半行没有烧尽的数字。那张纸属于他师父失踪前经手的旧账格式，最后一列被人用粗笔划去，只剩一个欠债人的姓。姓氏下面还有一枚浅得几乎看不见的印痕，像有人在纸背按过半枚私印，又在火烧前匆忙把它撕走。林越的手指停在半空，没碰那道印痕。",
    "仓门忽然响了一声。两个行会伙计从木箱后面走出来，领头的人先看铁盒，再看林越腰间的值牌。那人说今晚少了一笔入库货，要他把捡到的东西交出去。林越把纸片折进掌心，故意让铁盒留在鞋边，问对方缺的是哪一箱货。问题一出口，对方的眼神就偏开了半寸。若真丢的是货，他们会先报箱号；他们盯着的是铁盒里那张能证明旧账被改过的纸。",
    "林越没有后退。他抬脚踢开铁盒，盒盖撞上石阶，里面滚出一枚裂开的铅封。伙计弯腰去捡，他便借着灯影把烧焦的纸片塞进袖口。铅封上的纹路与值簿底页完全相同，唯独中间那道刻痕被重新磨过。林越记得师父说过，账本可以烧，封口不能凭空变成另一种纹路。只要把这枚铅封送进档案房，旧账就不再只是他一个人的猜测。",
    "另一个伙计抓住他的肩膀，力气大得像要把他按进潮湿的石缝。林越没有挣扎，只把身体向旁边一偏，让对方的手肘撞在铁盒边缘。趁那人吃痛，他用膝盖把铅封踢进排水沟，又用鞋底压住纸片露出的黑角。领头的人骂了一句，抬手要打，乔心却从仓门外喊出巡夜人的名字。她没有走近，只站在雨帘后面，声音清楚得足以让所有人听见。",
    "短暂的沉默把码头分成两边。领头的人看了乔心一眼，又看林越袖口的褶痕，终于把拳头收了回去。他警告林越明早交出值簿副本，否则就把今晚的缺货算到他头上。等脚步声远去，乔心才从雨里走到石阶旁，把一根细绳递给他。绳结里藏着半张新抄的清单，清单最下方写着同一个姓，后面多出一行日期，正好是师父失踪的前夜。林越接过清单，第一次确认这件事有具体的追查方向，旧怨已经变成一条可以验证的线索。",
    "他把铅封从排水沟边捡回来，泥水顺着指缝往下淌。乔心问他是否还要把清单交给档案房，林越看着仓门上新换的锁，知道那里的值夜人早已换了人。交出去，证据会先落到行会手里；藏起来，明天的欠债就会变成他的罪名。他把半张清单贴进内袋，留下那枚裂开的铅封作为可追查的物证。远处的钟敲过子时，码头的灯一盏盏熄灭，一条新的信息落到手里，眼前的压力随之有了方向，乔心的出现让两人的关系不再只是旁观与被旁观，林越的目标终于明确，风险也从旧账里抬起头来：师父并非无故失踪，真正的账从今晚才开始。",
  ].join("\n\n"),
  "=== POST_SETTLEMENT ===",
  "林越保留半张清单和裂开铅封，追查目标从师父失踪推进到旧账篡改；乔心提供日期线索，行会开始注意林越。",
].join("\n");

const CHAPTER_MEMO = [
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
  "## 当前任务",
  "林越在码头找到烧焦账页与裂开铅封，把师父失踪从猜测推进成可验证的旧账篡改线索。",
  "",
  "## 读者此刻在等什么",
  "1. 读者在等烧毁账页为何重新出现。",
  "2. 本章部分兑现来源问题，并把调查推进到旧账篡改证据。",
  "",
  "## 该兑现的 / 暂不掀的",
  "- 该兑现：烧毁账页重新出现 → 林越拿到烧焦账页、裂开铅封和半张清单。",
  "- 暂不掀：师父失踪的幕后主使 → 只确认旧账被改，暂不揭示操盘者。",
  "",
  "## 日常/过渡承担什么任务",
  "不适用 - 本章为码头取证与对峙场景，无日常过渡。",
  "",
  "## 关键抉择过三连问",
  "- 主角本章最关键的一次选择：林越留下证据继续追查。",
  "  - 为什么这么做？证据证明师父失踪不是偶然。",
  "  - 符合当前利益吗？符合，他需要先保住可验证物证。",
  "  - 符合他的人设吗？符合，他相信记录和证据。",
  "- 对手/配角本章最关键的一次选择：乔心公开叫出巡夜人的名字，阻止冲突升级。",
  "  - 为什么这么做？她要保住线索和林越。",
  "  - 符合当前利益吗？符合。",
  "  - 符合她的人设吗？符合。",
  "",
  "## 章尾必须发生的改变",
  "- 信息改变：林越保留半张清单和裂开铅封，确认旧账被人篡改。",
  "- 关系改变：乔心从旁观者变成提供线索的协助者。",
  "- 目标改变：林越决定继续追查师父失踪与旧账篡改。",
  "",
  "## 本章 hook 账",
  "open:",
  "- 无",
  "advance:",
  "- mentor-ledger \"烧毁账本\" → 林越拿到烧焦账页和裂开铅封",
  "resolve:",
  "- 无",
  "defer:",
  "- forged-notices \"伪造债务通知\" → 本章只确认旧账异常，暂不揭示系统规模",
  "- courier-network \"信使网络\" → 乔心只提供单次线索，后续再推进证人网络",
  "",
  "## 卷级 KR 绑定",
  "- 绑定：KR1",
  "- 推进方式：林越用烧焦账页、裂开铅封和半张清单把调查推进到可验证证据。",
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
    "## Volume 1 (Chapters 1-4)",
    "Lin Yue is forced back into the dock ledger world when a burned fragment tied to his missing mentor resurfaces. The emotional shape is suspicion to reluctant commitment: he wants distance, then realizes distance is exactly what the conspiracy counts on. Volume 1 should end with proof that the fraud is institutional rather than personal.",
    "",
    "## Volume 2 (Chapters 5-8)",
    "The investigation widens from the docks into clerks, brokers, and household debts that were reassigned by design. Lin Yue gains allies but each alliance carries a cost, so momentum comes from hard-earned access instead of lucky reveals. Volume 2 should end with a betrayal that exposes how near the fraud has always been to his own life.",
    "",
    "## Volume 3 (Chapters 9-12)",
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
      "At chapter 0 he still works near the harbor ledgers, keeps a half-burned seal from his missing mentor, and is trying not to be pulled back into old obligations.",
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
      "At chapter 0 she is moving information for cash, but she has already seen enough doctored notices to suspect the harbor books are being manipulated at scale.",
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
      "At chapter 0 he believes the archive chain is secure and that frightened clerks will keep obeying as long as the books look official.",
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
    "- Every chapter should advance either proof, pressure, or trust.",
    "",
    "## Guardrails",
    "- Do not solve conflicts with sudden power upgrades or external rescues.",
    "- Keep the harbor economy concrete: manifests, debts, seals, witnesses, and paper trails matter.",
    "- Preserve a noir-leaning, high-pressure tone even in quieter chapters.",
  ].join("\n"),
  "",
  "=== SECTION: pending_hooks ===",
  [
    "# Pending Hooks",
    "",
    "| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | payoff_timing | depends_on | pays_off_in_arc | core_hook | half_life | notes |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    "| mentor-ledger | 0 | mystery | open | 0 | Explain why Lin Yue's mentor vanished after hiding the burned ledger. | Volume 2 reveal | none | volume-2 | yes | 4 | Seed clue carried by the half-burned seal. |",
    "| forged-notices | 0 | conspiracy | open | 0 | Prove the harbor debt notices were altered by design, not clerical accident. | Volume 3 public proof | mentor-ledger | volume-3 | yes | 5 | Main structural fraud thread. |",
    "| courier-network | 0 | alliance | open | 0 | Turn the whisper network into admissible witness testimony. | Volume 3 climax | forged-notices | volume-3 | no | 3 | Qiao Xin is the bridge between rumor and proof. |",
  ].join("\n"),
].join("\n");

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
  return /continuity validator for a novel writing system|state card changes[\s\S]*hooks pool changes|first line:\s*exactly PASS or FAIL/i.test(joined);
}

function looksLikeWriterPrompt(joined: string): boolean {
  return /(?:Write chapter \d+|请续写第\d+章)/i.test(joined)
    && /PRE_WRITE_CHECK|CHAPTER_CONTENT|写作自检/.test(joined);
}

function looksLikePlannerMemoPrompt(joined: string): boolean {
  return /产生一份\s*chapter_memo|produce a chapter_memo|职责是为下一章产生|job is to produce.*chapter_memo/is.test(joined);
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
    content = FOUNDATION_SECTIONS;
  } else if (looksLikeStateValidatorPrompt(joined)) {
    content = "PASS";
  } else if (looksLikePlannerMemoPrompt(joined)) {
    content = CHAPTER_MEMO;
  } else if (looksLikeWriterPrompt(joined)) {
    content = CHAPTER_DRAFT;
  } else if (/nodes|structure|outline/i.test(joined)) {
    content = STRUCTURE_JSON;
  }

  return {
    content,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}
