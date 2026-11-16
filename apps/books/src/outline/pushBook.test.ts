import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BookRepository, BookWithAssetData } from "@/books/model";
import { sha256Hex } from "@/books/model";
import { createPgRepository } from "@/books/repository";
import { createBook, saveBook } from "@/books/usecases";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { FsBlobStore } from "@/storage/blobStore";
import type { CreatedAttachment, NewAttachment, OutlineDocument } from "./client";
import { OutlineHttpError } from "./client";
import { applyImport, previewImport } from "./importBook";
import { readProvenance } from "./provenance";
import { applyPush, compactDiff, previewPush } from "./pushBook";

const url = process.env.TEST_DATABASE_URL ?? "postgres://books:books-local-only@127.0.0.1:55439/books";

let pool: Pool;
let repo: BookRepository;

beforeAll(async () => {
  pool = new Pool({ connectionString: url });
  const db: Db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.join(__dirname, "../../drizzle") });
  repo = createPgRepository(db, new FsBlobStore(mkdtempSync(path.join(tmpdir(), "books-push-"))));
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
const T2 = "2026-03-01T00:00:00.000Z";
const IMG = "11111111-2222-4333-8444-555555555555";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

/** 取り込みと書き戻しの両方に答える Outline の代わり。文書の本文と更新時刻を持つ。 */
class FakeOutline {
  updates: { id: string; text: string }[] = [];
  attachments: NewAttachment[] = [];
  clock = T1;
  constructor(public docs: OutlineDocument[]) {}
  async listChildDocuments(parentId: string) {
    return parentId === PARENT ? this.docs.map((d) => ({ ...d })) : [];
  }
  async fetchAttachment() {
    return { bytes: png(400, 300), contentType: "image/png" };
  }
  async getDocument(id: string) {
    const d = this.docs.find((x) => x.id === id);
    if (!d) throw new OutlineHttpError(404, "documents.info");
    return { ...d };
  }
  async updateDocument(id: string, text: string) {
    const d = this.docs.find((x) => x.id === id)!;
    d.text = text;
    d.updatedAt = this.clock;
    this.updates.push({ id, text });
    return { ...d };
  }
  async createAttachment(input: NewAttachment): Promise<CreatedAttachment> {
    this.attachments.push(input);
    const id = `99999999-0000-4000-8000-00000000000${this.attachments.length}`;
    return { id, url: `/api/attachments.redirect?id=${id}` };
  }
}

const docs = () => [
  { id: A, title: "最初の章", text: `本文A\n\n![図](/api/attachments.redirect?id=${IMG} "source=diagrams.net"){w=80}\n\n*hello.c*\n\n\`\`\`c\nint a;\n//addstart\nint b;\n//addend\n\`\`\`\n`, updatedAt: T0 },
  { id: B, title: "次の章", text: "本文B\n", updatedAt: T0 },
];

/** Outline の2文書を取り込んだ本と、その Outline。 */
async function imported() {
  const outline = new FakeOutline(docs());
  const book = await createBook(repo, { title: "反映試験", config: {}, resources: [], chapters: [], locale: "ja" });
  const preview = await previewImport(repo, book.id, PARENT, outline);
  if (!preview.ok) throw new Error("preview");
  const applied = await applyImport(repo, book.id, { baseRevision: preview.revision, parentId: PARENT, documentIds: [A, B] }, outline);
  if (!applied.ok) throw new Error("import");
  return { id: book.id, outline };
}

const read = async (id: string): Promise<BookWithAssetData> => (await repo.getWithAssetData(id))!;

/** 章の本文を書き換えて保存する（Postext での編集の代わり）。 */
async function edit(id: string, index: number, change: (md: string) => string, extra: Partial<BookWithAssetData> = {}) {
  const book = await read(id);
  const chapters = book.chapters.map((c, i) => (i === index ? { ...c, markdown: change(c.markdown) } : c));
  const saved = await saveBook(repo, id, book.revision, { title: book.title, config: book.config, resources: book.resources, chapters, locale: "ja", ...extra });
  if (!saved.ok) throw new Error("save");
  return saved.revision;
}

