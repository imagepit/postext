import { describe, expect, it } from "vitest";
import { classify, lineDiff } from "./diff";
import { hashBody, writeChapter } from "./provenance";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-02-01T00:00:00.000Z";

const chapter = (id: string, body: string, updatedAt = T0, edited = false) => ({
  title: id,
  markdown: writeChapter("", edited ? `${body}編集\n` : body, { id, updatedAt, hash: hashBody(body) }),
});

describe("classify", () => {
  const body = "# t\n\n本文\n";

  it("6 つの状態を分類する", () => {
    const entries = classify(
      [
        { id: "n", title: "n", updatedAt: T0 },
        { id: "u", title: "u", updatedAt: T0 },
        { id: "o", title: "o", updatedAt: T1 },
        { id: "e", title: "e", updatedAt: T0 },
        { id: "b", title: "b", updatedAt: T1 },
      ],
      [
        chapter("u", body),
        chapter("o", body),
        chapter("e", body, T0, true),
        chapter("b", body, T0, true),
        chapter("gone", body),
        { title: "手書き", markdown: "# 手書き\n" },
      ],
    );
    expect(entries.map((e) => [e.documentId, e.status, e.chapterIndex])).toEqual([
      ["n", "new", undefined],
      ["u", "unchanged", 0],
      ["o", "outlineUpdated", 1],
      ["e", "bookEdited", 2],
      ["b", "both", 3],
      ["gone", "missingInOutline", 4],
    ]);
  });

  it("改行や行末の空白の違いは書籍側の編集にならない", () => {
    const markdown = writeChapter("", "# t  \r\n\r\n本文\r\n", { id: "x", updatedAt: T0, hash: hashBody(body) });
    expect(classify([{ id: "x", title: "x", updatedAt: T0 }], [{ title: "x", markdown }])[0]!.status).toBe("unchanged");
  });

  it("outline を持たない章は対象にならない", () => {
    expect(classify([], [{ title: "手書き", markdown: "本文" }])).toEqual([]);
  });
});

describe("lineDiff", () => {
  it("同じ・削除・追加の行を返す", () => {
    expect(lineDiff("a\nb\nc\n", "a\nc\nd\n")).toEqual([
      { type: "same", text: "a" },
      { type: "del", text: "b" },
      { type: "same", text: "c" },
      { type: "add", text: "d" },
    ]);
  });

  it("現在が空なら全行が追加", () => {
    expect(lineDiff("", "x\ny\n")).toEqual([
      { type: "add", text: "x" },
      { type: "add", text: "y" },
    ]);
  });
});
