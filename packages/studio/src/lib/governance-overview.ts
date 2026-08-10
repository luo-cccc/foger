export type GovernanceOverviewKind =
  | "current_arc"
  | "volume_dashboard"
  | "volume_progress"
  | "volume_contracts"
  | "episode_intent"
  | "episode_context"
  | "episode_claim_brief"
  | "episode_rule_stack"
  | "episode_trace";

export interface GovernanceOverviewTarget {
  readonly kind: GovernanceOverviewKind;
  readonly name: string;
}

export interface GovernanceOverviewSection {
  readonly id: "volume" | "episode";
  readonly status: "complete" | "partial";
  readonly targets: ReadonlyArray<GovernanceOverviewTarget>;
  readonly missing: ReadonlyArray<string>;
}

export function pickGovernanceOverviewTargets(
  files: ReadonlyArray<{ readonly name: string }>,
): ReadonlyArray<GovernanceOverviewTarget> {
  const names = new Set(files.map((file) => file.name));
  const latestEpisode = latestNumber(files, /^runtime\/episode-(\d{4})\./);
  const latestVolume = latestNumber(files, /^runtime\/volume-(\d{3})\./);

  const targets: GovernanceOverviewTarget[] = [];
  pushTarget(targets, names, "current_arc", "runtime/tier2_current_arc.md");
  pushTarget(targets, names, "volume_dashboard", "runtime/volume-dashboard.md");
  if (!targets.some((target) => target.kind === "volume_dashboard") && latestVolume !== null) {
    pushTarget(targets, names, "volume_dashboard", `runtime/volume-${latestVolume}.dashboard.md`);
  }
  pushTarget(targets, names, "volume_progress", "runtime/volume-progress.json");
  pushTarget(targets, names, "volume_contracts", "runtime/volume-contracts.json");

  if (latestEpisode !== null) {
    pushTarget(targets, names, "episode_intent", `runtime/episode-${latestEpisode}.intent.md`);
    pushTarget(targets, names, "episode_context", `runtime/episode-${latestEpisode}.context.json`);
    pushTarget(targets, names, "episode_claim_brief", `runtime/episode-${latestEpisode}.claim-brief.md`);
    pushTarget(targets, names, "episode_rule_stack", `runtime/episode-${latestEpisode}.rule-stack.yaml`);
    pushTarget(targets, names, "episode_trace", `runtime/episode-${latestEpisode}.trace.json`);
  }

  return targets;
}

export function latestRuntimeEpisode(
  files: ReadonlyArray<{ readonly name: string }>,
): string | null {
  return latestNumber(files, /^runtime\/episode-(\d{4})\./);
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
  const latestEpisode = latestRuntimeEpisode(files);
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

  const episodeTargets = targets.filter((target) =>
    target.kind === "episode_intent"
    || target.kind === "episode_context"
    || target.kind === "episode_claim_brief"
    || target.kind === "episode_rule_stack"
    || target.kind === "episode_trace"
  );
  const episodeMissing = latestEpisode
    ? [
        maybeMissing(names, `runtime/episode-${latestEpisode}.intent.md`),
        maybeMissing(names, `runtime/episode-${latestEpisode}.context.json`),
        maybeMissing(names, `runtime/episode-${latestEpisode}.claim-brief.md`),
        maybeMissing(names, `runtime/episode-${latestEpisode}.rule-stack.yaml`),
        maybeMissing(names, `runtime/episode-${latestEpisode}.trace.json`),
      ].filter((value): value is string => value !== null)
    : [];
  if (episodeTargets.length > 0 || episodeMissing.length > 0) {
    sections.push({
      id: "episode",
      status: episodeMissing.length === 0 ? "complete" : "partial",
      targets: episodeTargets,
      missing: episodeMissing,
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
