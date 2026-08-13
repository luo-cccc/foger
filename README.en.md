<p align="center">
  <img src="assets/logo.svg" width="120" height="120" alt="InkOS Logo">
  <img src="assets/inkos-text.svg" width="240" height="65" alt="InkOS">
</p>

<h1 align="center">Serialized Vertical Drama Production System</h1>

<p align="center">
  Planning, storyboard writing, continuity review, revision, and completion control for 100-episode drama series
</p>

<p align="center">
  English | <a href="README.md">中文</a>
</p>

## Product Scope

InkOS is an episode-first production system for short vertical drama scripts. It defaults to 100 episodes at a 150-second target (about 2.5 minutes) each. Structured `EpisodeScript JSON` is the creative source of truth, while screenplay Markdown is a readable and exportable projection.

The production standard is:

> Novel premise × familiar payoff × high-pressure relationships × causal reversals × emotional hooks

Each episode follows:

```text
Planner → Composer → Writer → deterministic gates → state reduction → Auditor → persistence
```

The normal path uses at most three model calls. Runtime state, summaries, hooks, and handoff capsules are derived locally from the structured script.

## Latest Update

### 2026-08-13

- Production gates now reject a vague ending hook before persistence: it must be a concrete audience question about a relationship, danger, identity, sacrifice, or choice. Writer output containing blocked political-sensitive terms is also rejected at the boundary instead of being discovered after review.
- Hook lifecycle data now stores the target payoff episode plus seed, advance, and payoff evidence. Early-payoff detection only fires when all declared payoff evidence appears; it no longer guesses from names or free-form notes.
- Unclaimed canon facts are accumulated deterministically. At the default backlog of 50, planning and writing stop with `CANON_REFRESH_REQUIRED`; run `inkos canon refresh <book-id>` and review the resulting claims before continuing. Exports are blocked for audit-failed or state-degraded episodes.
- Revision triage sends the Reviser only critical findings it owns, preserving other findings as review evidence and avoiding a full rewrite for unrelated warnings.
- Cross-episode shot-surface and action-signature checks detect padding through repeated staging, while the cleanup command removes only caches, reports, and temporary artifacts unless `clean:build` is explicitly used.

[Full release history](docs/releases/release-notes.md)

## Quick Start

Requirements: Node.js 20+ and pnpm 9+.

```bash
pnpm install
pnpm build

inkos init my-drama
cd my-drama

inkos book create \
  --title "Midnight Call" \
  --genre urban \
  --episodes 100 \
  --duration 150 \
  --brief creative-brief.md

inkos plan episode midnight-call
inkos compose episode midnight-call
inkos write next midnight-call
```

Review, revise, complete, and export:

```bash
inkos audit midnight-call 1
inkos revise midnight-call 1
inkos series status midnight-call
inkos series complete midnight-call

inkos export midnight-call --format screenplay-md
inkos export midnight-call --format screenplay-json
inkos export midnight-call --format dialogue

# Required when the canon backlog reaches its configured threshold
inkos canon refresh midnight-call
```

Running `inkos` without a subcommand starts Studio at `http://127.0.0.1:4567`.

## Episode Contract

Each episode must contain 1–3 scenes, a visible conflict, a prepared directional reversal, a local payoff, and outgoing pressure caused by the result. Its ending emotional hook must be a concrete audience question about a relationship, danger, identity, sacrifice, or choice. Shot count follows a dynamic budget derived from the target duration (about 8–20 shots at the default 150-second target) — only the lower bound is a hard constraint; the upper bound is a soft warning. The 150-second default target has a ±30-second soft range (120–180 seconds) and a 90–210 second hard range.

The structured contract tracks:

```text
incomingState
objective
opposition
causalEscalation
localDramaticResult
outgoingPressure
handoffState
informationPermissions
```

See [Architecture](docs/architecture.md) for the data flow and review rules.

## Storage

```text
books/<series-id>/
├── book.json
├── episodes/
│   ├── index.json
│   ├── 0001_Title.json
│   ├── 0001_Title.md
│   └── 0001_review.json
└── story/
    ├── outline/
    ├── roles/
    ├── state/
    ├── runtime/
    ├── snapshots/
    ├── current_state.md
    ├── pending_hooks.md
    └── episode_summaries.md
```

Episode JSON is authoritative. Markdown is a projection. Structured state, evidence reports, performance telemetry, and recovery capsules are persisted separately and committed transactionally with the script. Hook records retain their target payoff episode and lifecycle evidence; early payoff is evaluated only against declared payoff evidence, never inferred from free-form text.

## Development

```bash
pnpm check:hygiene
pnpm typecheck
pnpm audit:semantic-patterns
pnpm build
pnpm test
pnpm verify:publish-manifests
pnpm clean:build
```

See [Operations](docs/operations.md) for maintenance guidance.

## Current Boundary

InkOS produces text screenplay artifacts only. Image generation, voice, sound asset production, video generation, and media asset pipelines are not part of this release.

## License

[AGPL-3.0-only](LICENSE)
