import type {
  CurrentStatePatch,
  HookPayoffTiming,
  HookStatus,
  RuntimeStateLanguage,
} from "../models/runtime-state.js";
import { evaluateHookAdmission } from "../utils/hook-governance.js";
import { resolveHookPayoffTiming } from "../utils/hook-lifecycle.js";

export interface EpisodeStateManifest {
  readonly schemaVersion: 2;
  readonly language: RuntimeStateLanguage;
  readonly lastAppliedEpisode: number;
  readonly projectionVersion: number;
  readonly migrationWarnings: string[];
}

export interface EpisodeHookRecord {
  readonly hookId: string;
  readonly hookKind?: "plot" | "emotion";
  readonly startEpisode: number;
  readonly type: string;
  readonly status: HookStatus;
  readonly lastAdvancedEpisode: number;
  readonly expectedPayoff: string;
  readonly payoffTiming?: HookPayoffTiming;
  readonly notes: string;
  readonly audienceQuestion?: string;
  readonly seedEpisode?: number;
  readonly targetPayoffEpisode?: number;
  readonly pressureSource?: string;
  readonly dependsOn?: string[];
  readonly paysOffInArc?: string;
  readonly coreHook?: boolean;
  readonly halfLifeEpisodes?: number;
  readonly advancedCount?: number;
  readonly promoted?: boolean;
}

export interface EpisodeStateFact {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly validFromEpisode: number;
  readonly validUntilEpisode: number | null;
  readonly sourceEpisode: number;
}

export interface EpisodeRuntimeSummaryRow {
  readonly episodeNumber: number;
  readonly title: string;
  readonly characters: string;
  readonly events: string;
  readonly stateChanges: string;
  readonly hookActivity: string;
  readonly mood: string;
  readonly episodeType: string;
  readonly payoff?: string;
  readonly reversal?: string;
  readonly relationshipChange?: string;
  readonly emotionalHook?: string;
  readonly endingQuestion?: string;
  readonly estimatedDurationSeconds?: number;
  readonly shotCount?: number;
}

export interface EpisodeRuntimeStateSnapshot {
  readonly manifest: EpisodeStateManifest;
  readonly currentState: {
    readonly episode: number;
    readonly facts: EpisodeStateFact[];
  };
  readonly hooks: { readonly hooks: EpisodeHookRecord[] };
  readonly episodeSummaries: { readonly rows: EpisodeRuntimeSummaryRow[] };
}

export interface EpisodeRuntimeStateDelta {
  readonly episode: number;
  readonly currentStatePatch?: CurrentStatePatch;
  readonly hookOps: {
    readonly upsert: EpisodeHookRecord[];
    readonly mention: string[];
    readonly resolve: string[];
    readonly defer: string[];
  };
  readonly newHookCandidates: Array<{
    readonly type: string;
    readonly expectedPayoff: string;
    readonly payoffTiming?: HookPayoffTiming;
    readonly notes: string;
  }>;
  readonly episodeSummary?: EpisodeRuntimeSummaryRow;
  readonly subplotOps: Array<Record<string, unknown>>;
  readonly emotionalArcOps: Array<Record<string, unknown>>;
  readonly characterMatrixOps: Array<Record<string, unknown>>;
  readonly notes: string[];
}

export function applyEpisodeRuntimeStateDelta(params: {
  readonly snapshot: EpisodeRuntimeStateSnapshot;
  readonly delta: EpisodeRuntimeStateDelta;
  readonly allowReapply?: boolean;
}): EpisodeRuntimeStateSnapshot {
  const snapshot = cloneSnapshot(params.snapshot);
  const delta = params.delta;
  const allowReapply = params.allowReapply ?? false;

  if (allowReapply
    ? delta.episode < snapshot.manifest.lastAppliedEpisode
    : delta.episode <= snapshot.manifest.lastAppliedEpisode) {
    throw new Error(`delta episode ${delta.episode} goes backwards`);
  }
  if (delta.episodeSummary && delta.episodeSummary.episodeNumber !== delta.episode) {
    throw new Error(`episode summary ${delta.episodeSummary.episodeNumber} does not match delta episode ${delta.episode}`);
  }
  if (isEmptyEpisodeDelta(delta)) {
    throw new Error("episode runtime state delta is empty; refusing to advance structured state");
  }
  if (delta.episodeSummary
    && snapshot.episodeSummaries.rows.some((row) => row.episodeNumber === delta.episodeSummary?.episodeNumber)
    && !allowReapply) {
    throw new Error(`duplicate summary row for episode ${delta.episodeSummary.episodeNumber}`);
  }

  return {
    manifest: { ...snapshot.manifest, lastAppliedEpisode: delta.episode },
    currentState: applyCurrentStatePatch(snapshot.currentState, snapshot.manifest.language, delta),
    hooks: applyHookOps(snapshot.hooks, delta),
    episodeSummaries: applySummaryDelta(snapshot.episodeSummaries, delta, allowReapply),
  };
}

