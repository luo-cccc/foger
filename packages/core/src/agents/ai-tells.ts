/**
 * Structural AI-tell detection — pure rule-based analysis (no LLM).
 *
 * Detects patterns common in AI-generated Chinese text:
 * - dim 20: Paragraph length uniformity (low variance)
 * - dim 21: Filler/hedge word density
 * - dim 22: Formulaic transition patterns
 * - dim 23: List-like structure (consecutive same-prefix sentences)
 */

export interface AITellIssue {
  readonly severity: "warning" | "info";
  readonly category: string;
  readonly description: string;
  readonly suggestion: string;
}

export interface AITellResult {
  readonly issues: ReadonlyArray<AITellIssue>;
}

type AITellLanguage = "zh" | "en";

/**
 * Locate the 1-based paragraph index (split on blank lines) containing `offset`.
 */
function paragraphIndexAt(content: string, offset: number): number {
  const before = content.slice(0, offset);
  return before.split(/\n\s*\n/).length;
}

/**
 * Build a short quoted excerpt around a match so findings point at concrete text.
 */
function excerptAround(content: string, offset: number, matchLength: number, radius = 10): string {
  const start = Math.max(0, offset - radius);
  const end = Math.min(content.length, offset + matchLength + radius);
  const excerpt = content.slice(start, end).replace(/\s+/g, " ").trim();
  return `…${excerpt}…`;
}

const HEDGE_WORDS: Record<AITellLanguage, ReadonlyArray<string>> = {
  zh: ["似乎", "可能", "或许", "大概", "某种程度上", "一定程度上", "在某种意义上"],
  en: ["seems", "seemed", "perhaps", "maybe", "apparently", "in some ways", "to some extent"],
};

const TRANSITION_WORDS: Record<AITellLanguage, ReadonlyArray<string>> = {
  zh: ["然而", "不过", "与此同时", "另一方面", "尽管如此", "话虽如此", "但值得注意的是"],
  en: ["however", "meanwhile", "on the other hand", "nevertheless", "even so", "still"],
};

/**
 * Analyze text content for structural AI-tell patterns.
 * Returns issues that can be merged into audit results.
 */
