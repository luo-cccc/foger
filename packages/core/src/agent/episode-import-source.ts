import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { splitEpisodes, type SplitEpisode } from "../utils/episode-splitter.js";
import { parseEpisodeScriptOutput, renderEpisodeScriptMarkdown } from "../models/episode-script.js";

function normalizeImportedEpisode(content: string, source: string): SplitEpisode {
  try {
    const script = parseEpisodeScriptOutput(content);
    return { title: script.title, content: renderEpisodeScriptMarkdown(script) };
  } catch (error) {
    throw new Error(
      `INVALID_EPISODE_SCRIPT_IMPORT: ${source} is not a valid EpisodeScript JSON/Markdown artifact: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Load episodes from a local source path for `import_episodes`.
 *
 * - Directory mode: each `.md`/`.json` file becomes one episode, in filename
 *   sort order. The episode title is the filename without its extension and
 *   without a leading numeric prefix (e.g. `03_风暴.md` → `风暴`).
 * - Single-file mode: the file is split into episodes with `splitEpisodes`,
 *   using `splitPattern` as a custom heading regex when provided.
 *
 * This mirrors the pure loading logic of `inkos import episodes` in the CLI
 * so the agent tool does not depend on the CLI package.
 */
export async function loadEpisodesFromPath(
  sourcePath: string,
  splitPattern?: string,
): Promise<ReadonlyArray<SplitEpisode>> {
  const sourceStat = await stat(sourcePath);

  if (sourceStat.isDirectory()) {
    const entries = await readdir(sourcePath);
    const textFiles = entries
      .filter((f) => f.endsWith(".md") || f.endsWith(".json"))
      .sort();

    if (textFiles.length === 0) {
      throw new Error(`No EpisodeScript .md or .json files found in ${sourcePath}.`);
    }

    return Promise.all(
      textFiles.map(async (f) => {
        const path = join(sourcePath, f);
        const content = await readFile(path, "utf-8");
        return normalizeImportedEpisode(content, path);
      }),
    );
  }

  if (!/\.(md|json)$/i.test(sourcePath)) {
    throw new Error("UNSUPPORTED_EPISODE_IMPORT_FORMAT: import EpisodeScript JSON or Markdown files only.");
  }
  const text = await readFile(sourcePath, "utf-8");
  try {
    return [normalizeImportedEpisode(text, sourcePath)];
  } catch (singleError) {
    const episodes = splitEpisodes(text, splitPattern);
    if (episodes.length === 0) throw singleError;
    return episodes.map((episode, index) =>
      normalizeImportedEpisode(episode.content, `${sourcePath}#episode-${index + 1}`),
    );
  }
}
