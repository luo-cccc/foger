import { describe, it, expect } from "vitest";
import {
  BookConfigSchema,
  PlatformSchema,
  GenreSchema,
  BookStatusSchema,
  normalizePlatformId,
  normalizePlatformOrOther,
} from "../models/book.js";
import { EpisodeMetaSchema, EpisodeStatusSchema } from "../models/episode.js";
import {
  ProjectConfigSchema,
  LLMConfigSchema,
  NotifyChannelSchema,
} from "../models/project.js";
import {
  EpisodeIntentSchema,
  EpisodeMemoSchema,
  ContextPackageSchema,
  RuleStackSchema,
  EpisodeTraceSchema,
} from "../models/input-governance.js";
import {
  LengthSpecSchema,
  LengthTelemetrySchema,
  LengthWarningSchema,
} from "../models/length-governance.js";
import {
  EpisodeRuntimeStateDeltaSchema,
  StateManifestSchema,
  HooksStateSchema,
  EpisodeSummariesStateSchema,
  CurrentStateStateSchema,
} from "../models/runtime-state.js";

// ---------------------------------------------------------------------------
// BookConfig
// ---------------------------------------------------------------------------

describe("BookConfigSchema", () => {
  const validBook = {
    id: "test-book-1",
    title: "Test Novel",
    platform: "tomato",
    genre: "xuanhuan",
    status: "active",
    schemaVersion: "inkos-episode-v2" as const,
    format: "screenplay" as const,
    targetEpisodes: 100,
    episodeDurationSeconds: 90,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  it("accepts a valid BookConfig", () => {
    const result = BookConfigSchema.parse(validBook);
    expect(result.id).toBe("test-book-1");
    expect(result.title).toBe("Test Novel");
    expect(result.platform).toBe("tomato");
  });

  it("requires the Episode v2 contract fields", () => {
    const minimal = {
      id: "b1",
      title: "B1",
      platform: "qidian",
      genre: "xianxia",
      status: "incubating",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    expect(() => BookConfigSchema.parse(minimal)).toThrow();
  });

  it("rejects empty id", () => {
    expect(() =>
      BookConfigSchema.parse({ ...validBook, id: "" }),
    ).toThrow();
  });

  it("rejects empty title", () => {
    expect(() =>
      BookConfigSchema.parse({ ...validBook, title: "" }),
    ).toThrow();
  });

  it("rejects invalid platform", () => {
    expect(() =>
      BookConfigSchema.parse({ ...validBook, platform: "kindle" }),
    ).toThrow();
  });

  it("accepts custom genre (string)", () => {
    const config = BookConfigSchema.parse({ ...validBook, genre: "romance" });
    expect(config.genre).toBe("romance");
  });

  it("rejects invalid status", () => {
    expect(() =>
      BookConfigSchema.parse({ ...validBook, status: "archived" }),
    ).toThrow();
  });

  it("accepts the new 150-second default duration", () => {
    const config = BookConfigSchema.parse({ ...validBook, episodeDurationSeconds: 150 });
    expect(config.episodeDurationSeconds).toBe(150);
  });

  it("rejects episodeDurationSeconds outside the 60-210 second range", () => {
    expect(() =>
      BookConfigSchema.parse({ ...validBook, episodeDurationSeconds: 500 }),
    ).toThrow();
    expect(() =>
      BookConfigSchema.parse({ ...validBook, episodeDurationSeconds: 59 }),
    ).toThrow();
  });

  it("rejects targetEpisodes below 1", () => {
    expect(() =>
      BookConfigSchema.parse({ ...validBook, targetEpisodes: 0 }),
    ).toThrow();
  });

  it("rejects non-integer targetEpisodes", () => {
    expect(() =>
      BookConfigSchema.parse({ ...validBook, targetEpisodes: 10.5 }),
    ).toThrow();
  });

  it("rejects invalid datetime strings", () => {
    expect(() =>
      BookConfigSchema.parse({ ...validBook, createdAt: "not-a-date" }),
    ).toThrow();
  });
});

describe("PlatformSchema", () => {
  it.each(["tomato", "feilu", "qidian", "other"] as const)(
    "accepts '%s'",
    (value) => {
      expect(PlatformSchema.parse(value)).toBe(value);
    },
  );

  it("rejects unknown platform", () => {
    expect(() => PlatformSchema.parse("amazon")).toThrow();
  });

  it("normalizes platform ids and human-facing aliases", () => {
    expect(normalizePlatformId("tomato")).toBe("tomato");
    expect(normalizePlatformId("番茄小说")).toBe("tomato");
    expect(normalizePlatformId("fanqie-novel")).toBe("tomato");
    expect(normalizePlatformId("起点中文网")).toBe("qidian");
    expect(normalizePlatformId("飞卢")).toBe("feilu");
    expect(normalizePlatformId("royal-road")).toBe("other");
    expect(normalizePlatformId("Kindle Unlimited")).toBe("other");
    expect(normalizePlatformId("")).toBeUndefined();
    expect(normalizePlatformOrOther("")).toBe("other");
  });
});

describe("GenreSchema", () => {
  const validGenres = [
    "xuanhuan",
    "xianxia",
    "urban",
    "horror",
    "other",
  ] as const;

  it.each(validGenres)("accepts '%s'", (value) => {
    expect(GenreSchema.parse(value)).toBe(value);
  });

  it("accepts custom genre strings", () => {
    expect(GenreSchema.parse("scifi")).toBe("scifi");
    expect(GenreSchema.parse("my-custom-genre")).toBe("my-custom-genre");
  });

  it("rejects empty genre", () => {
    expect(() => GenreSchema.parse("")).toThrow();
  });
});

describe("BookStatusSchema", () => {
  const validStatuses = [
    "incubating",
    "outlining",
    "active",
    "paused",
    "completed",
    "dropped",
  ] as const;

  it.each(validStatuses)("accepts '%s'", (value) => {
    expect(BookStatusSchema.parse(value)).toBe(value);
  });

  it("rejects unknown status", () => {
    expect(() => BookStatusSchema.parse("archived")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// EpisodeMeta
// ---------------------------------------------------------------------------

describe("EpisodeMetaSchema", () => {
  const validEpisode = {
    episodeNumber: 1,
    title: "Episode One",
    status: "drafted",
    episodeDurationSeconds: 3000,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    auditIssues: [],
  };

  it("accepts a valid EpisodeMeta", () => {
    const result = EpisodeMetaSchema.parse(validEpisode);
    expect(result.episodeNumber).toBe(1);
    expect(result.title).toBe("Episode One");
    expect(result.status).toBe("drafted");
  });

  it("applies default episodeDurationSeconds of 0", () => {
    const minimal = {
      episodeNumber: 5,
      title: "Ch5",
      status: "card-generated",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const result = EpisodeMetaSchema.parse(minimal);
    expect(result.episodeDurationSeconds).toBe(0);
  });

  it("applies default empty auditIssues", () => {
    const minimal = {
      episodeNumber: 1,
      title: "Ch1",
      status: "drafted",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const result = EpisodeMetaSchema.parse(minimal);
    expect(result.auditIssues).toEqual([]);
  });

  it("applies default empty lengthWarnings", () => {
    const minimal = {
      episodeNumber: 1,
      title: "Ch1",
      status: "drafted",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const result = EpisodeMetaSchema.parse(minimal);
    expect(result.lengthWarnings).toEqual([]);
  });

  it("accepts optional reviewNote", () => {
    const withNote = { ...validEpisode, reviewNote: "Looks good" };
    const result = EpisodeMetaSchema.parse(withNote);
    expect(result.reviewNote).toBe("Looks good");
  });

  it("accepts an optional episode operation ID", () => {
    const result = EpisodeMetaSchema.parse({
      ...validEpisode,
      operationId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.operationId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(() => EpisodeMetaSchema.parse({ ...validEpisode, operationId: "not-a-uuid" })).toThrow();
  });

  it("accepts bounded review telemetry and rejects unknown termination reasons", () => {
    const reviewTelemetry = {
      terminationReason: "issue-set-unchanged",
      auditCalls: 2,
      revisionCalls: 1,
      normalizationCalls: 1,
      reviewedCandidates: 2,
      configuredMaxRevisions: 2,
    } as const;
    const result = EpisodeMetaSchema.parse({ ...validEpisode, reviewTelemetry });
    expect(result.reviewTelemetry).toEqual(reviewTelemetry);
    expect(() => EpisodeMetaSchema.parse({
      ...validEpisode,
      reviewTelemetry: { ...reviewTelemetry, terminationReason: "keep-spending" },
    })).toThrow();
  });

  it("omits reviewNote when not provided", () => {
    const result = EpisodeMetaSchema.parse(validEpisode);
    expect(result.reviewNote).toBeUndefined();
  });

  it("rejects episode number < 1", () => {
    expect(() =>
      EpisodeMetaSchema.parse({ ...validEpisode, episodeNumber: 0 }),
    ).toThrow();
  });

  it("rejects negative episode number", () => {
    expect(() =>
      EpisodeMetaSchema.parse({ ...validEpisode, episodeNumber: -1 }),
    ).toThrow();
  });

  it("rejects invalid status", () => {
    expect(() =>
      EpisodeMetaSchema.parse({ ...validEpisode, status: "writing" }),
    ).toThrow();
  });

  it("rejects non-integer episode number", () => {
    expect(() =>
      EpisodeMetaSchema.parse({ ...validEpisode, episodeNumber: 1.5 }),
    ).toThrow();
  });
});

describe("EpisodeStatusSchema", () => {
  const allStatuses = [
    "card-generated",
    "drafting",
    "drafted",
    "auditing",
    "audit-passed",
    "audit-failed",
    "state-degraded",
    "revising",
    "ready-for-review",
    "approved",
    "rejected",
    "published",
    "imported",
  ] as const;

  it.each(allStatuses)("accepts '%s'", (value) => {
    expect(EpisodeStatusSchema.parse(value)).toBe(value);
  });

  it("has exactly 13 valid statuses", () => {
    expect(EpisodeStatusSchema.options).toHaveLength(13);
  });

  it("rejects unknown status", () => {
    expect(() => EpisodeStatusSchema.parse("editing")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ProjectConfig
// ---------------------------------------------------------------------------

describe("ProjectConfigSchema", () => {
  const validProject = {
    name: "my-project",
    version: "0.1.0" as const,
    llm: {
      provider: "anthropic" as const,
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test-key",
      model: "claude-sonnet-4-5-20250514",
    },
    notify: [],
  };

  it("accepts a valid ProjectConfig", () => {
    const result = ProjectConfigSchema.parse(validProject);
    expect(result.name).toBe("my-project");
    expect(result.version).toBe("0.1.0");
  });

  it("applies default daemon config", () => {
    const result = ProjectConfigSchema.parse(validProject);
    expect(result.daemon.maxConcurrentBooks).toBe(3);
    expect(result.daemon.schedule.writeCron).toBe("*/15 * * * *");
    expect(result.daemon.episodesPerCycle).toBe(1);
    expect(result.daemon.maxEpisodesPerDay).toBe(50);
  });

  it("rejects invalid daemon cron expressions", () => {
    expect(() => ProjectConfigSchema.parse({
      ...validProject,
      daemon: { schedule: { writeCron: "not a cron expression" } },
    })).toThrow(/Invalid cron expression/);
  });

  it("defaults long-form writing review retries to two and accepts project overrides", () => {
    const defaults = ProjectConfigSchema.parse(validProject);
    expect(defaults.writing.reviewRetries).toBe(2);

    const overridden = ProjectConfigSchema.parse({
      ...validProject,
      writing: { reviewRetries: 3 },
    });
    expect(overridden.writing.reviewRetries).toBe(3);
  });

  it("keeps the long-form episode review mode through config parsing", () => {
    const parsed = ProjectConfigSchema.parse({
      ...validProject,
      writing: { reviewRetries: 1, reviewMode: "manual" },
    });

    expect(parsed.writing.reviewMode).toBe("manual");
  });

  it("applies default empty notify array", () => {
    const withoutNotify = {
      name: "p1",
      version: "0.1.0" as const,
      llm: validProject.llm,
    };
    const result = ProjectConfigSchema.parse(withoutNotify);
    expect(result.notify).toEqual([]);
  });

  it("rejects wrong version", () => {
    expect(() =>
      ProjectConfigSchema.parse({ ...validProject, version: "1.0.0" }),
    ).toThrow();
  });

  it("rejects empty project name", () => {
    expect(() =>
      ProjectConfigSchema.parse({ ...validProject, name: "" }),
    ).toThrow();
  });

  it("rejects missing LLM config", () => {
    expect(() =>
      ProjectConfigSchema.parse({ name: "p", version: "0.1.0" }),
    ).toThrow();
  });
});

describe("LLMConfigSchema", () => {
  it("accepts valid LLM config", () => {
    const result = LLMConfigSchema.parse({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-xxx",
      model: "gpt-4o",
    });
    expect(result.provider).toBe("openai");
  });

  it("rejects invalid provider", () => {
    expect(() =>
      LLMConfigSchema.parse({
        provider: "mistral",
        baseUrl: "https://api.example.com",
        apiKey: "key",
        model: "m",
      }),
    ).toThrow();
  });

  it("rejects invalid URL", () => {
    expect(() =>
      LLMConfigSchema.parse({
        provider: "custom",
        baseUrl: "not-a-url",
        apiKey: "key",
        model: "m",
      }),
    ).toThrow();
  });

  it("defaults apiKey to empty string when omitted", () => {
    const result = LLMConfigSchema.parse({
      provider: "anthropic",
      baseUrl: "https://api.example.com",
      model: "m",
    });
    expect(result.apiKey).toBe("");
  });

  it("rejects empty model", () => {
    expect(() =>
      LLMConfigSchema.parse({
        provider: "anthropic",
        baseUrl: "https://api.example.com",
        apiKey: "key",
        model: "",
      }),
    ).toThrow();
  });
});

describe("NotifyChannelSchema", () => {
  it("accepts telegram channel", () => {
    const result = NotifyChannelSchema.parse({
      type: "telegram",
      botToken: "123:ABC",
      chatId: "-100123",
    });
    expect(result.type).toBe("telegram");
  });

  it("accepts feishu channel", () => {
    const result = NotifyChannelSchema.parse({
      type: "feishu",
      webhookUrl: "https://open.feishu.cn/webhook/xxx",
    });
    expect(result.type).toBe("feishu");
  });

  it("accepts wechat-work channel", () => {
    const result = NotifyChannelSchema.parse({
      type: "wechat-work",
      webhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx",
    });
    expect(result.type).toBe("wechat-work");
  });

  it("rejects telegram with missing botToken", () => {
    expect(() =>
      NotifyChannelSchema.parse({
        type: "telegram",
        chatId: "-100",
      }),
    ).toThrow();
  });

  it("rejects feishu with invalid URL", () => {
    expect(() =>
      NotifyChannelSchema.parse({
        type: "feishu",
        webhookUrl: "not-a-url",
      }),
    ).toThrow();
  });

  it("rejects unknown channel type", () => {
    expect(() =>
      NotifyChannelSchema.parse({
        type: "slack",
        webhookUrl: "https://hooks.slack.com/xxx",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Input Governance
// ---------------------------------------------------------------------------

describe("EpisodeIntentSchema", () => {
  it("accepts a valid episode intent", () => {
    const result = EpisodeIntentSchema.parse({
      episode: 12,
      goal: "Pull focus back to the mentor conflict",
      outlineNode: "Volume 2 / Episode 12",
      arcContext: "Volume arc: mentor confrontation, post-betrayal.",
      mustKeep: ["Protagonist remains injured"],
      mustAvoid: ["Do not reveal the mastermind"],
      styleEmphasis: ["dialogue tension", "character conflict"],
    });

    expect(result.episode).toBe(12);
    expect(result.goal).toContain("mentor conflict");
    expect(result.outlineNode).toBe("Volume 2 / Episode 12");
    expect(result.arcContext).toContain("Volume arc");
    expect(result.mustKeep).toContain("Protagonist remains injured");
  });

  it("defaults optional arrays to empty", () => {
    const result = EpisodeIntentSchema.parse({
      episode: 1,
      goal: "Establish the protagonist's first setback",
    });

    expect(result.outlineNode).toBeUndefined();
    expect(result.arcContext).toBeUndefined();
    expect(result.mustKeep).toEqual([]);
    expect(result.mustAvoid).toEqual([]);
    expect(result.styleEmphasis).toEqual([]);
  });

  it("rejects invalid episode numbers", () => {
    expect(() =>
      EpisodeIntentSchema.parse({
        episode: 0,
        goal: "Bad episode",
      }),
    ).toThrow();
  });
});

describe("EpisodeMemoSchema", () => {
  it("accepts a memo with prose body and threadRefs", () => {
    const result = EpisodeMemoSchema.parse({
      episode: 12,
      goal: "把七号门被动过手脚钉成现场实证",
      isGoldenOpening: true,
      body: "## 当前任务\n主角进入七号门……\n## 不要做\n不要让对手降智。",
      threadRefs: ["H019", "S004"],
    });

    expect(result.isGoldenOpening).toBe(true);
    expect(result.body).toContain("当前任务");
    expect(result.threadRefs).toEqual(["H019", "S004"]);
  });

  it("defaults isGoldenOpening and threadRefs when omitted", () => {
    const result = EpisodeMemoSchema.parse({
      episode: 3,
      goal: "让主角做下第一次不可逆选择",
      body: "## 当前任务\n主角落下决定。",
    });

    expect(result.isGoldenOpening).toBe(false);
    expect(result.threadRefs).toEqual([]);
  });

  it("rejects goal longer than 50 chars", () => {
    expect(() =>
      EpisodeMemoSchema.parse({
        episode: 1,
        goal: "a".repeat(51),
        body: "## 当前任务\nx",
      }),
    ).toThrow();
  });

  it("rejects empty body", () => {
    expect(() =>
      EpisodeMemoSchema.parse({
        episode: 1,
        goal: "xxx",
        body: "",
      }),
    ).toThrow();
  });
});

describe("ContextPackageSchema", () => {
  it("accepts selected context with provenance", () => {
    const result = ContextPackageSchema.parse({
      episode: 8,
      selectedContext: [
        {
          source: "story/current_focus.md",
          reason: "Current focus requests mentor conflict recovery",
          excerpt: "Recent episodes should center the mentor/student break.",
        },
        {
          source: "story/episode_summaries.md#10",
          reason: "Provide prior conflict context",
        },
      ],
    });

    expect(result.episode).toBe(8);
    expect(result.selectedContext).toHaveLength(2);
  });

  it("rejects context entries without source", () => {
    expect(() =>
      ContextPackageSchema.parse({
        episode: 8,
        selectedContext: [
          {
            reason: "Missing source",
          },
        ],
      }),
    ).toThrow();
  });
});

describe("RuleStackSchema", () => {
  it("accepts explicit layer precedence and overrides", () => {
    const result = RuleStackSchema.parse({
      layers: [
        { id: "L1", name: "hard_facts", precedence: 100, scope: "global" },
        { id: "L2", name: "author_intent", precedence: 80, scope: "book" },
        { id: "L3", name: "planning", precedence: 60, scope: "arc" },
        { id: "L4", name: "current_task", precedence: 70, scope: "local" },
      ],
      sections: {
        hard: ["story_bible"],
        soft: ["author_intent", "current_focus"],
        diagnostic: ["anti_ai_checks"],
      },
      overrideEdges: [
        { from: "L4", to: "L3", allowed: true, scope: "current_episode" },
        { from: "L4", to: "L2", allowed: false, scope: "current_episode" },
      ],
      activeOverrides: [
        {
          from: "L4",
          to: "L3",
          target: "volume_outline.episode_12",
          reason: "Current focus overrides the local plan",
        },
      ],
    });

    expect(result.layers[0]?.id).toBe("L1");
    expect(result.sections.hard).toContain("story_bible");
    expect(result.activeOverrides).toHaveLength(1);
  });

  it("defaults override lists to empty", () => {
    const result = RuleStackSchema.parse({
      layers: [
        { id: "L1", name: "hard_facts", precedence: 100, scope: "global" },
      ],
    });

    expect(result.sections).toEqual({
      hard: [],
      soft: [],
      diagnostic: [],
    });
    expect(result.overrideEdges).toEqual([]);
    expect(result.activeOverrides).toEqual([]);
  });

  it("rejects empty rule stacks", () => {
    expect(() =>
      RuleStackSchema.parse({
        layers: [],
      }),
    ).toThrow();
  });
});

describe("EpisodeTraceSchema", () => {
  it("accepts trace metadata for planner/composer output", () => {
    const result = EpisodeTraceSchema.parse({
      episode: 8,
      plannerInputs: [
        "story/author_intent.md",
        "story/current_focus.md",
      ],
      composerInputs: [
        "story/runtime/episode-0008.intent.md",
      ],
      selectedSources: [
        "story/current_state.md",
        "story/episode_summaries.md#7",
      ],
      notes: ["current_focus locally overrides planning"],
    });

    expect(result.plannerInputs).toContain("story/author_intent.md");
    expect(result.notes).toHaveLength(1);
    expect(result.sourceStats).toEqual([]);
  });

  it("defaults notes to empty", () => {
    const result = EpisodeTraceSchema.parse({
      episode: 2,
      plannerInputs: [],
      composerInputs: [],
      selectedSources: [],
    });

    expect(result.notes).toEqual([]);
  });
});

describe("Length governance schemas", () => {
  it("accepts a conservative length spec", () => {
    const result = LengthSpecSchema.parse({
      target: 2200,
      softMin: 1900,
      softMax: 2500,
      hardMin: 1600,
      hardMax: 2800,
      countingMode: "zh_chars",
      normalizeMode: "compress",
    });

    expect(result.target).toBe(2200);
    expect(result.softMin).toBe(1900);
    expect(result.normalizeMode).toBe("compress");
  });

  it("accepts telemetry for a episode length pass", () => {
    const result = LengthTelemetrySchema.parse({
      target: 2200,
      softMin: 1900,
      softMax: 2500,
      hardMin: 1600,
      hardMax: 2800,
      countingMode: "en_words",
      writerCount: 2600,
      postWriterNormalizeCount: 2450,
      postReviseCount: 2480,
      finalCount: 2480,
      normalizeApplied: true,
      lengthWarning: false,
    });

    expect(result.writerCount).toBe(2600);
    expect(result.normalizeApplied).toBe(true);
  });

  it("accepts a warning when final length drifts outside the hard band", () => {
    const result = LengthWarningSchema.parse({
      episode: 12,
      target: 2200,
      actual: 3100,
      countingMode: "zh_chars",
      reason: "episode exceeded the hard max after one normalization pass",
    });

    expect(result.episode).toBe(12);
    expect(result.actual).toBe(3100);
  });
});

describe("Runtime state schemas", () => {
  it("accepts a valid state manifest", () => {
    const result = StateManifestSchema.parse({
      schemaVersion: 2,
      language: "en",
      lastAppliedEpisode: 12,
      projectionVersion: 1,
      migrationWarnings: [],
    });

    expect(result.language).toBe("en");
    expect(result.lastAppliedEpisode).toBe(12);
  });

  it("accepts hook, summary, and current-state payloads", () => {
    const hooks = HooksStateSchema.parse({
      hooks: [
        {
          hookId: "mentor-debt",
          startEpisode: 1,
          type: "relationship",
          status: "open",
          lastAdvancedEpisode: 12,
          expectedPayoff: "Reveal the debt",
          notes: "Still unresolved",
        },
      ],
    });
    const summaries = EpisodeSummariesStateSchema.parse({
      rows: [
        {
          episodeNumber: 12,
          title: "River Ledger",
          characters: "Lin Yue",
          events: "Lin Yue checks the old ledger",
          stateChanges: "Debt sharpens",
          hookActivity: "mentor-debt advanced",
          mood: "tense",
          episodeType: "mainline",
        },
      ],
    });
    const currentState = CurrentStateStateSchema.parse({
      episode: 12,
      facts: [
        {
          subject: "protagonist",
          predicate: "Current Goal",
          object: "Trace the mentor debt",
          validFromEpisode: 12,
          validUntilEpisode: null,
          sourceEpisode: 12,
        },
      ],
    });

    expect(hooks.hooks[0]?.hookId).toBe("mentor-debt");
    expect(summaries.rows[0]?.title).toBe("River Ledger");
    expect(currentState.episode).toBe(12);
  });

  it("accepts a valid runtime-state delta", () => {
    const result = EpisodeRuntimeStateDeltaSchema.parse({
      episode: 12,
      currentStatePatch: {
        currentGoal: "Trace the mentor debt",
        currentConflict: "Guild pressure keeps colliding with the debt trail",
      },
      hookOps: {
        upsert: [
          {
            hookId: "mentor-debt",
            startEpisode: 1,
            type: "relationship",
            status: "progressing",
            lastAdvancedEpisode: 12,
            expectedPayoff: "Reveal the debt",
            notes: "Ledger clue sharpens the line",
          },
        ],
        mention: ["ledger-whisper"],
        resolve: [],
        defer: [],
      },
      newHookCandidates: [
        {
          type: "source-risk",
          expectedPayoff: "Reveal what the anonymous source already knew",
          notes: "A new unresolved thread opens around the source's prior knowledge.",
        },
      ],
      episodeSummary: {
        episodeNumber: 12,
        title: "River Ledger",
        characters: "Lin Yue",
        events: "Lin Yue checks the old ledger",
        stateChanges: "Debt sharpens",
        hookActivity: "mentor-debt advanced",
        mood: "tense",
        episodeType: "mainline",
      },
      notes: [],
    });

    expect(result.episode).toBe(12);
    expect(result.hookOps.upsert[0]?.hookId).toBe("mentor-debt");
    expect(result.hookOps.mention).toEqual(["ledger-whisper"]);
    expect(result.newHookCandidates[0]?.type).toBe("source-risk");
  });

  it("rejects natural-language numeric drift in runtime-state delta hooks", () => {
    expect(() =>
      EpisodeRuntimeStateDeltaSchema.parse({
        episode: 12,
        hookOps: {
          upsert: [
            {
              hookId: "mentor-debt",
              startEpisode: 1,
              type: "relationship",
              status: "open",
              lastAdvancedEpisode: "episode twelve",
            },
          ],
          resolve: [],
          defer: [],
        },
        notes: [],
      }),
    ).toThrow();
  });
});
