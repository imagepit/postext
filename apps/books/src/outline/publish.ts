// Outline の「書籍出版」から、コースのテキストを Postext の書籍へ取り込む（CORE-229）。
// Outline のサーバーが book-mcp.image-pit.com の /mcp/outline/* から呼ぶ。
// 書籍がなければ作ってデザインを当て、Postext で編集された章は取り込まない（Postext を優先する）。

import { createHash } from "node:crypto";
import { applyDesign } from "postext";
import type { PostextConfig } from "postext";
import { openDesignBundle } from "postext/bundle";
import type { AssetData, Book, BookRepository } from "@/books/model";
import type { DesignRepository } from "@/designs/model";
import type { OutlineClient } from "./client";
import { applyImport, previewImport } from "./importBook";
import { readProvenance } from "./provenance";

export const DEFAULT_DESIGN_ID = "imagepit-textbook";

export interface CourseInput {
  /** 章にする子文書の親（コースの「テキスト」）。 */
  parentDocumentId: string;
  /** コースのテキストの章の文書 ID（Outline の並び順）。 */
  documentIds: string[];
  /** コース名。新しく作る書籍の題になる。 */
  title: string;
}

export type ChapterState = "imported" | "unchanged" | "outlineUpdated" | "postextEdited" | "notInBook";

export interface ChapterLink {
  documentId: string;
  title: string;
  /** 書籍の中の章の番号（1 から）。書籍にない章は undefined。 */
  chapter?: number;
  url?: string;
  state: ChapterState;
}

export interface CourseBook {
  book: { id: string; title: string; revision: number; url: string } | null;
  created: boolean;
  chapters: ChapterLink[];
  warnings: string[];
}

export interface PublishDeps {
  repo: BookRepository;
  designs: DesignRepository;
  outline: Pick<OutlineClient, "listChildDocuments" | "fetchAttachment">;
  /** 書籍の編集画面の URL の元。既定は POSTEXT_BOOK_URL か https://book.image-pit.com。 */
  bookUrl?: string;
  designId?: string;
}

const baseUrl = (deps: PublishDeps) =>
  (deps.bookUrl ?? (process.env.POSTEXT_BOOK_URL?.trim() || "https://book.image-pit.com")).replace(/\/+$/, "");

export const bookUrlOf = (base: string, bookId: string, chapter?: number) =>
  `${base}/books/${bookId}${chapter !== undefined ? `?chapter=${chapter}` : ""}`;

/** 取り込み元の記録で、コースの章をいちばん多く持つ書籍。なければ null。資産の中身は読まない。 */
async function findCourseBook(repo: BookRepository, documentIds: readonly string[]): Promise<Book | null> {
  const wanted = new Set(documentIds);
  let best: { book: Book; hits: number } | null = null;
  for (const summary of await repo.list()) {
    const book = await repo.get(summary.id);
    if (!book) continue;
    const hits = book.chapters.filter((c) => {
      const p = readProvenance(c.markdown);
      return p !== null && wanted.has(p.id);
    }).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { book, hits };
  }
  return best?.book ?? null;
}

