/** Shared TypeScript contracts for Studio API/UI communication. */

import type { BookConfig, EpisodeMeta, EpisodePerformanceReport } from "@actalk/inkos-core";

// --- Health ---

export interface HealthStatus {
  readonly status: "ok";
  readonly projectRoot: string;
  readonly projectConfigFound: boolean;
  readonly envFound: boolean;
  readonly projectEnvFound: boolean;
  readonly globalConfigFound: boolean;
  readonly bookCount: number;
  readonly provider: string | null;
  readonly model: string | null;
}

// --- Books ---

export type BookSummary = Pick<
  BookConfig,
  "id" | "title" | "genre" | "status" | "language"
> & {
  readonly episodesWritten: number;
};

export type BookDetail = BookConfig;

export interface BookListResponse {
  readonly books: ReadonlyArray<BookSummary>;
}

export interface BookDetailResponse {
  readonly book: BookDetail;
  readonly episodes: ReadonlyArray<EpisodeMeta & { readonly performanceReport?: EpisodePerformanceReport }>;
  readonly nextEpisode: number;
  readonly seriesPerformance?: {
    readonly totalCalls: number;
    readonly totalTokens: number;
    readonly averageContextEstimatedTokens: number;
    readonly cacheHits: number;
    readonly cacheMisses: number;
  };
}

// --- Episodes ---

export type EpisodeSummary = EpisodeMeta;

export type EpisodeDetail = EpisodeMeta & {
  readonly content: string;
};

export interface SaveEpisodePayload {
  readonly content: string;
}

// --- Truth Files ---

export interface TruthFileSummary {
  readonly name: string;
  readonly label: string;
  readonly exists: boolean;
  readonly path: string;
  readonly optional: boolean;
  readonly available: boolean;
}

export interface TruthFileDetail extends TruthFileSummary {
  readonly content: string | null;
}

// --- Review ---

export interface ReviewActionPayload {
  readonly episodeNumber: number;
  readonly reason?: string;
}

// --- Runs ---

export type RunAction = "draft" | "audit" | "revise" | "write-next";

export type RunStatus = "queued" | "running" | "succeeded" | "failed";

export interface RunLogEntry {
  readonly timestamp: string;
  readonly level: "info" | "warn" | "error";
  readonly message: string;
}

export interface RunActionPayload {
  readonly episodeNumber?: number;
}

export interface StudioRun {
  readonly id: string;
  readonly bookId: string;
  readonly episode: number | null;
  readonly episodeNumber: number | null;
  readonly action: RunAction;
  readonly status: RunStatus;
  readonly stage: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly logs: ReadonlyArray<RunLogEntry>;
  readonly result?: unknown;
  readonly error?: string;
}

export interface RunStreamEvent {
  readonly type: "snapshot" | "status" | "stage" | "log";
  readonly runId: string;
  readonly run?: StudioRun;
  readonly status?: RunStatus;
  readonly stage?: string;
  readonly log?: RunLogEntry;
  readonly result?: unknown;
  readonly error?: string;
}

// --- API Error Response ---

export interface ApiErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}
