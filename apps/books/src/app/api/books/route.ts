import { getDb } from "@/db/client";
import { parseBookWrite } from "@/books/model";
import { createPgRepository } from "@/books/repository";
import { createBook, listBooks } from "@/books/usecases";

export const dynamic = "force-dynamic";

export async function GET() {
  const books = await listBooks(createPgRepository(getDb()));
  return Response.json({ books });
}

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => undefined);
  const parsed = parseBookWrite(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const book = await createBook(createPgRepository(getDb()), parsed.value);
  return Response.json({ book }, { status: 201 });
}
