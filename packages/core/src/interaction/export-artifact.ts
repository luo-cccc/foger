import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EpisodeScriptSchema, renderEpisodeScriptMarkdown, type EpisodeScript } from "../models/episode-script.js";

export type EpisodeExportFormat = "screenplay-md" | "screenplay-json" | "dialogue";

function assertEpisodeExportFormat(value: string | undefined): EpisodeExportFormat {
  if (value === undefined || value === "screenplay-md" || value === "screenplay-json" || value === "dialogue") {
    return value ?? "screenplay-md";
  }
  throw new Error(`UNSUPPORTED_EXPORT_FORMAT: ${value}. Use screenplay-md, screenplay-json, or dialogue.`);
}

export interface ExportStateLike {
  readonly bookDir: (bookId: string) => string;
  readonly loadBookConfig: (bookId: string) => Promise<{ readonly title: string }>;
  readonly loadEpisodeIndex: (bookId: string) => Promise<ReadonlyArray<{
    readonly episodeNumber: number;
    readonly status: string;
    readonly episodeDurationSeconds: number;
  }>>;
}

export interface ExportArtifact {
  readonly outputPath: string;
  readonly fileName: string;
  readonly episodesExported: number;
  readonly totalDurationSeconds: number;
  readonly format: EpisodeExportFormat;
  readonly contentType: string;
  readonly payload: string;
}

function buildEpisodeFileLookup(files: ReadonlyArray<string>, extension: ".json"): ReadonlyMap<number, string> {
  const lookup = new Map<number, string>();
  for (const file of files) {
    if (!file.endsWith(extension) || file.endsWith("_review.json")) continue;
    const match = file.match(/^(\d{4})[_-]/u);
    if (!match) continue;
    const episodeNumber = Number.parseInt(match[1]!, 10);
    if (!lookup.has(episodeNumber)) lookup.set(episodeNumber, file);
  }
  return lookup;
}

export async function buildExportArtifact(
  state: ExportStateLike,
  bookId: string,
  options: {
    readonly format?: EpisodeExportFormat;
    readonly approvedOnly?: boolean;
    readonly outputPath?: string;
  },
): Promise<ExportArtifact> {
  const format = assertEpisodeExportFormat(options.format);
  const [index, book] = await Promise.all([
    state.loadEpisodeIndex(bookId),
    state.loadBookConfig(bookId),
  ]);
  const nonDeliverableEpisodes = index.filter((episode) =>
    episode.status !== "approved" && episode.status !== "published",
  );
  if (!options.approvedOnly && nonDeliverableEpisodes.length > 0) {
    throw new Error(
      `EXPORT_BLOCKED_BY_EPISODE_STATUS: approve every episode before default export (episodes: ${nonDeliverableEpisodes.map((episode) => `${episode.episodeNumber}:${episode.status}`).join(", ")}).`,
    );
  }
  const episodes = options.approvedOnly
    ? index.filter((episode) => episode.status === "approved")
    : index;
  if (episodes.length === 0) throw new Error("No episodes to export.");

  const bookDir = state.bookDir(bookId);
  const episodesDir = join(bookDir, "episodes");
  const projectRoot = dirname(dirname(bookDir));
  const outputPath = options.outputPath ?? join(projectRoot, `${bookId}_export.${format}`);
  const files = await readdir(episodesDir).catch(() => [] as string[]);
  const jsonFiles = buildEpisodeFileLookup(files, ".json");
  const scripts: EpisodeScript[] = [];
  for (const episode of episodes) {
    const file = jsonFiles.get(episode.episodeNumber);
    if (!file) {
      throw new Error(`EXPORT_MISSING_AUTHORITATIVE_EPISODE: episode ${episode.episodeNumber} has no screenplay JSON.`);
    }
    try {
      scripts.push(EpisodeScriptSchema.parse(JSON.parse(await readFile(join(episodesDir, file), "utf8"))));
    } catch (error) {
      throw new Error(
        `EXPORT_INVALID_AUTHORITATIVE_EPISODE: episode ${episode.episodeNumber} JSON is invalid.`,
        { cause: error },
      );
    }
  }
  const totalDurationSeconds = scripts.reduce((sum, script) => sum + script.estimatedDurationSeconds, 0);

  let payload: string;
  let fileName: string;
  let contentType: string;
  if (format === "screenplay-md") {
    const parts = [`# ${book.title}\n\n---\n\n`];
    for (const script of scripts) {
      parts.push(renderEpisodeScriptMarkdown(script), "\n\n---\n\n");
    }
    payload = parts.join("");
    fileName = `${bookId}.screenplay.md`;
    contentType = "text/markdown; charset=utf-8";
  } else {
    const exportedScripts: EpisodeScript[] = [];
    const dialogueLines: string[] = [];
    for (const script of scripts) {
      if (format === "screenplay-json") {
        exportedScripts.push(script);
        continue;
      }
      dialogueLines.push(`# Episode ${script.episode}`);
      for (const scene of script.scenes) {
        for (const shot of scene.shots) {
          for (const line of shot.dialogue) {
            if (line.speaker && line.text) dialogueLines.push(`${line.speaker}：${line.text}`);
          }
        }
      }
      dialogueLines.push("");
    }
    payload = format === "screenplay-json"
      ? `${JSON.stringify({ title: book.title, episodes: exportedScripts }, null, 2)}\n`
      : `${dialogueLines.join("\n").trimEnd()}\n`;
    fileName = format === "screenplay-json" ? `${bookId}.screenplay.json` : `${bookId}.dialogue.txt`;
    contentType = format === "screenplay-json"
      ? "application/json; charset=utf-8"
      : "text/plain; charset=utf-8";
  }

  return {
    outputPath,
    fileName,
    episodesExported: scripts.length,
    totalDurationSeconds,
    format,
    contentType,
    payload,
  };
}

export async function writeExportArtifact(
  state: ExportStateLike,
  bookId: string,
  options: {
    readonly format?: EpisodeExportFormat;
    readonly approvedOnly?: boolean;
    readonly outputPath?: string;
  },
): Promise<Omit<ExportArtifact, "payload" | "contentType" | "fileName">> {
  const artifact = await buildExportArtifact(state, bookId, options);
  await mkdir(dirname(artifact.outputPath), { recursive: true });
  await writeFile(artifact.outputPath, artifact.payload, "utf8");
  return {
    outputPath: artifact.outputPath,
    episodesExported: artifact.episodesExported,
    totalDurationSeconds: artifact.totalDurationSeconds,
    format: artifact.format,
  };
}