function cloneSnapshot(snapshot: EpisodeRuntimeStateSnapshot): EpisodeRuntimeStateSnapshot {
  return {
    manifest: { ...snapshot.manifest, migrationWarnings: [...snapshot.manifest.migrationWarnings] },
    currentState: { episode: snapshot.currentState.episode, facts: snapshot.currentState.facts.map((fact) => ({ ...fact })) },
    hooks: { hooks: snapshot.hooks.hooks.map((hook) => ({ ...hook })) },
    episodeSummaries: { rows: snapshot.episodeSummaries.rows.map((row) => ({ ...row })) },
  };
}

function isEmptyEpisodeDelta(delta: EpisodeRuntimeStateDelta): boolean {
  return !delta.currentStatePatch
    && delta.hookOps.upsert.length === 0
    && delta.hookOps.mention.length === 0
    && delta.hookOps.resolve.length === 0
    && delta.hookOps.defer.length === 0
    && delta.newHookCandidates.length === 0
    && !delta.episodeSummary
    && delta.subplotOps.length === 0
    && delta.emotionalArcOps.length === 0
    && delta.characterMatrixOps.length === 0;
}

function applyHookOps(
  state: EpisodeRuntimeStateSnapshot["hooks"],
  delta: EpisodeRuntimeStateDelta,
): EpisodeRuntimeStateSnapshot["hooks"] {
  const hooksById = new Map(state.hooks.map((hook) => [hook.hookId, { ...hook }]));
  const mentioned = new Set(delta.hookOps.mention);
  const deferred = new Set(delta.hookOps.defer);
  const resolved = new Set(delta.hookOps.resolve);

  for (const hook of delta.hookOps.upsert) {
    const existing = hooksById.get(hook.hookId);
    if (existing) {
      if (mentioned.has(hook.hookId)) continue;
      const normalized = deferred.has(hook.hookId)
        ? { ...hook, lastAdvancedEpisode: existing.lastAdvancedEpisode }
        : hook;
      hooksById.set(existing.hookId, mergeHookRecord(existing, normalized));
      continue;
    }
    const admission = evaluateHookAdmission({
      candidate: { type: hook.type, expectedPayoff: hook.expectedPayoff, notes: hook.notes },
      activeHooks: [...hooksById.values()]
        .filter((candidate) => candidate.status !== "resolved"),
    });
    if (!admission.admit && admission.reason === "duplicate_family") {
      const existingFamily = admission.matchedHookId
        ? hooksById.get(admission.matchedHookId)
        : undefined;
      if (!existingFamily) {
        throw new Error(`duplicate active hook family: ${hook.hookId} overlaps ${admission.matchedHookId}`);
      }
      hooksById.set(existingFamily.hookId, mergeHookRecord(existingFamily, hook));
      continue;
    }
    hooksById.set(hook.hookId, { ...hook });
  }

  for (const hookId of delta.hookOps.resolve) {
    const existing = hooksById.get(hookId);
    if (!existing) continue;
    hooksById.set(hookId, {
      ...existing,
      status: "resolved",
      lastAdvancedEpisode: Math.max(existing.lastAdvancedEpisode, delta.episode),
    });
  }
  for (const hookId of delta.hookOps.defer) {
    const existing = hooksById.get(hookId);
    if (!existing || existing.status === "resolved" || resolved.has(hookId)) continue;
    hooksById.set(hookId, { ...existing, status: "deferred" });
  }

  return {
    hooks: [...hooksById.values()].sort((left, right) => (
      left.startEpisode - right.startEpisode
      || left.lastAdvancedEpisode - right.lastAdvancedEpisode
      || left.hookId.localeCompare(right.hookId)
    )),
  };
}

