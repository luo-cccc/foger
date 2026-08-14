import { describe, expect, it } from "vitest";
import * as publicApi from "../index.js";

describe("public API mutation surface", () => {
  it("does not expose raw file mutation or the internal edit controller", () => {
    expect(Object.keys(publicApi)).not.toContain("createEditTool");
    expect(Object.keys(publicApi)).not.toContain("createWriteFileTool");
    expect(Object.keys(publicApi)).not.toContain("executeEditTransaction");
    expect(Object.keys(publicApi)).not.toContain("planEditTransaction");
  });
});
