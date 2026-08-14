export type TruthAuthority =
  | "direction"
  | "foundation"
  | "rules"
  | "runtime-truth"
  | "memory";

const NORMALIZED_TRUTH_FILES = new Set([
  "author_intent.md",
  "current_focus.md",
  "story_bible.md",
  "volume_outline.md",
  "book_rules.md",
  "current_state.md",
  "pending_hooks.md",
  "episode_summaries.md",
]);

export function normalizeTruthFileName(fileName: string): string {
  const trimmed = fileName.trim().toLowerCase();
  if (
    !trimmed
    || trimmed.startsWith("/")
    || trimmed.includes("\\")
    || trimmed.includes("\0")
    || trimmed.split("/").some((segment) => segment === ".." || segment === ".")
  ) {
    throw new Error(`Invalid truth file name: ${JSON.stringify(fileName)}`);
  }
  const normalized = trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
  if (!NORMALIZED_TRUTH_FILES.has(normalized)) {
    return normalized;
  }
  return normalized;
}

export function classifyTruthAuthority(fileName: string): TruthAuthority {
  switch (normalizeTruthFileName(fileName)) {
    case "author_intent.md":
    case "current_focus.md":
      return "direction";
    case "story_bible.md":
    case "volume_outline.md":
      return "foundation";
    case "book_rules.md":
      return "rules";
    case "current_state.md":
    case "pending_hooks.md":
      return "runtime-truth";
    case "episode_summaries.md":
    default:
      return "memory";
  }
}
