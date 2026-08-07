import type { AuditIssue } from "../agents/continuity.js";
import { auditEpisodeToolDiagnostics } from "./episode-tool-diagnostics.js";
import {
  EPISODE_DURATION_HARD_MAX_SECONDS,
  EPISODE_DURATION_HARD_MIN_SECONDS,
  measureEpisodeScript,
  type EpisodeScript,
  type EpisodeStateBucket,
} from "../models/episode-script.js";

const STATE_KEYS = ["knowledge", "power", "relationship", "physical", "activeAction"] as const;

function normalizeFacts(facts: ReadonlyArray<string>): string[] {
  return facts.map((fact) => fact.trim()).filter(Boolean).sort();
}

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
  const han = normalized.match(/[\u4e00-\u9fff]{2,}/gu) ?? [];
  const terms = [...new Set([...english, ...han])];
  if (terms.length === 0) return false;
  const hits = terms.filter((term) => surface.includes(term)).length;
  return hits >= Math.max(1, Math.ceil(Math.min(terms.length, 3) / 2));
}

function auditContractSurfaceEvidence(script: EpisodeScript): AuditIssue[] {
  const surface = episodeSurface(script);
  const issues: AuditIssue[] = [];
  const check = (value: string, ref: string, label: string): void => {
    if (hasSurfaceEvidence(value, surface)) return;
    issues.push({
      severity: "critical",
      category: "contract-without-screen-evidence",
      repairScope: "structural",
      ruleClass: "structural_invariant",
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
    if (JSON.stringify(expected) === JSON.stringify(actual)) continue;
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
  targetDurationSeconds = 90,
): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const metrics = measureEpisodeScript(script, targetDurationSeconds);
  const softMin = Math.max(EPISODE_DURATION_HARD_MIN_SECONDS, targetDurationSeconds - 15);
  const softMax = Math.min(EPISODE_DURATION_HARD_MAX_SECONDS, targetDurationSeconds + 15);

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
      description: `Estimated duration ${metrics.estimatedDurationSeconds}s is outside the hard 60-120s range.`,
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

  const hasConcreteAudienceQuestion = /[?？]/u.test(script.emotionalHook)
    || /(?:观众(?:追问|想知道|会问)|到底.{2,}|能否.{2,}|是否.{2,}|会不会.{2,}|为什么.{2,}|为何.{2,}|谁.{2,}(?:会|能|要|还)|什么.{2,}(?:会|能|要|还)|多少.{2,})/u.test(script.emotionalHook);
  if (!hasConcreteAudienceQuestion) {
    issues.push({
      severity: "critical",
      category: "emotional-hook",
      repairScope: "structural",
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
      suggestion: "Change at least one knowledge, power, relationship, physical, or active-action fact.",
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

  if (previousScript) issues.push(...compareHandoff(previousScript, script));
  issues.push(...auditContractSurfaceEvidence(script));
  issues.push(...auditEpisodeToolDiagnostics(script, previousScript));

  return issues;
}
