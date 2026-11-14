import { getDb } from "@/db/client";
import { isRevision, isUuid } from "@/books/model";
import { createPgRepository } from "@/books/repository";
import { createOutlineClient, OutlineHttpError, outlineConfigFromEnv } from "@/outline/client";
import { applyImport, previewImport } from "@/outline/importBook";
import type { ImportFailure } from "@/outline/importBook";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ bookId: string }> };

const notConfigured = () =>
  Response.json(
    { error: "Outlineに接続できません。環境変数 OUTLINE_URL と OUTLINE_API_TOKEN を設定してください" },
    { status: 503 },
  );

const notFound = () => Response.json({ error: "book not found" }, { status: 404 });

function failure(result: ImportFailure): Response {
  if (result.reason === "conflict") {
    return Response.json({ error: "revision conflict", revision: result.revision }, { status: 409 });
  }
  if (result.reason === "invalid") return Response.json({ error: result.message }, { status: 400 });
  return notFound();
}

function upstream(error: unknown): Response {
  if (error instanceof OutlineHttpError) {
    return Response.json({ error: `Outlineがエラーを返しました (${error.status})` }, { status: 502 });
  }
  return Response.json({ error: "Outlineと通信できませんでした" }, { status: 502 });
}

export async function GET(request: Request, { params }: Context) {
  const { bookId } = await params;
  const documentId = new URL(request.url).searchParams.get("documentId");
  if (!documentId) return Response.json({ error: "documentId is required" }, { status: 400 });
  const config = outlineConfigFromEnv();
  if (!config) return notConfigured();
  if (!isUuid(bookId)) return notFound();
  try {
    const result = await previewImport(createPgRepository(getDb()), bookId, documentId, createOutlineClient(config));
    if (!result.ok) return failure(result);
    return Response.json({ revision: result.revision, chapters: result.chapters });
  } catch (error) {
    return upstream(error);
  }
}

export async function POST(request: Request, { params }: Context) {
  const { bookId } = await params;
  const body: unknown = await request.json().catch(() => undefined);
  const { documentId, baseRevision, documentIds } =
    typeof body === "object" && body !== null
      ? (body as { documentId?: unknown; baseRevision?: unknown; documentIds?: unknown })
      : {};
  if (!isRevision(baseRevision)) {
    return Response.json({ error: "baseRevision must be a non-negative integer" }, { status: 400 });
  }
  if (typeof documentId !== "string" || documentId === "") {
    return Response.json({ error: "documentId must be a non-empty string" }, { status: 400 });
  }
  if (!Array.isArray(documentIds) || !documentIds.every((id) => typeof id === "string")) {
    return Response.json({ error: "documentIds must be an array of strings" }, { status: 400 });
  }
  const config = outlineConfigFromEnv();
  if (!config) return notConfigured();
  if (!isUuid(bookId)) return notFound();
  try {
    const result = await applyImport(
      createPgRepository(getDb()),
      bookId,
      { baseRevision, parentId: documentId, documentIds: documentIds as string[] },
      createOutlineClient(config),
    );
    if (!result.ok) return failure(result);
    return Response.json({ revision: result.revision, warnings: result.warnings });
  } catch (error) {
    return upstream(error);
  }
}
