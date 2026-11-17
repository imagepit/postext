import { getDb } from "@/db/client";
import { isUuid } from "@/books/model";
import { createPgRepository } from "@/books/repository";
import { exportBook } from "@/export/render";
import type { EpubLayout, ExportFormat } from "@/export/render";

// CORE-206: 書籍の今の内容、または版を、PDF か EPUB にして返す。
// GET ?format=pdf|epub&layout=fixed|reflowable&version=<版ID>

export const dynamic = "force-dynamic";
// 組版は数秒から数十秒かかる。
export const maxDuration = 300;

type Context = { params: Promise<{ bookId: string }> };

const CONTENT_TYPE: Record<ExportFormat, string> = { pdf: "application/pdf", epub: "application/epub+zip" };

const bad = (error: string, status = 400) => Response.json({ error }, { status });

/** RFC 5987 の filename*（日本語の題をそのまま名前にする）と、ASCII だけの filename。 */
function disposition(title: string, ext: string): string {
  const name = `${title.replace(/[\\/:*?"<>|\r\n]+/g, "_").trim() || "book"}.${ext}`;
  return `attachment; filename="book.${ext}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function GET(request: Request, { params }: Context) {
  const { bookId } = await params;
  const query = new URL(request.url).searchParams;
  const format = query.get("format") ?? "pdf";
  if (format !== "pdf" && format !== "epub") return bad("format must be pdf or epub");
  const layout = query.get("layout") ?? undefined;
  if (layout !== undefined && layout !== "fixed" && layout !== "reflowable") return bad("layout must be fixed or reflowable");
  const versionId = query.get("version") ?? undefined;
  if (!isUuid(bookId)) return bad("book not found", 404);
  if (versionId !== undefined && !isUuid(versionId)) return bad("version not found", 404);

  const result = await exportBook(createPgRepository(getDb()), {
    bookId,
    format,
    ...(layout ? { layout: layout as EpubLayout } : {}),
    ...(versionId ? { versionId } : {}),
  });
  if (!result.ok) {
    if (result.reason === "not_found") return bad("book not found", 404);
    if (result.reason === "version_not_found") return bad("version not found", 404);
    return bad(result.message, 500);
  }
  return new Response(new Uint8Array(result.bytes), {
    headers: {
      "Content-Type": CONTENT_TYPE[format],
      "Content-Disposition": disposition(result.title, format),
      "Cache-Control": "no-store",
      ...(result.pages !== undefined ? { "X-Postext-Pages": String(result.pages) } : {}),
      "X-Postext-Warnings": String(result.warnings.length),
    },
  });
}
