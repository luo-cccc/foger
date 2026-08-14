<p align="center">
  <img src="assets/logo.svg" width="120" height="120" alt="InkOS Logo">
  <img src="assets/inkos-text.svg" width="240" height="65" alt="InkOS">
</p>

<h1 align="center">Serialized Vertical Drama Production System</h1>

<p align="center">
  Planning, storyboard writing, continuity review, revision, approval, and completion control for long-running vertical drama
</p>

<p align="center">
  English | <a href="README.md">中文</a>
</p>

## Product Scope

InkOS is an episode-first text production system for vertical drama. The default target is 100 episodes at 150 seconds each. Structured `EpisodeScript JSON` is authoritative; Markdown is a readable delivery projection and never overrides JSON.

The episode pipeline is:

```text
Planner → Composer → Writer → deterministic gates → Auditor/Reviser → state reduction → persistence
```

A first-pass success normally uses Planner, Writer, and Auditor model calls. Runtime state, summaries, hooks, Canon evolution, and handoff capsules are derived deterministically. Revision calls are added only when review finds blocking issues.

## Latest Update

### 2026-08-14

- **One screenplay authority**: editing, auditing, revision, synchronization, and export read `episodes/*.json`; JSON and Markdown are committed or rolled back together.
- **Explicit production checkpoints**: manual mode persists a `drafted` episode without advancing truth, snapshots, or Canon. A passing audit moves it to `ready-for-review`; manual mode then requires approval before continuation.
- **Strict approval and delivery**: approval requires valid evidence for the current JSON hash. Default export and series completion accept only `approved/published`; `--approved-only` exports the approved subset.
- **Recoverable state and Canon**: per-episode snapshots include structured state and Canon. Rejection, rewrite, and latest-episode revision restore the matching baseline.

[Full release history](docs/releases/release-notes.md)

## Capabilities

- Hierarchical series, arc, episode-plan, and EpisodeScript production.
- Structured scenes and shots with framing, camera, duration, visuals, action, dialogue, narration, sound, and transitions.
- Episode contracts covering incoming state, objective, opposition, causal escalation, local result, outgoing pressure, and handoff state.
- Deterministic schema, duration, contract, Canon, Hook, character-reference, AI-tell, and cross-episode repetition checks.
- Review evidence with severity, ownership, evidence references, and source hashes.
- Transactional persistence and recovery for JSON/Markdown, indexes, runtime state, snapshots, Canon, and sidecars.
- Shared Core application boundaries for Studio, CLI, TUI, and natural-language Agent workflows.

## Quick Start

Requirements: Node.js 20+ and pnpm 9+.

```bash
pnpm install
pnpm build

inkos init my-drama
cd my-drama
```

Configure a model. Keep the key in an environment variable or local secret store:

```bash
inkos config set-global \
  --provider custom \
  --base-url https://api.example.com/v1 \
  --api-key-env MY_LLM_API_KEY \
  --model my-model
```

Create and produce a series:

```bash
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

Audit, revise, and approve:

```bash
inkos audit midnight-call 1
inkos revise midnight-call 1
inkos review list midnight-call
inkos review approve midnight-call 1
```

Default export requires every episode to be approved or published:

```bash
inkos export midnight-call --format screenplay-md
inkos export midnight-call --format screenplay-json
inkos export midnight-call --format dialogue

# Export only approved episodes
inkos export midnight-call --format screenplay-md --approved-only
```

Maintenance and completion:

```bash
inkos foundation extend midnight-call --episodes 120
inkos canon refresh midnight-call
inkos series status midnight-call
inkos series complete midnight-call
```

Running `inkos` without a subcommand starts Studio at `http://127.0.0.1:4567`.

## Episode States

| Status | Meaning | Can production continue? |
| --- | --- | --- |
| `drafted` | Manual-mode draft, not audited | No |
| `ready-for-review` | Audit passed; truth and snapshot committed | Yes in auto mode; manual mode requires approval |
| `audit-failed` | Blocking findings or a manual edit awaiting re-audit | No |
| `state-degraded` | Screenplay persisted, but state commit or recovery is incomplete | No |
| `approved` / `published` | Deliverable | Yes |
| `rejected` | Rejected; dependent state must be rolled back or rewritten | No |

Approval also requires valid `PROVISIONAL` review evidence whose hash matches the current Episode JSON. See [Architecture](docs/architecture.md) for the transition rules.

## Episode Contract

Each episode contains 1-3 scenes. At the default 150-second target, the dynamic shot budget is roughly 8-20 shots; the lower bound is hard and the upper bound is a warning. The default soft duration range is 120-180 seconds and the hard range is 90-210 seconds.

Contract fields:

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

## Project Layout

```text
books/<series-id>/
├── book.json
├── episodes/
│   ├── index.json
│   ├── 0001_Title.json       # authoritative screenplay
│   ├── 0001_Title.md         # readable projection
│   └── 0001_review.json      # review evidence
└── story/
    ├── canon/                # structured setting authority
    ├── outline/              # series and volume plans
    ├── roles/                # character profiles
    ├── state/                # structured runtime truth
    ├── runtime/              # operation artifacts and diagnostics
    ├── snapshots/            # per-episode state and Canon snapshots
    ├── current_state.md
    ├── pending_hooks.md
    └── episode_summaries.md
```

Legacy novel layouts, schemas, and runtime artifacts are never silently interpreted as Episode v2 projects.

## Development And Docs

```bash
pnpm verify
pnpm clean:dry-run
pnpm clean
```

- [Documentation index](docs/README.md)
- [Architecture](docs/architecture.md)
- [Operations](docs/operations.md)
- [Contributing](CONTRIBUTING.md)

## Boundary

This release produces text screenplay artifacts and structured production data. Image, voice, sound, video, and media-asset generation are out of scope.

## License

[AGPL-3.0-only](LICENSE)
