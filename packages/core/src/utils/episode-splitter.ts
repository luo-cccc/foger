export interface SplitEpisode {
  readonly title: string;
  readonly content: string;
}

/**
 * Split a single text file into episodes by matching title lines.
 *
 * Default pattern matches:
 * - "第一集 xxxx" / "第1集 xxxx"
 * - "# 第1集 xxxx" / "## 第23集 xxxx"
 * - "EPISODE I." / "EPISODE II."
 *
 * Each match marks the start of a new episode. Content between matches
 * belongs to the preceding episode.
 */
export function splitEpisodes(
  text: string,
  pattern?: string,
): ReadonlyArray<SplitEpisode> {
  const defaultPattern = /^#{0,2}\s*(?:第[零〇○Ｏ０一二三四五六七八九十百千万\d]+集(?:[:：]|\s+)?\s*(.*)|Episode\s+(?:\d+|[IVXLCDM]+)(?:\.|:|\s+)?\s*(.*))/i;
  const regex = pattern ? new RegExp(pattern, "m") : defaultPattern;

  const lines = text.split("\n");
  const episodes: Array<{ title: string; startLine: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(regex);
    if (match) {
      episodes.push({
        title: (match[1] ?? match[2] ?? "").trim(),
        startLine: i,
      });
    }
  }

  if (episodes.length === 0) {
    return [];
  }

  const result: SplitEpisode[] = [];

  for (let i = 0; i < episodes.length; i++) {
    const episode = episodes[i]!;
    const nextStart = i + 1 < episodes.length ? episodes[i + 1]!.startLine : lines.length;

    // Content starts after the title line
    const contentLines = lines.slice(episode.startLine + 1, nextStart);
    const content = stripTrailingLicense(contentLines.join("\n")).trim();

    result.push({
      title: episode.title || inferFallbackTitle(lines[episode.startLine] ?? "", i + 1),
      content,
    });
  }

  return result;
}

function stripTrailingLicense(content: string): string {
  const trailerMatch = content.match(/^\s*Project Gutenberg(?:™|\(TM\))?.*$/im);
  if (!trailerMatch || trailerMatch.index === undefined) {
    return content;
  }

  return content.slice(0, trailerMatch.index).trimEnd();
}

function inferFallbackTitle(headingLine: string, episodeNumber: number): string {
  if (/episode\s+(?:\d+|[ivxlcdm]+)/i.test(headingLine)) {
    return `Episode ${episodeNumber}`;
  }

  return `第${episodeNumber}集`;
}
