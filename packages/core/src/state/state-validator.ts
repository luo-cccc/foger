import {
  EpisodeSummariesStateSchema,
  CurrentStateStateSchema,
  HooksStateSchema,
  StateManifestSchema,
} from "../models/runtime-state.js";

export interface RuntimeStateValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export function validateRuntimeState(input: {
  readonly manifest: unknown;
  readonly currentState: unknown;
  readonly hooks: unknown;
  readonly episodeSummaries: unknown;
}): RuntimeStateValidationIssue[] {
  try {
    const issues: RuntimeStateValidationIssue[] = [];

    const manifest = parseOrIssue(
      StateManifestSchema,
      input.manifest,
      issues,
      "invalid_manifest",
      "manifest",
    );
    const currentState = parseOrIssue(
      CurrentStateStateSchema,
      input.currentState,
      issues,
      "invalid_current_state",
      "currentState",
    );
    const hooks = parseOrIssue(
      HooksStateSchema,
      input.hooks,
      issues,
      "invalid_hooks_state",
      "hooks",
    );
    const episodeSummaries = parseOrIssue(
      EpisodeSummariesStateSchema,
      input.episodeSummaries,
      issues,
      "invalid_episode_summaries_state",
      "episodeSummaries",
    );

    if (hooks) {
      const seen = new Set<string>();
      for (const hook of hooks.hooks) {
        if (seen.has(hook.hookId)) {
          issues.push({
            code: "duplicate_hook_id",
            message: `duplicate hook id: ${hook.hookId}`,
            path: `hooks.${hook.hookId}`,
          });
        }
        seen.add(hook.hookId);
      }
    }

    if (episodeSummaries) {
      const seen = new Set<number>();
      for (const row of episodeSummaries.rows) {
        if (seen.has(row.episodeNumber)) {
          issues.push({
            code: "duplicate_summary_episode",
            message: `duplicate summary episode: ${row.episodeNumber}`,
            path: `episodeSummaries.${row.episodeNumber}`,
          });
        }
        seen.add(row.episodeNumber);
      }
    }

    if (manifest && currentState && currentState.episode > manifest.lastAppliedEpisode) {
      issues.push({
        code: "current_state_ahead_of_manifest",
        message: `current state episode ${currentState.episode} exceeds manifest ${manifest.lastAppliedEpisode}`,
        path: "currentState.episode",
      });
    }
    if (manifest && currentState && currentState.episode < manifest.lastAppliedEpisode) {
      issues.push({
        code: "current_state_behind_manifest",
        message: `current state episode ${currentState.episode} trails manifest ${manifest.lastAppliedEpisode}`,
        path: "currentState.episode",
      });
    }
    if (manifest && episodeSummaries && episodeSummaries.rows.length > 0) {
      const latestSummaryEpisode = Math.max(...episodeSummaries.rows.map((row) => row.episodeNumber));
      if (latestSummaryEpisode < manifest.lastAppliedEpisode) {
        issues.push({
          code: "episode_summaries_behind_manifest",
          message: `latest episode summary ${latestSummaryEpisode} trails manifest ${manifest.lastAppliedEpisode}`,
          path: "episodeSummaries.rows",
        });
      }
    }

    return issues;
  } catch (error) {
    return [
      {
        code: "validator_crash",
        message: String(error),
        path: "",
      },
    ];
  }
}

function parseOrIssue<T>(
  schema: { parse(value: unknown): T },
  value: unknown,
  issues: RuntimeStateValidationIssue[],
  code: string,
  path: string,
): T | undefined {
  try {
    return schema.parse(value);
  } catch (error) {
    issues.push({
      code,
      message: String(error),
      path,
    });
    return undefined;
  }
}
