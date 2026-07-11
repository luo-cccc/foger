# Workspace Scripts

Run scripts through the root `package.json` when an alias exists. Direct script execution is mainly for debugging or passing script-specific options.

## Quality And Release

Use `pnpm verify` for the complete offline quality gate. Use `pnpm release` when networked dependency audit and isolated Studio E2E are also required.

- `audit-semantic-patterns.mjs`: scans source prompts and templates for suspicious semantic-pattern candidates.
- `verify-studio-bundle.mjs`: checks Studio entry JS/CSS against repository size budgets.
- `verify-no-workspace-protocol.mjs`: verifies publishable manifests do not contain workspace-only dependency ranges.
- `prepare-package-for-publish.mjs`, `restore-package-json.mjs`, `set-package-versions.mjs`: release workflow helpers. Do not run them casually in a dirty workspace.

## Reliability

- `process-contention-stress.mjs`: cross-process book/config contention and preparing/committed force-kill recovery stress test. Use `pnpm stress:process`.
- `studio-e2e-benchmark.mjs`: repeated isolated Studio E2E benchmark. Use `pnpm benchmark:studio-e2e`.

## Live Provider Tests

- `live-dual-api-routing.mjs`: multi-agent dual-provider live run and report generator.
- `live-openrouter-deepseek-flash.mjs`: focused OpenRouter live-provider run.

Live-provider scripts require explicit credentials and write into ignored `.tmp-*` directories. Reports that matter long term must be summarized in [the live LLM test record](../docs/live-llm-testing-and-next-goals.md); do not commit secrets or raw temporary projects.

## Cleanup

- `pnpm clean`: removes ignored temporary projects, test reports, E2E logs, coverage, and Vite caches while preserving dependencies and `dist`.
- `pnpm clean:build`: also removes package `dist` directories.
- `pnpm clean:dry-run`: prints cleanup targets without deleting them.
