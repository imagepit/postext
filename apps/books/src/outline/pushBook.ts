// 書籍の章を、取り込み元の Outline 文書へ書き戻すユースケース（CORE-228）。
// 確認（previewPush）は何も書き込まず、反映（applyPush）だけが Outline と書籍を更新する。
// 両方で変更された章も、Postext の内容で上書きする（Postext を優先する方針）。

import type { BookRepository, BookWithAssetData } from "@/books/model";
import { saveBook } from "@/books/usecases";
import type { OutlineClient, OutlineDocument } from "./client";
import { OutlineHttpError } from "./client";
import { lineDiff } from "./diff";
import type { DiffLine } from "./diff";
import type { Outcome } from "./importBook";
import { bodyOf, hashBody, readProvenance, writeChapter } from "./provenance";
import { toOutlineMarkdown } from "./reverse";

export type PushStatus = "bookEdited" | "both" | "outlineUpdated" | "unchanged" | "missingInOutline";

/** 反映できる状態。Outline 側だけの更新を書き戻すと Outline の編集が消えるので対象外。 */
export const PUSHABLE: ReadonlySet<PushStatus> = new Set(["bookEdited", "both"]);

export interface PushPreviewEntry {
  documentId: string;
  /** 書籍の章の題。 */
  title: string;
  status: PushStatus;
  warnings: string[];
  /** Outline の今の本文と、反映後の本文の差分（変わった行の前後だけ）。 */
  diff: DiffLine[];
  /** Outline へ新しく添付する画像（Postext で足した画像）の数。 */
  newImages: number;
}

export interface PushPreview {
  revision: number;
  chapters: PushPreviewEntry[];
}

export interface PushInput {
  baseRevision: number;
  /** 反映する章の取り込み元の Outline 文書 ID。 */
  documentIds: string[];
}

export interface PushResult {
  revision: number;
  pushed: number;
  warnings: string[];
}

export type PushSource = Pick<OutlineClient, "getDocument">;
export type PushTarget = Pick<OutlineClient, "getDocument" | "updateDocument" | "createAttachment">;

const time = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

const CONTEXT = 3;

/** 変わった行の前後 CONTEXT 行だけを残し、間は「…」の1行にまとめる。 */
export function compactDiff(diff: DiffLine[]): DiffLine[] {
  const near = new Set<number>();
  diff.forEach((d, i) => {
    if (d.type === "same") return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(diff.length - 1, i + CONTEXT); k++) near.add(k);
  });
  const out: DiffLine[] = [];
  let skipped = false;
  diff.forEach((d, i) => {
    if (near.has(i)) {
      out.push(d);
      skipped = false;
    } else if (!skipped) {
      out.push({ type: "same", text: "…" });
      skipped = true;
    }
  });
  return near.size === 0 ? [] : out;
}

/** 取り込み元の記録がある主言語の章。 */
function linkedChapters(book: BookWithAssetData) {
  const locale = book.locale ?? book.chapters[0]?.locale ?? "en";
  return book.chapters.flatMap((chapter, index) => {
    const provenance = chapter.locale === locale ? readProvenance(chapter.markdown) : null;
    return provenance ? [{ chapter, index, provenance }] : [];
  });
}

async function fetchDoc(client: PushSource, id: string): Promise<OutlineDocument | null> {
  try {
    return await client.getDocument(id);
  } catch (error) {
    if (error instanceof OutlineHttpError && (error.status === 404 || error.status === 403)) return null;
    throw error;
  }
}

function statusOf(markdown: string, stored: { updatedAt: string; hash: string }, doc: OutlineDocument | null): PushStatus {
  if (!doc) return "missingInOutline";
  const bookEdited = hashBody(bodyOf(markdown)) !== stored.hash;
  const outlineUpdated = time(doc.updatedAt) > time(stored.updatedAt);
  return bookEdited && outlineUpdated ? "both" : bookEdited ? "bookEdited" : outlineUpdated ? "outlineUpdated" : "unchanged";
}

function titleWarning(reversedTitle: string | undefined, doc: OutlineDocument): string[] {
  return reversedTitle !== undefined && reversedTitle !== doc.title
    ? [`題「${reversedTitle}」は Outline へ反映しません（Outline の題は「${doc.title}」のまま）`]
    : [];
}

