import { BaseAgent } from "./base.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readVolumeMap } from "../utils/outline-paths.js";
import {
  parsePendingHooksMarkdown,
  renderHookSnapshot,
} from "../utils/story-markdown.js";
import type { StoredHook } from "../state/memory-db.js";

export interface ConsolidationResult {
  readonly volumeSummaries: string;
  readonly archivedVolumes: number;
  readonly retainedEpisodes: number;
  /**
   * Phase 7 hotfix 2: number of ledger hooks whose `promoted` flag flipped
   * from false to true during this consolidation run (advanced_count rule).
   * 0 when pending_hooks.md is absent or no hook crossed the threshold.
   */
  readonly promotedHookCount: number;
}

/**
 * Consolidates episode summaries into volume-level narrative summaries.
 * Reduces token usage for long books while preserving critical context.
 */
export class ConsolidatorAgent extends BaseAgent {
  get name(): string {
    return "consolidator";
  }

  /**
   * Consolidate episode summaries by volume.
   * - Reads outline/volume_map.md (fallback: legacy volume_outline.md) to
   *   determine volume boundaries
   * - For each completed volume, LLM compresses episode summaries into a narrative paragraph
   * - Archives detailed summaries, keeps only recent volume's per-episode rows
   */
  async consolidate(bookDir: string): Promise<ConsolidationResult> {
    const storyDir = join(bookDir, "story");
    const summariesPath = join(storyDir, "episode_summaries.md");
    const volumeSummariesPath = join(storyDir, "volume_summaries.md");

    const [summariesRaw, outlineRaw] = await Promise.all([
      readFile(summariesPath, "utf-8").catch(() => ""),
      readVolumeMap(bookDir, ""),
    ]);

    // Phase 7 hotfix 2: pre-archive re-promotion pass. Runs independently of
    // summary consolidation so a new book (no completed volumes yet) still
    // flips the `promoted` flag whenever a seed's advanced_count crosses the
    // threshold.
    const promotedHookCount = await this.rerunAdvancedCountPromotion(storyDir);

    if (!summariesRaw || !outlineRaw) {
      return { volumeSummaries: "", archivedVolumes: 0, retainedEpisodes: 0, promotedHookCount };
    }

    // Parse volume boundaries from outline
    const volumeBoundaries = this.parseVolumeBoundaries(outlineRaw);
    if (volumeBoundaries.length === 0) {
      return { volumeSummaries: "", archivedVolumes: 0, retainedEpisodes: 0, promotedHookCount };
    }

    // Parse episode summaries into rows
    const { header, rows } = this.parseSummaryTable(summariesRaw);
    if (rows.length === 0) {
      return { volumeSummaries: "", archivedVolumes: 0, retainedEpisodes: 0, promotedHookCount };
    }

    const maxEpisode = Math.max(...rows.map((r) => r.episode));

    // Determine which volumes are "completed" (all episodes written)
    const completedVolumes: Array<{ name: string; startCh: number; endCh: number; rows: typeof rows }> = [];
    const currentVolumeRows: typeof rows = [];

    for (const vol of volumeBoundaries) {
      const volRows = rows.filter((r) => r.episode >= vol.startCh && r.episode <= vol.endCh);
      if (vol.endCh <= maxEpisode && volRows.length > 0) {
        completedVolumes.push({ ...vol, rows: volRows });
      } else {
        // Current/incomplete volume — keep detailed rows
        currentVolumeRows.push(...volRows);
      }
    }

    // Also keep any rows not covered by volume boundaries
    const coveredEpisodes = new Set(volumeBoundaries.flatMap((v) => {
      const chs: number[] = [];
      for (let i = v.startCh; i <= v.endCh; i++) chs.push(i);
      return chs;
    }));
    for (const r of rows) {
      if (!coveredEpisodes.has(r.episode)) currentVolumeRows.push(r);
    }

    if (completedVolumes.length === 0) {
      return {
        volumeSummaries: "",
        archivedVolumes: 0,
        retainedEpisodes: currentVolumeRows.length,
        promotedHookCount,
      };
    }

    // LLM consolidation for each completed volume
    const existingVolSummaries = await readFile(volumeSummariesPath, "utf-8").catch(() => "");
    const newSummaries: string[] = existingVolSummaries ? [existingVolSummaries.trim()] : ["# Volume Summaries\n"];

    for (const vol of completedVolumes) {
      const volSummaryRows = vol.rows.map((r) => r.raw).join("\n");

      const response = await this.chat([
        {
          role: "system",
          content: `You are a narrative summarizer. Compress episode-by-episode summaries into a single coherent paragraph (max 500 words) that captures the key events, character developments, and plot progression of this volume. Preserve specific names, locations, and plot points. Write in the same language as the input.`,
        },
        {
          role: "user",
          content: `Volume: ${vol.name} (Episodes ${vol.startCh}-${vol.endCh})\n\nEpisode summaries:\n${header}\n${volSummaryRows}`,
        },
      ], { temperature: 0.3, stream: false, callPhase: "consolidate" });

      newSummaries.push(`\n## ${vol.name} (Episodes ${vol.startCh}-${vol.endCh})\n\n${response.content.trim()}`);
    }

    // Write volume summaries
    await writeFile(volumeSummariesPath, newSummaries.join("\n"), "utf-8");

    // Archive detailed summaries
    const archiveDir = join(storyDir, "summaries_archive");
    await mkdir(archiveDir, { recursive: true });
    for (const vol of completedVolumes) {
      const archivePath = join(archiveDir, `vol_${vol.startCh}-${vol.endCh}.md`);
      await writeFile(archivePath, `# ${vol.name}\n\n${header}\n${vol.rows.map((r) => r.raw).join("\n")}`, "utf-8");
    }

    // Rewrite episode_summaries.md with only current volume rows
    const retainedContent = currentVolumeRows.length > 0
      ? `${header}\n${currentVolumeRows.map((r) => r.raw).join("\n")}\n`
      : `${header}\n`;
    await writeFile(summariesPath, retainedContent, "utf-8");

    return {
      volumeSummaries: newSummaries.join("\n"),
      archivedVolumes: completedVolumes.length,
      retainedEpisodes: currentVolumeRows.length,
      promotedHookCount,
    };
  }

