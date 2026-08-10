export type EpisodeRecoveryCheckpoint =
  | { readonly kind: "none" }
  | { readonly kind: "committed-cleanup"; readonly episodeNumber: number; readonly operationId?: string }
  | { readonly kind: "rolled-back"; readonly episodeNumber: number; readonly rolledBackTo: number; readonly operationId?: string };

type EpisodeResultForCheckpoint = {
  readonly operationId?: string;
  readonly episodeNumber: number;
  readonly status: string;
  readonly recovery?: Exclude<EpisodeRecoveryCheckpoint, { readonly kind: "none" }>;
};

export interface EpisodeCheckpoint {
  readonly operationId: string | null;
  readonly episodeNumber: number;
  readonly status: string;
  readonly recovery: EpisodeRecoveryCheckpoint;
}

/** Stable machine-readable summary for a completed episode mutation. */
export function withEpisodeCheckpoint<T extends EpisodeResultForCheckpoint>(
  result: T,
): T & { readonly checkpoint: EpisodeCheckpoint } {
  return {
    ...result,
    checkpoint: {
      operationId: result.operationId ?? null,
      episodeNumber: result.episodeNumber,
      status: result.status,
      recovery: result.recovery ?? { kind: "none" },
    },
  };
}