function mergeHookRecord(existing: EpisodeHookRecord, incoming: EpisodeHookRecord): EpisodeHookRecord {
  const expectedPayoff = preferRicherText(existing.expectedPayoff, incoming.expectedPayoff);
  const notes = preferRicherText(existing.notes, incoming.notes);
  const advanced = Math.max(existing.lastAdvancedEpisode, incoming.lastAdvancedEpisode);
  const progressed = advanced > existing.lastAdvancedEpisode;
  return {
    ...existing,
    startEpisode: Math.min(existing.startEpisode, incoming.startEpisode),
    type: preferRicherText(existing.type, incoming.type),
    status: mergeHookStatus(existing.status, incoming.status, progressed),
    lastAdvancedEpisode: advanced,
    expectedPayoff,
    payoffTiming: resolveHookPayoffTiming({
      payoffTiming: incoming.payoffTiming ?? existing.payoffTiming,
      expectedPayoff,
      notes,
    }),
    notes,
  };
}

function mergeHookStatus(existing: HookStatus, incoming: HookStatus, progressed: boolean): HookStatus {
  if (existing === "resolved" || incoming === "resolved") return "resolved";
  if (progressed || existing === "progressing" || incoming === "progressing") return "progressing";
  return existing;
}

function preferRicherText(primary: string, fallback: string): string {
  const left = primary.trim();
  const right = fallback.trim();
  if (!left) return right;
  if (!right || left === right) return left;
  return right.length > left.length ? right : left;
}

function applyCurrentStatePatch(
  state: EpisodeRuntimeStateSnapshot["currentState"],
  language: RuntimeStateLanguage,
  delta: EpisodeRuntimeStateDelta,
): EpisodeRuntimeStateSnapshot["currentState"] {
  if (!delta.currentStatePatch) return { episode: delta.episode, facts: [...state.facts] };
  const facts = [...state.facts];
  const labels = language === "en"
    ? {
      currentLocation: ["Current Location", "当前位置"],
      protagonistState: ["Protagonist State", "主角状态"],
      currentGoal: ["Current Goal", "当前目标"],
      currentConstraint: ["Current Constraint", "当前限制"],
      currentAlliances: ["Current Alliances", "Current Relationships", "当前敌我"],
      currentConflict: ["Current Conflict", "当前冲突"],
    }
    : {
      currentLocation: ["当前位置", "Current Location"],
      protagonistState: ["主角状态", "Protagonist State"],
      currentGoal: ["当前目标", "Current Goal"],
      currentConstraint: ["当前限制", "Current Constraint"],
      currentAlliances: ["当前敌我", "Current Alliances", "Current Relationships"],
      currentConflict: ["当前冲突", "Current Conflict"],
    };

  for (const [patchKey, aliases] of Object.entries(labels) as Array<[keyof typeof labels, string[]]>) {
    const value = delta.currentStatePatch[patchKey]?.trim();
    if (!value) continue;
    for (let index = facts.length - 1; index >= 0; index -= 1) {
      const predicate = facts[index]?.predicate ?? "";
      if (aliases.some((alias) => alias.toLowerCase() === predicate.toLowerCase())) facts.splice(index, 1);
    }
    facts.push({
      subject: "protagonist",
      predicate: aliases[0]!,
      object: value,
      validFromEpisode: delta.episode,
      validUntilEpisode: null,
      sourceEpisode: delta.episode,
    });
  }
  return {
    episode: delta.episode,
    facts: facts.sort((left, right) => left.predicate.localeCompare(right.predicate) || left.object.localeCompare(right.object)),
  };
}

function applySummaryDelta(
  state: EpisodeRuntimeStateSnapshot["episodeSummaries"],
  delta: EpisodeRuntimeStateDelta,
  allowReapply: boolean,
): EpisodeRuntimeStateSnapshot["episodeSummaries"] {
  if (!delta.episodeSummary) {
    return { rows: [...state.rows].sort((left, right) => left.episodeNumber - right.episodeNumber) };
  }
  return {
    rows: [
      ...(allowReapply ? state.rows.filter((row) => row.episodeNumber !== delta.episodeSummary!.episodeNumber) : state.rows),
      delta.episodeSummary,
    ].sort((left, right) => left.episodeNumber - right.episodeNumber),
  };
}
