import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import * as schema from "../db/schema";
import { createBundle, openBundle, openBundleZip, zipBundle } from "postext/bundle";
import { fromBundle, toBundle } from "./bundle";
import { parseBookWrite, sha256Hex } from "./model";
import type { AssetData, BookRepository, BookWrite } from "./model";
import { createPgRepository } from "./repository";
import {
  createBook,
  createVersion,
  getBook,
  listVersions,
  restoreVersion,
  saveBook,
} from "./usecases";

// 実 DB に対して検査する。docker-compose.dev.yml の PostgreSQL が既定の接続先。
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

const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

// 資産は資源が fileId で参照したときだけ .postext に入る。
const bitmapResource = (fileId: string): Record<string, unknown> => ({
  id: "fig-1",
  typeId: "figure",
  kind: "bitmap",
  createdAt: 0,
  updatedAt: 0,
  bitmap: { fileId, format: "png", width: 1, height: 1 },
});

const asset = (assetPath: string, bytes: Buffer): AssetData => ({
  kind: "resource",
  path: assetPath,
  mime: "image/png",
  bytes,
  sha256: sha256Hex(bytes),
  size: bytes.length,
});

const draft = (markdown: string, extra: Partial<BookWrite> = {}): BookWrite => ({
  title: "試験の本",
  config: {},
  resources: [],
  chapters: [{ title: "第一章", locale: "ja", markdown }],
  ...extra,
});

async function newBook(markdown = "# 第一章\n\nはじめの本文") {
  const book = await createBook(repo, draft(markdown));
  return book;
}

