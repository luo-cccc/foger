export type CliLanguage = "zh" | "en";

type WriteIssue = {
  readonly severity: string;
  readonly category: string;
  readonly description: string;
};

type WriteResultShape = {
  readonly episodeNumber: number;
  readonly title: string;
  readonly episodeDurationSeconds: number;
  readonly status: string;
  readonly revised: boolean;
  readonly issues: ReadonlyArray<WriteIssue>;
  readonly auditPassed?: boolean;
  readonly passedAudit?: boolean;
};

type EpisodeRecovery =
  | { readonly kind: "committed-cleanup"; readonly episodeNumber: number }
  | { readonly kind: "rolled-back"; readonly episodeNumber: number; readonly rolledBackTo: number };

type ImportResultShape = {
  readonly importedCount: number;
  readonly totalDurationSeconds: number;
  readonly nextEpisode: number;
  readonly continueBookId: string;
};

function localize(language: CliLanguage, messages: { zh: string; en: string }): string {
  return language === "en" ? messages.en : messages.zh;
}

function normalizeCliLanguageTag(value: string | undefined): CliLanguage | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized.startsWith("en")) {
    return "en";
  }
  if (normalized.startsWith("zh")) {
    return "zh";
  }
  return undefined;
}

export function resolveCliLanguage(
  language?: string,
  env: NodeJS.ProcessEnv = process.env,
): CliLanguage {
  const explicit = normalizeCliLanguageTag(language);
  if (explicit) {
    return explicit;
  }

  const requested = normalizeCliLanguageTag(env.INKOS_LOCALE);
  if (requested) {
    return requested;
  }

  const detected = normalizeCliLanguageTag(env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG);
  return detected ?? "zh";
}

export function formatBookCreateCreating(
  language: CliLanguage,
  title: string,
  genre: string,
  platform: string,
): string {
  return localize(language, {
    zh: `创建书籍 "${title}"（${genre} / ${platform}）...`,
    en: `Creating book "${title}" (${genre} / ${platform})...`,
  });
}

export function formatBookCreateCreated(language: CliLanguage, bookId: string): string {
  return localize(language, {
    zh: `已创建书籍：${bookId}`,
    en: `Book created: ${bookId}`,
  });
}

export function formatBookCreateLocation(language: CliLanguage, bookId: string): string {
  return localize(language, {
    zh: `  位置：books/${bookId}/`,
    en: `  Location: books/${bookId}/`,
  });
}

export function formatBookCreateFoundationReady(language: CliLanguage): string {
  return localize(language, {
    zh: "  故事圣经、大纲和书籍规则已生成。",
    en: "  Story bible, outline, book rules generated.",
  });
}

export function formatBookCreateNextStep(language: CliLanguage, bookId: string): string {
  return localize(language, {
    zh: `下一步：inkos write next ${bookId}`,
    en: `Next: inkos write next ${bookId}`,
  });
}

export function formatWriteNextProgress(
  language: CliLanguage,
  current: number,
  total: number,
  bookId: string,
): string {
  return localize(language, {
    zh: `[${current}/${total}] 为「${bookId}」撰写剧集...`,
    en: `[${current}/${total}] Writing episode for "${bookId}"...`,
  });
}

export function formatWriteNextResultLines(
  language: CliLanguage,
  result: WriteResultShape,
): string[] {
  const auditPassed = result.auditPassed ?? result.passedAudit ?? false;
  const durationLabel = `${result.episodeDurationSeconds}s`;
  const lines = [
    localize(language, {
      zh: `  第${result.episodeNumber}集：${result.title}`,
      en: `  Episode ${result.episodeNumber}: ${result.title}`,
    }),
    localize(language, {
      zh: `  时长：${durationLabel}`,
      en: `  Duration: ${durationLabel}`,
    }),
    localize(language, {
      zh: `  审计：${auditPassed ? "通过" : "需复核"}`,
      en: `  Audit: ${auditPassed ? "PASSED" : "NEEDS REVIEW"}`,
    }),
  ];

  if (result.revised) {
    lines.push(localize(language, {
      zh: "  自动修正：已执行（已修复关键问题）",
      en: "  Auto-revised: YES (critical issues were fixed)",
    }));
  }

  lines.push(localize(language, {
    zh: `  状态：${result.status}`,
    en: `  Status: ${result.status}`,
  }));

  if (result.issues.length > 0) {
    lines.push(localize(language, {
      zh: "  问题：",
      en: "  Issues:",
    }));
    for (const issue of result.issues) {
      lines.push(`    [${issue.severity}] ${issue.category}: ${issue.description}`);
    }
  }

  return lines;
}

export function formatWriteNextComplete(language: CliLanguage): string {
  return localize(language, {
    zh: "完成。",
    en: "Done.",
  });
}

