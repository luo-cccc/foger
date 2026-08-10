import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  analyzeAITells,
  chatCompletion,
  countChapterLength,
  createLLMClient,
  loadProjectConfig,
  normalizePostWriteSurface,
  parseCreativeOutput,
  validatePostWrite,
} from "../packages/core/dist/index.js";

const repoRoot = resolve(import.meta.dirname, "..");
const projectRoot = join(repoRoot, ".tmp-openrouter-deepseek-flash");
const reportDir = join(projectRoot, "reports");
const secretsPath = join(projectRoot, ".inkos", "secrets.json");
const serviceId = "custom:OpenRouterLive";
const model = "deepseek/deepseek-v4-flash";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  throw new Error("OPENROUTER_API_KEY is required");
}

const baseProfile = {
  id: "near-future-suspense",
  name: "近未来悬疑成长",
  language: "zh",
  chapterTypes: [],
  fatigueWords: ["忽然", "仿佛", "某种", "无法形容"],
  numericalSystem: false,
  powerScaling: false,
  eraResearch: false,
  pacingRule: "具体调查、城市压迫感、人物关系推进",
  satisfactionTypes: ["档案谜团", "城市隐秘", "亲情真相"],
  auditDimensions: [],
};

const bookRules = {
  narrativePerson: "third",
  protagonist: { name: "林澈" },
  prohibitions: ["作者点评", "本章", "总结", "设定如下", "突然觉醒"],
};

async function main() {
  await mkdir(join(projectRoot, ".inkos"), { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await writeFile(
    secretsPath,
    JSON.stringify({ services: { [serviceId]: { apiKey } } }, null, 2),
    "utf-8",
  );

  try {
    const config = await loadProjectConfig(projectRoot, {
      consumer: "cli",
      requireApiKey: true,
    });
    const client = createLLMClient(config.llm);

    const smoke = await chatCompletion(
      client,
      model,
      [
        {
          role: "system",
          content: "你是一个严格按要求输出的中文写作测试助手。",
        },
        {
          role: "user",
          content:
            "请用一句中文确认：模型已连通。不要输出 Markdown，不要超过 30 个字。",
        },
      ],
      { maxTokens: 80, temperature: 0.2, retry: false },
    );

    const creativePrompt = [
      "你是 InkOS 的小说 writer。必须只输出以下三个标签块：",
      "=== PRE_WRITE_CHECK ===",
      "用 3 条短句列出本章要避免的问题。",
      "=== CHAPTER_TITLE ===",
      "输出一个中文章节标题，不要包含“第X章”。",
      "=== CHAPTER_CONTENT ===",
      "输出中文正文，第三人称有限视角，900 到 1300 个汉字。",
      "禁止作者点评、设定讲解、章节总结、列表、Markdown 标题。",
      "",
      "小说简报：",
      "近未来旧城档案馆。主角林澈是夜班修复员，停电后发现一盘编号被涂改的磁带，里面出现母亲年轻时的声音。",
      "本章必须包含：停电、磁带编号涂改、母亲声音、林澈采取一个可验证的调查动作。",
    ].join("\n");

    const creative = await chatCompletion(
      client,
      model,
      [
        {
          role: "system",
          content:
            "你是长篇小说创作模型。输出必须符合用户指定标签格式，正文只写场景和行动。",
        },
        { role: "user", content: creativePrompt },
      ],
      { maxTokens: 2200, temperature: 0.72, retry: false },
    );

    const parsedCreative = parseCreativeOutput(1, creative.content, "zh_chars");
    const normalizedCreative = normalizePostWriteSurface(
      parsedCreative.content,
      "zh",
    );
    const creativeViolations = validatePostWrite(
      normalizedCreative,
      baseProfile,
      bookRules,
      "zh",
    );
    const creativeAiTells = analyzeAITells(normalizedCreative, "zh").issues;

    const revisionPrompt = [
      "下面是一个章节草稿和自动质检结果。请只输出修订后的正文，不要输出标题、解释或列表。",
      "修订要求：保留核心事件；减少作者点评和设定解释；强化动作、环境、对话；保持第三人称有限视角。",
      "",
      "自动质检：",
      `post_write_violations=${creativeViolations.length}`,
      `ai_tell_issues=${creativeAiTells.length}`,
      "",
      "草稿：",
      normalizedCreative,
    ].join("\n");

    const revision = await chatCompletion(
      client,
      model,
      [
        {
          role: "system",
          content:
            "你是中文小说修订模型。只返回修订正文，不能解释修订过程。",
        },
        { role: "user", content: revisionPrompt },
      ],
      { maxTokens: 2200, temperature: 0.55, retry: false },
    );

    const normalizedRevision = normalizePostWriteSurface(
      revision.content,
      "zh",
    );
    const revisionViolations = validatePostWrite(
      normalizedRevision,
      baseProfile,
      bookRules,
      "zh",
    );
    const revisionAiTells = analyzeAITells(normalizedRevision, "zh").issues;

    const report = {
      model,
      baseUrl: "https://openrouter.ai/api/v1",
      transport: "studio custom OpenAI-compatible, non-streaming",
      smoke: {
        content: smoke.content.trim(),
        usage: smoke.usage,
      },
      creative: {
        usage: creative.usage,
        title: parsedCreative.title,
        preWriteCheck: parsedCreative.preWriteCheck,
        rawLength: creative.content.length,
        parsedLength: countChapterLength(parsedCreative.content, "zh_chars"),
        normalizedLength: countChapterLength(normalizedCreative, "zh_chars"),
        postWriteViolations: creativeViolations,
        aiTellIssues: creativeAiTells,
        excerpt: normalizedCreative.slice(0, 900),
      },
      revision: {
        usage: revision.usage,
        normalizedLength: countChapterLength(normalizedRevision, "zh_chars"),
        postWriteViolations: revisionViolations,
        aiTellIssues: revisionAiTells,
        excerpt: normalizedRevision.slice(0, 900),
      },
    };

    await writeFile(
      join(reportDir, "openrouter-deepseek-v4-flash-live-report.json"),
      JSON.stringify(report, null, 2),
      "utf-8",
    );
    await writeFile(
      join(reportDir, "openrouter-deepseek-v4-flash-creative.md"),
      [
        `# ${parsedCreative.title}`,
        "",
        normalizedCreative,
        "",
        "## Revision",
        "",
        normalizedRevision,
      ].join("\n"),
      "utf-8",
    );

    console.log(
      JSON.stringify(
        {
          model,
          smoke: smoke.content.trim(),
          creativeChars: countChapterLength(normalizedCreative, "zh_chars"),
          creativeViolations: creativeViolations.length,
          creativeAiTells: creativeAiTells.length,
          revisionChars: countChapterLength(normalizedRevision, "zh_chars"),
          revisionViolations: revisionViolations.length,
          revisionAiTells: revisionAiTells.length,
          report:
            ".tmp-openrouter-deepseek-flash/reports/openrouter-deepseek-v4-flash-live-report.json",
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(secretsPath, { force: true });
  }
}

await main();
