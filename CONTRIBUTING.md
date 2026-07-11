# Contributing

## Setup

```bash
git clone https://github.com/Narcooo/inkos.git
cd inkos
pnpm install
pnpm build
pnpm test
```

Node ≥ 20, pnpm ≥ 9.

## Project Structure

```
packages/
  core/    # Agents, pipeline, state management, LLM providers
  cli/     # Commander.js commands, TUI, and daemon
  studio/  # React workbench and Hono API
```

Monorepo managed with pnpm workspaces. CLI and Studio consume the shared core package; publishable manifests use registry-installable internal versions while pnpm links workspace packages during development.

See `docs/current-architecture-and-priorities.md` before changing pipeline, persistence, Studio mutation routes, or package boundaries.

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

- [ ] `pnpm build` passes
- [ ] `pnpm test` passes (all existing + new tests)
- [ ] `pnpm typecheck` passes
- [ ] New features have tests
- [ ] No unrelated formatting changes (keep diffs focused)
- [ ] Commit messages follow the convention above

## Code Style

- TypeScript, strict mode
- 2-space indentation
- Immutable patterns: `{ ...obj, key: value }` over mutation
- Prefer functions under 50 lines and new domain modules under 800 lines. When changing an existing oversized module, extract a coherent business domain instead of adding another unrelated responsibility.
- Errors must surface, not be swallowed (`catch { }` without re-throw needs a comment)
- Publishable package manifests must use registry-installable internal versions, not `workspace:*`; `pnpm` links local packages through the workspace config during development.
- Studio and CLI must call core application use cases for book/chapter mutations. Do not duplicate rollback, locking, validation, or persistence sequences in an interface package.
- Structured JSON is authoritative runtime state. Markdown truth files are readable projections and must remain rebuildable.
- Multi-file chapter writes require the shared chapter persistence transaction; direct config/index writes require atomic helpers.
- Book mutations must respect the shared book lock. Project config initialization and read-modify-write operations must use the shared cross-process project config mutation helpers.

## Adding a CLI Command

1. Create `packages/cli/src/commands/<name>.ts`
2. Export a `Command` instance
3. Register it in `packages/cli/src/index.ts`
4. Add `--json` output support
5. Support book-id auto-detection when only one book exists

## Adding a Genre

1. Create `packages/core/genres/<id>.md` with YAML frontmatter
2. Define: `chapterTypes`, `fatigueWords`, `numericalSystem`, `powerScaling`, `pacingRule`, `satisfactionTypes`, `auditDimensions`, `language`
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

Studio Playwright tests run through `pnpm --filter @actalk/inkos-studio test:e2e`, which allocates an isolated temporary project root and dynamic ports. Do not invoke Playwright directly because the launcher provides the required runtime metadata. Recovery is a release-gate scenario; the 2026-07-11 baseline is 8/8, and its preparing/committed real child-process force-kill/restart cases passed five combined rounds, 10/10 in total. Changes to persistence, locking, or chapter mutations must keep both results green.

## Questions?

Open an issue or check existing ones: https://github.com/Narcooo/inkos/issues
