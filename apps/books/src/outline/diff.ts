// Outline の文書と書籍の章を突き合わせて状態を分類する。入出力を持たない。

import { bodyOf, hashBody, readProvenance } from "./provenance";

export type ChapterStatus =
  | "new"
  | "outlineUpdated"
  | "bookEdited"
  | "both"
  | "unchanged"
  | "missingInOutline";

export interface IncomingDoc {
  id: string;
  title: string;
  updatedAt: string;
}

export interface ExistingChapter {
  title: string;
  markdown: string;
}

export interface ClassifiedEntry {
  status: ChapterStatus;
  documentId: string;
  title: string;
  /** 対応する既存の章の位置（new 以外）。 */
  chapterIndex?: number;
}

const time = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/** incoming は Outline の順。missingInOutline は最後に付ける。chapters は主言語の章だけを渡す想定で、chapterIndex はその配列の添字。 */
export function classify(incoming: IncomingDoc[], chapters: ExistingChapter[]): ClassifiedEntry[] {
  const byId = new Map<string, { index: number; chapter: ExistingChapter }>();
  chapters.forEach((chapter, index) => {
    const p = readProvenance(chapter.markdown);
    if (p && !byId.has(p.id)) byId.set(p.id, { index, chapter });
  });
  const entries: ClassifiedEntry[] = incoming.map((doc) => {
    const hit = byId.get(doc.id);
    if (!hit) return { status: "new", documentId: doc.id, title: doc.title };
    const stored = readProvenance(hit.chapter.markdown)!;
    const bookEdited = hashBody(bodyOf(hit.chapter.markdown)) !== stored.hash;
    const outlineUpdated = time(doc.updatedAt) > time(stored.updatedAt);
    const status: ChapterStatus =
      bookEdited && outlineUpdated ? "both" : outlineUpdated ? "outlineUpdated" : bookEdited ? "bookEdited" : "unchanged";
    return { status, documentId: doc.id, title: doc.title, chapterIndex: hit.index };
  });
  const present = new Set(incoming.map((d) => d.id));
  for (const [id, { index, chapter }] of byId) {
    if (!present.has(id)) {
      entries.push({ status: "missingInOutline", documentId: id, title: chapter.title, chapterIndex: index });
    }
  }
  return entries;
}

export interface DiffLine {
  type: "same" | "add" | "del";
  text: string;
}

const MAX_DIFF_LINES = 1500;

/** 行単位の差分（最長共通部分列）。大きすぎるときは全行置き換えとして返す。 */
export function lineDiff(current: string, incoming: string): DiffLine[] {
  const a = current === "" ? [] : current.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  const b = incoming === "" ? [] : incoming.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return [...a.map((text) => ({ type: "del" as const, text })), ...b.map((text) => ({ type: "add" as const, text }))];
  }
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ type: "del", text: a[i++]! });
    else out.push({ type: "add", text: b[j++]! });
  }
  while (i < a.length) out.push({ type: "del", text: a[i++]! });
  while (j < b.length) out.push({ type: "add", text: b[j++]! });
  return out;
}