describe("作成と取得", () => {
  it("作成した書籍が revision 0 で取得できる", async () => {
    const created = await newBook();
    expect(created.revision).toBe(0);
    const got = await getBook(repo, created.id);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.book.title).toBe("試験の本");
    expect(got.book.revision).toBe(0);
    expect(got.book.chapters).toEqual([
      { title: "第一章", locale: "ja", markdown: "# 第一章\n\nはじめの本文" },
    ]);
  });

  it("存在しない書籍は not_found", async () => {
    const got = await getBook(repo, "00000000-0000-4000-8000-000000000000");
    expect(got).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("保存と競合", () => {
  it("正しい revision で保存すると内容が変わり revision が1増える", async () => {
    const book = await newBook();
    const saved = await saveBook(repo, book.id, 0, draft("# 第一章\n\n書き換えた本文"));
    expect(saved).toEqual({ ok: true, revision: 1 });
    const got = await getBook(repo, book.id);
    expect(got.ok && got.book.revision).toBe(1);
    expect(got.ok && got.book.chapters[0]?.markdown).toBe("# 第一章\n\n書き換えた本文");
  });

  it("古い revision の保存は拒否され、先に保存された内容が残る", async () => {
    const book = await newBook();
    await saveBook(repo, book.id, 0, draft("先に保存した本文"));
    const stale = await saveBook(repo, book.id, 0, draft("古い画面からの本文"));
    expect(stale).toEqual({ ok: false, reason: "conflict", revision: 1 });
    const got = await getBook(repo, book.id);
    expect(got.ok && got.book.revision).toBe(1);
    expect(got.ok && got.book.chapters[0]?.markdown).toBe("先に保存した本文");
  });

  it("同じ revision での同時保存は1件だけが通る", async () => {
    const book = await newBook();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => saveBook(repo, book.id, 0, draft(`同時保存 ${i}`))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const losers = results.filter((r) => !r.ok);
    expect(losers).toHaveLength(7);
    for (const loser of losers) expect(loser).toEqual({ ok: false, reason: "conflict", revision: 1 });
    const got = await getBook(repo, book.id);
    expect(got.ok && got.book.revision).toBe(1);
    const winner = results.findIndex((r) => r.ok);
    expect(got.ok && got.book.chapters[0]?.markdown).toBe(`同時保存 ${winner}`);
  });

  it("存在しない書籍への保存は not_found", async () => {
    const result = await saveBook(repo, "00000000-0000-4000-8000-000000000000", 0, draft("x"));
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("assets を省いた保存は資産を残し、渡した保存は置き換える", async () => {
    const book = await createBook(repo, draft("本文", { assets: [asset("a.png", pngBytes)] }));
    await saveBook(repo, book.id, 0, draft("本文2"));
    let got = await getBook(repo, book.id);
    expect(got.ok && got.book.assets.map((a) => a.path)).toEqual(["a.png"]);
    await saveBook(repo, book.id, 1, draft("本文3", { assets: [] }));
    got = await getBook(repo, book.id);
    expect(got.ok && got.book.assets).toEqual([]);
  });
});

describe("版", () => {
  it("版を作ると連番が付き、書籍の revision は変わらない", async () => {
    const book = await newBook();
    const first = await createVersion(repo, book.id, "初稿");
    const second = await createVersion(repo, book.id, "");
    expect(first.ok && first.version).toMatchObject({ number: 1, label: "初稿", revision: 0 });
    expect(second.ok && second.version.number).toBe(2);
    const got = await getBook(repo, book.id);
    expect(got.ok && got.book.revision).toBe(0);
    const list = await listVersions(repo, book.id);
    expect(list.ok && list.versions.map((v) => v.number)).toEqual([1, 2]);
  });

  it("同時に作った版は番号が重ならない", async () => {
    const book = await newBook();
    const results = await Promise.all(Array.from({ length: 5 }, () => createVersion(repo, book.id, "")));
    const numbers = results.map((r) => (r.ok ? r.version.number : -1)).sort();
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
  });

  it("存在しない書籍の版は not_found", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    expect(await createVersion(repo, id, "")).toEqual({ ok: false, reason: "not_found" });
    expect(await listVersions(repo, id)).toEqual({ ok: false, reason: "not_found" });
  });

  it("作った版の中身は .postext として読め、章と資産を含む", async () => {
    const book = await createBook(
      repo,
      draft("# 第一章\n\n版の時点の本文", {
        resources: [bitmapResource("img.png")],
        assets: [asset("img.png", pngBytes)],
      }),
    );
    const created = await createVersion(repo, book.id, "v1");
    if (!created.ok) throw new Error("version not created");
    const bytes = await repo.getVersionBundle(book.id, created.version.id);
    expect(bytes?.subarray(0, 2).toString()).toBe("PK");
    const opened = await fromBundle(bytes!);
    expect(opened.title).toBe("試験の本");
    expect(opened.chapters[0]?.markdown).toBe("# 第一章\n\n版の時点の本文");
    expect(opened.chapters[0]?.locale).toBe("ja");
  });

  it("内容を変えた後に復元すると、本文が版の時点へ戻り revision は増える", async () => {
    const book = await createBook(
      repo,
      draft("# 第一章\n\n版の時点の本文", {
        resources: [bitmapResource("img.png")],
        assets: [asset("img.png", pngBytes)],
      }),
    );
    const created = await createVersion(repo, book.id, "v1");
    if (!created.ok) throw new Error("version not created");

    await saveBook(repo, book.id, 0, draft("# 第一章\n\n変更後の本文", { resources: [], assets: [] }));
    const restored = await restoreVersion(repo, book.id, created.version.id, 1);
    expect(restored).toEqual({ ok: true, revision: 2 });

    const got = await getBook(repo, book.id);
    expect(got.ok && got.book.revision).toBe(2);
    expect(got.ok && got.book.title).toBe("試験の本");
    expect(got.ok && got.book.chapters[0]?.markdown).toBe("# 第一章\n\n版の時点の本文");
    expect(got.ok && got.book.assets).toHaveLength(1);
    const restoredPath = got.ok ? got.book.assets[0]?.path : undefined;
    expect(got.ok && got.book.resources).toHaveLength(1);
    const full = await repo.getWithAssetData(book.id);
    const restoredAsset = full?.assets[0];
    expect(restoredAsset?.path).toBe(restoredPath);
    expect(restoredAsset?.bytes.equals(pngBytes)).toBe(true);
    const restoredResource = got.ok ? got.book.resources[0] : undefined;
    expect((restoredResource?.bitmap as { fileId: string }).fileId).toBe(restoredPath);
    expect(restoredAsset?.sha256).toBe(sha256Hex(pngBytes));
  });

  it("復元は revision を照合し、古ければ何も書き換えない", async () => {
    const book = await newBook("# 第一章\n\n版の時点の本文");
    const created = await createVersion(repo, book.id, "v1");
    if (!created.ok) throw new Error("version not created");
    await saveBook(repo, book.id, 0, draft("# 第一章\n\n変更後の本文"));

    const stale = await restoreVersion(repo, book.id, created.version.id, 0);
    expect(stale).toEqual({ ok: false, reason: "conflict", revision: 1 });
    const got = await getBook(repo, book.id);
    expect(got.ok && got.book.revision).toBe(1);
    expect(got.ok && got.book.chapters[0]?.markdown).toBe("# 第一章\n\n変更後の本文");
  });

  it("別の書籍の版や存在しない版は復元できない", async () => {
    const a = await newBook();
    const b = await newBook();
    const version = await createVersion(repo, a.id, "");
    if (!version.ok) throw new Error("version not created");
    expect(await restoreVersion(repo, b.id, version.version.id, 0)).toEqual({ ok: false, reason: "not_found" });
    expect(await restoreVersion(repo, a.id, "00000000-0000-4000-8000-000000000000", 0)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("Sandbox が .postext に足す組版結果と表紙は資産として保存しない", async () => {
    const created = await createBundle({
      name: "試験の本",
      locale: "ja",
      chapters: [{ title: "第一章", markdown: "# 第一章\n\n本文" }],
      config: {},
      resources: [bitmapResource("img.png")] as never,
      files: new Map([["img.png", new Uint8Array(pngBytes)]]),
      thumbnail: { data: new Uint8Array(pngBytes), mime: "image/png" },
    });
    const zip = openBundleZip(created.bytes);
    const withCaches = zipBundle({
      ...Object.fromEntries([...zip.files]),
      "layouts.json": new TextEncoder().encode("{}"),
      "layouts.ja.json": new TextEncoder().encode("{}"),
    });

    const sent = [...openBundleZip(withCaches).files.keys()];
    expect(sent).toContain("layouts.json");
    expect(sent).toContain("layouts.ja.json");
    expect(sent.some((f) => f.startsWith("thumbnail"))).toBe(true);

    const parsed = await fromBundle(withCaches);
    expect(parsed.assets.map((a) => a.path)).toEqual(["resources/fig-1.png"]);

    const book = await createBook(repo, parsed);
    const saved = await saveBook(repo, book.id, 0, parsed);
    expect(saved).toEqual({ ok: true, revision: 1 });
    const got = await getBook(repo, book.id);
    expect(got.ok && got.book.assets.map((a) => a.path)).toEqual(["resources/fig-1.png"]);
  });
});

const bilingual = (suffix = ""): BookWrite => ({
  title: "日本語の題名",
  config: { marker: "ja-config" },
  resources: [],
  locale: "ja",
  chapters: [
    { title: "第一章", locale: "ja", markdown: `# 第一章\n\n日本語の本文${suffix}` },
    { title: "第二章", locale: "ja", markdown: `# 第二章\n\n日本語の続き${suffix}` },
    { title: "Chapter one", locale: "en", markdown: `# Chapter one\n\nEnglish body${suffix}` },
  ],
  editions: [
    {
      locale: "en",
      name: "English title",
      description: "An English edition",
      config: { marker: "en-config" },
      resources: [],
    },
  ],
});

describe("多言語の書籍", () => {
  it("2言語で作成すると、両言語の章・題名・設定を取得できる", async () => {
    const created = await createBook(repo, bilingual());
    const got = await getBook(repo, created.id);
    if (!got.ok) throw new Error("not found");
    expect(got.book.locale).toBe("ja");
    expect(got.book.title).toBe("日本語の題名");
    expect(got.book.config).toEqual({ marker: "ja-config" });
    expect(got.book.chapters.map((c) => [c.locale, c.title])).toEqual([
      ["ja", "第一章"],
      ["ja", "第二章"],
      ["en", "Chapter one"],
    ]);
    expect(got.book.editions).toEqual([
      {
        locale: "en",
        name: "English title",
        description: "An English edition",
        config: { marker: "en-config" },
        resources: [],
      },
    ]);
  });

  it("版を作って両言語を保存し直し、復元すると両言語が版の内容へ戻る", async () => {
    const book = await createBook(repo, bilingual());
    const version = await createVersion(repo, book.id, "v1");
    if (!version.ok) throw new Error("version not created");

    const changed = bilingual(" 変更");
    changed.title = "変更後の題名";
    changed.editions![0]!.name = "Changed title";
    expect(await saveBook(repo, book.id, 0, changed)).toEqual({ ok: true, revision: 1 });
    const mid = await getBook(repo, book.id);
    expect(mid.ok && mid.book.editions?.[0]?.name).toBe("Changed title");

    expect(await restoreVersion(repo, book.id, version.version.id, 1)).toEqual({ ok: true, revision: 2 });
    const got = await getBook(repo, book.id);
    if (!got.ok) throw new Error("not found");
    expect(got.book.title).toBe("日本語の題名");
    expect(got.book.editions?.map((e) => e.name)).toEqual(["English title"]);
    expect(got.book.editions?.[0]?.config).toMatchObject({ marker: "en-config" });
    expect(got.book.chapters.map((c) => [c.locale, c.markdown])).toEqual([
      ["ja", "# 第一章\n\n日本語の本文"],
      ["ja", "# 第二章\n\n日本語の続き"],
      ["en", "# Chapter one\n\nEnglish body"],
    ]);
  });

  it("createBundle の localized で作った .postext を取り込み、書き出すと各言語が読める", async () => {
    const made = await createBundle({
      name: "日本語の題名",
      locale: "ja",
      chapters: [{ title: "第一章", markdown: "# 第一章\n\n日本語" }],
      localized: {
        en: { name: "English title", chapters: [{ title: "One", markdown: "# One\n\nEnglish" }] },
        fr: { name: "Titre", chapters: [{ title: "Un", markdown: "# Un\n\nFrancais" }] },
      },
    });
    const parsed = await fromBundle(made.bytes);
    expect(parsed.locale).toBe("ja");
    expect(parsed.editions?.map((e) => e.locale)).toEqual(["en", "fr"]);
    expect(parsed.chapters.map((c) => c.locale)).toEqual(["ja", "en", "fr"]);

    const book = await createBook(repo, parsed);
    const full = await repo.getWithAssetData(book.id);
    const bytes = await toBundle(full!);
    const ja = await openBundle(bytes);
    expect(ja.name).toBe("日本語の題名");
    expect(ja.chapters.map((c) => c.markdown)).toEqual(["# 第一章\n\n日本語"]);
    const en = await openBundle(bytes, { locale: "en" });
    expect(en.name).toBe("English title");
    expect(en.chapters.map((c) => c.markdown)).toEqual(["# One\n\nEnglish"]);
    const fr = await openBundle(bytes, { locale: "fr" });
    expect(fr.name).toBe("Titre");
    expect(fr.chapters.map((c) => c.markdown)).toEqual(["# Un\n\nFrancais"]);
  });

  it("locale と editions を省いた単一言語の書籍は従来どおり往復する", async () => {
    const book = await newBook();
    expect(book.editions).toEqual([]);
    const version = await createVersion(repo, book.id, "");
    if (!version.ok) throw new Error("version not created");
    const bytes = await repo.getVersionBundle(book.id, version.version.id);
    const opened = await openBundle(bytes!);
    expect(opened.locales).toBeUndefined();
    const back = await fromBundle(bytes!);
    expect(back.editions).toEqual([]);
    expect(back.chapters).toEqual([{ title: "第一章", locale: "ja", markdown: "# 第一章\n\nはじめの本文" }]);
  });

  it("locale が NULL の書籍は先頭の章の言語を主言語として返す", async () => {
    const book = await newBook();
    await pool.query("update books set locale = null, shared_config = null where id = $1", [book.id]);
    const got = await getBook(repo, book.id);
    expect(got.ok && got.book.locale).toBe("ja");
    expect(got.ok && got.book.editions).toEqual([]);
    await saveBook(repo, book.id, 0, draft("保存し直した本文"));
    const row = await pool.query("select locale from books where id = $1", [book.id]);
    expect(row.rows[0].locale).toBe("ja");
  });
});

describe("書き込みの検証", () => {
  const base = { title: "t", chapters: [{ title: "a", locale: "ja", markdown: "x" }] };
  it("多言語の項目を省くと従来どおりの値になる", () => {
    const parsed = parseBookWrite(base);
    expect(parsed.ok && parsed.value).toEqual({ ...base, config: {}, resources: [] });
  });
  it("版の言語が重複・主言語と同じ・章の言語に未知があると拒否する", () => {
    const edition = { locale: "en", name: "n", config: {}, resources: [] };
    expect(parseBookWrite({ ...base, editions: [edition, edition] }).ok).toBe(false);
    expect(parseBookWrite({ ...base, editions: [{ ...edition, locale: "ja" }] }).ok).toBe(false);
    expect(parseBookWrite({ ...base, editions: [{ ...edition, locale: "fr" }] }).ok).toBe(true);
    expect(
      parseBookWrite({
        ...base,
        chapters: [...base.chapters, { title: "b", locale: "de", markdown: "y" }],
        editions: [edition],
      }).ok,
    ).toBe(false);
  });
});
