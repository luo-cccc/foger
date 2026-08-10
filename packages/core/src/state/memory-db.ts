/**
 * Temporal memory database for InkOS truth files.
 *
 * Uses Node.js built-in SQLite (node:sqlite, Node 22+).
 * Stores facts with temporal validity (valid_from/valid_until episode numbers),
 * enabling precise queries like "what did character X know in episode 5?"
 *
 * Backward compatible: existing markdown truth files are still the primary
 * persistence layer. MemoryDB is an acceleration index built alongside them.
 */

import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);

const FACT_SELECT_COLUMNS = `
  id,
  subject,
  predicate,
  object,
  valid_from_episode AS validFromEpisode,
  valid_until_episode AS validUntilEpisode,
  source_episode AS sourceEpisode
`;

export interface Fact {
  readonly id?: number;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly validFromEpisode: number;
  readonly validUntilEpisode: number | null;
  readonly sourceEpisode: number;
}

export interface StoredSummary {
  readonly episode: number;
  readonly title: string;
  readonly characters: string;
  readonly events: string;
  readonly stateChanges: string;
  readonly hookActivity: string;
  readonly mood: string;
  readonly episodeType: string;
}

export interface StoredHook {
  readonly hookId: string;
  readonly startEpisode: number;
  readonly type: string;
  readonly status: string;
  readonly lastAdvancedEpisode: number;
  readonly expectedPayoff: string;
  readonly payoffTiming?: string;
  readonly notes: string;
  // Phase 7 — hook causality / promotion metadata.
  readonly dependsOn?: ReadonlyArray<string>;
  readonly paysOffInArc?: string;
  readonly coreHook?: boolean;
  readonly halfLifeEpisodes?: number;
  readonly advancedCount?: number;
  // Phase 7 hotfix 2 — whether the seed has been promoted into the live ledger
  // (architect-time structural rules + consolidator-time advanced_count rule).
  // Reviewer uses this to gate critical-severity escalation.
  readonly promoted?: boolean;
}

export class MemoryDB {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;

  constructor(bookDir: string) {
    // node:sqlite requires Node 22+; require() via createRequire for ESM compat
    const { DatabaseSync } = require("node:sqlite");
    const dbPath = join(bookDir, "story", "memory.db");
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        valid_from_episode INTEGER NOT NULL,
        valid_until_episode INTEGER,
        source_episode INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS episode_summaries (
        episode INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        characters TEXT NOT NULL DEFAULT '',
        events TEXT NOT NULL DEFAULT '',
        state_changes TEXT NOT NULL DEFAULT '',
        hook_activity TEXT NOT NULL DEFAULT '',
        mood TEXT NOT NULL DEFAULT '',
        episode_type TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS hooks (
        hook_id TEXT PRIMARY KEY,
        start_episode INTEGER NOT NULL DEFAULT 0,
        type TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        last_advanced_episode INTEGER NOT NULL DEFAULT 0,
        expected_payoff TEXT NOT NULL DEFAULT '',
        payoff_timing TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject);
      CREATE INDEX IF NOT EXISTS idx_facts_valid ON facts(valid_from_episode, valid_until_episode);
      CREATE INDEX IF NOT EXISTS idx_facts_source ON facts(source_episode);
      CREATE INDEX IF NOT EXISTS idx_hooks_status ON hooks(status);
      CREATE INDEX IF NOT EXISTS idx_hooks_last_advanced ON hooks(last_advanced_episode);
    `);

    this.ensureColumn("hooks", "payoff_timing", "TEXT NOT NULL DEFAULT ''");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    try {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch {
      // Column already exists on existing databases.
    }
  }

  // ---------------------------------------------------------------------------
  // Facts (temporal)
  // ---------------------------------------------------------------------------

  /** Add a new fact. */
  addFact(fact: Omit<Fact, "id">): number {
    const stmt = this.db.prepare(
      `INSERT INTO facts (subject, predicate, object, valid_from_episode, valid_until_episode, source_episode)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      fact.subject, fact.predicate, fact.object,
      fact.validFromEpisode, fact.validUntilEpisode ?? null, fact.sourceEpisode,
    );
    return Number(result.lastInsertRowid);
  }

  /** Invalidate a fact (set valid_until). */
  invalidateFact(id: number, untilEpisode: number): void {
    this.db.prepare(
      "UPDATE facts SET valid_until_episode = ? WHERE id = ?",
    ).run(untilEpisode, id);
  }

  /** Get all currently valid facts (valid_until is null). */
  getCurrentFacts(): ReadonlyArray<Fact> {
    return this.db.prepare(
      `SELECT ${FACT_SELECT_COLUMNS}
       FROM facts
       WHERE valid_until_episode IS NULL
       ORDER BY subject, predicate`,
    ).all() as unknown as Fact[];
  }

  /** Get facts about a specific subject that are valid at a given episode. */
  getFactsAt(subject: string, episode: number): ReadonlyArray<Fact> {
    return this.db.prepare(
      `SELECT ${FACT_SELECT_COLUMNS}
       FROM facts
       WHERE subject = ? AND valid_from_episode <= ?
       AND (valid_until_episode IS NULL OR valid_until_episode > ?)
       ORDER BY predicate`,
    ).all(subject, episode, episode) as unknown as Fact[];
  }

