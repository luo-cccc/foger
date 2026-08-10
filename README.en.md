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

### 2026-08-11

- Episode duration moved to the 2-3 minute format: the default target is 150 seconds (soft range 120-180, hard range 90-210), and the shot-count upper bound is now a soft budget derived from the target duration (about 8-20 shots at 150s) — exceeding it warns instead of rejecting.
- Paid rerun validation (《子夜当铺》, 20 episodes, deepseek-v4-flash): all 20 episodes passed on first write with zero revision battles and zero manual content edits; the completion gate passed on the first attempt, and every episode landed within 147-154 seconds.
- Six production fixes shipped: severity-weighted revise candidate selection (criticals first), hook-ledger recognition of `→ resolve` terminal markers inside advance entries, automatic retry on audit-output parse failures, a runtime-state consistency guard with actionable repair hints before approve, a deterministic planner-memo self-contradiction warning, and JSON-sidecar rewrites on revise persistence.
- Writer parse failures hardened further: after the writer's bounded repair, the runner regenerates once from scratch, and a final failure persists the raw model output under `story/runtime/` with the path in the error message; invalid LLM endpoint configuration now fails with an actionable hint instead of a bare zod error.

### 2026-08-10

- Completed a 100-episode paid production test (Deepseek v4-flash): all 100 episodes produced as ready-for-review storyboards with zero failures, covering scene transitions, the fortune-accounting ledger, hook payoff tracking, and the finale closure gate.
- Fixed hook-ledger settlement: planner advance/resolve/defer annotations are now applied deterministically during writing, revision, and state replay, so hook-health monitoring reflects the real ledger and core hooks are paid off on schedule.
- Hardened writer-output parsing: `PRE_WRITE_CHECK` preambles are stripped before JSON extraction, and out-of-range drafts are normalized deterministically before failing, reducing repair calls and batch interruptions.
- De-noised the character-reference audit: functional role labels are exempt, and speakers introduced in earlier episodes no longer re-warn on every appearance; only newly invented names are flagged on first use (81→6 warnings on the 100-episode re-run).
- Fixed the manual revision gate: deterministic findings now merge into the re-audit, so revise no longer stalls on "no executable blocking evidence"; single-field issues like the emotional hook support local patches.
- Improved title de-duplication suffixes: fresh concrete 2-character terms from the body are preferred over awkward fragments.
- Validated the fixes with a fresh 10-episode book (《烽燧令》): a single uninterrupted run with the hook ledger advancing end-to-end, the completion gate passing, and far fewer audit warnings.

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

Each episode must contain 1–3 scenes, a visible conflict, a prepared directional reversal, a local payoff, and outgoing pressure caused by the result. Shot count follows a dynamic budget derived from the target duration (about 8–20 shots at the default 150-second target) — only the lower bound is a hard constraint; the upper bound is a soft warning. The 150-second default target has a ±30-second soft range (120–180 seconds) and a 90–210 second hard range.

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
