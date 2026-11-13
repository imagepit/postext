"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export interface BookListItem {
  id: string;
  title: string;
  updatedAt: string;
}

// サーバーとブラウザーで同じ表示になるよう、時刻帯を固定する。
const formatDate = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  dateStyle: "medium",
  timeStyle: "short",
});

export function BookList({ books, error }: { books: BookListItem[]; error: string | null }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function create(event: FormEvent) {
    event.preventDefault();
    const name = title.trim();
    if (!name || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      // 章は空にできないので、最初の章を1つ持つ書籍として作る。
      const response = await fetch("/api/books", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: name,
          chapters: [{ title: "第1章", locale: "ja", markdown: "# 第1章\n\n" }],
        }),
      });
      if (!response.ok) throw new Error(String(response.status));
      const { book } = (await response.json()) as { book: { id: string } };
      router.push(`/books/${book.id}`);
    } catch {
      setCreateError("書籍を作成できませんでした。もう一度お試しください。");
      setCreating(false);
    }
  }

  return (
    <main className="h-full overflow-auto bg-background text-foreground">
      <div className="mx-auto max-w-2xl px-6 py-10">
        <h1 className="mb-8 text-2xl font-semibold">書籍</h1>

        {error ? (
          <p role="alert" className="mb-8 rounded border border-vermilion px-4 py-3 text-vermilion">
            {error}
          </p>
        ) : (
          <>
            <form onSubmit={create} className="mb-8 flex gap-2">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="新しい書籍の題名"
                aria-label="新しい書籍の題名"
                className="min-w-0 flex-1 rounded border border-rule-strong bg-surface px-3 py-2"
              />
              <button
                type="submit"
                disabled={!title.trim() || creating}
                className="rounded bg-brand px-4 py-2 font-medium text-brand-contrast disabled:opacity-50"
              >
                {creating ? "作成中" : "作成"}
              </button>
            </form>
            {createError && (
              <p role="alert" className="-mt-4 mb-8 text-vermilion">
                {createError}
              </p>
            )}

            {books.length === 0 ? (
              <p className="text-slate">書籍はまだありません。題名を入れて作成してください。</p>
            ) : (
              <ul className="divide-y divide-rule border-y border-rule">
                {books.map((book) => (
                  <li key={book.id}>
                    <Link href={`/books/${book.id}`} className="flex items-baseline justify-between gap-4 px-2 py-3 hover:bg-surface">
                      <span className="font-medium">{book.title}</span>
                      <time dateTime={book.updatedAt} className="shrink-0 text-sm text-slate">
                        {formatDate.format(new Date(book.updatedAt))}
                      </time>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </main>
  );
}
