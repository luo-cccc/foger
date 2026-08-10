import { describe, expect, it } from "vitest";
import type { CodeHighlighterPlugin } from "streamdown";
import { studioCodePlugin } from "./studio-code-plugin";

type HighlightResult = Exclude<ReturnType<CodeHighlighterPlugin["highlight"]>, null>;

function highlight(code: string, language: "json"): Promise<HighlightResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("highlighting timed out")), 5_000);
    const immediate = studioCodePlugin.highlight(
      { code, language, themes: studioCodePlugin.getThemes() },
      (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
    );
    if (immediate) {
      clearTimeout(timeout);
      resolve(immediate);
    }
  });
}

describe("studioCodePlugin", () => {
  it("loads a supported grammar on demand and caches the result", async () => {
    const code = '{"status":"ready"}';
    const result = await highlight(code, "json");

    expect(result.tokens.flat().map((token) => token.content).join(""))
      .toBe(code);
    expect(studioCodePlugin.highlight({
      code,
      language: "json",
      themes: studioCodePlugin.getThemes(),
    })).toBe(result);
  });

  it("leaves unsupported languages as unhighlighted code", () => {
    expect(studioCodePlugin.supportsLanguage("emacs-lisp")).toBe(false);
    expect(studioCodePlugin.highlight({
      code: "(message \"hello\")",
      language: "emacs-lisp",
      themes: studioCodePlugin.getThemes(),
    })).toBeNull();
  });
});