  /** Get all facts about a subject (including historical). */
  getFactHistory(subject: string): ReadonlyArray<Fact> {
    return this.db.prepare(
      `SELECT ${FACT_SELECT_COLUMNS}
       FROM facts
       WHERE subject = ?
       ORDER BY valid_from_episode`,
    ).all(subject) as unknown as Fact[];
  }

  /** Search facts by predicate (e.g., all "location" facts). */
  getFactsByPredicate(predicate: string): ReadonlyArray<Fact> {
    return this.db.prepare(
      `SELECT ${FACT_SELECT_COLUMNS}
       FROM facts
       WHERE predicate = ? AND valid_until_episode IS NULL
       ORDER BY subject`,
    ).all(predicate) as unknown as Fact[];
  }

  /** Get facts relevant to a set of character names. */
  getFactsForCharacters(names: ReadonlyArray<string>): ReadonlyArray<Fact> {
    if (names.length === 0) return [];
    const placeholders = names.map(() => "?").join(",");
    return this.db.prepare(
      `SELECT ${FACT_SELECT_COLUMNS}
       FROM facts
       WHERE subject IN (${placeholders}) AND valid_until_episode IS NULL
       ORDER BY subject, predicate`,
    ).all(...names) as unknown as Fact[];
  }

  replaceCurrentFacts(facts: ReadonlyArray<Omit<Fact, "id">>): void {
    this.db.exec("DELETE FROM facts WHERE valid_until_episode IS NULL");
    for (const fact of facts) {
      this.addFact(fact);
    }
  }

  resetFacts(): void {
    this.db.exec("DELETE FROM facts");
  }

  // ---------------------------------------------------------------------------
  // Episode summaries
  // ---------------------------------------------------------------------------

  /** Upsert a episode summary. */
  upsertSummary(summary: StoredSummary): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO episode_summaries (episode, title, characters, events, state_changes, hook_activity, mood, episode_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      summary.episode, summary.title, summary.characters, summary.events,
      summary.stateChanges, summary.hookActivity, summary.mood, summary.episodeType,
    );
  }

  replaceSummaries(summaries: ReadonlyArray<StoredSummary>): void {
    this.db.exec("DELETE FROM episode_summaries");
    for (const summary of summaries) {
      this.upsertSummary(summary);
    }
  }

  /** Get summaries for a range of episodes. */
  getSummaries(fromEpisode: number, toEpisode: number): ReadonlyArray<StoredSummary> {
    return this.db.prepare(
      `SELECT
         episode,
         title,
         characters,
         events,
         state_changes AS stateChanges,
         hook_activity AS hookActivity,
         mood,
         episode_type AS episodeType
       FROM episode_summaries
       WHERE episode >= ? AND episode <= ?
       ORDER BY episode`,
    ).all(fromEpisode, toEpisode) as unknown as StoredSummary[];
  }

  /** Get summaries matching any of the given character names. */
  getSummariesByCharacters(names: ReadonlyArray<string>): ReadonlyArray<StoredSummary> {
    if (names.length === 0) return [];
    const conditions = names.map(() => "characters LIKE ?").join(" OR ");
    const params = names.map((n) => `%${n}%`);
    return this.db.prepare(
      `SELECT
         episode,
         title,
         characters,
         events,
         state_changes AS stateChanges,
         hook_activity AS hookActivity,
         mood,
         episode_type AS episodeType
       FROM episode_summaries
       WHERE ${conditions}
       ORDER BY episode`,
    ).all(...params) as unknown as StoredSummary[];
  }

  /** Get total episode count. */
  getEpisodeCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM episode_summaries").get() as unknown as { count: number };
    return row.count;
  }

  /** Get the most recent N summaries. */
  getRecentSummaries(count: number): ReadonlyArray<StoredSummary> {
    return this.db.prepare(
      `SELECT
         episode,
         title,
         characters,
         events,
         state_changes AS stateChanges,
         hook_activity AS hookActivity,
         mood,
         episode_type AS episodeType
       FROM episode_summaries
       ORDER BY episode DESC
       LIMIT ?`,
    ).all(count) as unknown as ReadonlyArray<StoredSummary>;
  }

  // ---------------------------------------------------------------------------
  // Hooks
  // ---------------------------------------------------------------------------

  upsertHook(hook: StoredHook): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO hooks (hook_id, start_episode, type, status, last_advanced_episode, expected_payoff, payoff_timing, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hook.hookId,
      hook.startEpisode,
      hook.type,
      hook.status,
      hook.lastAdvancedEpisode,
      hook.expectedPayoff,
      hook.payoffTiming ?? "",
      hook.notes,
    );
  }

  replaceHooks(hooks: ReadonlyArray<StoredHook>): void {
    this.db.exec("DELETE FROM hooks");
    for (const hook of hooks) {
      this.upsertHook(hook);
    }
  }

  getActiveHooks(): ReadonlyArray<StoredHook> {
    return this.db.prepare(
      `SELECT
         hook_id AS hookId,
         start_episode AS startEpisode,
         type,
         status,
         last_advanced_episode AS lastAdvancedEpisode,
         expected_payoff AS expectedPayoff,
         payoff_timing AS payoffTiming,
         notes
       FROM hooks
       WHERE lower(status) NOT IN ('resolved', 'closed', '已回收', '已解决')
       ORDER BY last_advanced_episode DESC, start_episode DESC, hook_id ASC`,
    ).all() as unknown as ReadonlyArray<StoredHook>;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  close(): void {
    this.db.close();
  }
}
