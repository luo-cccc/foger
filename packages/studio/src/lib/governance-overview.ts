export type GovernanceOverviewKind =
  | "current_arc"
  | "volume_dashboard"
  | "volume_progress"
  | "volume_contracts"
  | "chapter_intent"
  | "chapter_context"
  | "chapter_claim_brief"
  | "chapter_rule_stack"
  | "chapter_trace";

export interface GovernanceOverviewTarget {
  readonly kind: GovernanceOverviewKind;
  readonly name: string;
}

export interface GovernanceOverviewSection {
  readonly id: "volume" | "chapter";
  readonly status: "complete" | "partial";
  readonly targets: ReadonlyArray<GovernanceOverviewTarget>;
  readonly missing: ReadonlyArray<string>;
}

export function pickGovernanceOverviewTargets(
  files: ReadonlyArray<{ readonly name: string }>,
): ReadonlyArray<GovernanceOverviewTarget> {
  const names = new Set(files.map((file) => file.name));
  const latestChapter = latestNumber(files, /^runtime\/chapter-(\d{4})\./);
  const latestVolume = latestNumber(files, /^runtime\/volume-(\d{3})\./);

  const targets: GovernanceOverviewTarget[] = [];
  pushTarget(targets, names, "current_arc", "runtime/tier2_current_arc.md");
  pushTarget(targets, names, "volume_dashboard", "runtime/volume-dashboard.md");
  if (!targets.some((target) => target.kind === "volume_dashboard") && latestVolume !== null) {
    pushTarget(targets, names, "volume_dashboard", `runtime/volume-${latestVolume}.dashboard.md`);
  }
  pushTarget(targets, names, "volume_progress", "runtime/volume-progress.json");
  pushTarget(targets, names, "volume_contracts", "runtime/volume-contracts.json");

  if (latestChapter !== null) {
    pushTarget(targets, names, "chapter_intent", `runtime/chapter-${latestChapter}.intent.md`);
    pushTarget(targets, names, "chapter_context", `runtime/chapter-${latestChapter}.context.json`);
    pushTarget(targets, names, "chapter_claim_brief", `runtime/chapter-${latestChapter}.claim-brief.md`);
    pushTarget(targets, names, "chapter_rule_stack", `runtime/chapter-${latestChapter}.rule-stack.yaml`);
    pushTarget(targets, names, "chapter_trace", `runtime/chapter-${latestChapter}.trace.json`);
  }

  return targets;
}

export function latestRuntimeChapter(
  files: ReadonlyArray<{ readonly name: string }>,
): string | null {
  return latestNumber(files, /^runtime\/chapter-(\d{4})\./);
}

export function latestRuntimeVolume(
  files: ReadonlyArray<{ readonly name: string }>,
): string | null {
  return latestNumber(files, /^runtime\/volume-(\d{3})\./);
}

export function buildGovernanceOverviewSections(
  files: ReadonlyArray<{ readonly name: string }>,
): ReadonlyArray<GovernanceOverviewSection> {
  const names = new Set(files.map((file) => file.name));
  const latestChapter = latestRuntimeChapter(files);
  const latestVolume = latestRuntimeVolume(files);
  const targets = pickGovernanceOverviewTargets(files);

  const sections: GovernanceOverviewSection[] = [];

  const volumeTargets = targets.filter((target) =>
    target.kind === "current_arc"
    || target.kind === "volume_dashboard"
    || target.kind === "volume_progress"
    || target.kind === "volume_contracts"
  );
  const volumeMissing = [
    maybeMissing(names, "runtime/tier2_current_arc.md"),
    maybeMissing(names, names.has("runtime/volume-dashboard.md")
      ? "runtime/volume-dashboard.md"
      : latestVolume
        ? `runtime/volume-${latestVolume}.dashboard.md`
        : null),
    maybeMissing(names, "runtime/volume-progress.json"),
    maybeMissing(names, "runtime/volume-contracts.json"),
  ].filter((value): value is string => value !== null);
  if (volumeTargets.length > 0 || volumeMissing.length > 0) {
    sections.push({
      id: "volume",
      status: volumeMissing.length === 0 ? "complete" : "partial",
      targets: volumeTargets,
      missing: volumeMissing,
    });
  }

  const chapterTargets = targets.filter((target) =>
    target.kind === "chapter_intent"
    || target.kind === "chapter_context"
    || target.kind === "chapter_claim_brief"
    || target.kind === "chapter_rule_stack"
    || target.kind === "chapter_trace"
  );
  const chapterMissing = latestChapter
    ? [
        maybeMissing(names, `runtime/chapter-${latestChapter}.intent.md`),
        maybeMissing(names, `runtime/chapter-${latestChapter}.context.json`),
        maybeMissing(names, `runtime/chapter-${latestChapter}.claim-brief.md`),
        maybeMissing(names, `runtime/chapter-${latestChapter}.rule-stack.yaml`),
        maybeMissing(names, `runtime/chapter-${latestChapter}.trace.json`),
      ].filter((value): value is string => value !== null)
    : [];
  if (chapterTargets.length > 0 || chapterMissing.length > 0) {
    sections.push({
      id: "chapter",
      status: chapterMissing.length === 0 ? "complete" : "partial",
      targets: chapterTargets,
      missing: chapterMissing,
    });
  }

  return sections;
}

function pushTarget(
  targets: GovernanceOverviewTarget[],
  names: ReadonlySet<string>,
  kind: GovernanceOverviewKind,
  name: string,
): void {
  if (!names.has(name)) return;
  targets.push({ kind, name });
}

function latestNumber(
  files: ReadonlyArray<{ readonly name: string }>,
  pattern: RegExp,
): string | null {
  const values = files
    .map((file) => file.name.match(pattern)?.[1] ?? null)
    .filter((value): value is string => value !== null)
    .sort();
  return values.at(-1) ?? null;
}

function maybeMissing(
  names: ReadonlySet<string>,
  name: string | null,
): string | null {
  if (!name) return null;
  return names.has(name) ? null : name;
}
