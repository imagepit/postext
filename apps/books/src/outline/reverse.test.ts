import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { convertOutlineMarkdown } from "./convert";
import { chapterContentsBlock } from "./importBook";
import { buildImageResource, buildTableResource } from "./resources";
import { toOutlineMarkdown } from "./reverse";

const header = { format: "png", mime: "image/png", ext: "png", width: 10, height: 10 } as const;

/** 取り込みと同じ形の章（# 題 + この章の内容 + 本文）と resources を作る。 */
function importAs(text: string, docId: string, title: string, chapterNo = 1) {
  const converted = convertOutlineMarkdown(text, { docId });
  const resources = [
    ...converted.images.map((im) => buildImageResource(im, header, 0)),
    ...converted.tables.map((t) => buildTableResource(t, 0)),
  ];
  const chapter = `# ${title}\n\n${chapterContentsBlock(converted.markdown, chapterNo)}${converted.markdown}`;
  return { converted, resources, chapter };
}

/** 往復: 戻した本文をもう一度取り込むと、最初の取り込みと同じになる。 */
function roundTrip(text: string, docId = "doc-0000-test", title = "章") {
  const first = importAs(text, docId, title);
  const back = toOutlineMarkdown(first.chapter, { resources: first.resources, original: text });
  const again = convertOutlineMarkdown(back.markdown, { docId });
  return { first: first.converted, back, again };
}

const strip = (r: ReturnType<typeof convertOutlineMarkdown>) => ({
  markdown: r.markdown,
  images: r.images,
  tables: r.tables,
});

describe("toOutlineMarkdown: 教材の全章の往復", () => {
  const dir = path.join(__dirname, "fixtures/git-basics");
  const index = JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8")) as { file: string; id: string; title: string }[];

  for (const doc of index) {
    it(`${doc.file} ${doc.title}`, () => {
      const text = readFileSync(path.join(dir, doc.file), "utf8");
      const { first, back, again } = roundTrip(text, doc.id, doc.title);
      expect(strip(again)).toEqual(strip(first));
      expect(back.title).toBe(doc.title);
      expect(back.images).toEqual([]);
      // 取り込みで落とした先頭の yaml と差し込み記法は、元の本文から戻る。
      expect(back.markdown.startsWith("```yaml\n")).toBe(true);
      for (const tag of text.match(/^\{\{[^}]*\}\}$/gm) ?? []) expect(back.markdown).toContain(`\n${tag}\n`);
    });
  }
});

describe("toOutlineMarkdown: 書き方ごと", () => {
  const back = (chapter: string, resources: Record<string, unknown>[] = []) => toOutlineMarkdown(chapter, { resources });

  it("題の見出しと「この章の内容」を外し、題を返す", () => {
    const r = back(`---\noutline:\n  id: "x"\n---\n# 題\n\n:::callout{type="chapter-contents" label="【この章の内容】"}\n- 1.1 a\n:::\n\n## a\n\n本文\n`);
    expect(r.title).toBe("題");
    expect(r.markdown).toBe("## a\n\n本文\n");
  });

  it("手順の囲みを番号付きの項目へ戻す", () => {
    const r = back(
      [
        "**作業手順**",
        "",
        ':::callout{type="step"}',
        ':::callout{type="step-item" label="1"}',
        "",
        "**フォルダを作る**",
        "",
        "本文",
        "",
        "```java",
        "a",
        "",
        "b",
        "```",
        ":::",
        ':::callout{type="step-item" label="2"}',
        "",
        "**次**",
        ":::",
        ":::",
      ].join("\n"),
    );
    expect(r.markdown).toBe(
      [":::step 作業手順", "", "1. フォルダを作る", "", "   本文", "", "   ```java", "   a", "", "   b", "   ```", "", "2. 次", ":::", ""].join("\n"),
    );
  });

  it("端末の囲みを bash と bash-output へ戻し、ラベルを斜体の題にする", () => {
    const r = back(
      [':::callout{type="terminal" label="確認"}', "", "```console {highlight=\"3\"}", "$ java -version", "$ ls", "openjdk 21", "```", "", ":::"].join("\n"),
    );
    expect(r.markdown).toBe(["*確認*", "", "```bash", "java -version", "ls", "```", "", "```bash-output", "//addstart", "openjdk 21", "//addend", "```", ""].join("\n"));
  });

  it("コードの title と highlight を斜体の題と //addstart へ戻す", () => {
    const r = back(['```java {title="Hello.java" highlight="2-3"}', "a", "b", "c", "```"].join("\n"));
    expect(r.markdown).toBe(["*Hello.java*", "", "```java", "a", "//addstart", "b", "c", "//addend", "```", ""].join("\n"));
  });

  it("画像は幅とキャプションつきの Outline の添付へ、Postext で足した画像は仮の参照にする", () => {
    const r = back('::resource{id="outline-img-55036aff-0000-4000-8000-000000000000-2"}\n\n::resource{id="fig-new"}\n', [
      { id: "outline-img-55036aff-0000-4000-8000-000000000000-2", kind: "bitmap", caption: "GitLab", placement: { position: "here", width: 0.65 } },
      { id: "fig-new", kind: "bitmap", caption: "新しい図", placement: { position: "here" } },
    ]);
    expect(r.markdown).toBe(
      "![GitLab](/api/attachments.redirect?id=55036aff-0000-4000-8000-000000000000){w=65}\n\n![新しい図](postext-resource:fig-new)\n",
    );
    expect(r.images).toEqual([{ resourceId: "fig-new", placeholder: "postext-resource:fig-new" }]);
  });

  it("表をキャプションつきの GFM の表へ戻す", () => {
    const r = back('::resource{id="t1"}\n', [
      {
        id: "t1",
        kind: "table",
        caption: "結果",
        table: {
          model: {
            rows: [
              [{ content: "a", isHeader: true, align: "center" }, { content: "b", isHeader: true }],
              [{ content: "x|y", align: "center" }, { content: "1\n2" }],
            ],
          },
        },
      },
    ]);
    expect(r.markdown).toBe(["\\: 結果", "", "| a | b |", "| :---: | --- |", "| x\\|y | 1<br>2 |", ""].join("\n"));
  });

  it("改ページ・注記の囲みを戻し、Outline にない囲みは警告する", () => {
    const r = back([":::pagebreak", "", ':::callout{type="note" label="メモ"}', "本文", ":::", "", ':::callout{type="tip"}', "x", ":::"].join("\n"));
    expect(r.markdown).toBe(["//clearpage", "", ":::note メモ", "本文", ":::", "", ':::callout{type="tip"}', "x", ":::", ""].join("\n"));
    expect(r.warnings).toEqual(["Outline にない囲み（tip）は記法のまま戻しました"]);
  });

  it("書籍にないリソースは警告して記法のまま残す", () => {
    const r = back('::resource{id="gone"}\n');
    expect(r.markdown).toBe('::resource{id="gone"}\n');
    expect(r.warnings).toEqual(["書籍にないリソースを参照しています: gone"]);
  });
});
