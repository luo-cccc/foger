# Workspace Scripts

Run scripts through the root `package.json` when an alias exists. Direct script execution is mainly for debugging or passing script-specific options.

## Quality And Release

Use `pnpm verify` for the complete offline quality gate. Use `pnpm release` when networked dependency audit and isolated Studio E2E are also required.

- `audit-semantic-patterns.mjs`: scans source prompts and templates for suspicious semantic-pattern candidates.
- `check-code-hygiene.mjs`: rejects trailing whitespace, repeated blank lines, merge markers, missing final newlines, and focused tests in source/config files. It runs through `pnpm lint` and `pnpm verify`.
- `verify-studio-bundle.mjs`: checks Studio entry JS/CSS against repository size budgets.
- `verify-no-workspace-protocol.mjs`: verifies publishable manifests do not contain workspace-only dependency ranges.
- `prepare-package-for-publish.mjs`, `restore-package-json.mjs`, `set-package-versions.mjs`: release workflow helpers. Do not run them casually in a dirty workspace.

## Reliability

- `process-contention-stress.mjs`: cross-process book/config contention and preparing/committed force-kill recovery stress test. Use `pnpm stress:process`.
- `studio-e2e-benchmark.mjs`: repeated isolated Studio E2E benchmark. Use `pnpm benchmark:studio-e2e`.

## Live Provider Tests

- `pnpm test:linked`: fast browser -> Studio API -> Core -> persistence -> Doctor acceptance gate using the deterministic LLM stub. It verifies that the HTTP request ID, SSE lifecycle, Core operation ID, LLM telemetry, chapter index, and Doctor filter all refer to the same write operation.
- `pnpm test:linked:live`: runs the same linked gate against an isolated copy of the current real service configuration. It defaults to one 1000-word chapter and a 250000-token ceiling. Pass `-- --linked-chapters 3 --linked-words 1000 --linked-max-total-tokens 500000` to expand the scenario. A failed live report is fingerprinted; the same code and scenario will not be rerun until something changes unless `--repeat-known-failure` is supplied explicitly. The launcher records its PID and removes its isolated project/runtime directories on exit; later runs recover stale directories whose launcher is no longer alive so copied secrets do not persist indefinitely.
- `live-dual-api-routing.mjs`: multi-agent dual-provider live run and report v2 generator. It records service/model token and retry aggregates, structured fallbacks, chapter length deviation, optional repair/resync recovery, per-agent/per-phase token budgets, and configurable quality gates. Use `--review-mode manual` (default) to stop for human review, or `--review-mode auto` to exercise audit, revision, and length normalization. Budget limits accept `--max-total-tokens`, `--max-chapter-tokens`, `--max-prompt-tokens-per-call`, `--max-agent-tokens writer=...`, and `--max-phase-tokens write=...`.
- `live-openrouter-deepseek-flash.mjs`: focused OpenRouter live-provider run.

Live-provider scripts require explicit credentials and write into ignored `.tmp-*` directories. `INKOS_MAX_PROMPT_ESTIMATED_TOKENS_PER_CALL` rejects oversized assembled prompts before either provider or stub transport is invoked; report-level token budgets remain post-run aggregate gates. Reports that matter long term must be summarized in [the live LLM test record](../docs/live-llm-testing-and-next-goals.md); do not commit secrets or raw temporary projects.

## Cleanup

- `pnpm clean`: removes ignored temporary projects, test reports, E2E logs, coverage, and Vite caches while preserving dependencies and `dist`.
- `pnpm clean:build`: also removes package `dist` directories.
- `pnpm clean:dry-run`: prints cleanup targets without deleting them.