export function formatEpisodeRecoveryNotice(
  language: CliLanguage,
  recovery: EpisodeRecovery | undefined,
): string | null {
  if (!recovery) {
    return null;
  }

  if (recovery.kind === "rolled-back") {
    return localize(language, {
      zh: `已恢复未完成的第 ${recovery.episodeNumber} 集写入，已回滚至第 ${recovery.rolledBackTo} 集后继续。`,
      en: `Recovered an incomplete episode ${recovery.episodeNumber} write and rolled back to episode ${recovery.rolledBackTo} before continuing.`,
    });
  }

  return localize(language, {
    zh: `已清理第 ${recovery.episodeNumber} 集已提交写入留下的恢复标记。`,
    en: `Cleared the recovery marker left by the committed episode ${recovery.episodeNumber} write.`,
  });
}

export function formatAutoWriteStart(
  language: CliLanguage,
  bookId: string,
  startEpisode: number,
  targetEpisode: number,
): string {
  return localize(language, {
    zh: `自动写作「${bookId}」：从第${startEpisode}集连续写到第${targetEpisode}集...`,
    en: `Auto-writing "${bookId}": episode ${startEpisode} through episode ${targetEpisode}...`,
  });
}

export function formatAutoWriteAlreadyComplete(
  language: CliLanguage,
  bookId: string,
  writtenEpisodes: number,
  targetEpisode: number,
): string {
  return localize(language, {
    zh: `「${bookId}」已写到第${writtenEpisodes}集（目标第${targetEpisode}集），无需继续。`,
    en: `"${bookId}" already has ${writtenEpisodes} episode(s) written (target: episode ${targetEpisode}). Nothing to do.`,
  });
}

export type NotifyCommandAction = "write-next" | "write-rewrite" | "revise" | "audit" | "auto";

const NOTIFY_ACTION_LABELS: Record<NotifyCommandAction, { zh: string; en: string }> = {
  "write-next": { zh: "写作", en: "Write" },
  "write-rewrite": { zh: "重写", en: "Rewrite" },
  revise: { zh: "修订", en: "Revise" },
  audit: { zh: "审计", en: "Audit" },
  auto: { zh: "自动连写", en: "Auto-write" },
};

export function formatNotifyCommandTitle(
  language: CliLanguage,
  action: NotifyCommandAction,
  bookName: string | undefined,
  succeeded: boolean,
): string {
  const label = localize(language, NOTIFY_ACTION_LABELS[action]);
  const book = bookName === undefined
    ? ""
    : localize(language, { zh: `《${bookName}》`, en: `: ${bookName}` });
  return succeeded
    ? localize(language, { zh: `✅ ${label}完成${book}`, en: `✅ ${label} complete${book}` })
    : localize(language, { zh: `❌ ${label}失败${book}`, en: `❌ ${label} failed${book}` });
}

export function formatNotifyBatchWriteBody(
  language: CliLanguage,
  episodes: ReadonlyArray<{
    readonly episodeNumber: number;
    readonly title: string;
    readonly episodeDurationSeconds: number;
    readonly auditPassed: boolean;
  }>,
): string {
  const first = episodes[0]!;
  const last = episodes[episodes.length - 1]!;
  const lines = [
    localize(language, {
      zh: `本次完成 ${episodes.length} 集（第${first.episodeNumber}集到第${last.episodeNumber}集）`,
      en: `${episodes.length} episode(s) written (episode ${first.episodeNumber} to ${last.episodeNumber})`,
    }),
    ...episodes.map((episode) => {
      const durationLabel = `${episode.episodeDurationSeconds}s`;
      return localize(language, {
        zh: `第${episode.episodeNumber}集 ${episode.title} | ${durationLabel} | ${episode.auditPassed ? "审计通过" : "需复核"}`,
        en: `Episode ${episode.episodeNumber} ${episode.title} | ${durationLabel} | ${episode.auditPassed ? "audit passed" : "needs review"}`,
      });
    }),
  ];
  return lines.join("\n");
}

export function formatNotifyAuditBody(
  language: CliLanguage,
  result: {
    readonly episodeNumber: number;
    readonly passed: boolean;
    readonly issueCount: number;
    readonly summary: string;
  },
): string {
  const head = localize(language, {
    zh: `第${result.episodeNumber}集审计${result.passed ? "通过" : "未通过"}（${result.issueCount} 个问题）`,
    en: `Episode ${result.episodeNumber} audit ${result.passed ? "passed" : "failed"} (${result.issueCount} issue(s))`,
  });
  return result.summary ? `${head}\n${result.summary}` : head;
}

export function formatNotifyReviseBody(
  language: CliLanguage,
  result: {
    readonly episodeNumber: number;
    readonly applied: boolean;
    readonly episodeDurationSeconds: number;
    readonly fixedCount: number;
    readonly skippedReason?: string;
  },
): string {
  if (!result.applied) {
    return localize(language, {
      zh: `第${result.episodeNumber}集保留原稿${result.skippedReason ? `：${result.skippedReason}` : ""}`,
      en: `Episode ${result.episodeNumber} kept original draft${result.skippedReason ? `: ${result.skippedReason}` : ""}`,
    });
  }
  const durationLabel = `${result.episodeDurationSeconds}s`;
  return localize(language, {
    zh: `第${result.episodeNumber}集已修订 | ${durationLabel} | 修复 ${result.fixedCount} 个问题`,
    en: `Episode ${result.episodeNumber} revised | ${durationLabel} | ${result.fixedCount} issue(s) fixed`,
  });
}

