import { BaseAgent } from "./base.js";
import type { ChapterMemo } from "../models/input-governance.js";
import type { VolumeContract, VolumeGateIssue, VolumeProgressFile } from "../models/volume-contract.js";
import { runVolumeGate } from "../utils/volume-contract.js";

export interface VolumeAuditInput {
  readonly memo: ChapterMemo;
  readonly contract: VolumeContract | null;
  readonly phase: "pre" | "post";
  readonly text?: string;
  readonly progress?: VolumeProgressFile;
  readonly chapterNumber?: number;
  readonly miniCycleWindow?: number;
}

export class VolumeAuditorAgent extends BaseAgent {
  get name(): string {
    return "volume-auditor";
  }

  auditVolumeGate(input: VolumeAuditInput): ReadonlyArray<VolumeGateIssue> {
    const issues = runVolumeGate(input);
    this.log?.debug("deterministic volume gate completed", {
      phase: input.phase,
      chapterNumber: input.chapterNumber ?? input.memo.chapter,
      volumeId: input.contract?.volumeId ?? null,
      issueCount: issues.length,
      model: this.ctx.model,
    });
    return issues;
  }
}
