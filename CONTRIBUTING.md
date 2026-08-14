# Contributing

## Setup

```bash
git clone https://github.com/luo-cccc/foger.git
cd foger
pnpm install
pnpm build
pnpm test
```

Node ≥ 20, pnpm ≥ 9.

## Project Structure

```
packages/
  core/
    src/agents/       # LLM-facing domain agents and prompt contracts
    src/pipeline/     # Foundation/episode workflows and unattended scheduling
    src/state/        # Authoritative state, projections, locks, and transactions
    src/llm/          # Provider transport, model metadata, routing, and telemetry
    src/interaction/  # Agent sessions and shared interaction tools
  cli/                # Commander.js commands, TUI, and daemon
  studio/
    src/api/          # Local Hono API and SSE operation lifecycle
    src/pages/        # React route-level workbench pages
    e2e/              # Isolated browser/API/Core/persistence acceptance tests
scripts/              # Quality gates, stress tests, cleanup, and live-provider tools
docs/                 # Current Episode architecture, operations, and release history
```

Monorepo managed with pnpm workspaces. CLI and Studio consume the shared core package; publishable manifests use registry-installable internal versions while pnpm links workspace packages during development.

Read `docs/architecture.md` before changing pipeline, persistence, Studio mutation routes, or package boundaries. Keep domain rules in Core: CLI and Studio may adapt transport and presentation, but must not reimplement locking, rollback, validation, or state transitions. Changes to Planner/Hook/Canon or export-gate rules must keep the architecture and operations documents in sync. Operational guidance belongs in `docs/operations.md`; user-visible changes belong in `docs/releases/release-notes.md`.

## Development

```bash
pnpm dev          # Watch mode for workspace packages
pnpm build        # Build once
pnpm test         # Run all tests
pnpm typecheck    # Type-check without emitting
pnpm verify       # Run the complete offline quality gate
pnpm clean        # Remove temporary projects, test reports, logs, and caches
```

`pnpm clean` preserves `node_modules` and package `dist` directories. Use `pnpm clean:build` only when you explicitly want a fresh build. Use `pnpm clean:dry-run` to inspect cleanup targets first. Script ownership and usage are indexed in `scripts/README.md`.

## Commit Convention

```
<type>: <description>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`

Keep commits atomic — one logical change per commit. Split new files, interface changes, tests, and docs into separate commits when they're non-trivial.

## Pull Request Checklist

- [ ] `pnpm verify` passes
- [ ] `git diff --check` passes
- [ ] New features have tests
- [ ] README / architecture / operations / release notes are updated where behavior changed
- [ ] No unrelated formatting changes (keep diffs focused)
- [ ] Commit messages follow the convention above

## Code Style

- TypeScript, strict mode
- 2-space indentation
- Immutable patterns: `{ ...obj, key: value }` over mutation
- Prefer functions under 50 lines and new domain modules under 800 lines. When changing an existing oversized module, extract a coherent business domain instead of adding another unrelated responsibility.
- Errors must surface, not be swallowed (`catch { }` without re-throw needs a comment)
- Source package manifests use `workspace:*` for internal dependencies. Prepack rewrites them to registry versions; never hand-edit source manifests to imitate packed output.
- Studio and CLI must call core application use cases for series/episode mutations. Do not duplicate rollback, locking, validation, or persistence sequences in an interface package.
- Structured JSON is authoritative runtime state. Markdown truth files are readable projections and must remain rebuildable.
- Multi-file episode writes require the shared persistence transaction; direct config/index writes require atomic helpers.
- Book mutations must respect the shared book lock. Project config initialization and read-modify-write operations must use the shared cross-process project config mutation helpers.

## Adding a CLI Command

1. Create `packages/cli/src/commands/<name>.ts`
2. Export a `Command` instance
3. Register it in `packages/cli/src/program.ts`
4. Add `--json` output support
5. Support book-id auto-detection when only one book exists

## Adding a Genre

1. Create `packages/core/genres/<id>.md` with YAML frontmatter
2. Define: `episodeTypes`, `fatigueWords`, `numericalSystem`, `powerScaling`, `pacingRule`, `satisfactionTypes`, `auditDimensions`, `language`
3. Add genre body (prohibitions, language rules, narrative guidance)

## Testing

Tests live next to source in `__tests__/` directories. We use Vitest.

```bash
pnpm --filter @actalk/inkos-core test    # Core tests only
pnpm --filter @actalk/inkos test         # CLI tests only
pnpm --filter @actalk/inkos-studio test  # Studio tests only
```

For features touching the LLM pipeline, mock the LLM calls — don't make real API requests in tests.

Verification is layered:

- Commit-level: focused Vitest files plus package typecheck.
- Merge-level: `pnpm verify` (typecheck, semantic audit, build, bundle budget, tests, and publish manifests).
- Release-level: `pnpm release` adds production dependency audit and isolated Studio E2E.

Changes to locks, transaction markers, recovery, project configuration, or process lifecycle must also run `pnpm stress:process`.

Studio Playwright tests run through `pnpm --filter @actalk/inkos-studio test:e2e`, which allocates an isolated temporary project root and dynamic ports. Do not invoke Playwright directly because the launcher provides the required runtime metadata. Changes to persistence, locking, or episode mutations must keep the suite green.

Real-provider runs are manual acceptance tests, not commit-level tests. Keep credentials outside the repository, summarize durable user-visible findings in the dated release notes, and remove raw projects and reports with `pnpm clean` after review. Do not commit one-off tool-review documents or paid-run transcripts. An interrupted report is not authoritative: cross-check the episode index, structured truth, snapshots, and runtime telemetry before documenting its outcome.

### Paid-run data must not contaminate source or tests

Every contamination found in this codebase traced back to one path: a paid production run generated a book, its characters/plots got copied into a regression-test fixture, and the fixture then leaked into production code, prompts, or spec documents as an example. The guard (`scripts/audit-contamination.mjs`) blocks denylisted proper nouns in production files and tests under `packages/*/src`, plus `genres/`, `scripts/`, and the canonical spec docs (`README*.md`, `CONTRIBUTING.md`, `docs/architecture.md`, `docs/operations.md`). Dated release notes may retain concise historical conclusions, but not full scripts or raw model output.

Rules:

- Never use a paid-book proper noun (character, faction, place, artifact, book title) in production code, tests, comments, prompts, genre files, Studio copy, or spec docs; use neutral invented fixtures instead.
- When a new paid run introduces names, register them in `KNOWN_CONTAMINATION` inside `scripts/audit-contamination.mjs`, then neutralize any copied fixture before it lands under a scanned source tree.
- `pnpm audit:contamination` is part of `pnpm verify`; a failing guard blocks merge.

## Questions?

Open an issue or check existing ones: https://github.com/luo-cccc/foger/issues
