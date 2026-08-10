import type { AuditIssue } from "../agents/continuity.js";
import type { EpisodeScript } from "../models/episode-script.js";
import { factsMissingFrom } from "../utils/state-facts.js";
const issue = (category: string, description: string, suggestion: string, evidenceRefs: string[]): AuditIssue => ({
  severity: "warning",
  category,
  ruleClass: "reviewed_invariant",
  repairScope: "unknown",
  description,
  suggestion,
  evidenceRefs,
});

/** Tool-only diagnostics. These report suspicious structure without rewriting the episode. */
export function auditEpisodeToolDiagnostics(script: EpisodeScript, previous?: EpisodeScript): AuditIssue[] {
  const findings: AuditIssue[] = [];
  const allText = [
    script.openingHook,
    script.reversal,
    script.emotionalHook,
    script.endState,
    script.contract.localDramaticResult.stateChange,
    ...script.scenes.flatMap((scene) => scene.shots.flatMap((shot) => [
      shot.visual,
      shot.action ?? "",
      shot.dialogue?.map((line) => line.text).join(" ") ?? "",
      shot.narration ?? "",
    ])),
  ].join(" ");

  const contradictoryPairs: ReadonlyArray<readonly [RegExp, RegExp]> = [
    [/已经死亡|已死|dead/iu, /活着|说话|出现|alive|speaks/iu],
    [/没有受伤|毫发无损/iu, /重伤|流血|骨折|injur(?:ed|y)/iu],
    [/失去能力|无法使用/iu, /再次使用|发动能力|uses? ability/iu],
  ];
  for (const [left, right] of contradictoryPairs) {
    if (left.test(allText) && right.test(allText)) {
      findings.push(issue(
        "fact-contradiction",
        "The episode contains mutually contradictory state claims.",
        "Keep one authoritative fact and show the visible event that changes it.",
        [`episode:${script.episode}:script`, `episode:${script.episode}:contract.handoffState`],
      ));
      break;
    }
  }

  const shotIds = script.scenes.flatMap((scene) => scene.shots.map((shot) => shot.id));
  if (new Set(shotIds).size !== shotIds.length) {
    findings.push(issue(
      "artifact-identity-ambiguity",
      "Two or more shots share the same identifier.",
      "Assign a unique stable ID to every shot so production and review can reference it unambiguously.",
      [`episode:${script.episode}:scenes.shots.id`],
    ));
  }

  if (previous && script.episode === previous.episode + 1) {
    const previousTail = previous.contract.handoffState.physical;
    const incoming = script.contract.incomingState.physical;
    const missing = factsMissingFrom(previousTail, incoming);
    if (previousTail.length > 0 && missing.length > 0) {
      findings.push(issue(
        "timeline-drift",
        `The incoming physical state omits facts carried by the previous handoff: ${missing.join("；")}.`,
        "Carry the handoff forward exactly or document the transition in the episode contract.",
        [`episode:${previous.episode}:contract.handoffState.physical`, `episode:${script.episode}:contract.incomingState.physical`],
      ));
    }
  }

  const hookActions = [script.contract.causalEscalation.map((step) => step.nextPressure), script.contract.outgoingPressure.startedDecisionDangerOrQuestion]
    .join(" ").trim();
  const hasLedgerMention = /hook|伏笔|线索|秘密|任务|道具|身份/iu.test(allText);
  if (hasLedgerMention && !hookActions) {
    findings.push(issue(
      "ledger-half-completeness",
      "The script mentions a hook-like element but does not record how it advances or exits the episode.",
      "Add an explicit hook ledger action or mark the hook as intentionally deferred.",
      [`episode:${script.episode}:contract.causalEscalation`, `episode:${script.episode}:contract.outgoingPressure`],
    ));
  }

  if (script.contract.informationPermissions.some((permission) => permission.known.length === 0 && permission.suspected.length === 0 && permission.mistaken.length === 0)) {
    findings.push(issue(
      "unjustified-information",
      "An information-permission entry has no known, suspected, or mistaken facts to review.",
      "Record the concrete fact boundary for this subject or remove the empty entry.",
      [`episode:${script.episode}:contract.informationPermissions`],
    ));
  }

  if (script.contract.objective.desiredChange.trim() && !script.contract.localDramaticResult.stateChange.trim()) {
    findings.push(issue(
      "goal-abandonment",
      "The episode declares a desired change but records no resulting state change.",
      "Tie the objective to an observable gain, loss, refusal, proof, or relationship change.",
      [`episode:${script.episode}:contract.objective`, `episode:${script.episode}:contract.localDramaticResult`],
    ));
  }

  if (script.contract.causalEscalation.length > 0 && script.contract.causalEscalation.every((step) => step.stateChange.trim().length < 4)) {
    findings.push(issue(
      "countdown-stagnation",
      "The causal chain contains pressure but no meaningful state change.",
      "Make at least one escalation irreversible and carry its consequence into next pressure.",
      [`episode:${script.episode}:contract.causalEscalation`],
    ));
  }

  const entries = new Set<string>();
  const duplicatedEntries = new Set<string>();
  for (const scene of script.scenes) {
    for (const shot of scene.shots) {
      const mentioned = shot.dialogue?.map((line) => line.speaker) ?? [];
      for (const speaker of mentioned) {
        if (entries.has(speaker)) continue;
        entries.add(speaker);
      }
      if (shot.action && /突然|忽然|凭空|suddenly|appears? out of nowhere/iu.test(shot.action)) {
        duplicatedEntries.add(shot.id);
      }
    }
  }
  if (duplicatedEntries.size > 0) {
    findings.push(issue(
      "unexplained-character-entry",
      "A character entry is described as sudden without a setup, location cue, or causal carrier.",
      "Seed the character in the scene or show the arrival action before the intervention.",
      [...duplicatedEntries].map((id) => `episode:${script.episode}:shot:${id}`),
    ));
  }
  return findings;
}
