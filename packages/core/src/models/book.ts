import { z } from "zod";

export const PlatformSchema = z.enum(["tomato", "feilu", "qidian", "other"]);
export type Platform = z.infer<typeof PlatformSchema>;

export function normalizePlatformId(platform: unknown): Platform | undefined {
  if (typeof platform !== "string") {
    return undefined;
  }

  const raw = platform.trim();
  if (!raw) {
    return undefined;
  }

  const lowered = raw.toLowerCase();
  const compact = lowered.replace(/[\s_-]+/g, "");

  if (compact === "tomato" || compact === "fanqie" || compact === "fanqienovel" || raw.includes("番茄")) {
    return "tomato";
  }
  if (compact === "qidian" || compact === "qidianzhongwenwang" || raw.includes("起点")) {
    return "qidian";
  }
  if (compact === "feilu" || raw.includes("飞卢")) {
    return "feilu";
  }
  if (compact === "other" || compact === "others" || raw.includes("其他") || raw.includes("其它")) {
    return "other";
  }

  return "other";
}

export function normalizePlatformOrOther(platform: unknown): Platform {
  return normalizePlatformId(platform) ?? "other";
}

export const GenreSchema = z.string().min(1);
export type Genre = z.infer<typeof GenreSchema>;

export const BookStatusSchema = z.enum([
  "incubating",
  "outlining",
  "active",
  "paused",
  "completed",
  "dropped",
]);
export type BookStatus = z.infer<typeof BookStatusSchema>;

export const BookConfigSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  platform: PlatformSchema,
  genre: GenreSchema,
  status: BookStatusSchema,
  /** InkOS now produces episodic screenplay scripts rather than novel prose. */
  format: z.literal("screenplay").optional(),
  schemaVersion: z.literal("inkos-episode-v2").optional(),
  targetEpisodes: z.number().int().min(1).max(100).optional(),
  episodeDurationSeconds: z.number().int().min(30).max(300).optional(),
  targetChapters: z.number().int().min(1).default(200),
  chapterWordCount: z.number().int().min(1000).default(3000),
  language: z.enum(["zh", "en"]).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  parentBookId: z.string().optional(),
  writing: z.object({
    reviewMode: z.enum(["auto", "manual"]).optional(),
    revisionGate: z.enum(["strict", "lenient", "always"]).optional(),
  }).optional(),
});

export type BookConfig = z.infer<typeof BookConfigSchema>;

/** Strict schema used by new creation/continuation entry points. */
export const ScreenplayBookConfigSchema = BookConfigSchema.extend({
  format: z.literal("screenplay"),
  targetEpisodes: z.number().int().min(1).max(100),
  episodeDurationSeconds: z.number().int().min(30).max(300),
});
export type ScreenplayBookConfig = z.infer<typeof ScreenplayBookConfigSchema>;

export const EpisodeBookConfigSchema = BookConfigSchema.extend({
  schemaVersion: z.literal("inkos-episode-v2"),
  format: z.literal("screenplay"),
  targetEpisodes: z.number().int().min(1).max(100),
  episodeDurationSeconds: z.number().int().min(30).max(300),
}).omit({ targetChapters: true, chapterWordCount: true });
export type EpisodeBookConfig = z.infer<typeof EpisodeBookConfigSchema>;

export class UnsupportedLegacyFormatError extends Error {
  readonly code = "UNSUPPORTED_LEGACY_FORMAT" as const;

  constructor(message = "This project uses the legacy novel/chapter format. Create a new InkOS episode project to continue.") {
    super(message);
    this.name = "UnsupportedLegacyFormatError";
  }
}

export function assertEpisodeBookConfig(book: BookConfig): EpisodeBookConfig {
  if (
    book.schemaVersion !== "inkos-episode-v2"
    || book.format !== "screenplay"
    || book.targetEpisodes === undefined
    || book.episodeDurationSeconds === undefined
  ) {
    throw new UnsupportedLegacyFormatError();
  }
  return EpisodeBookConfigSchema.parse(book);
}

export function assertScreenplayBookConfig(book: BookConfig): ScreenplayBookConfig {
  return ScreenplayBookConfigSchema.parse(book);
}

export type ChapterReviewMode = "auto" | "manual";

/**
 * Resolve the effective chapter review mode for a book:
 * book-level `writing.reviewMode` (book.json) overrides the project-level
 * `writing.reviewMode` (inkos.json); both unset falls back to "auto".
 */
export function resolveChapterReviewMode(
  book: Pick<BookConfig, "writing">,
  projectWriting?: { readonly reviewMode?: ChapterReviewMode },
): ChapterReviewMode {
  return book.writing?.reviewMode ?? projectWriting?.reviewMode ?? "auto";
}

export type RevisionGate = "strict" | "lenient" | "always";

/**
 * Resolve the effective manual-revision gate for a book:
 * book-level `writing.revisionGate` (book.json) overrides the project-level
 * `writing.revisionGate` (inkos.json); both unset falls back to "strict".
 *
 * - "strict": apply only when audit counts do not worsen AND at least one of
 *   blocking/AI-tell improves (historical default behavior).
 * - "lenient": apply whenever audit counts do not worsen (no improvement required).
 * - "always": always apply manual revisions; audit counts are recorded only.
 */
export function resolveRevisionGate(
  book: Pick<BookConfig, "writing">,
  projectWriting?: { readonly revisionGate?: RevisionGate },
): RevisionGate {
  return book.writing?.revisionGate ?? projectWriting?.revisionGate ?? "strict";
}
