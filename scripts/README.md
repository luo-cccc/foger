# Workspace Scripts

Run scripts through the root `package.json` when an alias exists. Direct script execution is mainly for debugging or passing script-specific options.

## Quality And Release

Use `pnpm verify` for the complete offline quality gate. Use `pnpm release` when networked dependency audit and isolated Studio E2E are also required.

- `audit-semantic-patterns.mjs`: scans source prompts and templates for suspicious semantic-pattern candidates.
- `audit-contamination.mjs`: rejects test-fixture / paid-run book proper nouns in production source (characters, factions, places, titles). Every historical contamination (book plots hardcoded into audit gates, prompts, or Studio placeholders) traced back to this path, so the guard is part of `pnpm verify` and its denylist is the living registry of paid-run characters. Add new paid-run names to `KNOWN_CONTAMINATION` and keep them out of prompts and pipeline logic.
- `check-code-hygiene.mjs`: rejects trailing whitespace, repeated blank lines, merge markers, missing final newlines, and focused tests in source/config files. It runs through `pnpm lint` and `pnpm verify`.
- `verify-studio-bundle.mjs`: checks Studio entry JS/CSS against repository size budgets.
- `verify-no-workspace-protocol.mjs`: verifies publishable manifests before publish — internal dependencies use `workspace:*` in source (so local development always links workspace sources) and may only reference packages in this workspace; pinned workspace versions must match the current workspace version; the prepack hook rewrites them to real versions for the registry tarball.
- `prepare-package-for-publish.mjs`, `restore-package-json.mjs`, `set-package-versions.mjs`: release workflow helpers. Do not run them casually in a dirty workspace.

## Reliability

- `process-contention-stress.mjs`: cross-process book/config contention and preparing/committed force-kill recovery stress test. Use `pnpm stress:process`.
- `unattended-soak.mjs`: unattended scheduler soak with a forced process kill during a locked episode write, an injected provider `ETIMEDOUT`, and restart recovery in a fresh process. It verifies durable unattended state, episode/snapshot counts, and lock cleanup. Use `pnpm stress:unattended`.
- `studio-e2e-benchmark.mjs`: repeated isolated Studio E2E benchmark. Use `pnpm benchmark:studio-e2e`.

## Live Provider Tests

- `pnpm test:linked`: browser → Studio API → Core → persistence → Doctor acceptance using the deterministic LLM stub. It verifies that the request ID, SSE lifecycle, Core operation ID, telemetry, episode index, and Doctor filter refer to one operation.
- `pnpm test:linked:live`: optional manual provider check against an isolated project. Keep credentials in the process environment, choose a small episode count, and review the resulting performance report before spending more budget. The launcher removes isolated projects and copied secrets during cleanup.

Live-provider scripts require explicit credentials and write into ignored `.tmp-*` directories. `INKOS_MAX_PROMPT_ESTIMATED_TOKENS_PER_CALL` rejects oversized assembled prompts before either provider or stub transport is invoked; report-level token budgets remain post-run aggregate gates. Raw reports are disposable local artifacts and are removed by `pnpm clean`; durable user-visible findings belong in [the release notes](../docs/releases/release-notes.md), without credentials or generated scripts. Do not commit credentials, raw reports, or temporary projects.

## Cleanup

- `pnpm clean`: removes ignored root and Studio linked-test temporary projects, test reports, E2E logs, coverage, and Vite caches while preserving dependencies, user runtime data, and `dist`.
- `pnpm clean:build`: also removes package `dist` directories.
- `pnpm clean:dry-run`: prints cleanup targets without deleting them.
