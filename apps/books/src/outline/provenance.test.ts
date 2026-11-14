import { describe, expect, it } from "vitest";
import { bodyOf, hashBody, readProvenance, writeChapter } from "./provenance";

const prov = { id: "doc-1", updatedAt: "2026-01-01T00:00:00.000Z", hash: "abc" };

describe("provenance", () => {
  it("frontmatter がなければ作り、本文は変えない", () => {
    const md = writeChapter("", "# t\n\n本文\n", prov);
    expect(md).toBe(`---\noutline:\n  id: "doc-1"\n  updatedAt: "2026-01-01T00:00:00.000Z"\n  hash: "abc"\n---\n# t\n\n本文\n`);
    expect(readProvenance(md)).toEqual(prov);
    expect(bodyOf(md)).toBe("# t\n\n本文\n");
  });

  it("outline 以外のキーを残して outline だけ置き換える", () => {
    const first = writeChapter("---\nchapterStyle: appendix\nauthor: 良輔\n---\n古い\n", "新しい\n", prov);
    const second = writeChapter(first, "さらに新しい\n", { ...prov, hash: "def" });
    expect(second).toContain("chapterStyle: appendix\nauthor: 良輔\noutline:");
    expect(second.match(/outline:/g)).toHaveLength(1);
    expect(readProvenance(second)?.hash).toBe("def");
    expect(bodyOf(second)).toBe("さらに新しい\n");
  });

  it("引用符なしの値や末尾にキーが来る形も読める", () => {
    const md = "---\noutline:\n  id: doc-1\n  updatedAt: 2026-01-01T00:00:00.000Z\n  hash: abc\ntitle: x\n---\n本文";
    expect(readProvenance(md)).toEqual(prov);
  });

  it("outline がない章や閉じていない frontmatter は null", () => {
    expect(readProvenance("# t\n")).toBeNull();
    expect(readProvenance("---\ntitle: x\n---\n")).toBeNull();
    expect(readProvenance("---\noutline:\n  id: a\n")).toBeNull();
  });

  it("hashBody は改行・行末空白・前後の空行に影響されない", () => {
    expect(hashBody("a  \r\nb\r\n\r\n")).toBe(hashBody("\na\nb"));
    expect(hashBody("a")).not.toBe(hashBody("b"));
  });
});
