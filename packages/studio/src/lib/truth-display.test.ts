import { describe, expect, it } from "vitest";
import { setAppLanguage } from "./app-language";
import { runtimeDiagnosticFileLabel, sortTruthFiles, truthFileDisplayLabel } from "./truth-display";

describe("runtimeDiagnosticFileLabel", () => {
  it("labels canon and volume runtime files for Chinese users", () => {
    setAppLanguage("zh");

    expect(runtimeDiagnosticFileLabel("runtime/chapter-0003.claim-brief.md")).toBe("第3章设定工作集摘要");
    expect(runtimeDiagnosticFileLabel("runtime/tier2_current_arc.md")).toBe("当前叙事弧");
    expect(runtimeDiagnosticFileLabel("runtime/volume-dashboard.md")).toBe("卷级进度看板");
    expect(runtimeDiagnosticFileLabel("runtime/volume-002.contract.json")).toBe("第2卷合同");
  });

  it("labels canon and volume runtime files for English users", () => {
    setAppLanguage("en");

    expect(runtimeDiagnosticFileLabel("runtime/chapter-0003.claims.json")).toBe("Chapter 3 Claim Set Data");
    expect(runtimeDiagnosticFileLabel("runtime/tier2_current_arc.md")).toBe("Current Arc");
    expect(runtimeDiagnosticFileLabel("runtime/volume-progress.json")).toBe("Volume Progress");
    expect(runtimeDiagnosticFileLabel("runtime/volume-002.dashboard.md")).toBe("Volume 2 Dashboard");

    setAppLanguage("zh");
  });

  it("returns undefined for non-runtime files or unknown runtime files", () => {
    setAppLanguage("zh");

    expect(runtimeDiagnosticFileLabel("outline/story_frame.md")).toBeUndefined();
    expect(runtimeDiagnosticFileLabel("runtime/chapter-0003.unknown.txt")).toBeUndefined();
  });
});

describe("truthFileDisplayLabel", () => {
  it("uses friendly labels before falling back to the raw path", () => {
    setAppLanguage("zh");

    expect(truthFileDisplayLabel("outline/story_frame.md")).toBe("故事基石");
    expect(truthFileDisplayLabel("roles/主要角色/林澈.md")).toBe("林澈");
    expect(truthFileDisplayLabel("runtime/volume-contracts.json")).toBe("卷级合同汇总");
    expect(truthFileDisplayLabel("notes/unknown.md")).toBe("notes/unknown.md");
  });
});

describe("sortTruthFiles", () => {
  it("orders foundation files, role files, and runtime diagnostics consistently", () => {
    const sorted = sortTruthFiles([
      { name: "runtime/chapter-0002.trace.json" },
      { name: "roles/次要角色/周岚.md" },
      { name: "runtime/volume-001.dashboard.md" },
      { name: "outline/volume_map.md" },
      { name: "runtime/volume-dashboard.md" },
      { name: "runtime/tier2_current_arc.md" },
      { name: "roles/主要角色/林澈.md" },
      { name: "outline/story_frame.md" },
      { name: "runtime/chapter-0002.context.json" },
      { name: "runtime/volume-contracts.json" },
    ]).map((file) => file.name);

    expect(sorted).toEqual([
      "outline/story_frame.md",
      "outline/volume_map.md",
      "roles/主要角色/林澈.md",
      "roles/次要角色/周岚.md",
      "runtime/tier2_current_arc.md",
      "runtime/volume-contracts.json",
      "runtime/volume-dashboard.md",
      "runtime/volume-001.dashboard.md",
      "runtime/chapter-0002.context.json",
      "runtime/chapter-0002.trace.json",
    ]);
  });
});