describe("Outlineへ反映", () => {
  it("Postextで編集した章だけが反映の対象になり、差分は変わった行の前後だけ", async () => {
    const { id, outline } = await imported();
    await edit(id, 0, (md) => md.replace("本文A", "本文A（Postextで直した）"));
    const preview = await previewPush(repo, id, outline);
    if (!preview.ok) throw new Error("preview");
    expect(preview.chapters.map((c) => [c.title, c.status])).toEqual([
      ["最初の章", "bookEdited"],
      ["次の章", "unchanged"],
    ]);
    const first = preview.chapters[0]!;
    expect(first.diff.filter((d) => d.type !== "same").map((d) => `${d.type}:${d.text}`)).toEqual(["del:本文A", "add:本文A（Postextで直した）"]);
    expect(preview.chapters[1]!.diff).toEqual([]);
  });

  it("反映すると Outline の本文が変わり、画像の幅と draw.io の印・行注釈は残り、次の確認と取り込みでは「変更なし」", async () => {
    const { id, outline } = await imported();
    const base = await edit(id, 0, (md) => md.replace("本文A", "本文A（直した）"));
    const result = await applyPush(repo, id, { baseRevision: base, documentIds: [A] }, outline);
    expect(result).toMatchObject({ ok: true, pushed: 1, warnings: [] });
    expect(outline.updates).toHaveLength(1);
    const text = outline.docs[0]!.text;
    expect(text).toContain("本文A（直した）");
    expect(text).toContain(`![図](/api/attachments.redirect?id=${IMG} "source=diagrams.net"){w=80}`);
    expect(text).toContain("//addstart\nint b;\n//addend");
    expect(text).toContain("*hello.c*");

    const after = await previewPush(repo, id, outline);
    expect(after.ok && after.chapters.map((c) => c.status)).toEqual(["unchanged", "unchanged"]);
    const back = await previewImport(repo, id, PARENT, outline);
    expect(back.ok && back.chapters.map((c) => c.status)).toEqual(["unchanged", "unchanged"]);
    // 記録の更新時刻は、Outline が返した更新後の時刻。
    expect(readProvenance((await read(id)).chapters[0]!.markdown)?.updatedAt).toBe(T1);
  });

  it("両方で変更された章は、Postextの内容で上書きする", async () => {
    const { id, outline } = await imported();
    const base = await edit(id, 1, (md) => md.replace("本文B", "Postextの本文B"));
    outline.docs[1]!.text = "Outlineで直した本文B\n";
    outline.docs[1]!.updatedAt = T1;
    outline.clock = T2;
    const preview = await previewPush(repo, id, outline);
    expect(preview.ok && preview.chapters[1]!.status).toBe("both");
    const result = await applyPush(repo, id, { baseRevision: base, documentIds: [B] }, outline);
    expect(result).toMatchObject({ ok: true, pushed: 1 });
    expect(outline.docs[1]!.text).toBe("Postextの本文B\n");
  });

  it("Outline側だけ更新された章は反映せず、警告にする", async () => {
    const { id, outline } = await imported();
    outline.docs[1]!.text = "Outlineだけ直した\n";
    outline.docs[1]!.updatedAt = T1;
    const book = await read(id);
    const result = await applyPush(repo, id, { baseRevision: book.revision, documentIds: [B] }, outline);
    expect(result).toMatchObject({ ok: true, pushed: 0, revision: book.revision });
    expect(result.ok && result.warnings[0]).toContain("outlineUpdated");
    expect(outline.updates).toEqual([]);
    expect(outline.docs[1]!.text).toBe("Outlineだけ直した\n");
  });

  it("Postextで足した画像は Outline へ添付し、本文の参照と書籍のリソース ID をその添付に付け替える", async () => {
    const { id, outline } = await imported();
    const book = await read(id);
    const bytes = Buffer.from(png(20, 10));
    const resource = { id: "fig-new", typeId: "figure", kind: "bitmap", caption: "新しい図", createdAt: 0, updatedAt: 0, bitmap: { fileId: "resources/fig-new.png", format: "png", width: 20, height: 10 }, placement: { position: "here", width: 0.5 } };
    const base = await edit(id, 1, (md) => `${md}\n::resource{id="fig-new"}\n`, {
      resources: [...book.resources, resource],
      assets: [...book.assets, { kind: "resource", path: "resources/fig-new.png", mime: "image/png", bytes, sha256: sha256Hex(bytes), size: bytes.length }],
    } as Partial<BookWithAssetData>);
    const preview = await previewPush(repo, id, outline);
    expect(preview.ok && preview.chapters[1]!.newImages).toBe(1);
    const result = await applyPush(repo, id, { baseRevision: base, documentIds: [B] }, outline);
    expect(result).toMatchObject({ ok: true, pushed: 1 });
    expect(outline.attachments).toHaveLength(1);
    expect(outline.attachments[0]).toMatchObject({ documentId: B, name: "fig-new.png", contentType: "image/png" });
    const attId = "99999999-0000-4000-8000-000000000001";
    expect(outline.docs[1]!.text).toContain(`![新しい図](/api/attachments.redirect?id=${attId}){w=50}`);
    const saved = await read(id);
    expect(saved.resources.some((r) => r.id === `outline-img-${attId}`)).toBe(true);
    expect(saved.resources.some((r) => r.id === "fig-new")).toBe(false);
    expect(saved.chapters[1]!.markdown).toContain(`::resource{id="outline-img-${attId}"}`);
    // もう一度確かめても、同じ画像を添付し直さない。
    const again = await previewPush(repo, id, outline);
    expect(again.ok && again.chapters[1]).toMatchObject({ status: "unchanged", newImages: 0 });
  });

  it("書籍が先に保存されていたら、Outline を書き換える前に衝突として止める", async () => {
    const { id, outline } = await imported();
    const base = await edit(id, 0, (md) => md.replace("本文A", "x"));
    const result = await applyPush(repo, id, { baseRevision: base - 1, documentIds: [A] }, outline);
    expect(result).toEqual({ ok: false, reason: "conflict", revision: base });
    expect(outline.updates).toEqual([]);
  });

  it("書籍の章の取り込み元でない文書は受け付けない", async () => {
    const { id, outline } = await imported();
    const book = await read(id);
    const result = await applyPush(repo, id, { baseRevision: book.revision, documentIds: ["other"] }, outline);
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("Outlineで消された文書は「Outlineにない」で、反映できない", async () => {
    const { id, outline } = await imported();
    outline.docs = outline.docs.filter((d) => d.id !== B);
    const preview = await previewPush(repo, id, outline);
    expect(preview.ok && preview.chapters[1]!.status).toBe("missingInOutline");
  });
});

describe("compactDiff", () => {
  it("変わった行の前後3行だけを残し、間を「…」にする。変化がなければ空", () => {
    const same = (t: string) => ({ type: "same" as const, text: t });
    const lines = [...Array.from({ length: 10 }, (_, i) => same(`a${i}`)), { type: "add" as const, text: "new" }, ...Array.from({ length: 10 }, (_, i) => same(`b${i}`))];
    expect(compactDiff(lines).map((d) => d.text)).toEqual(["…", "a7", "a8", "a9", "new", "b0", "b1", "b2", "…"]);
    expect(compactDiff([same("x")])).toEqual([]);
  });
});
