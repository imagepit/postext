// 端末の AI が書籍を読み書きするためのツールの中身（CORE-203）。MCP の登録は server.ts が行う。
// 保存は編集画面と同じ saveBook を通し、読んだときの revision と違えば保存しない。

import type { Book, BookRepository, ChapterContent } from "@/books/model";
import { createVersion, saveBook } from "@/books/usecases";
import { exportBook } from "@/export/render";
import type { EpubLayout, ExportFormat, ExportOptions } from "@/export/render";
import type { ExportStore } from "./exportStore";
import { bodyOf } from "@/outline/provenance";

export interface ToolDeps {
  repo: BookRepository;
  exports: ExportStore;
  exportOptions?: ExportOptions;
}

export type ToolResult = Record<string, unknown>;

/** 失敗の結果。AI が次に何をすればよいかを message に書く。 */
const fail = (error: string, message: string, extra: Record<string, unknown> = {}): ToolResult => ({ ok: false, error, message, ...extra });

const notFound = (bookId: string) => fail("not_found", `書籍 ${bookId} が見つかりません。list_books で ID を確かめてください。`);

const conflict = (revision: number) =>
  fail("conflict", `書籍は revision ${revision} に更新されています。read_chapter で読み直してから、もう一度やり直してください。`, { revision });

/** 章の frontmatter（--- で囲まれた先頭）と本文に分ける。本文だけを AI に渡し、frontmatter（取り込み元の記録など）は保つ。 */
export function splitChapter(markdown: string): { frontmatter: string; body: string } {
  const text = markdown.replace(/^﻿/, "");
  const body = bodyOf(text);
  return { frontmatter: text.slice(0, text.length - body.length), body };
}

const chapterAt = (book: Book, chapter: number): ChapterContent | undefined =>
  Number.isInteger(chapter) && chapter >= 1 ? book.chapters[chapter - 1] : undefined;

const badChapter = (book: Book, chapter: number) =>
  fail("bad_chapter", `章 ${chapter} はありません。この書籍の章は 1〜${book.chapters.length} です。get_book で確かめてください。`);

async function save(deps: ToolDeps, book: Book, baseRevision: number, chapters: ChapterContent[]): Promise<ToolResult> {
  const saved = await saveBook(deps.repo, book.id, baseRevision, {
    title: book.title,
    config: book.config,
    resources: book.resources,
    chapters,
    ...(book.locale !== undefined ? { locale: book.locale } : {}),
    sharedConfig: book.sharedConfig ?? null,
    editions: book.editions ?? [],
  });
  if (saved.ok) return { ok: true, revision: saved.revision };
  return saved.reason === "conflict" ? conflict(saved.revision) : notFound(book.id);
}

export async function listBooks(deps: ToolDeps): Promise<ToolResult> {
  const books = await deps.repo.list();
  return { ok: true, books: books.map((b) => ({ id: b.id, title: b.title, revision: b.revision, updatedAt: b.updatedAt.toISOString() })) };
}

export async function getBook(deps: ToolDeps, bookId: string): Promise<ToolResult> {
  const book = await deps.repo.get(bookId);
  if (!book) return notFound(bookId);
  const versions = (await deps.repo.listVersions(bookId)) ?? [];
  return {
    ok: true,
    id: book.id,
    title: book.title,
    revision: book.revision,
    locale: book.locale ?? book.chapters[0]?.locale,
    chapters: book.chapters.map((c, i) => ({ chapter: i + 1, title: c.title, locale: c.locale, characters: splitChapter(c.markdown).body.length })),
    versions: versions.map((v) => ({ id: v.id, number: v.number, label: v.label, revision: v.revision, createdAt: v.createdAt.toISOString() })),
  };
}

export async function readChapter(deps: ToolDeps, bookId: string, chapter: number): Promise<ToolResult> {
  const book = await deps.repo.get(bookId);
  if (!book) return notFound(bookId);
  const c = chapterAt(book, chapter);
  if (!c) return badChapter(book, chapter);
  return { ok: true, revision: book.revision, chapter, title: c.title, locale: c.locale, markdown: splitChapter(c.markdown).body };
}

