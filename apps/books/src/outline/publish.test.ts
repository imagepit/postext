import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { extractDesign } from "postext";
import type { PostextConfig } from "postext";
import { createDesignBundle } from "postext/bundle";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BookRepository } from "@/books/model";
import { createPgRepository } from "@/books/repository";
import { saveBook } from "@/books/usecases";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import type { DesignRecord, DesignRepository } from "@/designs/model";
import { FsBlobStore } from "@/storage/blobStore";
import type { OutlineDocument } from "./client";
import { locateCourse, publishCourse } from "./publish";
import type { PublishDeps } from "./publish";

const url = process.env.TEST_DATABASE_URL ?? "postgres://books:books-local-only@127.0.0.1:55439/books";

let pool: Pool;
let repo: BookRepository;

beforeAll(async () => {
  pool = new Pool({ connectionString: url });
  const db: Db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.join(__dirname, "../../drizzle") });
  repo = createPgRepository(db, new FsBlobStore(mkdtempSync(path.join(tmpdir(), "books-publish-"))));
});

afterAll(async () => {
  await pool.end();
});

const PARENT = "11111111-0000-4000-8000-000000000000";
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-02-01T00:00:00.000Z";

let seq = 0;
/** 毎回ちがう文書 ID（前の実行で残った書籍や、ほかのテストの書籍と取り違えないため）。 */
const ids = () => {
  seq++;
  return [randomUUID(), randomUUID()];
};

class FakeOutline {
  constructor(public docs: OutlineDocument[]) {}
  async listChildDocuments(parentId: string) {
    return parentId === PARENT ? this.docs.map((d) => ({ ...d })) : [];
  }
  async fetchAttachment() {
    return { bytes: new Uint8Array(), contentType: "image/png" };
  }
}

const fontBytes = new Uint8Array(Array.from({ length: 2000 }, (_, i) => (i * 7) % 256));

async function designs(): Promise<DesignRepository> {
  const made = await createDesignBundle({
    name: "教材",
    design: extractDesign(
      { bodyText: { fontFamily: "IMAGEPIT Sans" }, customFonts: [{ name: "IMAGEPIT Sans", variants: [{ weight: 400, style: "normal", fileId: "f1", format: "ttf" }] }] } as PostextConfig,
      ["text"],
    ),
    files: { f1: fontBytes },
  });
  const record: DesignRecord = { id: "imagepit-textbook", name: "教材", parts: ["text"], createdAt: 1, updatedAt: 1, bytes: Buffer.from(made.bytes) };
  return {
    list: async () => [],
    get: async (id) => (id === record.id ? record : null),
    upsert: async () => undefined,
    delete: async () => false,
  };
}

async function setup() {
  const [a, b] = ids();
  const outline = new FakeOutline([
    { id: a!, title: "第1章", text: "本文A\n", updatedAt: T0 },
    { id: b!, title: "第2章", text: "本文B\n", updatedAt: T0 },
  ]);
  const deps: PublishDeps = { repo, designs: await designs(), outline, bookUrl: "https://book.example/" };
  return { a: a!, b: b!, outline, deps, input: { parentDocumentId: PARENT, documentIds: [a!, b!], title: `コース${seq}` } };
}

describe("書籍出版", () => {
  it("書籍がなければ、コース名で作ってデザインとフォントを当て、全章を取り込み、書籍と章の URL を返す", async () => {
    const { deps, input, a, b } = await setup();
    expect((await locateCourse(deps, input)).book).toBeNull();
    const out = await publishCourse(deps, input);
    expect(out.created).toBe(true);
    expect(out.book).toMatchObject({ title: input.title, url: `https://book.example/books/${out.book!.id}` });
    expect(out.chapters).toEqual([
      { documentId: a, title: "第1章", chapter: 1, url: `https://book.example/books/${out.book!.id}?chapter=1`, state: "imported" },
      { documentId: b, title: "第2章", chapter: 2, url: `https://book.example/books/${out.book!.id}?chapter=2`, state: "imported" },
    ]);
    const book = (await repo.getWithAssetData(out.book!.id))!;
    expect((book.config.bodyText as { fontFamily?: string }).fontFamily).toBe("IMAGEPIT Sans");
    const font = book.assets.find((x) => x.kind === "font");
    expect(font?.bytes.equals(Buffer.from(fontBytes))).toBe(true);
  });

  it("2回目は同じ書籍を使い、Outline側だけ更新された章を取り込み、Postextで編集された章は取り込まない", async () => {
    const { deps, input, outline, a, b } = await setup();
    const first = await publishCourse(deps, input);
    const bookId = first.book!.id;
    // Postext で1章を編集し、Outline では1章と2章を更新する。
    const book = (await repo.get(bookId))!;
    await saveBook(repo, bookId, book.revision, {
      title: book.title, config: book.config, resources: book.resources, locale: "ja",
      chapters: book.chapters.map((c, i) => (i === 0 ? { ...c, markdown: c.markdown.replace("本文A", "Postextで直した本文A") } : c)),
    });
    outline.docs[0] = { ...outline.docs[0]!, text: "Outlineで直した本文A\n", updatedAt: T1 };
    outline.docs[1] = { ...outline.docs[1]!, text: "Outlineで直した本文B\n", updatedAt: T1 };

    const located = await locateCourse(deps, input);
    expect(located.chapters.map((c) => c.state)).toEqual(["postextEdited", "outlineUpdated"]);

    const out = await publishCourse(deps, input);
    expect(out.created).toBe(false);
    expect(out.book!.id).toBe(bookId);
    expect(out.chapters.map((c) => [c.documentId, c.state])).toEqual([[a, "postextEdited"], [b, "imported"]]);
    expect(out.warnings.some((w) => w.includes("Postextの編集が優先"))).toBe(true);
    const saved = (await repo.get(bookId))!;
    expect(saved.chapters[0]!.markdown).toContain("Postextで直した本文A");
    expect(saved.chapters[1]!.markdown).toContain("Outlineで直した本文B");
  });

  it("locate は書き換えない", async () => {
    const { deps, input } = await setup();
    const out = await publishCourse(deps, input);
    const before = (await repo.get(out.book!.id))!.revision;
    const located = await locateCourse(deps, input);
    expect(located.chapters.map((c) => c.state)).toEqual(["unchanged", "unchanged"]);
    expect((await repo.get(out.book!.id))!.revision).toBe(before);
  });
});
