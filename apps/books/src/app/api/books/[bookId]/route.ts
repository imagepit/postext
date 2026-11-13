import { getDb } from "@/db/client";
import { isRevision, isUuid, parseBookWrite } from "@/books/model";
import { createPgRepository } from "@/books/repository";
import { getBook, saveBook } from "@/books/usecases";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ bookId: string }> };

const notFound = () => Response.json({ error: "book not found" }, { status: 404 });

export async function GET(_request: Request, { params }: Context) {
  const { bookId } = await params;
  if (!isUuid(bookId)) return notFound();
  const result = await getBook(createPgRepository(getDb()), bookId);
  if (!result.ok) return notFound();
  return Response.json({ book: result.book });
}

export async function PUT(request: Request, { params }: Context) {
  const { bookId } = await params;
  const body: unknown = await request.json().catch(() => undefined);
  const baseRevision =
    typeof body === "object" && body !== null ? (body as { baseRevision?: unknown }).baseRevision : undefined;
  if (!isRevision(baseRevision)) {
    return Response.json({ error: "baseRevision must be a non-negative integer" }, { status: 400 });
  }
  const parsed = parseBookWrite(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  if (!isUuid(bookId)) return notFound();
  const result = await saveBook(createPgRepository(getDb()), bookId, baseRevision, parsed.value);
  if (result.ok) return Response.json({ revision: result.revision });
  if (result.reason === "conflict") {
    return Response.json({ error: "revision conflict", revision: result.revision }, { status: 409 });
  }
  return notFound();
}
