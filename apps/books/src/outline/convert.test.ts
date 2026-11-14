import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { convertOutlineMarkdown } from "./convert";

const fixture = readFileSync(path.join(__dirname, "fixtures/git-basics.md"), "utf8");
const DOC = "56e8aa77-45cb-b3e8-ab7d";
const result = convertOutlineMarkdown(fixture, { docId: DOC });
const lines = result.markdown.split("\n");
const convert = (text: string) => convertOutlineMarkdown(text, { docId: DOC });

describe("git-basics の変換", () => {
  it("1. 先頭の yaml フェンスを消す", () => {
    expect(result.markdown.startsWith("## ローカルリポジトリを作る")).toBe(true);
    expect(result.markdown).not.toContain("outline_poc_id");
    expect(result.markdown).not.toContain("```yaml");
  });

  it("2. //clearpage は :::pagebreak になる", () => {
    expect(lines).toContain(":::pagebreak");
    expect(result.markdown).not.toContain("//clearpage");
  });

  it("3. note / syntax / step は callout になり、閉じの ::: はそのまま", () => {
    expect(lines).toContain(':::callout{type="step" label="作業手順"}');
    expect(lines).toContain(':::callout{type="syntax" label="ローカルリポジトリの初期化"}');
    expect(lines).toContain(':::callout{type="note" label=".gitフォルダについて"}');
    // callout の閉じ 3 つ + step-item 段落の閉じ 2 つ
    expect(lines.filter((l) => l === ":::")).toHaveLength(5);
  });

  it("4. 画像は単独の ::resource 行になり、alt と幅が集まる", () => {
    expect(result.images).toEqual([
      {
        attachmentId: "65feaeab-9dc6-4e19-ac4b-bcb721c5ca33",
        resourceId: "outline-img-65feaeab-9dc6-4e19-ac4b-bcb721c5ca33",
        alt: "git-testフォルダの作成",
      },
      {
        attachmentId: "16a272a4-3618-4fb6-826e-13236ae242b9",
        resourceId: "outline-img-16a272a4-3618-4fb6-826e-13236ae242b9",
        alt: "",
        widthPercent: 80,
      },
      {
        attachmentId: "0c359496-0938-44b5-b871-1c485a9cd259",
        resourceId: "outline-img-0c359496-0938-44b5-b871-1c485a9cd259",
        alt: ".gitフォルダの確認",
      },
    ]);
    for (const img of result.images) expect(lines).toContain(`::resource{id="${img.resourceId}"}`);
    expect(result.markdown).not.toContain("attachments.redirect");
    expect(result.markdown).not.toContain("{w=");
  });

  it("5. 表は ::resource 行になり、行とセルの inline Markdown を保つ", () => {
    expect(lines).toContain('::resource{id="outline-table-56e8aa77-1"}');
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]).toMatchObject({
      id: "outline-table-56e8aa77-1",
      header: ["項目", "内容"],
      rows: [
        ["Graph", "コミットの履歴をグラフで表示"],
        ["`Commit`", "**コミット**のハッシュ値"],
      ],
    });
    expect(result.markdown).not.toContain("|---");
  });

  it("6. フェンス直前の *題* は title になり、題の行は消える", () => {
    expect(lines).toContain('```bash {title="コマンド実行"}');
    expect(lines).toContain('```html {title="index.html（25行目あたり）" highlight="3"}');
    expect(result.markdown).not.toContain("*コマンド実行*");
    // 題のないフェンスはそのまま
    expect(lines).toContain("```");
  });

  it("7. //addstart〜//addend は highlight、//delstart/delend は行を残して警告", () => {
    const start = lines.findIndex((l) => l.startsWith("```html"));
    const end = lines.indexOf("```", start + 1);
    expect(lines.slice(start + 1, end)).toEqual([
      '  <div class="content">',
      '    <h1 class="hedding01">当ホテルからのご案内</h1>',
      '    <h1 class="heading01">当ホテルからのご案内</h1>',
      "    <p>インターネットで予約すると、特別料金でご宿泊いただけます。</p>",
      "  </div>",
    ]);
    expect(result.markdown).not.toMatch(/\/\/(add|del)(start|end)/);
    expect(result.warnings.some((w) => w.includes("//delstart"))).toBe(true);
  });

  it("8. 続きを持つ番号付き項目は1項目ずつの番号付きリストになり、続きは項目の外へ出る", () => {
    // :::step の中なので番号付きリストではなく、丸数字の step-item 段落になる
    const i1 = lines.indexOf("① フォルダの作成") + 1;
    const i2 = lines.indexOf("② Gitリポジトリを作成") + 1;
    expect(lines[i1 - 2]).toBe(':::paragraphs{style="step-item"}');
    expect(lines[i1]).toBe(":::");
    expect(i1).toBeGreaterThan(-1);
    expect(i2).toBeGreaterThan(i1);
    // 項目の後ろに続きが字下げなしで並ぶ
    expect(lines[i1 + 1]).toBe("");
    expect(lines[i1 + 2]).toBe("まずは任意の場所（デスクトップなど）に「git-text」という名前のフォルダを作成します。");
    expect(lines.some((l) => /^ {2,}\S/.test(l) && !l.startsWith("  <") && !l.startsWith("    ") && !l.startsWith("  *"))).toBe(false);
    // 続きのない最初の一覧は1つのリストのまま
    expect(lines.indexOf("2. Gitローカルリポジトリ作成コマンド（`git init`）実行")).toBe(
      lines.indexOf("1. フォルダを作成") + 1,
    );
    // 項目の続きの中のコードブロックにも題が付く
    expect(lines.indexOf('```bash {title="コマンド実行"}')).toBeGreaterThan(i2);
  });

  it("8. 箇条書きの入れ子は Postext の入れ子のまま残る", () => {
    expect(lines).toContain("* テキストファイルでなく、バイナリファイルの場合は管理しない方が都合がいい場合がある");
    expect(lines).toContain("  * Javaの.classファイルなど");
  });

  it("9. {{ toch3 }} は消えて警告になる", () => {
    expect(result.markdown).not.toContain("{{");
    expect(result.warnings).toContain("Outlineの差し込み記法 {{ toch3 }} は取り込めないため削除しました");
  });

  it("出力は連続する空行を含まず、改行で終わる", () => {
    expect(result.markdown.endsWith("\n")).toBe(true);
    expect(result.markdown).not.toMatch(/\n\n\n/);
  });
});

