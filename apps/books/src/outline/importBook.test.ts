import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { extractFrontmatter } from "postext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromBundle, toBundle } from "@/books/bundle";
import type { BookRepository, BookWrite } from "@/books/model";
import { createPgRepository } from "@/books/repository";
import { createBook, getBook, saveBook } from "@/books/usecases";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import type { OutlineDocument } from "./client";
import { applyImport, previewImport } from "./importBook";
import type { OutlineSource } from "./importBook";
import { readProvenance } from "./provenance";

const url =
  process.env.TEST_DATABASE_URL ?? "postgres://books:books-local-only@127.0.0.1:55439/books";

let pool: Pool;
let repo: BookRepository;

beforeAll(async () => {
  pool = new Pool({ connectionString: url });
  const db: Db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.join(__dirname, "../../drizzle") });
  repo = createPgRepository(db);
});

afterAll(async () => {
  await pool.end();
});

const png = (width: number, height: number): Uint8Array => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
};

const PARENT = "parent-doc";
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-02-01T00:00:00.000Z";

class FakeOutline implements OutlineSource {
  fetched: string[] = [];
  constructor(public docs: OutlineDocument[]) {}
  async listChildDocuments(parentId: string) {
    return parentId === PARENT ? this.docs.map((d) => ({ ...d })) : [];
  }
  async fetchAttachment(id: string) {
    this.fetched.push(id);
    return { bytes: png(400, 300), contentType: "image/png" };
  }
}

const doc = (id: string, title: string, text: string, updatedAt = T0): OutlineDocument => ({ id, title, text, updatedAt });

const docA = (extra = "") =>
  doc(
    "aaaaaaaa-0000-4000-8000-000000000001",
    "最初の章",
    `本文A\n\n![図](/api/attachments.redirect?id=img-1){w=80}\n\n| 項目 | 内容 |\n|---|---|\n| a | b |\n${extra}`,
  );
const docB = (text = "本文B\n", updatedAt = T0) => doc("bbbbbbbb-0000-4000-8000-000000000002", "次の章", text, updatedAt);

const draft = (): BookWrite => ({
  title: "取り込み試験",
  config: { page: { size: "A5" } },
  resources: [{ id: "keep-me", typeId: "figure", kind: "bitmap", createdAt: 0, updatedAt: 0 }],
  chapters: [
    { title: "はじめに", locale: "ja", markdown: "# はじめに\n\n手書き\n" },
    { title: "Chapter", locale: "en", markdown: "# Chapter\n" },
  ],
  locale: "ja",
  editions: [{ locale: "en", name: "English", config: {}, resources: [] }],
});

const load = async (id: string) => {
  const got = await getBook(repo, id);
  if (!got.ok) throw new Error("not found");
  return got.book;
};

