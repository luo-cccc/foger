import type { EpisodeScript, EpisodeScriptMetrics } from "../models/episode-script.js";
import type { EpisodeRuntimeStateDelta, HookRecord } from "../models/runtime-state.js";
import type { EpisodeMemo } from "../models/input-governance.js";
import { parseHookLedger } from "../utils/hook-ledger-validator.js";

type ExistingHook = {
  readonly hookId: string;
  readonly startEpisode: number;
  readonly type: string;
  readonly status: string;
  readonly lastAdvancedEpisode: number;
  readonly expectedPayoff: string;
  readonly payoffTiming?: string;
  readonly notes: string;
  readonly targetPayoffEpisode?: number;
  readonly seedEvidence?: ReadonlyArray<string>;
  readonly advanceEvidence?: ReadonlyArray<string>;
  readonly payoffEvidence?: ReadonlyArray<string>;
  readonly lastVerifiedEvidenceEpisode?: number;
};

function joinFacts(values: ReadonlyArray<string>): string {
  return values.filter(Boolean).join("；");
}

function updateHook(
  existing: ExistingHook,
  episode: number,
  descriptor: string,
  evidence: ReadonlyArray<string>,
): HookRecord {
  return {
    hookId: existing.hookId,
    startEpisode: existing.startEpisode,
    type: existing.type,
    status: existing.status === "resolved" ? "resolved" : "progressing",
    lastAdvancedEpisode: Math.max(existing.lastAdvancedEpisode, episode),
    expectedPayoff: existing.expectedPayoff,
    ...(existing.payoffTiming ? { payoffTiming: existing.payoffTiming as HookRecord["payoffTiming"] } : {}),
    ...(existing.targetPayoffEpisode ? { targetPayoffEpisode: existing.targetPayoffEpisode } : {}),
    ...(existing.seedEvidence?.length ? { seedEvidence: [...existing.seedEvidence] } : {}),
    ...(existing.advanceEvidence?.length ? { advanceEvidence: [...existing.advanceEvidence] } : {}),
    ...(existing.payoffEvidence?.length ? { payoffEvidence: [...existing.payoffEvidence] } : {}),
    ...(existing.lastVerifiedEvidenceEpisode ? { lastVerifiedEvidenceEpisode: existing.lastVerifiedEvidenceEpisode } : {}),
    ...(evidence.length > 0 ? {
      advanceEvidence: [...new Set([...(existing.advanceEvidence ?? []), ...evidence])],
      lastVerifiedEvidenceEpisode: episode,
    } : {}),
    notes: descriptor.trim()
      ? [existing.notes, descriptor.trim()].filter(Boolean).join("；")
      : existing.notes,
  };
}

export function deriveEpisodeRuntimeDelta(params: {
  readonly script: EpisodeScript;
  readonly title: string;
  readonly episode: number;
  readonly metrics?: EpisodeScriptMetrics;
  readonly memo?: EpisodeMemo;
  readonly existingHooks?: ReadonlyArray<ExistingHook>;
}): EpisodeRuntimeStateDelta {
  const { script, episode, metrics } = params;
  const handoff = script.contract.handoffState;
  const outgoingPressure = script.contract.outgoingPressure;
  const ledger = params.memo?.body ? parseHookLedger(params.memo.body) : undefined;
  const hooksById = new Map((params.existingHooks ?? []).map((hook) => [hook.hookId, hook]));

  const actionEntries = [...(ledger?.advance ?? []), ...(ledger?.resolve ?? [])];
  const advancedIds = new Set((ledger?.advance ?? []).map((entry) => entry.id));
  const upsert = actionEntries
    .map((entry) => hooksById.get(entry.id))
    .filter((hook): hook is ExistingHook => Boolean(hook))
    .map((hook) => {
      const entry = actionEntries.find((candidate) => candidate.id === hook.hookId)!;
      return updateHook(hook, episode, entry.descriptor, entry.evidence);
    });

  const currentStatePatch = {
    currentLocation: script.scenes.at(-1)?.location || undefined,
    protagonistState: joinFacts(handoff.physical) || undefined,
    currentGoal: joinFacts(handoff.activeAction) || undefined,
    currentConstraint: outgoingPressure.startedDecisionDangerOrQuestion || undefined,
    currentAlliances: joinFacts(handoff.relationship) || undefined,
    currentConflict: [outgoingPressure.startedDecisionDangerOrQuestion, outgoingPressure.whyItFollows]
      .filter(Boolean)
      .join("；") || undefined,
  };

  return {
    episode: episode,
    currentStatePatch,
    hookOps: {
      upsert,
      mention: [...(ledger?.open ?? []), ...(ledger?.advance ?? [])]
        .map((entry) => entry.id)
        .filter((id) => !advancedIds.has(id)),
      resolve: (ledger?.resolve ?? []).map((entry) => entry.id),
      defer: (ledger?.defer ?? []).map((entry) => entry.id),
    },
    newHookCandidates: (ledger?.newOpenDescriptions ?? []).map((description) => ({
      type: "plot",
      expectedPayoff: script.contract.outgoingPressure.startedDecisionDangerOrQuestion,
      notes: description,
    })),
    episodeSummary: {
      episodeNumber: episode,
      title: params.title,
      characters: script.contract.objective.character,
      events: script.endState,
      stateChanges: script.contract.localDramaticResult.stateChange,
      hookActivity: [
        ...(ledger?.advance ?? []).map((entry) => `advance:${entry.id}`),
        ...(ledger?.resolve ?? []).map((entry) => `resolve:${entry.id}`),
        ...(ledger?.defer ?? []).map((entry) => `defer:${entry.id}`),
      ].join(", "),
      mood: script.emotionalHook,
      episodeType: "episode",
      payoff: [
        script.contract.localDramaticResult.goalOutcome,
        script.contract.localDramaticResult.stateChange,
        `代价：${script.contract.localDramaticResult.costPaid}`,
      ].join("；"),
      reversal: script.reversal,
      relationshipChange: joinFacts(handoff.relationship),
      emotionalHook: script.emotionalHook,
      endingQuestion: script.emotionalHook,
      estimatedDurationSeconds: metrics?.estimatedDurationSeconds ?? script.estimatedDurationSeconds,
      shotCount: metrics?.shotCount ?? script.scenes.reduce((sum, scene) => sum + scene.shots.length, 0),
    },
    subplotOps: [],
    emotionalArcOps: [],
    characterMatrixOps: [],
    notes: [script.contract.outgoingPressure.whyItFollows].filter(Boolean),
  };
}
