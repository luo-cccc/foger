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

InkOS is an episode-first production system for short vertical drama scripts. It defaults to 100 episodes at roughly 90 seconds each. Structured `EpisodeScript JSON` is the creative source of truth, while screenplay Markdown is a readable and exportable projection.

The production standard is:

> Novel premise × familiar payoff × high-pressure relationships × causal reversals × emotional hooks

Each episode follows:

```text
Planner → Composer → Writer → deterministic gates → state reduction → Auditor → persistence
```

The normal path uses at most three model calls. Runtime state, summaries, hooks, and handoff capsules are derived locally from the structured script.

## Latest Update

### 2026-08-08

- Switched the product to the Episode v2 drama workflow: 100 episodes, 90 seconds, 1–3 scenes, and 6–12 shots by default.
- Added explicit contracts for incoming state, objective, opposition, causal escalation, local payoff, outgoing pressure, information permissions, and handoff state.
- Added production, duration, reversal, emotional, continuity, handoff, and complete-series gates.
- Reduced the normal episode path to three model calls and added shared context snapshots, budgets, evidence reports, and performance telemetry.
- Legacy novel projects are rejected with `UNSUPPORTED_LEGACY_FORMAT` instead of being interpreted silently.

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
  --duration 90 \
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
```

Running `inkos` without a subcommand starts Studio at `http://127.0.0.1:4567`.

## Episode Contract

Each episode must contain 1–3 scenes, 6–12 shots, a visible conflict, a prepared directional reversal, a local payoff, and outgoing pressure caused by the result. The 90-second target has a 75–105 second soft range and a 60–120 second hard range.

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

Episode JSON is authoritative. Markdown is a projection. Structured state, evidence reports, performance telemetry, and recovery capsules are persisted separately and committed transactionally with the script.

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
