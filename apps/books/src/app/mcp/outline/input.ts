// CORE-229: Outline の「書籍出版」から来る要求の入力の検査と、依存の組み立て。
import { getDb } from "@/db/client";
import { createPgRepository } from "@/books/repository";
import { createPgDesignRepository } from "@/designs/repository";
import { createOutlineClient, outlineConfigFromEnv } from "@/outline/client";
import type { CourseInput, PublishDeps } from "@/outline/publish";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readCourseInput(body: unknown): CourseInput | string {
  if (typeof body !== "object" || body === null) return "body must be a JSON object";
  const { parentDocumentId, documentIds, title } = body as Record<string, unknown>;
  if (typeof parentDocumentId !== "string" || !UUID.test(parentDocumentId)) return "parentDocumentId must be a document id";
  if (!Array.isArray(documentIds) || documentIds.length === 0 || documentIds.length > 500 || !documentIds.every((d) => typeof d === "string" && UUID.test(d))) {
    return "documentIds must be a non-empty array of document ids";
  }
  if (typeof title !== "string" || title.trim() === "" || title.length > 200) return "title must be a non-empty string";
  return { parentDocumentId, documentIds: documentIds as string[], title: title.trim() };
}

export function publishDeps(): PublishDeps | null {
  const config = outlineConfigFromEnv();
  if (!config) return null;
  return { repo: createPgRepository(getDb()), designs: createPgDesignRepository(getDb()), outline: createOutlineClient(config) };
}
