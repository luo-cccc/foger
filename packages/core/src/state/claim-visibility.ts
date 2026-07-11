import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const RevealedClaimRecordSchema = z.object({
  claimId: z.string().min(1),
  revealedAtChapter: z.number().int().min(1),
});

export type RevealedClaimRecord = z.infer<typeof RevealedClaimRecordSchema>;

export const ClaimVisibilityStateSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string().min(1),
  revealedToReader: z.array(RevealedClaimRecordSchema).default([]),
});

export type ClaimVisibilityState = z.infer<typeof ClaimVisibilityStateSchema>;

function emptyClaimVisibilityState(now = new Date().toISOString()): ClaimVisibilityState {
  return {
    version: 1,
    updatedAt: now,
    revealedToReader: [],
  };
}

export async function loadClaimVisibilityState(bookDir: string): Promise<ClaimVisibilityState> {
  const path = join(bookDir, "story", "state", "claim_visibility.json");
  try {
    return ClaimVisibilityStateSchema.parse(JSON.parse(await readFile(path, "utf-8")));
  } catch {
    return emptyClaimVisibilityState();
  }
}

export async function saveClaimVisibilityState(
  bookDir: string,
  state: ClaimVisibilityState,
): Promise<string> {
  const stateDir = join(bookDir, "story", "state");
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, "claim_visibility.json");
  const parsed = ClaimVisibilityStateSchema.parse(state);
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
  return path;
}

export async function recordReaderClaimReveals(
  bookDir: string,
  params: {
    readonly chapter: number;
    readonly claimIds: ReadonlyArray<string>;
    readonly recordedAt?: string;
  },
): Promise<ClaimVisibilityState> {
  const claimIds = [...new Set(params.claimIds.filter(Boolean))];
  const recordedAt = params.recordedAt ?? new Date().toISOString();
  if (claimIds.length === 0) {
    const existing = await loadClaimVisibilityState(bookDir);
    if (existing.updatedAt === recordedAt) return existing;
    const next = { ...existing, updatedAt: recordedAt };
    await saveClaimVisibilityState(bookDir, next);
    return next;
  }

  const existing = await loadClaimVisibilityState(bookDir);
  const revealedById = new Map(existing.revealedToReader.map((entry) => [entry.claimId, entry]));
  for (const claimId of claimIds) {
    const current = revealedById.get(claimId);
    if (!current || params.chapter < current.revealedAtChapter) {
      revealedById.set(claimId, {
        claimId,
        revealedAtChapter: params.chapter,
      });
    }
  }

  const next = ClaimVisibilityStateSchema.parse({
    version: 1,
    updatedAt: recordedAt,
    revealedToReader: [...revealedById.values()].sort((left, right) => (
      left.revealedAtChapter - right.revealedAtChapter
      || left.claimId.localeCompare(right.claimId)
    )),
  });
  await saveClaimVisibilityState(bookDir, next);
  return next;
}

export function revealedClaimIds(state: ClaimVisibilityState): string[] {
  return state.revealedToReader.map((entry) => entry.claimId);
}
