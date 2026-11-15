import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { assets, bookEditions, bookVersionAssets, bookVersions, books, chapters } from "../db/schema";
import type { BlobRef, BlobStore } from "../storage/blobStore";
import { getBlobStore } from "../storage/config";
import { knownRefs, resolveAssetRefs } from "../storage/refs";
import type { KnownRefs } from "../storage/refs";
import { joinZipFiles } from "../storage/zipSplit";
import { splitBookBundle } from "./bundle";
import { nextRevision } from "./model";
import type {
  AssetData,
  AssetMeta,
  Book,
  BookContent,
  BookEdition,
  BookRepository,
  BookSummary,
  BookWithAssetData,
  BookWrite,
  ChapterContent,
  VersionSummary,
} from "./model";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const versionColumns = {
  id: bookVersions.id,
  number: bookVersions.number,
  label: bookVersions.label,
  revision: bookVersions.revision,
  createdAt: bookVersions.createdAt,
};

const refOfRow = (row: {
  storage: "outline" | "postext";
  objectKey: string;
  sha256: string;
  size: number;
  mime: string;
}): BlobRef => ({ storage: row.storage, key: row.objectKey, sha256: row.sha256, size: row.size, mime: row.mime });

/** 書籍がすでに持つ参照。保存する資産が同じ内容なら、これを使い回す。 */
async function readKnownRefs(db: Db | Tx, bookId: string): Promise<KnownRefs> {
  const rows = await db.select().from(assets).where(eq(assets.bookId, bookId));
  return knownRefs(rows.map((r) => ({ path: r.path, ref: refOfRow(r) })));
}

const BYTE_FETCH_CONCURRENCY = 4;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function insertChildren(
  tx: Tx,
  bookId: string,
  content: BookWrite,
  refs: Map<string, BlobRef>,
): Promise<void> {
  if (content.chapters.length > 0) {
    await tx.insert(chapters).values(
      content.chapters.map((c, position) => ({ bookId, position, ...c })),
    );
  }
  await insertEditions(tx, bookId, content);
  if (content.assets && content.assets.length > 0) {
    await tx.insert(assets).values(
      content.assets.map((a) => {
        const ref = refs.get(a.path)!;
        return {
          bookId,
          kind: a.kind,
          path: a.path,
          mime: a.mime,
          sha256: ref.sha256,
          storage: ref.storage,
          objectKey: ref.key,
          size: ref.size,
        };
      }),
    );
  }
}

async function insertEditions(tx: Tx, bookId: string, content: BookWrite): Promise<void> {
  const editions = content.editions ?? [];
  if (editions.length === 0) return;
  await tx.insert(bookEditions).values(
    editions.map((e, position) => ({
      bookId,
      position,
      locale: e.locale,
      name: e.name,
      description: e.description ?? null,
      config: e.config,
      resources: e.resources,
      start: e.start ?? null,
    })),
  );
}

async function readEditions(db: Db | Tx, bookId: string): Promise<BookEdition[]> {
  const rows = await db
    .select()
    .from(bookEditions)
    .where(eq(bookEditions.bookId, bookId))
    .orderBy(asc(bookEditions.position));
  return rows.map((e) => ({
    locale: e.locale,
    name: e.name,
    ...(e.description !== null ? { description: e.description } : {}),
    config: e.config,
    resources: e.resources,
    ...(e.start !== null ? { start: e.start } : {}),
  }));
}

async function readChapters(db: Db | Tx, bookId: string): Promise<ChapterContent[]> {
  return db
    .select({ title: chapters.title, locale: chapters.locale, markdown: chapters.markdown })
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(asc(chapters.position));
}

// 書籍・章・資産を別々に読むと、間に入った保存で revision と中身がずれる。
// 版の作成が revision と中身の組を正しく記録できるよう、同じスナップショットで読む。
function snapshot<T>(db: Db, run: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(run, { isolationLevel: "repeatable read", accessMode: "read only" });
}

