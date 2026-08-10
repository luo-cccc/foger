/**
 * POV-aware context filtering.
 *
 * Filters truth file content based on the current POV character's
 * information boundaries. Characters should only "see" information
 * they've actually witnessed or been told about.
 *
 * Works with markdown-based truth files (no DB dependency).
 * When MemoryDB is available, can do more precise queries.
 */

/**
 * Extract the POV character from the volume outline for a given episode.
 * Looks for patterns like "POV: 角色名" or "视角: 角色名" or "POV: CharacterName"
 * in the episode's section of the outline.
 */
export function extractPOVFromOutline(volumeOutline: string, episodeNumber: number): string | null {
  // Find the section for this episode
  const lines = volumeOutline.split("\n");

  // Look for episode reference near the episode number
  const episodePatterns = [
    new RegExp(`第${episodeNumber}集`),
    new RegExp(`Episode\\s+${episodeNumber}\\b`),
    new RegExp(`\\b${episodeNumber}\\b.*集`),
  ];

  let inEpisodeSection = false;
  for (const line of lines) {
    // Check if we're in the right episode section
    if (episodePatterns.some((p) => p.test(line))) {
      inEpisodeSection = true;
    } else if (inEpisodeSection && /^[#-]/.test(line) && !line.includes(String(episodeNumber))) {
      // Left the episode section
      break;
    }

    if (inEpisodeSection) {
      // Look for POV declaration
      const povMatch = line.match(/(?:POV|视角|pov)[：:\s]+([^\s，,。.、]+)/i);
      if (povMatch) return povMatch[1]!;
    }
  }

  return null;
}

/**
 * Filter character_matrix information boundaries for the POV character.
 * Returns only what the POV character knows — strips other characters' "known info".
 */
export function filterMatrixByPOV(characterMatrix: string, povCharacter: string): string {
  if (!characterMatrix || characterMatrix === "(文件尚未创建)") return characterMatrix;
  if (!povCharacter) return characterMatrix;

  // Find the 信息边界 / Information Boundaries section
  const sections = characterMatrix.split(/(?=^###)/m);
  const filtered = sections.map((section) => {
    const isInfoBoundary = /信息边界|Information\s+Boundar/i.test(section);
    if (!isInfoBoundary) return section;

    // In the info boundary table, keep only the POV character's row
    // and add a note about what other characters know
    const lines = section.split("\n");
    const headerLines = lines.filter((l) =>
      l.startsWith("|") && (l.includes("---") || l.includes("角色") || l.includes("Character") || l.includes("已知") || l.includes("Known")),
    );
    const dataLines = lines.filter((l) =>
      l.startsWith("|") && !l.includes("---") && !l.includes("角色") && !l.includes("Character") && !l.includes("已知") && !l.includes("Known"),
    );

    // Keep POV character's row + a summary note
    const povRows = dataLines.filter((l) => l.includes(povCharacter));
    const otherCharCount = dataLines.length - povRows.length;

    const sectionHeader = lines.find((l) => l.startsWith("###"));
    const result = [
      sectionHeader ?? "### 信息边界",
      `（当前视角：${povCharacter}，其他 ${otherCharCount} 个角色的信息边界已隐藏）`,
      ...headerLines,
      ...povRows,
    ];

    return result.join("\n");
  });

  return filtered.join("\n");
}

/**
 * Filter pending_hooks by POV character's knowledge.
 * Hooks planted in scenes where the POV character was NOT present are hidden.
 *
 * This is a heuristic: if the hook's episode summary mentions the POV character,
 * they likely know about it.
 */
export function filterHooksByPOV(
  hooks: string,
  povCharacter: string,
  episodeSummaries: string,
): string {
  if (!hooks || hooks === "(文件尚未创建)") return hooks;
  if (!povCharacter) return hooks;

  const lines = hooks.split("\n");
  const headerLines = lines.filter((l) =>
    l.startsWith("|") && (l.includes("hook_id") || l.includes("---")),
  );
  const dataLines = lines.filter((l) =>
    l.startsWith("|") && !l.includes("hook_id") && !l.includes("---"),
  );

  // Parse summary rows to find which episodes the POV character appeared in
  const povEpisodes = new Set<number>();
  if (episodeSummaries) {
    for (const line of episodeSummaries.split("\n")) {
      if (line.includes(povCharacter)) {
        const match = line.match(/\|\s*(\d+)\s*\|/);
        if (match) povEpisodes.add(parseInt(match[1]!, 10));
      }
    }
  }

  // Keep hooks where:
  // 1. The POV character was present in the source episode, OR
  // 2. The hook mentions the POV character directly, OR
  // 3. We can't determine (keep to be safe)
  const filtered = dataLines.filter((row) => {
    // If hook directly mentions POV character, keep it
    if (row.includes(povCharacter)) return true;

    // Extract source episode from hook row
    const episodeMatch = row.match(/\|\s*(\d+)\s*\|/);
    if (!episodeMatch) return true; // can't determine, keep

    const sourceEpisode = parseInt(episodeMatch[1]!, 10);
    // If POV was in that episode, they know about the hook
    if (povEpisodes.has(sourceEpisode)) return true;

    // POV wasn't in that episode — hide this hook
    return false;
  });

  // Fallback: if filtering removes everything, return original
  if (filtered.length === 0 && dataLines.length > 0) return hooks;

  const nonTableLines = lines.filter((l) => !l.startsWith("|"));
  return [...nonTableLines, ...headerLines, ...filtered].join("\n");
}