export async function searchText(deps: ToolDeps, bookId: string, query: string, limit = 50): Promise<ToolResult> {
  const book = await deps.repo.get(bookId);
  if (!book) return notFound(bookId);
  const q = query.toLowerCase();
  if (!q) return fail("bad_query", "探す語が空です。");
  const matches: { chapter: number; line: number; text: string }[] = [];
  let total = 0;
  book.chapters.forEach((c, i) => {
    splitChapter(c.markdown).body.split("\n").forEach((line, k) => {
      if (!line.toLowerCase().includes(q)) return;
      total++;
      if (matches.length < limit) matches.push({ chapter: i + 1, line: k + 1, text: line });
    });
  });
  return { ok: true, revision: book.revision, total, matches };
}

export async function writeChapter(deps: ToolDeps, bookId: string, chapter: number, markdown: string, baseRevision: number): Promise<ToolResult> {
  const book = await deps.repo.get(bookId);
  if (!book) return notFound(bookId);
  if (book.revision !== baseRevision) return conflict(book.revision);
  const c = chapterAt(book, chapter);
  if (!c) return badChapter(book, chapter);
  const { frontmatter } = splitChapter(c.markdown);
  const chapters = book.chapters.map((x, i) => (i === chapter - 1 ? { ...x, markdown: frontmatter + markdown } : x));
  return save(deps, book, baseRevision, chapters);
}

export async function replaceText(
  deps: ToolDeps,
  bookId: string,
  find: string,
  replace: string,
  baseRevision: number,
  chapter?: number,
): Promise<ToolResult> {
  const book = await deps.repo.get(bookId);
  if (!book) return notFound(bookId);
  if (book.revision !== baseRevision) return conflict(book.revision);
  if (!find) return fail("bad_query", "置き換える語が空です。");
  if (chapter !== undefined && !chapterAt(book, chapter)) return badChapter(book, chapter);
  let replaced = 0;
  const chapters = book.chapters.map((c, i) => {
    if (chapter !== undefined && i !== chapter - 1) return c;
    const { frontmatter, body } = splitChapter(c.markdown);
    const parts = body.split(find);
    if (parts.length === 1) return c;
    replaced += parts.length - 1;
    return { ...c, markdown: frontmatter + parts.join(replace) };
  });
  if (replaced === 0) return fail("no_match", `「${find}」は見つかりませんでした。保存していません。`, { replaced: 0, revision: book.revision });
  const saved = await save(deps, book, baseRevision, chapters);
  return saved.ok ? { ...saved, replaced } : saved;
}

export async function makeVersion(deps: ToolDeps, bookId: string, label: string): Promise<ToolResult> {
  const created = await createVersion(deps.repo, bookId, label);
  if (!created.ok) return notFound(bookId);
  const v = created.version;
  return { ok: true, version: { id: v.id, number: v.number, label: v.label, revision: v.revision } };
}

const MIME: Record<ExportFormat, string> = { pdf: "application/pdf", epub: "application/epub+zip" };

export async function exportBookTool(
  deps: ToolDeps,
  bookId: string,
  format: ExportFormat,
  layout?: EpubLayout,
  versionId?: string,
): Promise<ToolResult> {
  const result = await exportBook(
    deps.repo,
    { bookId, format, ...(layout ? { layout } : {}), ...(versionId ? { versionId } : {}) },
    deps.exportOptions,
  );
  if (!result.ok) {
    if (result.reason === "not_found") return notFound(bookId);
    if (result.reason === "version_not_found") return fail("version_not_found", `版 ${versionId} が見つかりません。get_book で版の ID を確かめてください。`);
    return fail("export_failed", result.message);
  }
  const fileName = `${result.title.replace(/[\\/:*?"<>|\r\n]+/g, "_").trim() || "book"}.${format}`;
  const stored = await deps.exports.put(result.bytes, fileName, MIME[format]);
  return {
    ok: true,
    exportId: stored.id,
    fileName,
    size: stored.size,
    pages: result.pages,
    warnings: result.warnings.length,
    warningKinds: [...new Set(result.warnings.map((w) => w.kind))],
    expiresAt: stored.expiresAt.toISOString(),
    next: "手元に保存するときは save_export にこの exportId と保存先のパスを渡してください。",
  };
}
