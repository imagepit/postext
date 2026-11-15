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
import { createPgDesignRepository } from "../designs/repository";
import { createPgRepository } from "../books/repository";
import { FsBlobStore, sha256Of } from "./blobStore";
import { decideAssetRef, migrateAssetsToR2, outlineAttachmentIdOf } from "./migrate";
import { knownRefs } from "./refs";

const enc = (s: string) => new TextEncoder().encode(s);
const ATT = "11111111-2222-4333-8444-555555555555";

describe("outlineAttachmentIdOf", () => {
  it("outline/<uuid>.<ext> だけを添付 ID として読む", () => {
    expect(outlineAttachmentIdOf(`outline/${ATT}.png`)).toBe(ATT);
    expect(outlineAttachmentIdOf(`outline/${ATT}.svg`)).toBe(ATT);
    expect(outlineAttachmentIdOf("resources/fig.png")).toBeUndefined();
    expect(outlineAttachmentIdOf("outline/not-a-uuid.png")).toBeUndefined();
    expect(outlineAttachmentIdOf(`x/outline/${ATT}.png`)).toBeUndefined();
    expect(outlineAttachmentIdOf(`resources/outline-img-${ATT}.png`)).toBe(ATT);
    expect(outlineAttachmentIdOf(`resources/outline-img-${ATT}-2.svg`)).toBe(ATT);
    expect(outlineAttachmentIdOf(`resources/outline-img-not-a-uuid.png`)).toBeUndefined();
  });
});

describe("decideAssetRef", () => {
  const bytes = enc("原本");
  const file = { path: `outline/${ATT}.png`, mime: "image/png", bytes };
  const dir = () => new FsBlobStore(mkdtempSync(path.join(tmpdir(), "mig-")));

  it("Outline の原本の sha256 が一致すれば outline 参照（書き込みなし）", async () => {
    const store = dir();
    const r = await decideAssetRef(file, { store, fetchOutline: async () => ({ bytes, objectKey: "uploads/u/a.png" }) });
    expect(r.reason).toBe("outline");
    expect(r.ref).toEqual({ storage: "outline", key: "uploads/u/a.png", sha256: sha256Of(bytes), size: bytes.length, mime: "image/png" });
  });

  it("sha256 が違う、鍵がない、取得に失敗する場合は postext へ", async () => {
    const mismatch = await decideAssetRef(file, { store: dir(), fetchOutline: async () => ({ bytes: enc("別物"), objectKey: "k" }) });
    expect(mismatch.reason).toBe("outline-sha-mismatch");
    expect(mismatch.ref.storage).toBe("postext");
    const noKey = await decideAssetRef(file, { store: dir(), fetchOutline: async () => ({ bytes }) });
    expect(noKey.reason).toBe("outline-unresolvable");
    const failing = await decideAssetRef(file, { store: dir(), fetchOutline: async () => { throw new Error("404"); } });
    expect(failing.reason).toBe("outline-unresolvable");
    const noClient = await decideAssetRef(file, { store: dir() });
    expect(noClient.reason).toBe("outline-unresolvable");
  });

  it("outline 由来でないパスは postext", async () => {
    const r = await decideAssetRef({ ...file, path: "fonts/a.woff2" }, { store: dir() });
    expect(r.reason).toBe("postext");
    expect(r.ref.key).toBe(`sha256/${sha256Of(bytes)}`);
  });

  it("同じ内容の既知の参照があればそれを使う", async () => {
    const known = knownRefs([{ path: "p", ref: { storage: "outline", key: "k", sha256: sha256Of(bytes), size: 1, mime: "image/png" } }]);
    let called = false;
    const r = await decideAssetRef(file, { store: dir(), fetchOutline: async () => { called = true; return null; } }, known);
    expect(r.ref.key).toBe("k");
    expect(called).toBe(false);
  });
});

const url = process.env.TEST_DATABASE_URL ?? "postgres://books:books-local-only@127.0.0.1:55439/books";
let pool: Pool;
let db: Db;

beforeAll(async () => {
  pool = new Pool({ connectionString: url });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.join(__dirname, "../../drizzle") });
});
afterAll(async () => {
  await pool.end();
});

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