async function readContent(tx: Tx, row: typeof books.$inferSelect): Promise<BookContent> {
  const chapterRows = await readChapters(tx, row.id);
  return {
    title: row.title,
    config: row.config,
    resources: row.resources,
    chapters: chapterRows,
    // 多言語対応前の書籍は locale が NULL。先頭の章の言語を主言語とみなす。
    ...((row.locale ?? chapterRows[0]?.locale) ? { locale: row.locale ?? chapterRows[0]!.locale } : {}),
    sharedConfig: row.sharedConfig,
    editions: await readEditions(tx, row.id),
  };
}

const primaryLocale = (content: BookContent): string | null =>
  content.locale ?? content.chapters[0]?.locale ?? null;

/**
 * store を省くと環境変数から作る（R2、開発では .data/blobs）。
 * 画像・フォントのバイト列は DB に置かず、assets / book_version_assets は参照だけを持つ。
 */
export function createPgRepository(db: Db, store?: BlobStore): BookRepository {
  const blobs = (): BlobStore => store ?? getBlobStore();
  const refsFor = (content: BookWrite, known?: KnownRefs) =>
    resolveAssetRefs(
      blobs(),
      (content.assets ?? []).map((a) => ({
        path: a.path,
        mime: a.mime,
        bytes: a.bytes,
        ...(a.ref ? { ref: a.ref } : {}),
        ...(a.outlineKey ? { outlineKey: a.outlineKey } : {}),
      })),
      known,
    );
  return {
    async create(content) {
      // R2 への書き込みはトランザクションの外で済ませる。
      const refs = await refsFor(content);
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(books)
          .values({
            title: content.title,
            config: content.config,
            resources: content.resources,
            locale: primaryLocale(content),
            sharedConfig: content.sharedConfig ?? null,
          })
          .returning();
        await insertChildren(tx, row!.id, content, refs);
        const assetMetas = await readAssetMetas(tx, row!.id);
        return {
          id: row!.id,
          revision: row!.revision,
          createdAt: row!.createdAt,
          updatedAt: row!.updatedAt,
          ...(await readContent(tx, row!)),
          assets: assetMetas,
        } satisfies Book;
      });
    },

    async list(): Promise<BookSummary[]> {
      return db
        .select({
          id: books.id,
          title: books.title,
          revision: books.revision,
          updatedAt: books.updatedAt,
        })
        .from(books)
        .orderBy(desc(books.updatedAt), asc(books.id));
    },

    async get(id) {
      return snapshot(db, async (tx) => {
        const [row] = await tx.select().from(books).where(eq(books.id, id));
        if (!row) return null;
        return {
          id: row.id,
          revision: row.revision,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          ...(await readContent(tx, row)),
          assets: await readAssetMetas(tx, id),
        };
      });
    },

    async getWithAssetData(id): Promise<BookWithAssetData | null> {
      const loaded = await snapshot(db, async (tx) => {
        const [row] = await tx.select().from(books).where(eq(books.id, id));
        if (!row) return null;
        const rows = await tx
          .select()
          .from(assets)
          .where(eq(assets.bookId, id))
          .orderBy(asc(assets.path));
        return { row, rows, content: await readContent(tx, row) };
      });
      if (!loaded) return null;
      // スナップショットを閉じてから、R2（とディスクキャッシュ）からバイト列を読む。
      const data: AssetData[] = await mapLimit(loaded.rows, BYTE_FETCH_CONCURRENCY, async (a) => {
        const ref = refOfRow(a);
        const bytes = Buffer.from(await blobs().get(ref));
        return {
          kind: a.kind,
          path: a.path,
          mime: a.mime,
          sha256: a.sha256,
          size: bytes.length,
          bytes,
          ref,
        };
      });
      return { id: loaded.row.id, revision: loaded.row.revision, ...loaded.content, assets: data };
    },

    async replace(id, baseRevision, content) {
      const refs = content.assets
        ? await refsFor(content, await readKnownRefs(db, id))
        : new Map<string, BlobRef>();
      return db.transaction(async (tx) => {
        // 条件付き UPDATE が判定と更新を兼ねる。同じ行への2つ目の更新は
        // 1つ目のコミットを待ってから条件を評価し直すので、片方だけが通る。
        const updated = await tx
          .update(books)
          .set({
            title: content.title,
            config: content.config,
            resources: content.resources,
            locale: primaryLocale(content),
            sharedConfig: content.sharedConfig ?? null,
            revision: nextRevision(baseRevision),
            updatedAt: sql`now()`,
          })
          .where(and(eq(books.id, id), eq(books.revision, baseRevision)))
          .returning({ revision: books.revision });
        if (updated.length === 0) {
          const [current] = await tx
            .select({ revision: books.revision })
            .from(books)
            .where(eq(books.id, id));
          return current
            ? { ok: false as const, reason: "conflict" as const, revision: current.revision }
            : { ok: false as const, reason: "not_found" as const };
        }
        await tx.delete(chapters).where(eq(chapters.bookId, id));
        await tx.delete(bookEditions).where(eq(bookEditions.bookId, id));
        if (content.assets) await tx.delete(assets).where(eq(assets.bookId, id));
        await insertChildren(tx, id, content, refs);
        return { ok: true as const, revision: updated[0]!.revision };
      });
    },

    async addVersion(bookId, version) {
      // 資産ファイルを除いた .postext を DB に、ファイルは参照にして保存する。
      const split = await splitBookBundle(version.bundle);
      const refs = await resolveAssetRefs(
        blobs(),
        split.assets.map((a) => ({ path: a.path, mime: a.mime, bytes: a.bytes })),
        await readKnownRefs(db, bookId),
      );
      return db.transaction(async (tx) => {
        // 版番号の採番を直列化するため、書籍の行を先にロックする。
        const locked = await tx
          .select({ id: books.id })
          .from(books)
          .where(eq(books.id, bookId))
          .for("update");
        if (locked.length === 0) return null;
        const [{ latest }] = await tx
          .select({ latest: sql<number>`coalesce(max(${bookVersions.number}), 0)::int` })
          .from(bookVersions)
          .where(eq(bookVersions.bookId, bookId));
        const [row] = await tx
          .insert(bookVersions)
          .values({ bookId, number: latest + 1, ...version, bundle: Buffer.from(split.stripped) })
          .returning(versionColumns);
        if (split.assets.length > 0) {
          await tx.insert(bookVersionAssets).values(
            split.assets.map((a) => {
              const ref = refs.get(a.path)!;
              return {
                versionId: row!.id,
                path: a.path,
                kind: a.kind,
                mime: a.mime,
                sha256: ref.sha256,
                storage: ref.storage,
                objectKey: ref.key,
                size: ref.size,
              };
            }),
          );
        }
        return row!;
      });
    },

    async listVersions(bookId): Promise<VersionSummary[] | null> {
      const [exists] = await db.select({ id: books.id }).from(books).where(eq(books.id, bookId));
      if (!exists) return null;
      return db
        .select(versionColumns)
        .from(bookVersions)
        .where(eq(bookVersions.bookId, bookId))
        .orderBy(asc(bookVersions.number));
    },

    async getVersionBundle(bookId, versionId) {
      const [row] = await db
        .select({ id: bookVersions.id, bundle: bookVersions.bundle })
        .from(bookVersions)
        .where(and(eq(bookVersions.bookId, bookId), eq(bookVersions.id, versionId)));
      if (!row) return null;
      const files = await db
        .select()
        .from(bookVersionAssets)
        .where(eq(bookVersionAssets.versionId, row.id));
      // 参照を持たない版（R2 移行前の、ファイルを含んだままの .postext）はそのまま返す。
      if (files.length === 0) return row.bundle;
      const loaded = await mapLimit(files, BYTE_FETCH_CONCURRENCY, async (f) => {
        const ref = refOfRow(f)!;
        return [f.path, await blobs().get(ref)] as const;
      });
      return Buffer.from(joinZipFiles(row.bundle, new Map(loaded)));
    },
  };
}

async function readAssetMetas(db: Db | Tx, bookId: string): Promise<AssetMeta[]> {
  return db
    .select({
      kind: assets.kind,
      path: assets.path,
      mime: assets.mime,
      sha256: assets.sha256,
      size: assets.size,
    })
    .from(assets)
    .where(eq(assets.bookId, bookId))
    .orderBy(asc(assets.path));
}
