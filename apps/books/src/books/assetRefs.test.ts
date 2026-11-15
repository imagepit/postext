import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { extractDesign } from "postext";
import type { PostextConfig } from "postext";
import { createBundle, createDesignBundle, openBundle, openBundleZip } from "postext/bundle";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import * as schema from "../db/schema";
import { FsBlobStore, sha256Of } from "../storage/blobStore";
import { createPgDesignRepository } from "../designs/repository";
import { toBundle } from "./bundle";
import { sha256Hex } from "./model";
import type { AssetData, BookRepository, BookWrite } from "./model";
import { createPgRepository } from "./repository";
import { createVersion, restoreVersion, saveBook } from "./usecases";

const url = process.env.TEST_DATABASE_URL ?? "postgres://books:books-local-only@127.0.0.1:55439/books";

let pool: Pool;
let db: Db;
let store: FsBlobStore;
let repo: BookRepository;

beforeAll(async () => {
  pool = new Pool({ connectionString: url });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.join(__dirname, "../../drizzle") });
  store = new FsBlobStore(mkdtempSync(path.join(tmpdir(), "books-refs-")));
  repo = createPgRepository(db, store);
});

afterAll(async () => {
  await pool.end();
});

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const asset = (p: string, bytes: Buffer, extra: Partial<AssetData> = {}): AssetData => ({
  kind: "resource",
  path: p,
  mime: "image/png",
  bytes,
  sha256: sha256Hex(bytes),
  size: bytes.length,
  ...extra,
});
const bitmap = (fileId: string) => ({
  id: "fig-1",
  typeId: "figure",
  kind: "bitmap",
  createdAt: 0,
  updatedAt: 0,
  bitmap: { fileId, format: "png", width: 1, height: 1 },
});
const draft = (extra: Partial<BookWrite> = {}): BookWrite => ({
  title: "参照の本",
  config: {},
  resources: [bitmap("outline/a.png")],
  chapters: [{ title: "章", locale: "ja", markdown: "# 章\n\n本文" }],
  ...extra,
});

describe("書籍の資産は R2 の参照になる", () => {
  it("保存した資産は DB に bytes を持たず、postext 参照で、読むと同じバイト列が返る", async () => {
    const book = await repo.create(draft({ assets: [asset("outline/a.png", png)] }));
    const [row] = await db.select().from(schema.assets).where(eq(schema.assets.bookId, book.id));
    expect(row).toMatchObject({
      bytes: null,
      storage: "postext",
      objectKey: `sha256/${sha256Of(png)}`,
      size: png.length,
      sha256: sha256Hex(png),
    });
    expect(book.assets).toEqual([{ kind: "resource", path: "outline/a.png", mime: "image/png", sha256: sha256Hex(png), size: png.length }]);
    const got = await repo.getWithAssetData(book.id);
    expect(got?.assets[0]?.bytes.equals(png)).toBe(true);
  });

  it("Outline の鍵つきの資産は outline 参照になり、バイト列は postext へ書かない", async () => {
    const book = await repo.create(draft({ assets: [asset("outline/a.png", png, { outlineKey: "uploads/u/a/a.png" })] }));
    const [row] = await db.select().from(schema.assets).where(eq(schema.assets.bookId, book.id));
    expect(row).toMatchObject({ storage: "outline", objectKey: "uploads/u/a/a.png", bytes: null });
    await expect(store.putPostext(png, "image/png")).resolves.toBeTruthy();
    // outline 側のオブジェクトを用意すれば読める。
    await store.putOutline("uploads/u/a/a.png", png);
    expect((await repo.getWithAssetData(book.id))?.assets[0]?.bytes.equals(png)).toBe(true);
  });

  it("同じ内容で書き戻す保存（PUT bundle 相当）は outline 参照を保ち、変わった内容は postext へ", async () => {
    const book = await repo.create(draft({ assets: [asset("outline/a.png", png, { outlineKey: "uploads/u/b/a.png" })] }));
    await store.putOutline("uploads/u/b/a.png", png);
    // bytes だけの資産（ref なし）。path と sha256 が同じなので既存の参照を使う。
    expect(await saveBook(repo, book.id, 0, draft({ assets: [asset("outline/a.png", png)] }))).toEqual({ ok: true, revision: 1 });
    let [row] = await db.select().from(schema.assets).where(eq(schema.assets.bookId, book.id));
    expect(row).toMatchObject({ storage: "outline", objectKey: "uploads/u/b/a.png" });
    const changed = Buffer.concat([png, Buffer.from([0])]);
    await saveBook(repo, book.id, 1, draft({ assets: [asset("outline/a.png", changed)] }));
    [row] = await db.select().from(schema.assets).where(eq(schema.assets.bookId, book.id));
    expect(row).toMatchObject({ storage: "postext", objectKey: `sha256/${sha256Of(changed)}`, size: changed.length });
  });

  it("読み出した資産をそのまま書き戻すと参照が保たれる（Outline 取り込みの経路）", async () => {
    const book = await repo.create(draft({ assets: [asset("outline/a.png", png, { outlineKey: "uploads/u/c/a.png" })] }));
    await store.putOutline("uploads/u/c/a.png", png);
    const read = await repo.getWithAssetData(book.id);
    await saveBook(repo, book.id, 0, { ...draft(), assets: read!.assets });
    const [row] = await db.select().from(schema.assets).where(eq(schema.assets.bookId, book.id));
    expect(row).toMatchObject({ storage: "outline", objectKey: "uploads/u/c/a.png" });
  });
});

