import { z } from "zod";

export const ActionSourceSchema = z.enum(["free-text", "button", "slash", "quick-action"]);
export type ActionSource = z.infer<typeof ActionSourceSchema>;

export const RequestedIntentSchema = z.enum([
  "create_book",
  "write_next",
  "edit_artifact",
  "continuation_import",
]);
export type RequestedIntent = z.infer<typeof RequestedIntentSchema>;

export const CreateBookActionPayloadSchema = z.object({
  title: z.string().min(1).optional(),
  genre: z.string().min(1).optional(),
  platform: z.enum(["tomato", "qidian", "feilu", "other"]).optional(),
  language: z.enum(["zh", "en"]).optional(),
  targetChapters: z.number().int().min(1).optional(),
  chapterWordCount: z.number().int().min(1).optional(),
}).strict();

export const ActionPayloadSchema = z.object({
  createBook: CreateBookActionPayloadSchema.optional(),
}).strict();

export type ActionPayload = z.infer<typeof ActionPayloadSchema>;

export function normalizeActionSource(value: unknown): ActionSource {
  if (value === undefined || value === null || value === "") return "free-text";
  return ActionSourceSchema.parse(value);
}

export function normalizeRequestedIntent(value: unknown): RequestedIntent | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return RequestedIntentSchema.parse(value);
}

export function normalizeActionPayload(value: unknown): ActionPayload | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return ActionPayloadSchema.parse(value);
}

export function isWriteNextInstruction(
  instruction: string,
  options: { readonly allowSlashWrite?: boolean } = {},
): boolean {
  const trimmed = instruction.trim();
  const pattern = options.allowSlashWrite
    ? /^(\/write|continue|继续|继续写|写下一章|write next|下一章|再来一章)$/i
    : /^(continue|继续|继续写|写下一章|write next|下一章|再来一章)$/i;
  return pattern.test(trimmed);
}

export function isExplicitWriteChapterCommand(instruction: string): boolean {
  const trimmed = instruction.trim();
  if (!trimmed) return false;

  const zhWriteChapter =
    /^(?:请|帮我|麻烦|现在|直接|开始|继续|接着|再)?\s*(?:写|续写|创作|生成)(?:出|一下)?\s*(?:第?\s*[一二三四五六七八九十百千万\d]+\s*章|下一章|一章|正文|章节)(?:\s|[，。,.！!？?；;：:]|$)/.test(trimmed);
  if (zhWriteChapter) return true;

  return /^(?:please\s+)?(?:write|continue|draft|generate)\s+(?:the\s+)?(?:next\s+)?chapter(?:\s+\d+|\s+one)?\b/i.test(trimmed);
}
