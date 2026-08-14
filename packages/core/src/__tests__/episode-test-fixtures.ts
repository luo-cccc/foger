import { EpisodeScriptSchema, renderEpisodeScriptMarkdown } from "../models/episode-script.js";
import { buildEpisodeContextSnapshot } from "../pipeline/episode-context.js";

export function createEpisodeContextSnapshot(episode = 1) {
  return buildEpisodeContextSnapshot({
    episode,
    model: "test-model",
    service: "test",
    entries: [
      { source: "story/outline/story_frame.md", content: "# Story Frame\n\nA pressured alliance drives the series." },
      { source: "story/outline/volume_map.md", content: `# Volume Map\n\n## Episode ${episode}\nSecure the evidence.` },
      { source: "story/current_state.md", content: "# Current State\n\nThe protagonist is inside the archive." },
      { source: "story/character_context.md", content: "# Character Context\n\nMara distrusts Taryn." },
      { source: "story/pending_hooks.md", content: "# Pending Hooks\n\n- H01: Who altered the seal?" },
      { source: "story/episode_summaries.md", content: "# Episode Summaries" },
      { source: "story/style_guide.md", content: "# Style Guide\n\nKeep actions visible." },
      { source: "story/particle_ledger.md", content: "# Ledger" },
      { source: "story/subplot_board.md", content: "# Subplot Board" },
      { source: "story/emotional_arcs.md", content: "# Emotional Arcs" },
    ],
  });
}

export function createEpisodeScript(episode = 1, title = "Archive Pressure") {
  return EpisodeScriptSchema.parse({
    episode,
    title,
    estimatedDurationSeconds: 90,
    openingHook: "Mara blocks the archive exit.",
    reversal: "The ledger proves Taryn controlled the seal all along.",
    emotionalHook: "Will Mara still trust Taryn with the evidence?",
    endState: "Mara holds the ledger while Taryn controls the only exit.",
    contract: {
      incomingState: { knowledge: [], power: [], relationship: [], physical: [], activeAction: [] },
      objective: { character: "Mara", desiredChange: "Secure the ledger", whyNow: "The archive is closing" },
      opposition: { actorOrConstraint: "Taryn", goal: "Keep the seal", leverage: "Controls the exit" },
      causalEscalation: [{
        becauseOf: "Mara finds the ledger fragment",
        choice: "Mara confronts Taryn",
        countermove: "Taryn locks the exit",
        stateChange: "Both reveal their leverage",
        nextPressure: "They must decide who carries the evidence",
      }],
      localDramaticResult: {
        goalOutcome: "Mara secures the ledger",
        stateChange: "Control splits",
        costPaid: "She is trapped",
      },
      outgoingPressure: {
        startedDecisionDangerOrQuestion: "The archive alarm starts",
        whyItFollows: "Taryn locked the exit",
      },
      handoffState: {
        knowledge: ["Taryn controlled the seal"],
        power: ["Mara holds the ledger"],
        relationship: ["Trust collapses"],
        physical: [],
        activeAction: ["Alarm starts"],
      },
      informationPermissions: [],
    },
    scenes: [{
      id: "S1",
      location: "Archive",
      time: "Night",
      purpose: "Transfer the ledger and split control",
      shots: [
        "Mara confronts Taryn across the ledger table.",
        "Taryn locks the exit while Mara grabs the ledger.",
        "Both reveal their leverage and control splits between them.",
        "Mara secures the ledger, but the sealed door traps her.",
        "The archive alarm starts because Taryn locked the exit.",
        "Mara holds the ledger while Taryn controls the only exit.",
      ].map((action, index) => ({
        id: `S1-${index + 1}`,
        shotSize: "medium",
        camera: "locked",
        durationSeconds: 15,
        visual: `The archive confrontation advances in shot ${index + 1}.`,
        action,
        dialogue: [],
      })),
    }],
  });
}

export function createEpisodeScriptMarkdown(episode = 1, title?: string): string {
  return renderEpisodeScriptMarkdown(createEpisodeScript(episode, title));
}

export function createEpisodeScriptJson(episode = 1, title?: string): string {
  return `${JSON.stringify(createEpisodeScript(episode, title), null, 2)}\n`;
}
