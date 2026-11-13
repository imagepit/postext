import { getDb } from "@/db/client";
import { isRevision, isUuid } from "@/books/model";
import { createPgRepository } from "@/books/repository";
import { createVersion, listVersions, restoreVersion } from "@/books/usecases";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ bookId: string }> };

const notFound = (what: string) => Response.json({ error: `${what} not found` }, { status: 404 });
const badRequest = (error: string) => Response.json({ error }, { status: 400 });

export async function GET(_request: Request, { params }: Context) {
  const { bookId } = await params;
  if (!isUuid(bookId)) return notFound("book");
  const result = await listVersions(createPgRepository(getDb()), bookId);
  if (!result.ok) return notFound("book");
  return Response.json({ versions: result.versions });
}

/**
 * 本文が `{ restore, baseRevision }` なら版の復元、それ以外は版の作成（`{ label? }`）。
 * 復元は作成と違い書籍を書き換えるので、保存と同じく baseRevision を要求する。
 */
export async function POST(request: Request, { params }: Context) {
  const { bookId } = await params;
  const body: unknown = await request.json().catch(() => ({}));
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return badRequest("body must be a JSON object");
  }
  const { restore, baseRevision, label } = body as Record<string, unknown>;
  const repo = createPgRepository(getDb());

  if (restore !== undefined) {
    if (typeof restore !== "string") return badRequest("restore must be a version id string");
    if (!isRevision(baseRevision)) return badRequest("baseRevision must be a non-negative integer");
    if (!isUuid(bookId)) return notFound("book");
    if (!isUuid(restore)) return notFound("version");
    const result = await restoreVersion(repo, bookId, restore, baseRevision);
    if (result.ok) return Response.json({ revision: result.revision });
    if (result.reason === "conflict") {
      return Response.json({ error: "revision conflict", revision: result.revision }, { status: 409 });
    }
    return notFound("book or version");
  }

  if (label !== undefined && typeof label !== "string") return badRequest("label must be a string");
  if (!isUuid(bookId)) return notFound("book");
  const result = await createVersion(repo, bookId, label ?? "");
  if (!result.ok) return notFound("book");
  return Response.json({ version: result.version }, { status: 201 });
}