describe("版は資産を参照にして保存し、取り出すと自己完結した .postext に戻る", () => {
  it("bundle には画像が入らず、book_version_assets が参照を持ち、取得すると画像つき", async () => {
    const book = await repo.create(draft({ assets: [asset("resources/fig.png", png)], resources: [bitmap("resources/fig.png")] }));
    const created = await createVersion(repo, book.id, "v1");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const [version] = await db.select().from(schema.bookVersions).where(eq(schema.bookVersions.id, created.version.id));
    const full = await toBundle((await repo.getWithAssetData(book.id))!);
    expect(version!.bundle.length).toBeLessThan(full.length);
    const rows = await db.select().from(schema.bookVersionAssets).where(eq(schema.bookVersionAssets.versionId, created.version.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ path: "resources/fig-1.png", storage: "postext", sha256: sha256Hex(png), size: png.length, kind: "resource" });

    const bytes = await repo.getVersionBundle(book.id, created.version.id);
    const opened = await openBundle(new Uint8Array(bytes!));
    expect(Buffer.from(opened.files.get("resources/fig-1.png")!).equals(png)).toBe(true);

    // 復元すると書籍に画像が戻る。
    const restored = await restoreVersion(repo, book.id, created.version.id, 0);
    expect(restored).toEqual({ ok: true, revision: 1 });
    expect((await repo.getWithAssetData(book.id))?.assets[0]?.bytes.equals(png)).toBe(true);
  });

  it("書籍の資産が outline 参照なら、版のファイルも同じ参照を使う", async () => {
    const book = await repo.create(draft({ assets: [asset("resources/fig.png", png, { outlineKey: "uploads/u/d/fig.png" })], resources: [bitmap("resources/fig.png")] }));
    await store.putOutline("uploads/u/d/fig.png", png);
    const created = await createVersion(repo, book.id, "");
    if (!created.ok) throw new Error("version");
    const rows = await db.select().from(schema.bookVersionAssets).where(eq(schema.bookVersionAssets.versionId, created.version.id));
    expect(rows[0]).toMatchObject({ storage: "outline", objectKey: "uploads/u/d/fig.png" });
  });

  it("参照を持たない従来の版（ファイルを含んだ bundle）はそのまま返す", async () => {
    const book = await repo.create(draft());
    const legacy = Buffer.from(
      (await createBundle({ name: "旧", chapters: [{ markdown: "# 旧" }], resources: [bitmap("a.png")] as never, files: new Map([["a.png", new Uint8Array(png)]]) })).bytes,
    );
    const [v] = await db.insert(schema.bookVersions).values({ bookId: book.id, number: 1, revision: 0, bundle: legacy }).returning();
    const got = await repo.getVersionBundle(book.id, v!.id);
    expect(got?.equals(legacy)).toBe(true);
  });
});

describe("デザイン", () => {
  const fontBytes = new Uint8Array(Array.from({ length: 3000 }, (_, i) => (i * 13) % 256));

  async function designBundle() {
    return Buffer.from(
      (
        await createDesignBundle({
          name: "字体",
          design: extractDesign(
            {
              bodyText: { fontFamily: "Lora" },
              customFonts: [{ name: "Lora", variants: [{ weight: 400, style: "normal", fileId: "f1", format: "woff2" }] }],
            } as PostextConfig,
            ["text"],
          ),
          files: { f1: fontBytes },
        })
      ).bytes,
    );
  }

  it("フォントを除いた bundle を designs.bytes に、フォントは design_assets の参照に持ち、get は元の内容に戻す", async () => {
    const designs = createPgDesignRepository(db, store);
    const id = `design-refs-${Date.now().toString(36)}`;
    const bytes = await designBundle();
    await designs.upsert({ id, name: "d", parts: ["text"], createdAt: 1, updatedAt: 2, bytes });
    const [row] = await db.select().from(schema.designs).where(eq(schema.designs.id, id));
    expect(row!.bytes.length).toBeLessThan(bytes.length);
    const fontPath = [...openBundleZip(new Uint8Array(bytes)).files.keys()].find((k) => k.startsWith("fonts/"))!;
    const files = await db.select().from(schema.designAssets).where(eq(schema.designAssets.designId, id));
    expect(files.map((f) => ({ path: f.path, storage: f.storage, kind: f.kind, size: f.size, sha256: f.sha256 }))).toEqual([
      { path: fontPath, storage: "postext", kind: "font", size: fontBytes.length, sha256: sha256Of(fontBytes) },
    ]);
    const got = await designs.get(id);
    // 戻した .postext は、フォントを含んだ元の形で開ける。
    const opened = await openBundle(new Uint8Array(got!.bytes));
    expect(Buffer.from(opened.files.get(fontPath)!).equals(Buffer.from(fontBytes))).toBe(true);
    expect(Buffer.from(openBundleZip(new Uint8Array(got!.bytes)).files.get(fontPath)!).equals(Buffer.from(fontBytes))).toBe(true);
    expect((await designs.list()).find((d) => d.id === id)?.size).toBe(row!.bytes.length + fontBytes.length);

    // 上書きするとファイルの参照も置き換わり、削除で design_assets も消える。
    await designs.upsert({ id, name: "d", parts: ["text"], createdAt: 1, updatedAt: 3, bytes: Buffer.from("not a zip") });
    expect(await db.select().from(schema.designAssets).where(eq(schema.designAssets.designId, id))).toHaveLength(0);
    expect((await designs.get(id))?.bytes.toString()).toBe("not a zip");
    await designs.upsert({ id, name: "d", parts: ["text"], createdAt: 1, updatedAt: 4, bytes });
    expect(await designs.delete(id)).toBe(true);
    expect(await db.select().from(schema.designAssets).where(eq(schema.designAssets.designId, id))).toHaveLength(0);
  });
});
