const WRITABLE_TRUTH_FLAT_FILES = new Set([
  "author_intent.md",
  "current_focus.md",
  "story_bible.md",
  "volume_outline.md",
  "book_rules.md",
  "current_state.md",
  "particle_ledger.md",
  "pending_hooks.md",
  "chapter_summaries.md",
  "subplot_board.md",
  "emotional_arcs.md",
  "style_guide.md",
  "parent_canon.md",
  "character_matrix.md",
]);

const WRITABLE_TRUTH_OUTLINE_FILES = new Set([
  "outline/story_frame.md",
  "outline/volume_map.md",
  "outline/节奏原则.md",
  "outline/rhythm_principles.md",
]);

const WRITABLE_ROLE_TRUTH_FILE_RE = /^roles\/(主要角色|次要角色|major|minor)\/[^/\\]+\.md$/u;

export const LEGACY_TRUTH_SHIM_FILES = new Set(["story_bible.md", "book_rules.md"]);

export const RUNTIME_DIAGNOSTIC_TRUTH_FILE_RE = /^runtime\/(?:chapter-\d{4}\.(?:intent\.md|plan\.md|context\.json|rule-stack\.yaml|trace\.json|claims\.json|claim-brief\.md)|recovery\.json|tier2_current_arc\.md|volume-contracts\.json|volume-progress\.json|volume-dashboard\.md|volume-\d{3}\.(?:contract\.json|dashboard\.md))$/;

export function assertSafeTruthFileName(fileName: string): string {
  const trimmed = fileName.trim();
  const withExtension = trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
  const lower = withExtension.toLowerCase();
  if (
    !trimmed
    || withExtension.startsWith("/")
    || withExtension.includes("\\")
    || withExtension.includes("\0")
    || withExtension.includes("..")
  ) {
    throw new Error(`Invalid truth file name: ${JSON.stringify(fileName)}`);
  }
  if (WRITABLE_TRUTH_FLAT_FILES.has(lower)) return lower;
  if (WRITABLE_TRUTH_OUTLINE_FILES.has(lower)) return lower;
  if (WRITABLE_ROLE_TRUTH_FILE_RE.test(withExtension)) return withExtension;
  throw new Error(`Invalid truth file name: ${JSON.stringify(fileName)}`);
}

export function isRuntimeDiagnosticTruthFile(fileName: string): boolean {
  return RUNTIME_DIAGNOSTIC_TRUTH_FILE_RE.test(fileName);
}
