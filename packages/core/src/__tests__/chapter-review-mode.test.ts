import { describe, expect, it } from "vitest";
import { resolveEpisodeReviewMode } from "../models/book.js";

describe("resolveEpisodeReviewMode", () => {
  it("book-level reviewMode overrides project-level reviewMode", () => {
    expect(resolveEpisodeReviewMode(
      { writing: { reviewMode: "manual" } },
      { reviewMode: "auto" },
    )).toBe("manual");

    expect(resolveEpisodeReviewMode(
      { writing: { reviewMode: "auto" } },
      { reviewMode: "manual" },
    )).toBe("auto");
  });

  it("falls back to project-level reviewMode when book does not set one", () => {
    expect(resolveEpisodeReviewMode({}, { reviewMode: "manual" })).toBe("manual");
    expect(resolveEpisodeReviewMode(
      { writing: {} },
      { reviewMode: "manual" },
    )).toBe("manual");
  });

  it("defaults to auto when neither book nor project sets a reviewMode", () => {
    expect(resolveEpisodeReviewMode({})).toBe("auto");
    expect(resolveEpisodeReviewMode({ writing: {} }, {})).toBe("auto");
  });
});