describe("migrateAssetsToR2（実 DB）", () => {
  it("dry-run は何も変えず、実行すると bytes が外れて参照になり、再実行は何もしない", async () => {
    const store = new FsBlobStore(mkdtempSync(path.join(tmpdir(), "mig-db-")));
    const font = enc("FONTBYTES");
    const resource = { id: "fig", typeId: "figure", kind: "bitmap", createdAt: 0, updatedAt: 0, bitmap: { fileId: `outline/${ATT}.png`, format: "png", width: 1, height: 1 } };

    // 従来の形で入れる: assets は bytes あり・参照なし、版は画像を含んだ bundle。
    const [book] = await db.insert(schema.books).values({ title: "旧", config: {}, resources: [resource], locale: "ja" }).returning();
    await db.insert(schema.chapters).values({ bookId: book!.id, position: 0, locale: "ja", title: "章", markdown: "# 章" });
    const [outlineRow] = await db
      .insert(schema.assets)
      .values({ bookId: book!.id, kind: "resource", path: `outline/${ATT}.png`, mime: "image/png", bytes: png, sha256: sha256Of(png) })
      .returning();
    const [fontRow] = await db
      .insert(schema.assets)
      .values({ bookId: book!.id, kind: "font", path: "fonts/a.woff2", mime: "font/woff2", bytes: Buffer.from(font), sha256: sha256Of(font) })
      .returning();
    const legacyBundle = Buffer.from(
      (await createBundle({ name: "旧", locale: "ja", chapters: [{ markdown: "# 章" }], resources: [resource] as never, files: new Map([[`outline/${ATT}.png`, new Uint8Array(png)]]) })).bytes,
    );
    const [version] = await db.insert(schema.bookVersions).values({ bookId: book!.id, number: 1, revision: 0, bundle: legacyBundle }).returning();
    const designId = `design-mig-${Date.now().toString(36)}`;
    const designBytes = Buffer.from(
      (
        await createDesignBundle({
          name: "字体",
          design: extractDesign(
            { bodyText: { fontFamily: "Lora" }, customFonts: [{ name: "Lora", variants: [{ weight: 400, style: "normal", fileId: "f1", format: "woff2" }] }] } as PostextConfig,
            ["text"],
          ),
          files: { f1: font },
        })
      ).bytes,
    );
    await db.insert(schema.designs).values({ id: designId, name: "d", parts: ["text"], bytes: designBytes, createdAt: 1, updatedAt: 1 });

    const fetchOutline = async (id: string) =>
      id === ATT ? { bytes: new Uint8Array(png), objectKey: `uploads/u/${id}/a.png` } : null;
    await store.putOutline(`uploads/u/${ATT}/a.png`, png);
    const logs: string[] = [];

    // dry-run
    const dry = await migrateAssetsToR2({ db, store, fetchOutline, dryRun: true, log: (l) => logs.push(l) });
    expect(dry.assetsMigrated).toBeGreaterThanOrEqual(2);
    expect(dry.bytesMovedOffDb).toBeGreaterThan(0);
    expect(dry.bytesToPostext).toBeGreaterThanOrEqual(font.length);
    const [stillOutline] = await db.select().from(schema.assets).where(eq(schema.assets.id, outlineRow!.id));
    expect(stillOutline!.bytes).not.toBeNull();
    expect((await db.select().from(schema.bookVersionAssets).where(eq(schema.bookVersionAssets.versionId, version!.id)))).toHaveLength(0);
    expect((await db.select().from(schema.designs).where(eq(schema.designs.id, designId)))[0]!.bytes.equals(designBytes)).toBe(true);

    // 実行
    const stats = await migrateAssetsToR2({ db, store, fetchOutline, dryRun: false, log: (l) => logs.push(l) });
    expect(stats.assetsFailed + stats.versionsFailed + stats.designsFailed).toBe(0);
    const [o] = await db.select().from(schema.assets).where(eq(schema.assets.id, outlineRow!.id));
    expect(o).toMatchObject({ bytes: null, storage: "outline", objectKey: `uploads/u/${ATT}/a.png`, size: png.length });
    const [f] = await db.select().from(schema.assets).where(eq(schema.assets.id, fontRow!.id));
    expect(f).toMatchObject({ bytes: null, storage: "postext", objectKey: `sha256/${sha256Of(font)}`, size: font.length });

    // 版: 画像は同じ内容の書籍の outline 参照にそろう。bundle は小さくなり、取得すると元の画像つきで開ける。
    const vrows = await db.select().from(schema.bookVersionAssets).where(eq(schema.bookVersionAssets.versionId, version!.id));
    expect(vrows).toHaveLength(1);
    expect(vrows[0]).toMatchObject({ storage: "outline", objectKey: `uploads/u/${ATT}/a.png`, sha256: sha256Of(png) });
    const repo = createPgRepository(db, store);
    const got = await repo.getVersionBundle(book!.id, version!.id);
    expect(got!.length).toBeGreaterThan(0);
    const opened = await openBundle(new Uint8Array(got!));
    expect([...opened.files.values()].some((b) => Buffer.from(b).equals(png))).toBe(true);
    const [vAfter] = await db.select().from(schema.bookVersions).where(eq(schema.bookVersions.id, version!.id));
    expect(vAfter!.bundle.length).toBeLessThan(legacyBundle.length);

    // 書籍の資産も読める。
    const withData = await repo.getWithAssetData(book!.id);
    expect(withData!.assets.map((a) => a.bytes.length).sort()).toEqual([font.length, png.length].sort());

    // デザイン
    const dfiles = await db.select().from(schema.designAssets).where(eq(schema.designAssets.designId, designId));
    expect(dfiles).toHaveLength(1);
    const design = await createPgDesignRepository(db, store).get(designId);
    expect(openBundleZip(new Uint8Array(design!.bytes)).files.get(dfiles[0]!.path)).toEqual(new Uint8Array(font));

    // 再実行は何も変えない（この3件は移行済みとして飛ばす）
    const again = await migrateAssetsToR2({ db, store, fetchOutline, dryRun: false });
    expect(again.assetsMigrated).toBe(0);
    expect(again.versionsMigrated).toBe(0);
    expect(again.designsMigrated).toBe(0);
    expect(again.assetsSkipped).toBeGreaterThanOrEqual(2);
    expect(logs.some((l) => l.includes("[outline]"))).toBe(true);
  });
});