describe("Outline の取り込み", () => {
  it("初回は新規として2章を取り込み、画像と表が資源になる", async () => {
    const book = await createBook(repo, draft());
    const outline = new FakeOutline([docA(), docB()]);

    const preview = await previewImport(repo, book.id, PARENT, outline);
    expect(preview.ok && preview.chapters.map((c) => [c.title, c.status])).toEqual([
      ["最初の章", "new"],
      ["次の章", "new"],
    ]);
    // 確認だけでは何も保存しない
    expect((await load(book.id)).revision).toBe(0);

    const applied = await applyImport(repo, book.id, { baseRevision: 0, parentId: PARENT, documentIds: [docA().id, docB().id] }, outline);
    expect(applied).toMatchObject({ ok: true, revision: 1 });

    const after = await load(book.id);
    expect(after.chapters.map((c) => [c.locale, c.title])).toEqual([
      ["ja", "はじめに"],
      ["ja", "最初の章"],
      ["ja", "次の章"],
      ["en", "Chapter"],
    ]);
    const first = after.chapters[1]!;
    expect(readProvenance(first.markdown)).toMatchObject({ id: docA().id, updatedAt: T0 });
    expect(first.markdown).toContain('::resource{id="outline-img-img-1"}');
    expect(first.markdown).toContain('::resource{id="outline-table-aaaaaaaa-1"}');
    expect(after.chapters[0]!.markdown).toBe("# はじめに\n\n手書き\n");

    expect(after.resources.map((r) => r.id)).toEqual(["keep-me", "outline-img-img-1", "outline-table-aaaaaaaa-1"]);
    const image = after.resources[1] as Record<string, any>;
    expect(image.bitmap).toEqual({ fileId: "outline/img-1.png", format: "png", width: 400, height: 300 });
    expect(image.placement).toEqual({ position: "here", width: 0.8 });
    expect(after.assets.map((a) => a.path)).toEqual(["outline/img-1.png"]);

    // 他の設定は変わらない
    expect(after.config).toEqual({ page: { size: "A5" } });
    expect(after.locale).toBe("ja");
    expect(after.editions?.map((e) => e.locale)).toEqual(["en"]);
  });

  it("書籍側を編集し、Outline 側の別の章を更新すると、状態が分かれる", async () => {
    const book = await createBook(repo, draft());
    const outline = new FakeOutline([docA(), docB()]);
    await applyImport(repo, book.id, { baseRevision: 0, parentId: PARENT, documentIds: [docA().id, docB().id] }, outline);

    const current = await load(book.id);
    // 最初の章（docA）の本文を書籍側で編集する。frontmatter はそのまま。
    const chapters = current.chapters.map((c) =>
      c.title === "最初の章" ? { ...c, markdown: `${c.markdown}書籍側の追記\n` } : c,
    );
    const saved = await saveBook(repo, book.id, current.revision, { ...current, chapters, assets: undefined });
    expect(saved).toEqual({ ok: true, revision: 2 });

    outline.docs = [docA(), docB("本文B 更新\n", T1)];
    const preview = await previewImport(repo, book.id, PARENT, outline);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.revision).toBe(2);
    expect(preview.chapters.map((c) => [c.title, c.status])).toEqual([
      ["最初の章", "bookEdited"],
      ["次の章", "outlineUpdated"],
    ]);
    const diff = preview.chapters[1]!.diff;
    expect(diff).toContainEqual({ type: "del", text: "本文B" });
    expect(diff).toContainEqual({ type: "add", text: "本文B 更新" });

    // 書籍側だけ編集した章は適用対象外（選んでもスキップ）。
    const applied = await applyImport(
      repo,
      book.id,
      { baseRevision: 2, parentId: PARENT, documentIds: [docA().id, docB().id] },
      outline,
    );
    expect(applied.ok && applied.warnings.some((w) => w.includes("取り込み対象外"))).toBe(true);
    const after = await load(book.id);
    expect(after.revision).toBe(3);
    expect(after.chapters.find((c) => c.title === "最初の章")!.markdown).toContain("書籍側の追記");
    const second = after.chapters.find((c) => c.title === "次の章")!;
    expect(second.markdown).toContain("本文B 更新");
    expect(readProvenance(second.markdown)?.updatedAt).toBe(T1);

    // 取り込み後は変更なし
    const again = await previewImport(repo, book.id, PARENT, outline);
    expect(again.ok && again.chapters.map((c) => c.status)).toEqual(["bookEdited", "unchanged"]);
  });

  it("両方で変更した章は選ぶと Outline 側で置き換わり、手で足した frontmatter のキーは残る", async () => {
    const book = await createBook(repo, draft());
    const outline = new FakeOutline([docB()]);
    await applyImport(repo, book.id, { baseRevision: 0, parentId: PARENT, documentIds: [docB().id] }, outline);
    const current = await load(book.id);
    const chapters = current.chapters.map((c) =>
      c.title === "次の章"
        ? { ...c, markdown: c.markdown.replace("---\noutline:", "---\nchapterStyle: appendix\noutline:") + "追記\n" }
        : c,
    );
    await saveBook(repo, book.id, current.revision, { ...current, chapters, assets: undefined });

    outline.docs = [docB("本文B 新\n", T1)];
    const preview = await previewImport(repo, book.id, PARENT, outline);
    expect(preview.ok && preview.chapters[0]!.status).toBe("both");

    const applied = await applyImport(repo, book.id, { baseRevision: 2, parentId: PARENT, documentIds: [docB().id] }, outline);
    expect(applied.ok).toBe(true);
    const replaced = (await load(book.id)).chapters.find((c) => c.title === "次の章")!;
    expect(replaced.markdown).toContain("本文B 新");
    expect(replaced.markdown).not.toContain("追記");
    expect(replaced.markdown).toContain("chapterStyle: appendix");
    expect(readProvenance(replaced.markdown)?.updatedAt).toBe(T1);
  });

  it("frontmatter は .postext の往復と Postext の読み取りを生き残る", async () => {
    const book = await createBook(repo, draft());
    const outline = new FakeOutline([docA(), docB()]);
    await applyImport(repo, book.id, { baseRevision: 0, parentId: PARENT, documentIds: [docA().id, docB().id] }, outline);
    const withData = await repo.getWithAssetData(book.id);
    const roundTripped = await fromBundle(await toBundle(withData!));
    const chapter = roundTripped.chapters.find((c) => c.title === "次の章")!;
    expect(readProvenance(chapter.markdown)).toMatchObject({ id: docB().id, updatedAt: T0 });
    const parsed = extractFrontmatter(chapter.markdown);
    expect((parsed.metadata as Record<string, any>).outline).toMatchObject({ id: docB().id });
    expect(roundTripped.chapters.map((c) => c.markdown)).toEqual(withData!.chapters.map((c) => c.markdown));
    // .postext は資産のパスを resources/<資源ID>.<拡張子> に付け替え、資源の fileId も合わせる。
    const rtImage = roundTripped.resources.find((r) => r.id === "outline-img-img-1") as Record<string, any>;
    expect(roundTripped.assets.map((a) => a.path)).toContain(rtImage.bitmap.fileId);
    expect(roundTripped.assets).toHaveLength(1);
    expect(roundTripped.assets[0]!.bytes.equals(withData!.assets[0]!.bytes)).toBe(true);
  });

  it("画像は取り込みのたびに取得し直し、同じパスの資産は置き換わる", async () => {
    const book = await createBook(repo, draft());
    const outline = new FakeOutline([docA()]);
    await applyImport(repo, book.id, { baseRevision: 0, parentId: PARENT, documentIds: [docA().id] }, outline);
    outline.docs = [docA("追記\n")];
    outline.docs[0]!.updatedAt = T1;
    await applyImport(repo, book.id, { baseRevision: 1, parentId: PARENT, documentIds: [docA().id] }, outline);
    expect(outline.fetched).toEqual(["img-1", "img-1"]);
    const after = await load(book.id);
    expect(after.assets).toHaveLength(1);
    expect(after.resources.filter((r) => r.id === "outline-img-img-1")).toHaveLength(1);
    expect(after.chapters.filter((c) => c.title === "最初の章")).toHaveLength(1);
  });

  it("baseRevision が古ければ conflict で何も書き換えない", async () => {
    const book = await createBook(repo, draft());
    const outline = new FakeOutline([docB()]);
    await saveBook(repo, book.id, 0, { ...draft(), title: "別の場所で保存" });
    const result = await applyImport(repo, book.id, { baseRevision: 0, parentId: PARENT, documentIds: [docB().id] }, outline);
    expect(result).toEqual({ ok: false, reason: "conflict", revision: 1 });
    const after = await load(book.id);
    expect(after.revision).toBe(1);
    expect(after.chapters.some((c) => c.title === "次の章")).toBe(false);
  });

  it("親の子でない文書の指定と、存在しない書籍を拒否する", async () => {
    const book = await createBook(repo, draft());
    const outline = new FakeOutline([docB()]);
    const invalid = await applyImport(repo, book.id, { baseRevision: 0, parentId: PARENT, documentIds: ["zzz"] }, outline);
    expect(invalid).toMatchObject({ ok: false, reason: "invalid" });
    const missing = await applyImport(
      repo,
      "00000000-0000-4000-8000-000000000000",
      { baseRevision: 0, parentId: PARENT, documentIds: [] },
      outline,
    );
    expect(missing).toEqual({ ok: false, reason: "not_found" });
  });

  it("Outline にない章は missingInOutline と表示されるだけで、章は残る", async () => {
    const book = await createBook(repo, draft());
    const outline = new FakeOutline([docA(), docB()]);
    await applyImport(repo, book.id, { baseRevision: 0, parentId: PARENT, documentIds: [docA().id, docB().id] }, outline);
    outline.docs = [docB()];
    const preview = await previewImport(repo, book.id, PARENT, outline);
    expect(preview.ok && preview.chapters.map((c) => [c.title, c.status])).toEqual([
      ["次の章", "unchanged"],
      ["最初の章", "missingInOutline"],
    ]);
  });

  it("新しい章は Outline の並びに合わせて既存の取り込み済みの章の間へ入る", async () => {
    const book = await createBook(repo, draft());
    const docC = doc("cccccccc-0000-4000-8000-000000000003", "三番目", "C\n");
    const outline = new FakeOutline([docA(), docC]);
    await applyImport(repo, book.id, { baseRevision: 0, parentId: PARENT, documentIds: [docA().id, docC.id] }, outline);
    outline.docs = [docA(), docB(), docC];
    await applyImport(repo, book.id, { baseRevision: 1, parentId: PARENT, documentIds: [docB().id] }, outline);
    expect((await load(book.id)).chapters.map((c) => c.title)).toEqual(["はじめに", "最初の章", "次の章", "三番目", "Chapter"]);
  });
});