export function analyzeAITells(content: string, language: AITellLanguage = "zh"): AITellResult {
  const issues: AITellIssue[] = [];
  const isEnglish = language === "en";
  const joiner = isEnglish ? ", " : "、";

  const paragraphs = content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // dim 20: Paragraph length uniformity (needs ≥3 paragraphs)
  if (paragraphs.length >= 3) {
    const paragraphLengths = paragraphs.map((p) => p.length);
    const mean = paragraphLengths.reduce((a, b) => a + b, 0) / paragraphLengths.length;
    if (mean > 0) {
      const variance = paragraphLengths.reduce((sum, l) => sum + (l - mean) ** 2, 0) / paragraphLengths.length;
      const stdDev = Math.sqrt(variance);
      const cv = stdDev / mean;
      if (cv < 0.15) {
        const lengthList = paragraphs
          .slice(0, 8)
          .map((p, i) => (isEnglish ? `para ${i + 1} (${p.length} chars)` : `第${i + 1}段${p.length}字`))
          .join(joiner);
        const moreSuffix = paragraphs.length > 8
          ? (isEnglish ? ` … ${paragraphs.length} paragraphs total` : ` …共${paragraphs.length}段`)
          : "";
        issues.push({
          severity: "warning",
          category: isEnglish ? "Paragraph uniformity" : "段落等长",
          description: isEnglish
            ? `Paragraph-length coefficient of variation is only ${cv.toFixed(3)} (threshold <0.15), which suggests unnaturally uniform paragraph sizing. Lengths: ${lengthList}${moreSuffix}`
            : `段落长度变异系数仅${cv.toFixed(3)}（阈值<0.15），段落长度过于均匀，呈现AI生成特征。涉及段落：${lengthList}${moreSuffix}`,
          suggestion: isEnglish
            ? "Increase paragraph-length contrast: use shorter beats for impact and longer blocks for immersive detail"
            : "增加段落长度差异：短段落用于节奏加速或冲击，长段落用于沉浸描写",
        });
      }
    }
  }

  // dim 21: Hedge word density
  const totalChars = content.length;
  if (totalChars > 0) {
    let hedgeCount = 0;
    const hedgeLocations: string[] = [];
    for (const word of HEDGE_WORDS[language]) {
      const regex = new RegExp(word, isEnglish ? "gi" : "g");
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        hedgeCount += 1;
        if (hedgeLocations.length < 3) {
          const para = paragraphIndexAt(content, match.index);
          const excerpt = excerptAround(content, match.index, match[0].length);
          hedgeLocations.push(isEnglish ? `para ${para} "${excerpt}"` : `第${para}段「${excerpt}」`);
        }
      }
    }
    const hedgeDensity = hedgeCount / (totalChars / 1000);
    if (hedgeDensity > 3) {
      const locationDetail = hedgeLocations.length > 0
        ? (isEnglish ? ` Locations: ${hedgeLocations.join(joiner)}` : `位置：${hedgeLocations.join(joiner)}`)
        : "";
      issues.push({
        severity: "warning",
        category: isEnglish ? "Hedge density" : "套话密度",
        description: isEnglish
          ? `Hedge-word density is ${hedgeDensity.toFixed(1)} per 1k characters (threshold >3), making the prose sound overly tentative.${locationDetail}`
          : `套话词（似乎/可能/或许等）密度为${hedgeDensity.toFixed(1)}次/千字（阈值>3），语气过于模糊犹豫。${locationDetail}`,
        suggestion: isEnglish
          ? "Replace hedges with firmer narration: remove vague qualifiers and use concrete detail instead"
          : "用确定性叙述替代模糊表达：去掉「似乎」直接描述状态，用具体细节替代「可能」",
      });
    }
  }

  // dim 22: Formulaic transition repetition
  const transitionCounts: Record<string, number> = {};
  const transitionLocations: Record<string, string[]> = {};
  for (const word of TRANSITION_WORDS[language]) {
    const regex = new RegExp(word, isEnglish ? "gi" : "g");
    const key = isEnglish ? word.toLowerCase() : word;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      transitionCounts[key] = (transitionCounts[key] ?? 0) + 1;
      const locations = (transitionLocations[key] ??= []);
      if (locations.length < 2) {
        const para = paragraphIndexAt(content, match.index);
        const excerpt = excerptAround(content, match.index, match[0].length);
        locations.push(isEnglish ? `para ${para} "${excerpt}"` : `第${para}段「${excerpt}」`);
      }
    }
  }
  const repeatedTransitions = Object.entries(transitionCounts)
    .filter(([, count]) => count >= 3);
  if (repeatedTransitions.length > 0) {
    const detail = repeatedTransitions
      .map(([word, count]) => `"${word}"×${count}`)
      .join(joiner);
    const locationDetail = repeatedTransitions
      .flatMap(([word]) => (transitionLocations[word] ?? []).map((loc) => `"${word}"→${loc}`))
      .slice(0, 4)
      .join(joiner);
    issues.push({
      severity: "warning",
      category: isEnglish ? "Formulaic transitions" : "公式化转折",
      description: isEnglish
        ? `Transition words repeat too often: ${detail}. Reusing the same transition pattern 3+ times creates a formulaic AI texture. Locations: ${locationDetail}`
        : `转折词重复使用：${detail}。同一转折模式≥3次暴露AI生成痕迹。位置：${locationDetail}`,
      suggestion: isEnglish
        ? "Let scenes pivot through action, timing, or viewpoint shifts instead of repeating the same transitions"
        : "用情节自然转折替代转折词，或换用不同的过渡手法（动作切入、时间跳跃、视角切换）",
    });
  }

  // dim 23: List-like structure (consecutive sentences with same prefix pattern)
  const sentences = content
    .split(isEnglish ? /[.!?\n]/ : /[。！？\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);

  if (sentences.length >= 3) {
    let consecutiveSamePrefix = 1;
    let maxConsecutive = 1;
    let maxRunEnd = 0;
    for (let i = 1; i < sentences.length; i++) {
      const prevPrefix = isEnglish
        ? sentences[i - 1]!.split(/\s+/)[0]?.toLowerCase() ?? ""
        : sentences[i - 1]!.slice(0, 2);
      const currPrefix = isEnglish
        ? sentences[i]!.split(/\s+/)[0]?.toLowerCase() ?? ""
        : sentences[i]!.slice(0, 2);
      if (prevPrefix === currPrefix) {
        consecutiveSamePrefix++;
        if (consecutiveSamePrefix > maxConsecutive) {
          maxConsecutive = consecutiveSamePrefix;
          maxRunEnd = i;
        }
      } else {
        consecutiveSamePrefix = 1;
      }
    }
    if (maxConsecutive >= 3) {
      const runSentences = sentences.slice(maxRunEnd - maxConsecutive + 1, maxRunEnd + 1);
      const runDetail = runSentences
        .slice(0, 3)
        .map((s) => (isEnglish ? `"${s.slice(0, 40)}${s.length > 40 ? "…" : ""}"` : `「${s.slice(0, 20)}${s.length > 20 ? "…" : ""}」`))
        .join(joiner);
      issues.push({
        severity: "info",
        category: isEnglish ? "List-like structure" : "列表式结构",
        description: isEnglish
          ? `Detected ${maxConsecutive} consecutive sentences with the same opening pattern, creating a list-like generated cadence. Run: ${runDetail}`
          : `检测到${maxConsecutive}句连续以相同开头的句子，呈现列表式AI生成结构。连续句：${runDetail}`,
        suggestion: isEnglish
          ? "Vary how sentences open: change subject, timing, or action entry to break the list effect"
          : "变换句式开头：用不同主语、时间词、动作词开头，打破列表感",
      });
    }
  }

  return { issues };
}
