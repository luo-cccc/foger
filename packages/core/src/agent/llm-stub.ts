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
  } else if (/nodes|structure|outline/i.test(joined)) {
    content = STRUCTURE_JSON;
  }

  return {
    content,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}
