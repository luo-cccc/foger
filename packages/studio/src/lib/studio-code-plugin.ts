import { createHighlighterCore, type HighlighterCore, type LanguageRegistration } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { BundledLanguage, CodeHighlighterPlugin } from "streamdown";

type HighlightResult = Exclude<ReturnType<CodeHighlighterPlugin["highlight"]>, null>;

type LanguageModule = { readonly default: LanguageRegistration[] };

const languageLoaders = {
  bash: () => import("shiki/langs/bash.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
} satisfies Record<string, () => Promise<LanguageModule>>;

type StudioLanguage = keyof typeof languageLoaders;

const aliases: Readonly<Record<string, StudioLanguage>> = {
  bash: "bash",
  css: "css",
  diff: "diff",
  html: "html",
  js: "javascript",
  javascript: "javascript",
  json: "json",
  jsonc: "jsonc",
  jsx: "jsx",
  md: "markdown",
  markdown: "markdown",
  powershell: "powershell",
  ps1: "powershell",
  py: "python",
  python: "python",
  shell: "bash",
  sh: "bash",
  sql: "sql",
  ts: "typescript",
  tsx: "tsx",
  typescript: "typescript",
  yaml: "yaml",
  yml: "yaml",
};

const themes = ["github-light", "github-dark"] as const;
const resultCache = new Map<string, HighlightResult>();
const subscribers = new Map<string, Set<(result: HighlightResult) => void>>();
const languagePromises = new Map<StudioLanguage, Promise<void>>();
const pendingKeys = new Set<string>();

let loadQueue = Promise.resolve();

const highlighterPromise: Promise<HighlighterCore> = Promise.all([
  import("shiki/themes/github-light.mjs"),
  import("shiki/themes/github-dark.mjs"),
]).then(([light, dark]) => createHighlighterCore({
  engine: createJavaScriptRegexEngine({ forgiving: true }),
  langs: [],
  themes: [light.default, dark.default],
}));

function resolveLanguage(language: string): StudioLanguage | undefined {
  return aliases[language.trim().toLowerCase()];
}

function ensureLanguage(language: StudioLanguage): Promise<void> {
  const cached = languagePromises.get(language);
  if (cached) return cached;

  const pending = loadQueue.then(async () => {
    const [highlighter, module] = await Promise.all([
      highlighterPromise,
      languageLoaders[language](),
    ]);
    if (!highlighter.getLoadedLanguages().includes(language)) {
      await highlighter.loadLanguage(module.default);
    }
  });
  loadQueue = pending.catch(() => undefined);
  languagePromises.set(language, pending);
  return pending;
}

function notify(key: string, result: HighlightResult): void {
  resultCache.set(key, result);
  const callbacks = subscribers.get(key);
  if (!callbacks) return;
  for (const callback of callbacks) callback(result);
  subscribers.delete(key);
}

export const studioCodePlugin: CodeHighlighterPlugin = {
  name: "shiki",
  type: "code-highlighter",
  getSupportedLanguages: () => Object.keys(aliases) as BundledLanguage[],
  getThemes: () => [...themes],
  supportsLanguage: (language) => resolveLanguage(language) !== undefined,
  highlight: ({ code, language }, callback) => {
    const resolved = resolveLanguage(language);
    if (!resolved) return null;

    const key = `${resolved}\u0000${code}`;
    const cached = resultCache.get(key);
    if (cached) return cached;

    if (callback) {
      const callbacks = subscribers.get(key) ?? new Set();
      callbacks.add(callback);
      subscribers.set(key, callbacks);
    }

    if (!pendingKeys.has(key)) {
      pendingKeys.add(key);
      ensureLanguage(resolved)
        .then(async () => {
          const highlighter = await highlighterPromise;
          const result = highlighter.codeToTokens(code, {
            lang: resolved,
            themes: { light: themes[0], dark: themes[1] },
          });
          pendingKeys.delete(key);
          notify(key, result);
        })
        .catch((error: unknown) => {
          console.error("[InkOS Studio] Failed to highlight code:", error);
          pendingKeys.delete(key);
          subscribers.delete(key);
        });
    }

    return null;
  },
};
