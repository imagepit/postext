// PostgreSQL に入っている画像・フォントのバイト列を R2 の参照へ移す処理。
// scripts/migrate-assets-to-r2.ts が呼ぶ。何度実行しても同じ結果になる（移行済みの行は飛ばす）。

import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { bundleFileMime } from "postext/bundle";
import { splitBookBundle } from "../books/bundle";
import type { Db } from "../db/client";
import {
  assets,
  bookVersionAssets,
  bookVersions,
  designAssets,
  designs,
} from "../db/schema";
import { designAssetKind, splitDesign } from "../designs/repository";
import { sha256Of } from "./blobStore";
import type { BlobRef, BlobStore } from "./blobStore";
import { knownRefs, resolveAssetRefs } from "./refs";
import type { KnownRefs } from "./refs";

/** `outline/<attachmentId>.<ext>` の添付 ID。Outline から取り込んだ画像のパス。 */
export function outlineAttachmentIdOf(path: string): string | undefined {
  return /^outline\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[A-Za-z0-9]+$/i.exec(path)?.[1];
}

export interface OutlineObject {
  bytes: Uint8Array;
  objectKey?: string;
}

export type RefReason =
  | "outline" // Outline の原本を参照した
  | "postext" // outline 由来ではない。自前のバケットへ
  | "outline-sha-mismatch" // Outline の現在の原本が保存済みと違う。自前のバケットへ
  | "outline-unresolvable"; // Outline から鍵を得られなかった。自前のバケットへ

export interface DecidedRef {
  ref: BlobRef;
  reason: RefReason;
}

export interface DecideDeps {
  store: BlobStore;
  /** Outline の添付を取得する。取得できなければ null か例外。 */
  fetchOutline?: (attachmentId: string) => Promise<OutlineObject | null>;
}

/** 保存済みの1ファイルについて、移行後の参照を決める。 */
export async function decideAssetRef(
  file: { path: string; mime: string; bytes: Uint8Array },
  deps: DecideDeps,
  known?: KnownRefs,
): Promise<DecidedRef> {
  const sha256 = sha256Of(file.bytes);
  const sameContent = known?.bySha.get(sha256);
  if (sameContent) return { ref: { ...sameContent, mime: file.mime }, reason: sameContent.storage };
  const attachmentId = outlineAttachmentIdOf(file.path);
  let reason: RefReason = "postext";
  if (attachmentId && deps.fetchOutline) {
    const fetched = await deps.fetchOutline(attachmentId).catch(() => null);
    if (fetched?.objectKey && sha256Of(fetched.bytes) === sha256) {
      return {
        ref: { storage: "outline", key: fetched.objectKey, sha256, size: file.bytes.length, mime: file.mime },
        reason: "outline",
      };
    }
    reason = fetched?.objectKey ? "outline-sha-mismatch" : "outline-unresolvable";
  } else if (attachmentId) {
    reason = "outline-unresolvable";
  }
  return { ref: await deps.store.putPostext(file.bytes, file.mime), reason };
}

export interface MigrationStats {
  assetsMigrated: number;
  assetsSkipped: number;
  assetsFailed: number;
  versionsMigrated: number;
  versionsSkipped: number;
  versionsFailed: number;
  designsMigrated: number;
  designsSkipped: number;
  designsFailed: number;
  refsOutline: number;
  refsPostext: number;
  /** DB から外したバイト数（assets.bytes と、版・デザインの .postext から除いたファイル）。 */
  bytesMovedOffDb: number;
  /** postext バケットへ新たに書く（書いた）一意なオブジェクトのバイト数。 */
  bytesToPostext: number;
  reasons: Record<RefReason, number>;
}

export const emptyStats = (): MigrationStats => ({
  assetsMigrated: 0,
  assetsSkipped: 0,
  assetsFailed: 0,
  versionsMigrated: 0,
  versionsSkipped: 0,
  versionsFailed: 0,
  designsMigrated: 0,
  designsSkipped: 0,
  designsFailed: 0,
  refsOutline: 0,
  refsPostext: 0,
  bytesMovedOffDb: 0,
  bytesToPostext: 0,
  reasons: { outline: 0, postext: 0, "outline-sha-mismatch": 0, "outline-unresolvable": 0 },
});