  /**
   * Phase 7 hotfix 2 — re-run promotion for seeds whose advancedCount has
   * crossed the 2-episode threshold since architect seed time. Delegates to
   * the shared `rerunPromotionPass` in utils/hook-promotion.ts.
   *
   * Returns the number of hooks that flipped from promoted=false (or
   * undefined) to promoted=true this run.
   */
  private async rerunAdvancedCountPromotion(storyDir: string): Promise<number> {
    const ledgerPath = join(storyDir, "pending_hooks.md");
    const raw = await readFile(ledgerPath, "utf-8").catch(() => "");
    if (!raw.trim()) return 0;

    const hooks = parsePendingHooksMarkdown(raw);
    if (hooks.length === 0) return 0;

    const language: "zh" | "en" = /[\u4e00-\u9fff]/.test(raw) ? "zh" : "en";
    const summariesRaw = await readFile(join(storyDir, "episode_summaries.md"), "utf-8").catch(() => "");

    const { rerunPromotionPass } = await import("../utils/hook-promotion.js");
    const result = rerunPromotionPass(hooks, summariesRaw);
    if (!result.updated) return 0;

    await writeFile(ledgerPath, renderHookSnapshot([...result.hooks], language), "utf-8");
    return result.flippedCount;
  }

  private parseVolumeBoundaries(outline: string): Array<{ name: string; startCh: number; endCh: number }> {
    const volumes: Array<{ name: string; startCh: number; endCh: number }> = [];
    const lines = outline.split("\n");
    const volumeHeader = /^(第[一二三四五六七八九十百千万零〇\d]+卷|Volume\s+\d+)/i;
    const rangePattern = /[（(]\s*(?:第|[Cc]hapters?\s+)?(\d+)\s*[-–~～—]\s*(\d+)\s*(?:章)?\s*[）)]|(?:第|[Cc]hapters?\s+)(\d+)\s*[-–~～—]\s*(\d+)\s*(?:章)?/i;

    for (const rawLine of lines) {
      const line = rawLine.replace(/^#+\s*/, "").trim();
      if (!volumeHeader.test(line)) continue;

      const rangeMatch = line.match(rangePattern);
      if (!rangeMatch) continue;

      const startCh = parseInt(rangeMatch[1] ?? rangeMatch[3] ?? "0", 10);
      const endCh = parseInt(rangeMatch[2] ?? rangeMatch[4] ?? "0", 10);
      if (startCh <= 0 || endCh <= 0) continue;

      const rangeIndex = rangeMatch.index ?? line.length;
      const name = line.slice(0, rangeIndex).replace(/[（(]\s*$/, "").trim();
      if (name.length > 0) {
        volumes.push({ name, startCh, endCh });
      }
    }
    return volumes;
  }

  private parseSummaryTable(raw: string): { header: string; rows: Array<{ episode: number; raw: string }> } {
    const lines = raw.split("\n");
    const headerLines = lines.filter((l) => l.startsWith("|") && (l.includes("章节") || l.includes("Episode") || l.includes("---")));
    const dataLines = lines.filter((l) => l.startsWith("|") && !l.includes("章节") && !l.includes("Episode") && !l.includes("---"));

    const header = headerLines.join("\n");
    const rows = dataLines.map((line) => {
      const match = line.match(/\|\s*(\d+)\s*\|/);
      return { episode: match ? parseInt(match[1]!, 10) : 0, raw: line };
    }).filter((r) => r.episode > 0);

    return { header, rows };
  }
}
