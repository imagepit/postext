import { getDb } from "@/db/client";
import { fromBundle, toBundle } from "@/books/bundle";
import { isRevision, isUuid } from "@/books/model";
import type { BookWrite } from "@/books/model";
import { createPgRepository } from "@/books/repository";
import { saveBook } from "@/books/usecases";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ bookId: string }> };

const notFound = () => Response.json({ error: "book not found" }, { status: 404 });

/** If-Match は整数の revision。標準の書式に合わせて引用符つきも受ける。 */
function parseBaseRevision(header: string | null): number | undefined {
  const raw = header?.trim().replace(/^"(.*)"$/, "$1");
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return isRevision(value) ? value : undefined;
}

export async function GET(_request: Request, { params }: Context) {
  const { bookId } = await params;
  if (!isUuid(bookId)) return notFound();
  const book = await createPgRepository(getDb()).getWithAssetData(bookId);
  if (!book) return notFound();
  const bytes = await toBundle(book);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/zip",
      "Cache-Control": "no-store",
      // revision は本文と同時に決まる値なので、応答ヘッダーで一緒に渡す。
      "X-Book-Revision": String(book.revision),
    },
  });
}

export async function PUT(request: Request, { params }: Context) {
  const { bookId } = await params;
  const baseRevision = parseBaseRevision(request.headers.get("If-Match"));
  if (baseRevision === undefined) {
    return Response.json({ error: "If-Match must be a non-negative integer revision" }, { status: 400 });
  }
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length === 0) return Response.json({ error: "body must be a .postext archive" }, { status: 400 });
  let input: BookWrite;
  try {
    input = await fromBundle(body);
  } catch {
    return Response.json({ error: "body is not a valid .postext archive" }, { status: 400 });
  }
  if (input.chapters.length === 0 || input.title.trim() === "") {
    return Response.json({ error: "archive must have a title and at least one chapter" }, { status: 400 });
  }
  if (!isUuid(bookId)) return notFound();
  const result = await saveBook(createPgRepository(getDb()), bookId, baseRevision, input);
  if (result.ok) return Response.json({ revision: result.revision });
  if (result.reason === "conflict") {
    return Response.json({ error: "revision conflict", revision: result.revision }, { status: 409 });
  }
  return notFound();
}