export interface MigrateOptions {
  db: Db;
  store: BlobStore;
  fetchOutline?: DecideDeps["fetchOutline"];
  dryRun: boolean;
  log?: (line: string) => void;
}

/** 書き込みをせず、postext への書き込みを数えるだけの store。 */
export function planningStore(inner: BlobStore, seen: Set<string>, stats: MigrationStats): BlobStore {
  return {
    get: (ref) => inner.get(ref),
    async putPostext(bytes, mime) {
      const sha256 = sha256Of(bytes);
      if (!seen.has(sha256)) {
        seen.add(sha256);
        stats.bytesToPostext += bytes.length;
      }
      return { storage: "postext", key: `sha256/${sha256}`, sha256, size: bytes.length, mime };
    },
  };
}

export async function migrateAssetsToR2(opts: MigrateOptions): Promise<MigrationStats> {
  const { db, dryRun } = opts;
  const log = opts.log ?? (() => {});
  const stats = emptyStats();
  const seen = new Set<string>();
  const store = dryRun ? planningStore(opts.store, seen, stats) : opts.store;
  // 実行時の書き込みバイト数は、postext へ新規に書いた一意なオブジェクトを putPostext の包みで数える。
  const counting: BlobStore = dryRun
    ? store
    : {
        get: (ref) => store.get(ref),
        async putPostext(bytes, mime) {
          const ref = await store.putPostext(bytes, mime);
          if (!seen.has(ref.sha256)) {
            seen.add(ref.sha256);
            stats.bytesToPostext += bytes.length;
          }
          return ref;
        },
      };
  const deps: DecideDeps = {
    store: counting,
    ...(opts.fetchOutline ? { fetchOutline: opts.fetchOutline } : {}),
  };
  const count = (ref: BlobRef, reason?: RefReason) => {
    if (ref.storage === "outline") stats.refsOutline++;
    else stats.refsPostext++;
    if (reason) stats.reasons[reason]++;
  };

  // 1. assets
  const rows = await db.select().from(assets).where(isNotNull(assets.bytes)).orderBy(asc(assets.bookId), asc(assets.path));
  stats.assetsSkipped = Number(
    (await db.select({ n: sql<number>`count(*)::int` }).from(assets).where(sql`${assets.bytes} is null`))[0]!.n,
  );
  // 本ごとに、決めた参照を覚えておく。同じ内容の資産・版のファイルが同じ参照を共有する。
  const bookKnown = new Map<string, { path: string; ref: BlobRef }[]>();
  const existing = await db.select().from(assets).where(sql`${assets.bytes} is null and ${assets.storage} is not null`);
  for (const r of existing) {
    const list = bookKnown.get(r.bookId) ?? [];
    list.push({ path: r.path, ref: { storage: r.storage!, key: r.objectKey!, sha256: r.sha256, size: r.size, mime: r.mime } });
    bookKnown.set(r.bookId, list);
  }
  for (const row of rows) {
    try {
      const bytes = new Uint8Array(row.bytes!);
      const known = knownRefs(bookKnown.get(row.bookId) ?? []);
      const { ref, reason } = await decideAssetRef({ path: row.path, mime: row.mime, bytes }, deps, known);
      // 参照の先から実際に読めて、内容が一致することを確かめてから bytes を消す。
      if (!dryRun && ref.storage === "outline") await opts.store.get(ref);
      log(`assets ${row.bookId} ${row.path} (${bytes.length} B) -> ${ref.storage}:${ref.key} [${reason}]`);
      if (!dryRun) {
        await db
          .update(assets)
          .set({ bytes: null, storage: ref.storage, objectKey: ref.key, size: bytes.length, sha256: ref.sha256 })
          .where(and(eq(assets.id, row.id), isNotNull(assets.bytes)));
      }
      const list = bookKnown.get(row.bookId) ?? [];
      list.push({ path: row.path, ref });
      bookKnown.set(row.bookId, list);
      stats.assetsMigrated++;
      stats.bytesMovedOffDb += bytes.length;
      count(ref, reason);
    } catch (error) {
      stats.assetsFailed++;
      log(`assets ${row.bookId} ${row.path} 失敗: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 2. 版。ファイルを含んだままの .postext を、除いた .postext と参照へ分ける。
  const versions = await db.select().from(bookVersions).orderBy(asc(bookVersions.bookId), asc(bookVersions.number));
  const migratedVersionIds = new Set(
    (await db.selectDistinct({ id: bookVersionAssets.versionId }).from(bookVersionAssets)).map((r) => r.id),
  );
  for (const v of versions) {
    if (migratedVersionIds.has(v.id)) {
      stats.versionsSkipped++;
      continue;
    }
    try {
      const split = await splitBookBundle(v.bundle);
      if (split.assets.length === 0) {
        stats.versionsSkipped++;
        continue;
      }
      const known = knownRefs(bookKnown.get(v.bookId) ?? []);
      const refs = await resolveAssetRefs(
        counting,
        split.assets.map((a) => ({ path: a.path, mime: a.mime, bytes: a.bytes })),
        known,
      );
      const moved = split.assets.reduce((n, a) => n + a.bytes.length, 0);
      log(`version ${v.bookId}#${v.number} ${split.assets.length} files (${moved} B) -> refs, bundle ${v.bundle.length} -> ${split.stripped.length} B`);
      if (!dryRun) {
        await db.transaction(async (tx) => {
          await tx.update(bookVersions).set({ bundle: Buffer.from(split.stripped) }).where(eq(bookVersions.id, v.id));
          await tx.insert(bookVersionAssets).values(
            split.assets.map((a) => {
              const ref = refs.get(a.path)!;
              return {
                versionId: v.id,
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
        });
      }
      for (const ref of refs.values()) count(ref);
      stats.versionsMigrated++;
      stats.bytesMovedOffDb += moved;
    } catch (error) {
      stats.versionsFailed++;
      log(`version ${v.bookId}#${v.number} 失敗: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 3. デザイン
  const designRows = await db.select().from(designs).orderBy(asc(designs.id));
  const migratedDesignIds = new Set(
    (await db.selectDistinct({ id: designAssets.designId }).from(designAssets)).map((r) => r.id),
  );
  for (const d of designRows) {
    if (migratedDesignIds.has(d.id)) {
      stats.designsSkipped++;
      continue;
    }
    try {
      const split = splitDesign(d.bytes);
      if (split.files.size === 0) {
        stats.designsSkipped++;
        continue;
      }
      const refs = await resolveAssetRefs(
        counting,
        [...split.files].map(([path, bytes]) => ({ path, mime: bundleFileMime(path), bytes })),
      );
      const moved = [...split.files.values()].reduce((n, b) => n + b.length, 0);
      log(`design ${d.id} ${split.files.size} files (${moved} B) -> refs, bytes ${d.bytes.length} -> ${split.stripped.length} B`);
      if (!dryRun) {
        await db.transaction(async (tx) => {
          await tx.update(designs).set({ bytes: Buffer.from(split.stripped) }).where(eq(designs.id, d.id));
          await tx.insert(designAssets).values(
            [...refs].map(([path, ref]) => ({
              designId: d.id,
              path,
              kind: designAssetKind(path),
              mime: ref.mime,
              sha256: ref.sha256,
              storage: ref.storage,
              objectKey: ref.key,
              size: ref.size,
            })),
          );
        });
      }
      for (const ref of refs.values()) count(ref);
      stats.designsMigrated++;
      stats.bytesMovedOffDb += moved;
    } catch (error) {
      stats.designsFailed++;
      log(`design ${d.id} 失敗: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return stats;
}