describe("個別の規則", () => {
  it("番号は元の番号から始まる（3 から始まる項目は 3 のまま）", () => {
    const r = convert("3. 三番目\n\n   説明文\n\n4. 四番目\n   * 子項目\n");
    expect(r.markdown).toBe("3. 三番目\n\n説明文\n\n4. 四番目\n   * 子項目\n");
  });

  it("title に二重引用符があれば一重引用符で囲み、両方あれば印刷用の引用符にする", () => {
    expect(convert(':::note He said "hi"\nx\n:::\n').markdown).toContain(`label='He said "hi"'`);
    expect(convert(`:::note a "b" 'c'\nx\n:::\n`).markdown).toContain(`label="a ”b” 'c'"`);
  });

  it(":::caution も callout になる（Git基礎研修の「チーム開発でのGitの運用」が使う）", () => {
    expect(convert(":::caution 注意点\nx\n:::\n").markdown).toContain(':::callout{type="caution" label="注意点"}');
  });

  it("title なしの :::step は label=\"作業手順\" を付け、題があればその題を使う", () => {
    expect(convert(":::step\nx\n:::\n").markdown).toBe(':::callout{type="step" label="作業手順"}\nx\n\n:::\n');
    expect(convert(":::step 準備\nx\n:::\n").markdown).toContain(':::callout{type="step" label="準備"}');
  });

  it(":::step の番号付き項目は丸数字の step-item 段落になり、続きの本文は項目の外へ出る", () => {
    const md = convert(":::step\n\n1. フォルダの作成\n\n   本文です。\n\n2. 次の手順\n:::\n\n1. 通常の項目\n2. もう一つ\n").markdown;
    expect(md).toContain(':::paragraphs{style="step-item"}\n① フォルダの作成\n:::');
    expect(md).toContain(':::paragraphs{style="step-item"}\n② 次の手順\n:::');
    expect(md).toContain("\n本文です。\n");
    expect(md).not.toMatch(/^1\. フォルダの作成/m);
    // 囲みの外の番号付きリストはそのまま
    expect(md).toContain("1. 通常の項目\n2. もう一つ");
  });

  it("21 番目以降の手順項目は (21) になる", () => {
    const items = Array.from({ length: 21 }, (_, k) => `${k + 1}. s${k + 1}\n`).join("");
    const md = convert(`:::step\n${items}:::\n`).markdown;
    expect(md).toContain("⑳ s20");
    expect(md).toContain("(21) s21");
  });

  it("callout の題は title ではなく label 属性になる（note / syntax / caution、波括弧は全角にする）", () => {
    for (const kind of ["note", "syntax", "caution"]) {
      const md = convert(`:::${kind} 題 {x}\nx\n:::\n`).markdown;
      expect(md).toContain(`:::callout{type="${kind}" label="題 ｛x｝"}`);
      expect(md).not.toContain("title=");
    }
  });

  it("未対応の ::: ブロックはテキストのまま残して警告する", () => {
    const r = convert(":::warning 注意\nx\n:::\n");
    expect(r.markdown).toContain(":::warning 注意");
    expect(r.warnings.some((w) => w.includes(":::warning"))).toBe(true);
  });

  it("フェンス内の ::: や画像記法は変換しない", () => {
    const r = convert("```md\n:::note x\n![a](/api/attachments.redirect?id=zzz)\n```\n");
    expect(r.markdown).toBe("```md\n:::note x\n![a](/api/attachments.redirect?id=zzz)\n```\n");
    expect(r.images).toEqual([]);
  });

  it("言語のないフェンスに題や highlight が付くときは text を補う", () => {
    const r = convert("*題*\n\n```\na\n//addstart\nb\nc\n//addend\n```\n");
    expect(r.markdown).toBe('```text {title="題" highlight="2-3"}\na\nb\nc\n```\n');
  });

  it("*強調* の行はフェンスが続かなければ段落のまま", () => {
    expect(convert("*強調*\n\n本文\n").markdown).toBe("*強調*\n\n本文\n");
  });

  it("同じ画像が別の幅で使われたら別のリソースにする", () => {
    const a = "![x](/api/attachments.redirect?id=abc)";
    const r = convert(`${a}\n\n${a}{w=50}\n\n${a}{w=50}\n`);
    expect(r.images.map((i) => [i.resourceId, i.widthPercent])).toEqual([
      ["outline-img-abc", undefined],
      ["outline-img-abc-2", 50],
    ]);
  });

  it("{w=100} は幅の指定なしとして扱う", () => {
    expect(convert("![x](/api/attachments.redirect?id=abc){w=100}\n").images[0]).not.toHaveProperty("widthPercent");
  });

  it("表の配置・パイプのエスケープ・セルの不足を扱う", () => {
    const r = convert("| a | b | c |\n|:--|:-:|--:|\n| 1 \\| 2 | x |\n");
    expect(r.tables[0]!.align).toEqual(["left", "center", "right"]);
    expect(r.tables[0]!.rows).toEqual([["1 | 2", "x", ""]]);
  });

  it("表の直前の \\: キャプション（Outline の書き出し）を表のキャプションにし、本文から消す", () => {
    const r = convert("説明です。\n\n\\: マージ結果の種類\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(r.tables[0]!.caption).toBe("マージ結果の種類");
    expect(r.markdown).toBe(`説明です。\n\n::resource{id="outline-table-${DOC.slice(0, 8)}-1"}\n`);
  });

  it("表の直後の : キャプションも表のキャプションにする", () => {
    const r = convert("| a | b |\n|---|---|\n| 1 | 2 |\n\n: 前提となる環境\n\n次の段落。\n");
    expect(r.tables[0]!.caption).toBe("前提となる環境");
    expect(r.markdown).not.toContain("前提となる環境");
    expect(r.markdown).toContain("次の段落。");
  });

  it("キャプションのない表は caption を持たない", () => {
    expect(convert("| a |\n|---|\n| 1 |\n").tables[0]!.caption).toBeUndefined();
  });

  it("箇条書き項目の続きも項目の外へ出し、警告する", () => {
    const r = convert("* 項目\n\n  ![x](/api/attachments.redirect?id=abc)\n");
    expect(r.markdown).toBe('* 項目\n\n::resource{id="outline-img-abc"}\n');
    expect(r.warnings).toHaveLength(1);
  });

  it("CRLF でも同じ結果になる", () => {
    expect(convert(fixture.replace(/\n/g, "\r\n")).markdown).toBe(result.markdown);
  });
});
