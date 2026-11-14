// Outline の文書を書籍の章として取り込むユースケース。
// 取り込みの確認（previewImport）は何も保存せず、適用（applyImport）だけが saveBook で書き込む。

import type { BookRepository, BookWithAssetData, Failure } from "@/books/model";
import { saveBook } from "@/books/usecases";
import type { OutlineClient, OutlineDocument } from "./client";
import { convertOutlineMarkdown } from "./convert";
import { classify, lineDiff } from "./diff";
import type { ChapterStatus, ClassifiedEntry, DiffLine } from "./diff";
import { bodyOf, hashBody, readProvenance, writeChapter } from "./provenance";
import { buildResources } from "./resources";

export type ImportFailure = Failure | { ok: false; reason: "invalid"; message: string };
export type Outcome<T> = ({ ok: true } & T) | ImportFailure;

export interface PreviewEntry {
  documentId: string;
  title: string;
  status: ChapterStatus;
  warnings: string[];
  /** 現在の章の本文（frontmatter なし）と、取り込み後の本文の差分。 */
  diff: DiffLine[];
}

export interface PreviewResult {
  revision: number;
  chapters: PreviewEntry[];
}

export interface ApplyInput {
  baseRevision: number;
  /** 子文書を章にする親文書。 */
  parentId: string;
  /** 適用する子文書。 */
  documentIds: string[];
}

export interface ApplyResult {
  revision: number;
  warnings: string[];
}

/** 取り込める状態。bookEdited は書籍側の編集を守るため、unchanged は変わらないため対象外。 */
export const APPLICABLE: ReadonlySet<ChapterStatus> = new Set(["new", "outlineUpdated", "both"]);

export type OutlineSource = Pick<OutlineClient, "listChildDocuments" | "fetchAttachment">;

const primaryLocaleOf = (book: BookWithAssetData): string => book.locale ?? book.chapters[0]?.locale ?? "en";

const stripInlineMarks = (title: string): string =>
  title
    .replace(/\s*\{[^{}]*\}\s*$/, "")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/(^|[\s(（])_([^_]+)_(?=$|[\s)）、。,.])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();