export async function previewPush(repo: BookRepository, bookId: string, client: PushSource): Promise<Outcome<PushPreview>> {
  const book = await repo.getWithAssetData(bookId);
  if (!book) return { ok: false, reason: "not_found" };
  const chapters: PushPreviewEntry[] = [];
  for (const { chapter, provenance } of linkedChapters(book)) {
    const doc = await fetchDoc(client, provenance.id);
    const status = statusOf(chapter.markdown, provenance, doc);
    if (!doc) {
      chapters.push({ documentId: provenance.id, title: chapter.title, status, warnings: ["Outline に文書が見つかりません"], diff: [], newImages: 0 });
      continue;
    }
    const back = toOutlineMarkdown(chapter.markdown, { resources: book.resources, original: doc.text });
    chapters.push({
      documentId: doc.id,
      title: chapter.title,
      status,
      warnings: [...back.warnings, ...titleWarning(back.title, doc)],
      diff: PUSHABLE.has(status) ? compactDiff(lineDiff(doc.text, back.markdown)) : [],
      newImages: back.images.length,
    });
  }
  return { ok: true, revision: book.revision, chapters };
}

const fileIdOf = (resource: Record<string, unknown>): string | undefined => {
  const media = (resource.bitmap ?? resource.svg) as { fileId?: unknown } | undefined;
  return typeof media?.fileId === "string" ? media.fileId : undefined;
};

/** 章の本文の `::resource{id="from"}` を `to` に付け替える。 */
const renameResource = (markdown: string, from: string, to: string): string =>
  markdown.split(`::resource{id="${from}"}`).join(`::resource{id="${to}"}`);

export async function applyPush(
  repo: BookRepository,
  bookId: string,
  input: PushInput,
  client: PushTarget,
): Promise<Outcome<PushResult>> {
  const book = await repo.getWithAssetData(bookId);
  if (!book) return { ok: false, reason: "not_found" };
  if (book.revision !== input.baseRevision) return { ok: false, reason: "conflict", revision: book.revision };

  const linked = linkedChapters(book);
  const known = new Set(linked.map((l) => l.provenance.id));
  const unknown = input.documentIds.find((id) => !known.has(id));
  if (unknown) return { ok: false, reason: "invalid", message: `書籍の章の取り込み元ではない文書です: ${unknown}` };

  const wanted = new Set(input.documentIds);
  const chapters = [...book.chapters];
  let resources = book.resources;
  const assets = new Map(book.assets.map((a) => [a.path, a]));
  const warnings: string[] = [];
  let pushed = 0;

  for (const { index, provenance } of linked) {
    if (!wanted.has(provenance.id)) continue;
    const chapter = chapters[index]!;
    const doc = await fetchDoc(client, provenance.id);
    const status = statusOf(chapter.markdown, provenance, doc);
    if (!doc || !PUSHABLE.has(status)) {
      warnings.push(`${chapter.title}: 反映できない状態（${status}）のためスキップしました`);
      continue;
    }
    const back = toOutlineMarkdown(chapter.markdown, { resources, original: doc.text });
    let text = back.markdown;
    // Postext で足した画像は先に Outline へ添付し、本文の仮の参照と書籍のリソース ID を、その添付に付け替える。
    for (const pending of back.images) {
      const resource = resources.find((r) => r.id === pending.resourceId);
      const fileId = resource ? fileIdOf(resource) : undefined;
      const asset = fileId ? assets.get(fileId) : undefined;
      if (!resource || !asset) {
        warnings.push(`${chapter.title}: 画像 ${pending.resourceId} のファイルがないため、仮の参照のまま残しました`);
        continue;
      }
      const name = fileId!.split("/").pop() ?? `${pending.resourceId}`;
      const created = await client.createAttachment({ documentId: doc.id, name, contentType: asset.mime, bytes: new Uint8Array(asset.bytes) });
      text = text.split(`(${pending.placeholder})`).join(`(/api/attachments.redirect?id=${created.id})`);
      const newId = `outline-img-${created.id}`;
      resources = resources.map((r) => (r.id === pending.resourceId ? { ...r, id: newId } : r));
      for (let k = 0; k < chapters.length; k++) {
        chapters[k] = { ...chapters[k]!, markdown: renameResource(chapters[k]!.markdown, pending.resourceId, newId) };
      }
    }
    const updated = await client.updateDocument(doc.id, text);
    const markdown = chapters[index]!.markdown;
    const body = bodyOf(markdown);
    // 書き戻した内容が Outline の今の版なので、記録を合わせて次の確認で「変更なし」にする。
    chapters[index] = { ...chapters[index]!, markdown: writeChapter(markdown, body, { id: doc.id, updatedAt: updated.updatedAt, hash: hashBody(body) }) };
    for (const w of [...back.warnings, ...titleWarning(back.title, doc)]) warnings.push(`${chapter.title}: ${w}`);
    pushed++;
  }

  if (pushed === 0) return { ok: true, revision: book.revision, pushed, warnings };
  const saved = await saveBook(repo, bookId, input.baseRevision, {
    title: book.title,
    config: book.config,
    resources,
    chapters,
    ...(book.locale !== undefined ? { locale: book.locale } : {}),
    sharedConfig: book.sharedConfig ?? null,
    editions: book.editions ?? [],
  });
  if (!saved.ok) return saved;
  return { ok: true, revision: saved.revision, pushed, warnings };
}