export function formatNotifyFailureBody(language: CliLanguage, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return localize(language, {
    zh: `错误：${detail}`,
    en: `Error: ${detail}`,
  });
}

export function formatImportEpisodesDiscovery(
  language: CliLanguage,
  episodeCount: number,
  bookId: string,
): string {
  return localize(language, {
    zh: `发现 ${episodeCount} 集，准备导入到「${bookId}」。`,
    en: `Found ${episodeCount} episodes to import into "${bookId}".`,
  });
}

export function formatImportEpisodesResume(
  language: CliLanguage,
  resumeFrom: number,
): string {
  return localize(language, {
    zh: `从第 ${resumeFrom} 集继续导入。`,
    en: `Resuming from episode ${resumeFrom}.`,
  });
}

export function formatImportEpisodesComplete(
  language: CliLanguage,
  result: ImportResultShape,
): string[] {
  const durationLabel = `${result.totalDurationSeconds}s`;
  return [
    localize(language, {
      zh: "导入完成：",
      en: "Import complete:",
    }),
    localize(language, {
      zh: `  已导入剧集：${result.importedCount}`,
      en: `  Episodes imported: ${result.importedCount}`,
    }),
    localize(language, {
      zh: `  总时长：${durationLabel}`,
      en: `  Total duration: ${durationLabel}`,
    }),
    localize(language, {
      zh: `  下一集编号：${result.nextEpisode}`,
      en: `  Next episode number: ${result.nextEpisode}`,
    }),
    "",
    localize(language, {
      zh: `运行 "inkos write next ${result.continueBookId}" 继续写作。`,
      en: `Run "inkos write next ${result.continueBookId}" to continue writing.`,
    }),
  ];
}

export function formatImportCanonStart(
  language: CliLanguage,
  parentBookId: string,
  targetBookId: string,
): string {
  return localize(language, {
    zh: `把 "${parentBookId}" 的正典导入到 "${targetBookId}"...`,
    en: `Importing canon from "${parentBookId}" into "${targetBookId}"...`,
  });
}

export function formatImportCanonComplete(language: CliLanguage): string[] {
  return [
    localize(language, {
      zh: "正典已导入：story/parent_canon.md",
      en: "Canon imported: story/parent_canon.md",
    }),
    localize(language, {
      zh: "Writer 和 auditor 会在番外模式下自动识别这个文件。",
      en: "Writer and auditor will auto-detect this file for spinoff mode.",
    }),
  ];
}

export function formatListModelsEmpty(language: CliLanguage, service: string): string {
  return localize(language, {
    zh: `${service} 没有可用模型（可能需要 --api-key 和 --base-url）`,
    en: `No models available for ${service} (you may need --api-key and --base-url)`,
  });
}

export function formatListModelsHeader(
  language: CliLanguage,
  service: string,
  count: number,
): string {
  return localize(language, {
    zh: `${service}：${count} 个模型`,
    en: `${service}: ${count} model(s)`,
  });
}

export function formatDoctorHintQuota(language: CliLanguage): string {
  return localize(language, {
    zh: "检查 API Key 是否正确、模型是否可用，以及账号余额或配额是否足够。",
    en: "Check that the API key is valid, the model is available, and the account has enough balance or quota.",
  });
}

export function formatDoctorHintOpenAiProbeExhausted(language: CliLanguage): string {
  return localize(language, {
    zh: "当前已自动尝试 chat/responses 与流式开关组合；如果仍失败，问题更可能在模型名、baseUrl 路径或服务商兼容性本身。",
    en: "All chat/responses and stream on/off combinations were already probed; if it still fails, the problem is more likely the model name, the baseUrl path, or provider compatibility itself.",
  });
}

export function formatDoctorHintBaseUrl(language: CliLanguage): string {
  return localize(language, {
    zh: "baseUrl 可能不正确，检查 INKOS_LLM_BASE_URL 是否包含完整路径（如 /v1）",
    en: "The baseUrl may be wrong. Check that INKOS_LLM_BASE_URL includes the full path (e.g. /v1).",
  });
}

export function formatDoctorHintStreamRequirement(language: CliLanguage): string {
  return localize(language, {
    zh: "检查提供方文档，确认该接口要求 stream=true、stream=false，还是根本不支持 stream",
    en: "Check the provider docs to confirm whether the endpoint requires stream=true, stream=false, or does not support streaming at all.",
  });
}

export function formatDoctorHintModelName(language: CliLanguage): string {
  return localize(language, {
    zh: "检查模型名称是否正确（INKOS_LLM_MODEL）",
    en: "Check that the model name is correct (INKOS_LLM_MODEL).",
  });
}

export function formatDoctorHintInvalidApiKey(language: CliLanguage): string {
  return localize(language, {
    zh: "API Key 无效，检查 INKOS_LLM_API_KEY",
    en: "The API key is invalid. Check INKOS_LLM_API_KEY.",
  });
}