const FONT_MIME: Record<string, string> = { ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2" };

/** デザインの設定とフォントで、新しい書籍の中身を作る。デザインがなければ設定は空。 */
async function designedContent(deps: PublishDeps, warnings: string[]): Promise<{ config: Record<string, unknown>; assets: AssetData[] }> {
  const record = await deps.designs.get(deps.designId ?? DEFAULT_DESIGN_ID);
  if (!record) {
    warnings.push(`デザイン ${deps.designId ?? DEFAULT_DESIGN_ID} が見つからないため、既定の見た目で作りました`);
    return { config: {}, assets: [] };
  }
  const opened = await openDesignBundle(new Uint8Array(record.bytes));
  const config = applyDesign({} as PostextConfig, opened.design) as unknown as Record<string, unknown>;
  const assets: AssetData[] = [...opened.files].map(([path, data]) => {
    const bytes = Buffer.from(data);
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    return {
      kind: path.startsWith("fonts/") ? "font" : "resource",
      path,
      mime: FONT_MIME[ext] ?? "application/octet-stream",
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    };
  });
  return { config, assets };
}

function linksOf(base: string, book: Book, input: CourseInput, titles: Map<string, string>, stateOf: (id: string) => ChapterState): ChapterLink[] {
  const index = new Map<string, number>();
  book.chapters.forEach((c, i) => {
    const p = readProvenance(c.markdown);
    if (p && !index.has(p.id)) index.set(p.id, i + 1);
  });
  return input.documentIds.map((documentId) => {
    const chapter = index.get(documentId);
    return {
      documentId,
      title: titles.get(documentId) ?? (chapter !== undefined ? book.chapters[chapter - 1]!.title : ""),
      ...(chapter !== undefined ? { chapter, url: bookUrlOf(base, book.id, chapter) } : {}),
      state: chapter === undefined ? "notInBook" : stateOf(documentId),
    };
  });
}

const stateFromStatus = (status: string | undefined): ChapterState =>
  status === "bookEdited" || status === "both" ? "postextEdited" : status === "outlineUpdated" ? "outlineUpdated" : status === "new" ? "notInBook" : "unchanged";

/** 何も書き換えずに、コースの書籍と章の URL と状態を返す（欄を開いたときの表示）。 */
export async function locateCourse(deps: PublishDeps, input: CourseInput): Promise<CourseBook> {
  const base = baseUrl(deps);
  const book = await findCourseBook(deps.repo, input.documentIds);
  if (!book) {
    return { book: null, created: false, chapters: input.documentIds.map((documentId) => ({ documentId, title: "", state: "notInBook" })), warnings: [] };
  }
  const preview = await previewImport(deps.repo, book.id, input.parentDocumentId, deps.outline);
  const status = new Map(preview.ok ? preview.chapters.map((c) => [c.documentId, c.status] as const) : []);
  const titles = new Map(preview.ok ? preview.chapters.map((c) => [c.documentId, c.title] as const) : []);
  return {
    book: { id: book.id, title: book.title, revision: book.revision, url: bookUrlOf(base, book.id) },
    created: false,
    chapters: linksOf(base, book, input, titles, (id) => stateFromStatus(status.get(id))),
    warnings: [],
  };
}

/** コースのテキストを書籍へ取り込む。書籍がなければ作る。Postext で編集された章は取り込まない。 */
export async function publishCourse(deps: PublishDeps, input: CourseInput): Promise<CourseBook> {
  const base = baseUrl(deps);
  const warnings: string[] = [];
  let book = await findCourseBook(deps.repo, input.documentIds);
  let created = false;
  if (!book) {
    const content = await designedContent(deps, warnings);
    const made = await deps.repo.create({ title: input.title, config: content.config, resources: [], chapters: [], locale: "ja", assets: content.assets });
    book = await deps.repo.get(made.id);
    created = true;
  }
  if (!book) throw new Error("書籍を作れませんでした");

  const preview = await previewImport(deps.repo, book.id, input.parentDocumentId, deps.outline);
  if (!preview.ok) throw new Error("書籍の取り込みの確認に失敗しました");
  const course = new Set(input.documentIds);
  const status = new Map(preview.chapters.map((c) => [c.documentId, c.status] as const));
  const titles = new Map(preview.chapters.map((c) => [c.documentId, c.title] as const));
  const toImport = preview.chapters.filter((c) => course.has(c.documentId) && (c.status === "new" || c.status === "outlineUpdated")).map((c) => c.documentId);
  const imported = new Set<string>();
  if (toImport.length > 0) {
    const applied = await applyImport(
      deps.repo,
      book.id,
      { baseRevision: preview.revision, parentId: input.parentDocumentId, documentIds: toImport, protectBookEdits: true },
      deps.outline,
    );
    if (!applied.ok) throw new Error(applied.reason === "conflict" ? "書籍が同時に保存されました。もう一度やり直してください" : "取り込みに失敗しました");
    warnings.push(...applied.warnings);
    for (const id of toImport) imported.add(id);
  }
  for (const id of input.documentIds) {
    const s = status.get(id);
    if (s === "bookEdited" || s === "both") warnings.push(`${titles.get(id) ?? id}: Postextの編集が優先されます。先にPostextの「Outlineへ反映」を使ってください`);
  }
  const saved = (await deps.repo.get(book.id))!;
  return {
    book: { id: saved.id, title: saved.title, revision: saved.revision, url: bookUrlOf(base, saved.id) },
    created,
    chapters: linksOf(base, saved, input, titles, (id) => (imported.has(id) ? "imported" : stateFromStatus(status.get(id)))),
    warnings,
  };
}
