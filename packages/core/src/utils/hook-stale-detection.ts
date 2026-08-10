/**
 * Phase 7 — stale / blocked hook detection.
 *
 * Runs per-episode (called from the writer's runtime-state projection
 * pipeline when it emits pending_hooks.md). Tags hooks the reviewer and
 * writer-planner should pay attention to:
 *
 *   stale   — planted long ago (distance > half_life) and still not
 *             marked paid-off / resolved.
 *   blocked — depends_on references upstream hooks that are still
 *             unplanted or unresolved.
 *
 * The detection is pure: given the current hook list + current episode
 * number, it returns a map of hook id -> diagnostic flags. Nothing is
 * persisted outside the rendered markdown.
 */

import type { StoredHook } from "../state/memory-db.js";
import type { HookRecord } from "../models/runtime-state.js";
import { resolveHalfLifeEpisodes } from "./hook-promotion.js";

export interface HookDiagnostics {
  readonly stale: boolean;
  readonly blocked: boolean;
  readonly missingUpstream: ReadonlyArray<string>;
  readonly distance: number;
  readonly halfLife: number;
  /**
   * Phase 7 hotfix 3 — number of episodes this hook has been blocked.
   *
   * When blocked=false this is 0. When blocked=true it is computed as:
   *   max over unresolved upstream of (currentEpisode - referenceEpisode)
   * where referenceEpisode is:
   *   - upstream.startEpisode, if upstream is planted (startEpisode > 0)
   *   - hook.startEpisode, if upstream is missing or not yet planted
   *     (blocked since this hook's own planting)
   *
   * Reviewer reads this as the "blocked Y episodes" token for threshold
   * evaluation (5/6+ episodes → warning).
   */
  readonly blockedDistance: number;
}

type HookLike = StoredHook | HookRecord;

const RESOLVED_STATUSES: ReadonlyArray<RegExp> = [
  /^resolved$/i,
  /^closed$/i,
  /^done$/i,
  /^已回收$/,
  /^已解决$/,
];

function isResolved(hook: HookLike): boolean {
  const status = (hook.status ?? "").trim();
  return RESOLVED_STATUSES.some((pattern) => pattern.test(status));
}

export function computeHookDiagnostics(params: {
  readonly hooks: ReadonlyArray<HookLike>;
  readonly currentEpisode: number;
}): Map<string, HookDiagnostics> {
  const { hooks, currentEpisode } = params;
  const byId = new Map<string, HookLike>();
  for (const hook of hooks) {
    byId.set(hook.hookId, hook);
  }

  const result = new Map<string, HookDiagnostics>();

  for (const hook of hooks) {
    const halfLife = resolveHalfLifeEpisodes(hook as StoredHook);
    const plantedEpisode = Math.max(0, hook.startEpisode);
    const distance = Math.max(0, currentEpisode - plantedEpisode);

    // Stale: past half-life AND not resolved AND actually planted
    // (startEpisode > 0 — a seed with startEpisode 0 is a pre-planting seed).
    const stale = !isResolved(hook)
      && plantedEpisode > 0
      && distance > halfLife;

    // Blocked: depends_on references a hook that is unplanted or unresolved.
    // Hotfix 3: also track per-upstream reference episode so we can compute
    // how long this hook has been blocked (for reviewer threshold eval).
    const missingUpstream: string[] = [];
    const upstreamReferenceEpisodes: number[] = [];
    for (const upstreamId of hook.dependsOn ?? []) {
      const upstream = byId.get(upstreamId);
      if (!upstream) {
        missingUpstream.push(upstreamId);
        // Upstream missing from ledger entirely — we've been blocked since
        // our own planting (or since episode 0 if we're a pre-planting seed).
        upstreamReferenceEpisodes.push(plantedEpisode);
        continue;
      }
      // Upstream is "planted but not delivered" if startEpisode is non-zero
      // AND it's not resolved. An upstream that is still a seed (startEpisode
      // 0) counts as unplanted.
      const upstreamResolved = isResolved(upstream);
      const upstreamPlanted = upstream.startEpisode > 0
        && upstream.startEpisode <= currentEpisode;
      if (!upstreamPlanted || !upstreamResolved) {
        // We only block when the upstream genuinely has not cleared its gate.
        // For a pure "must be planted first" relationship, "planted but not
        // resolved" still counts as blocking the downstream from firing.
        missingUpstream.push(upstreamId);
        // Blocked since upstream planting (if planted) or since our own
        // planting (if upstream still unplanted).
        const referenceEpisode = upstreamPlanted
          ? upstream.startEpisode
          : plantedEpisode;
        upstreamReferenceEpisodes.push(referenceEpisode);
      }
    }
    const blocked = missingUpstream.length > 0 && !isResolved(hook);

    // Blocked distance = episodes elapsed since the *earliest* reference
    // episode among unresolved upstream. Picking the min reference yields the
    // max distance — the longest any of these gates has held us up.
    let blockedDistance = 0;
    if (blocked && upstreamReferenceEpisodes.length > 0) {
      const earliestReference = Math.min(...upstreamReferenceEpisodes);
      blockedDistance = Math.max(0, currentEpisode - earliestReference);
    }

    result.set(hook.hookId, {
      stale,
      blocked,
      missingUpstream,
      distance,
      halfLife,
      blockedDistance,
    });
  }

  return result;
}

/**
 * Render the diagnostic flags as a compact marker string suitable for
 * appending to an existing table cell. Empty when nothing is flagged.
 */
export function renderHookDiagnosticMarker(
  diagnostics: HookDiagnostics,
  language: "zh" | "en",
): string {
  const tokens: string[] = [];
  if (diagnostics.stale) {
    tokens.push(language === "en"
      ? `stale (d=${diagnostics.distance}/half=${diagnostics.halfLife})`
      : `过期 (距=${diagnostics.distance}/半衰=${diagnostics.halfLife})`);
  }
  if (diagnostics.blocked) {
    const missing = diagnostics.missingUpstream.join(", ");
    // Hotfix 3: embed the blocked distance so reviewer can apply its 5/6-episode
    // threshold without guessing. Token format is load-bearing — it's read by
    // the reviewer prompt verbatim.
    const distanceToken = diagnostics.blockedDistance > 0
      ? (language === "en"
        ? ` (blocked ${diagnostics.blockedDistance} episodes)`
        : ` (已阻 ${diagnostics.blockedDistance} 集)`)
      : "";
    tokens.push(language === "en"
      ? `blocked on ${missing}${distanceToken}`
      : `受阻于 ${missing}${distanceToken}`);
  }
  return tokens.join("; ");
}
