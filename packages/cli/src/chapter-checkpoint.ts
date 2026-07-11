export type ChapterRecoveryCheckpoint =
  | { readonly kind: "none" }
  | { readonly kind: "committed-cleanup"; readonly chapterNumber: number; readonly operationId?: string }
  | { readonly kind: "rolled-back"; readonly chapterNumber: number; readonly rolledBackTo: number; readonly operationId?: string };

type ChapterResultForCheckpoint = {
  readonly operationId?: string;
  readonly chapterNumber: number;
  readonly status: string;
  readonly recovery?: Exclude<ChapterRecoveryCheckpoint, { readonly kind: "none" }>;
};

export interface ChapterCheckpoint {
  readonly operationId: string | null;
  readonly chapterNumber: number;
  readonly status: string;
  readonly recovery: ChapterRecoveryCheckpoint;
}

/** Stable machine-readable summary for a completed chapter mutation. */
export function withChapterCheckpoint<T extends ChapterResultForCheckpoint>(
  result: T,
): T & { readonly checkpoint: ChapterCheckpoint } {
  return {
    ...result,
    checkpoint: {
      operationId: result.operationId ?? null,
      chapterNumber: result.chapterNumber,
      status: result.status,
      recovery: result.recovery ?? { kind: "none" },
    },
  };
}
