import { BookList, type BookListItem } from "@/books/BookList";
import { getDb } from "@/db/client";
import { createPgRepository } from "@/books/repository";
import { listBooks } from "@/books/usecases";

// DATABASE_URL のない環境（イメージの起動確認、next build）でも描画できるよう、要求ごとに読む。
export const dynamic = "force-dynamic";

async function load(): Promise<{ books: BookListItem[] } | { error: string }> {
  try {
    const books = await listBooks(createPgRepository(getDb()));
    return {
      books: books.map((b) => ({ id: b.id, title: b.title, updatedAt: b.updatedAt.toISOString() })),
    };
  } catch (error) {
    console.error("book list failed", error);
    return { error: "データベースに接続できないため、書籍の一覧を表示できません。" };
  }
}

export default async function Home() {
  const loaded = await load();
  return <BookList books={"books" in loaded ? loaded.books : []} error={"error" in loaded ? loaded.error : null} />;
}