/** 章の `##` と `###` から「【この章の内容】」ブロックを作る。コードブロック内の行は見出しにしない。`##` がなければ空文字。 */
export function chapterContentsBlock(markdown: string, chapterNo: number): string {
  const items: string[] = [];
  let fence: { char: string; len: number } | null = null;
  let h2 = 0;
  let h3 = 0;
  for (const line of markdown.split("\n")) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      const marker = f[1]!;
      if (!fence) fence = { char: marker[0]!, len: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.len && /^\s*[`~]+\s*$/.test(line)) fence = null;
      continue;
    }
    if (fence) continue;
    const m = /^(##|###)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const title = stripInlineMarks(m[2]!.replace(/\s+#+$/, ""));
    if (!title) continue;
    if (m[1] === "##") {
      h2++;
      h3 = 0;
      items.push(`- ${chapterNo}.${h2} ${title}`);
    } else if (h2 > 0) {
      h3++;
      items.push(`  - ${chapterNo}.${h2}.${h3} ${title}`);
    }
  }
  if (h2 === 0) return "";
  return `:::callout{type="chapter-contents" label="【この章の内容】"}\n${items.join("\n")}\n:::\n\n`;
}

/** chapterNo は Outline の親文書の子の並びでの 1 始まりの位置。 */
function convertDocument(doc: OutlineDocument, chapterNo: number) {
  const converted = convertOutlineMarkdown(doc.text, { docId: doc.id });
  const body = `# ${doc.title}\n\n${chapterContentsBlock(converted.markdown, chapterNo)}${converted.markdown}`;
  return { converted, body, hash: hashBody(body) };
}

function classifyAgainst(book: BookWithAssetData, docs: OutlineDocument[]) {
  const locale = primaryLocaleOf(book);
  const primary = book.chapters.map((c, index) => ({ c, index })).filter((x) => x.c.locale === locale);
  const entries = classify(
    docs.map((d) => ({ id: d.id, title: d.title, updatedAt: d.updatedAt })),
    primary.map((x) => ({ title: x.c.title, markdown: x.c.markdown })),
  );
  return { locale, primary, entries };
}

export async function previewImport(
  repo: BookRepository,
  bookId: string,
  parentId: string,
  client: Pick<OutlineClient, "listChildDocuments">,
): Promise<Outcome<PreviewResult>> {
  const book = await repo.getWithAssetData(bookId);
  if (!book) return { ok: false, reason: "not_found" };
  const docs = await client.listChildDocuments(parentId);
  const { primary, entries } = classifyAgainst(book, docs);
  const byId = new Map(docs.map((d) => [d.id, d]));
  const numberOf = new Map(docs.map((d, i) => [d.id, i + 1]));
  const chapters: PreviewEntry[] = entries.map((entry: ClassifiedEntry) => {
    const doc = byId.get(entry.documentId);
    const current = entry.chapterIndex !== undefined ? bodyOf(primary[entry.chapterIndex]!.c.markdown) : "";
    if (!doc) return { documentId: entry.documentId, title: entry.title, status: entry.status, warnings: [], diff: [] };
    const { converted, body } = convertDocument(doc, numberOf.get(doc.id) ?? 1);
    return {
      documentId: doc.id,
      title: doc.title,
      status: entry.status,
      warnings: converted.warnings,
      diff: lineDiff(current, body),
    };
  });
  return { ok: true, revision: book.revision, chapters };
}

function upsertById(list: Record<string, unknown>[], incoming: Record<string, unknown>[]): Record<string, unknown>[] {
  const out = [...list];
  for (const item of incoming) {
    const at = out.findIndex((r) => r.id === item.id);
    if (at >= 0) out[at] = item;
    else out.push(item);
  }
  return out;
}

export async function applyImport(
  repo: BookRepository,
  bookId: string,
  input: ApplyInput,
  client: OutlineSource,
  now: () => number = Date.now,
): Promise<Outcome<ApplyResult>> {
  const book = await repo.getWithAssetData(bookId);
  if (!book) return { ok: false, reason: "not_found" };
  if (book.revision !== input.baseRevision) return { ok: false, reason: "conflict", revision: book.revision };

  const docs = await client.listChildDocuments(input.parentId);
  const known = new Set(docs.map((d) => d.id));
  const unknown = input.documentIds.find((id) => !known.has(id));
  if (unknown) return { ok: false, reason: "invalid", message: `親文書の子ではない文書です: ${unknown}` };

  const { locale, entries } = classifyAgainst(book, docs);
  const statusOf = new Map(entries.map((e) => [e.documentId, e.status]));
  const wanted = new Set(input.documentIds);
  const warnings: string[] = [];

  const chapters = [...book.chapters];
  let resources = book.resources;
  const assets = new Map(book.assets.map((a) => [a.path, a]));

  const indexOfOutline = (id: string) =>
    chapters.findIndex((c) => c.locale === locale && readProvenance(c.markdown)?.id === id);

  for (const [k, doc] of docs.entries()) {
    if (!wanted.has(doc.id)) continue;
    const status = statusOf.get(doc.id)!;
    if (!APPLICABLE.has(status)) {
      warnings.push(`${doc.title}: 取り込み対象外の状態（${status}）のためスキップしました`);
      continue;
    }
    const { converted, body, hash } = convertDocument(doc, k + 1);
    const built = await buildResources(converted, (id) => client.fetchAttachment(id), now());
    for (const w of [...converted.warnings, ...built.warnings]) warnings.push(`${doc.title}: ${w}`);
    resources = upsertById(resources, built.resources);
    for (const a of built.assets) assets.set(a.path, a);

    const existing = indexOfOutline(doc.id);
    const provenance = { id: doc.id, updatedAt: doc.updatedAt, hash };
    if (existing >= 0) {
      const prev = chapters[existing]!;
      chapters[existing] = { ...prev, title: doc.title, markdown: writeChapter(prev.markdown, body, provenance) };
      continue;
    }
    // 新しい章は、Outline で直前にある取り込み済みの章の後ろへ。なければ直後の章の前へ。どちらもなければ主言語の章の末尾へ。
    let at = -1;
    for (let j = k - 1; j >= 0 && at < 0; j--) {
      const idx = indexOfOutline(docs[j]!.id);
      if (idx >= 0) at = idx + 1;
    }
    for (let j = k + 1; j < docs.length && at < 0; j++) {
      const idx = indexOfOutline(docs[j]!.id);
      if (idx >= 0) at = idx;
    }
    if (at < 0) {
      const lastPrimary = chapters.map((c) => c.locale).lastIndexOf(locale);
      at = lastPrimary + 1;
    }
    chapters.splice(at, 0, { title: doc.title, locale, markdown: writeChapter("", body, provenance) });
  }

  const saved = await saveBook(repo, bookId, input.baseRevision, {
    title: book.title,
    config: book.config,
    resources,
    chapters,
    ...(book.locale !== undefined ? { locale: book.locale } : {}),
    sharedConfig: book.sharedConfig ?? null,
    editions: book.editions ?? [],
    assets: [...assets.values()].sort((a, b) => a.path.localeCompare(b.path)),
  });
  if (!saved.ok) return saved;
  return { ok: true, revision: saved.revision, warnings };
}
