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
- `unattended-soak.mjs`: 20-chapter unattended scheduler soak with a forced process kill during a locked write, an injected provider `ETIMEDOUT`, and restart recovery in a fresh process. It verifies the durable `.inkos/unattended-state.json`, chapter/snapshot counts, and lock cleanup. Use `pnpm stress:unattended`.
- `studio-e2e-benchmark.mjs`: repeated isolated Studio E2E benchmark. Use `pnpm benchmark:studio-e2e`.

## Live Provider Tests

- `pnpm test:linked`: fast browser -> Studio API -> Core -> persistence -> Doctor acceptance gate using the deterministic LLM stub. It verifies that the HTTP request ID, SSE lifecycle, Core operation ID, LLM telemetry, chapter index, and Doctor filter all refer to the same write operation.
- `pnpm test:linked:live`: runs the same linked gate against an isolated copy of the current real service configuration. It defaults to one 1000-word chapter, a 250000-token ceiling, and at most two book-creation attempts. Pass `-- --linked-chapters 3 --linked-words 1000 --linked-max-total-tokens 500000` for a short stability sample, or `-- --linked-chapters 20 --linked-words 1000 --linked-max-total-tokens 0 --linked-max-prompt-tokens-per-call 0 --linked-quality-policy report-only` for the current long-run acceptance. `--linked-create-attempts 1` disables recovery from an incomplete foundation response. `--linked-quality-policy strict` keeps chapter quality as a blocking assertion; `--linked-quality-policy report-only` records quality findings while still requiring browser/API/SSE/persistence/Doctor integrity. A failed live report is fingerprinted by code, scenario, creation-attempt limit, and quality policy; the same run will not be repeated until something changes unless `--repeat-known-failure` is supplied explicitly. The launcher records its PID and removes isolated project/runtime directories on normal exit; later runs recover stale directories whose launcher is no longer alive so copied secrets do not persist indefinitely. If the parent process is externally terminated, treat the JSON report as partial and cross-check the isolated chapter index, truth, snapshots, and runtime LLM JSONL before summarizing or cleaning it.
- `live-dual-api-routing.mjs`: multi-agent live run and report v2 generator. Route modes are `single-provider`, `openrouter-only` (default), `minimax-writer`, and `minimax-governance`. `single-provider` reads `INKOS_LLM_SERVICE`, `INKOS_LLM_PROVIDER`, `INKOS_LLM_BASE_URL`, `INKOS_LLM_MODEL`, `INKOS_LLM_API_KEY`, and optional `INKOS_LIVE_PROVIDER_LABEL` from the current process without writing the key to disk. Chapter execution uses the production unattended Scheduler in one-shot mode, including durable transient retry, audit revision/rewrite, state repair/resync, and per-chapter gates. The runner records service/model token and retry aggregates, structured fallbacks, chapter length deviation, final audit issues, every available audit/revision candidate, persisted review termination telemetry, and per-chapter governance call counts. Use `--review-mode manual` (default) to stop for human review, or `--review-mode auto` to exercise audit, revision, and length normalization; `--foundation-review-retries` defaults to one bounded regeneration before a rejected foundation is reported as a blocking fallback. `--foundation-only` runs smoke, routing, Foundation review, Canon extraction, and the irreversible pre-chapter gate without starting the Scheduler; its quality gate intentionally excludes chapter count, audit, state, and length checks. Retry rate remains visible but is not enforced in this small-sample mode, matching the production pre-chapter gate; fallback, timeout, token budgets, and configured governance call limits remain blocking. Budget limits accept `--max-total-tokens`, `--max-chapter-tokens`, `--max-prompt-tokens-per-call`, `--max-agent-tokens writer=...`, `--max-phase-tokens write=...`, `--max-audit-calls`, `--max-revision-calls`, `--max-normalize-calls`, and `--max-settle-calls`. Revision and settlement limits are enforced before repeated governance or recovery calls; the final report independently checks all four call limits. Provider smoke calls use the configured timeout and telemetry. After book creation, an irreversible pre-chapter gate skips chapter generation when fallback count, zero-tolerance timeouts, or token budgets have already failed; retry-rate observations remain deferred to the complete run because an early small sample can recover.
- `live-openrouter-deepseek-flash.mjs`: focused OpenRouter live-provider run.

Live-provider scripts require explicit credentials and write into ignored `.tmp-*` directories. `INKOS_MAX_PROMPT_ESTIMATED_TOKENS_PER_CALL` rejects oversized assembled prompts before either provider or stub transport is invoked; report-level token budgets remain post-run aggregate gates. Raw reports are disposable local artifacts and are removed by `pnpm clean`; results that matter long term must first be summarized without secrets or generated prose in [the live LLM test record](../docs/live-llm-testing-and-next-goals.md). Do not commit credentials, raw reports, or temporary projects.

## Cleanup

- `pnpm clean`: removes ignored root and Studio linked-test temporary projects, test reports, E2E logs, coverage, and Vite caches while preserving dependencies, user runtime data, and `dist`.
- `pnpm clean:build`: also removes package `dist` directories.
- `pnpm clean:dry-run`: prints cleanup targets without deleting them.
