import { getDb } from "@/db/client";
import { isRevision, isUuid } from "@/books/model";
import { createPgRepository } from "@/books/repository";
import { createOutlineClient, OutlineHttpError, outlineConfigFromEnv } from "@/outline/client";
import type { ImportFailure } from "@/outline/importBook";
import { applyPush, previewPush } from "@/outline/pushBook";

// CORE-228: 書籍の章を、取り込み元の Outline 文書へ書き戻す。GET は確認だけ、POST が反映する。

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

export async function GET(_request: Request, { params }: Context) {
  const { bookId } = await params;
  const config = outlineConfigFromEnv();
  if (!config) return notConfigured();
  if (!isUuid(bookId)) return notFound();
  try {
    const result = await previewPush(createPgRepository(getDb()), bookId, createOutlineClient(config));
    if (!result.ok) return failure(result);
    return Response.json({ revision: result.revision, chapters: result.chapters });
  } catch (error) {
    return upstream(error);
  }
}

export async function POST(request: Request, { params }: Context) {
  const { bookId } = await params;
  const body: unknown = await request.json().catch(() => undefined);
  const { baseRevision, documentIds } =
    typeof body === "object" && body !== null ? (body as { baseRevision?: unknown; documentIds?: unknown }) : {};
  if (!isRevision(baseRevision)) {
    return Response.json({ error: "baseRevision must be a non-negative integer" }, { status: 400 });
  }
  if (!Array.isArray(documentIds) || !documentIds.every((id) => typeof id === "string")) {
    return Response.json({ error: "documentIds must be an array of strings" }, { status: 400 });
  }
  const config = outlineConfigFromEnv();
  if (!config) return notConfigured();
  if (!isUuid(bookId)) return notFound();
  try {
    const result = await applyPush(
      createPgRepository(getDb()),
      bookId,
      { baseRevision, documentIds: documentIds as string[] },
      createOutlineClient(config),
    );
    if (!result.ok) return failure(result);
    return Response.json({ revision: result.revision, pushed: result.pushed, warnings: result.warnings });
  } catch (error) {
    return upstream(error);
  }
}
