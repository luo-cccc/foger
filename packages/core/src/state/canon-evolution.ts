import type { CanonClaim, ClaimsFile } from "../models/canon.js";
import type { UnclaimedFactsFile } from "../models/canon.js";
import type { EpisodeScript } from "../models/episode-script.js";
import { claimTextMatches } from "../utils/claim-gate.js";
import { loadClaimVisibilityState, revealedClaimIds } from "./claim-visibility.js";
import { loadClaimsFile, loadUnclaimedFacts, saveClaimsFile, saveUnclaimedFacts } from "./canon-store.js";

export interface EpisodeCanonUpdateResult {
  readonly claims: ReadonlyArray<CanonClaim>;
  readonly changed: boolean;
}

/**
 * Facts established by the episode (handoff knowledge, local result, end
 * state) that no existing canon claim covers. Deterministic candidates for a
 * later explicit `inkos canon refresh`; never claims by themselves.
 */
export function collectUnclaimedEpisodeFacts(params: {
  readonly script: EpisodeScript;
  readonly claims: ReadonlyArray<CanonClaim>;
}): string[] {
  const candidates = [
    ...params.script.contract.handoffState.knowledge,
    params.script.contract.localDramaticResult.stateChange,
    params.script.endState,
  ].map((fact) => fact.trim()).filter(Boolean);
  return [...new Set(candidates.filter((fact) =>
    !params.claims.some((claim) => claimTextMatches(fact, claim.content)),
  ))];
}

async function recordUnclaimedFacts(
  bookDir: string,
  script: EpisodeScript,
  claims: ReadonlyArray<CanonClaim>,
): Promise<boolean> {
  const fresh = collectUnclaimedEpisodeFacts({ script, claims });
  if (fresh.length === 0) return false;
  const existing = await loadUnclaimedFacts(bookDir);
  const byFact = new Map(existing.facts.map((entry) => [entry.fact, entry.sourceEpisode]));
  let changedFlag = false;
  for (const fact of fresh) {
    const current = byFact.get(fact);
    if (current === undefined || script.episode < current) {
      byFact.set(fact, script.episode);
      changedFlag = true;
    }
  }
  if (!changedFlag) return false;
  const next: UnclaimedFactsFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    facts: [...byFact.entries()]
      .map(([fact, sourceEpisode]) => ({ fact, sourceEpisode }))
      .sort((left, right) => left.sourceEpisode - right.sourceEpisode),
  };
  await saveUnclaimedFacts(bookDir, next);
  return true;
}

/**
 * Deterministic canon evolution. A claim settles when the episode's
 * authoritative state (handoff knowledge, local result, end state) carries
 * the fact's salient terms; characters listed as knowing/suspecting the fact
 * in `informationPermissions` are merged into `visibility.characterKnownBy`.
 * Secret truths only settle after they are revealed to the reader, so the
 * reveal ledger stays authoritative for suspense.
 */
export function deriveEpisodeCanonUpdates(params: {
  readonly script: EpisodeScript;
  readonly claims: ReadonlyArray<CanonClaim>;
  readonly revealedIds: ReadonlySet<string>;
}): EpisodeCanonUpdateResult {
  const { script, claims, revealedIds } = params;
  const stateText = [
    ...script.contract.handoffState.knowledge,
    ...script.contract.handoffState.activeAction,
    script.contract.localDramaticResult.stateChange,
    script.endState,
  ].filter(Boolean).join("；");

  const permissionEntries = script.contract.informationPermissions.map((permission) => ({
    subject: permission.subject.trim(),
    knownText: [...permission.known, ...permission.suspected].filter(Boolean).join("；"),
  }));

  let changed = false;
  const updated = claims.map((claim) => {
    let next = claim;

    if (claim.status === "active") {
      const readerRevealed = claim.claimType !== "secret_truth"
        || revealedIds.has(claim.id)
        || claim.visibility.readerKnownFrom === undefined
        || script.episode >= claim.visibility.readerKnownFrom;
      if (readerRevealed && claimTextMatches(stateText, claim.content)) {
        next = {
          ...next,
          status: "resolved",
          statusUpdatedAtEpisode: script.episode,
        };
        changed = true;
      }
    }

    const newKnownBy = permissionEntries
      .filter((entry) => entry.subject && entry.knownText && claimTextMatches(entry.knownText, claim.content))
      .map((entry) => entry.subject)
      .filter((subject) => !next.visibility.characterKnownBy.includes(subject));
    if (newKnownBy.length > 0) {
      next = {
        ...next,
        visibility: {
          ...next.visibility,
          characterKnownBy: [...next.visibility.characterKnownBy, ...newKnownBy],
        },
      };
      changed = true;
    }

    return next;
  });

  return { claims: updated, changed };
}

/**
 * Persist canon evolution for one episode. Idempotent: re-running the same
 * episode (rewrite, recovery, audit) produces no additional changes.
 */
export async function applyEpisodeCanonUpdates(params: {
  readonly bookDir: string;
  readonly script: EpisodeScript;
  readonly revealedIds?: ReadonlySet<string>;
}): Promise<boolean> {
  const claimsFile: ClaimsFile = await loadClaimsFile(params.bookDir);
  const revealedIds = params.revealedIds
    ?? new Set(revealedClaimIds(await loadClaimVisibilityState(params.bookDir)));
  const result = deriveEpisodeCanonUpdates({
    script: params.script,
    claims: claimsFile.claims,
    revealedIds,
  });
  const claimsChanged = result.changed;
  if (claimsChanged) {
    await saveClaimsFile(params.bookDir, { claims: [...result.claims] });
  }
  const factsChanged = await recordUnclaimedFacts(params.bookDir, params.script, result.claims);
  return claimsChanged || factsChanged;
}
