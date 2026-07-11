export type PipelineFailureStage = "write" | "draft" | "rewrite" | "revise" | "audit";

export type PipelineFailureAction = "retry" | "repair-state" | "open-services" | "open-doctor";

export function getPipelineFailureAction(input: {
  readonly stage: PipelineFailureStage;
  readonly error: string;
  readonly canRepairLatestState: boolean;
}): PipelineFailureAction {
  const message = input.error.toLowerCase();

  if (input.canRepairLatestState && /state-degraded|state repair/.test(message)) {
    return "repair-state";
  }

  if (/api key|unauthorized|forbidden|authentication|\b401\b|\b403\b/.test(message)) {
    return "open-services";
  }

  if (input.stage === "write" || input.stage === "draft") {
    return "retry";
  }

  return "open-doctor";
}
