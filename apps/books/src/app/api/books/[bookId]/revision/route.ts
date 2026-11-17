import { getDb } from "@/db/client";
import { isUuid } from "@/books/model";
import { createPgRepository } from "@/books/repository";

// CORE-203: 書籍の revision だけを返す。編集画面が、AI などによる先の保存を知るために定期的に呼ぶ。

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ bookId: string }> };

export async function GET(_request: Request, { params }: Context) {
  const { bookId } = await params;
  if (!isUuid(bookId)) return Response.json({ error: "book not found" }, { status: 404 });
  const summary = (await createPgRepository(getDb()).list()).find((b) => b.id === bookId);
  if (!summary) return Response.json({ error: "book not found" }, { status: 404 });
  return Response.json({ revision: summary.revision }, { headers: { "Cache-Control": "no-store" } });
}
