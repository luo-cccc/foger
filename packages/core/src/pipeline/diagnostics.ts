export type PipelineDiagnosticKind =
  | "foundation-fallback"
  | "planner-parse-retry"
  | "planner-fallback"
  | "canon-fallback"
  | "content-policy-fallback"
  | "resync-analyzer-fallback";

export interface PipelineDiagnostic {
  readonly kind: PipelineDiagnosticKind;
  readonly severity: "info" | "warning" | "error";
  readonly agent: string;
  readonly phase: string;
  readonly message: string;
  readonly timestamp: string;
  readonly bookId?: string;
  readonly chapterNumber?: number;
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
}

export type OnPipelineDiagnostic = (diagnostic: PipelineDiagnostic) => void;
