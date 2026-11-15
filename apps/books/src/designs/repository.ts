import { desc, eq, sql } from "drizzle-orm";
import { bundleFileMime, openBundleZip } from "postext/bundle";
import type { Db } from "../db/client";
import { designAssets, designs } from "../db/schema";
import type { BlobStore } from "../storage/blobStore";
import { getBlobStore } from "../storage/config";
import { resolveAssetRefs } from "../storage/refs";
import { joinZipFiles, stripZipFiles } from "../storage/zipSplit";
import type { DesignRepository } from "./model";

/** デザインの .postext で資産として別置きするファイル。マニフェストとサムネイル以外のすべて（fonts/ と profiles/）。 */
export function designAssetPaths(manifestThumbnail: unknown): (path: string) => boolean {
  return (path) => path !== manifestThumbnail;
}

export const designAssetKind = (path: string): "font" | "resource" =>
  path.startsWith("fonts/") ? "font" : "resource";

function thumbnailOf(bytes: Uint8Array): unknown {
  return (openBundleZip(bytes).manifest as { thumbnail?: unknown } | null)?.thumbnail;
}

/** .postext でないバイト列（検査のない PUT で来うる）は分けず、そのまま持つ。 */
export function splitDesign(bytes: Uint8Array): { stripped: Uint8Array; files: Map<string, Uint8Array> } {
  try {
    return stripZipFiles(bytes, designAssetPaths(thumbnailOf(bytes)));
  } catch {
    return { stripped: bytes, files: new Map() };
  }
}

/**
 * designs.bytes には、フォントなどのファイルを除いた .postext を置く。
 * 除いたファイルは R2 にあり、design_assets が参照を持つ。get() が元の .postext に戻す。
 */
export function createPgDesignRepository(db: Db, store?: BlobStore): DesignRepository {
  const blobs = (): BlobStore => store ?? getBlobStore();
  return {
    async list() {
      const assetSize = sql<number>`coalesce((select sum(${designAssets.size}) from ${designAssets} where ${designAssets.designId} = ${designs.id}), 0)`;
      const rows = await db
        .select({
          id: designs.id,
          name: designs.name,
          description: designs.description,
          source: designs.source,
          parts: designs.parts,
          createdAt: designs.createdAt,
          updatedAt: designs.updatedAt,
          // 戻したあとの .postext の大きさのめやす（除いた .postext + ファイルの合計）。
          size: sql<number>`octet_length(${designs.bytes}) + ${assetSize}`.mapWith(Number),
        })
        .from(designs)
        .orderBy(desc(designs.updatedAt), desc(designs.id));
      return rows.map(({ description, source, ...r }) => ({
        ...r,
        ...(description ? { description } : {}),
        ...(source ? { source } : {}),
      }));
    },

    async get(id) {
      const [row] = await db.select().from(designs).where(eq(designs.id, id));
      if (!row) return null;
      const files = await db.select().from(designAssets).where(eq(designAssets.designId, id));
      const loaded = new Map<string, Uint8Array>();
      for (const f of files) {
        loaded.set(
          f.path,
          await blobs().get({
            storage: f.storage!,
            key: f.objectKey,
            sha256: f.sha256,
            size: f.size,
            mime: f.mime,
          }),
        );
      }
      const { description, source, ...r } = row;
      return {
        ...r,
        bytes: Buffer.from(joinZipFiles(row.bytes, loaded)),
        ...(description ? { description } : {}),
        ...(source ? { source } : {}),
      };
    },

    async upsert(d) {
      const split = splitDesign(d.bytes);
      const refs = await resolveAssetRefs(
        blobs(),
        [...split.files].map(([path, bytes]) => ({ path, mime: bundleFileMime(path), bytes })),
      );
      const values = {
        name: d.name,
        description: d.description ?? null,
        source: d.source ?? null,
        parts: d.parts,
        bytes: Buffer.from(split.stripped),
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      };
      await db.transaction(async (tx) => {
        await tx
          .insert(designs)
          .values({ id: d.id, ...values })
          .onConflictDoUpdate({ target: designs.id, set: values });
        await tx.delete(designAssets).where(eq(designAssets.designId, d.id));
        if (refs.size > 0) {
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
        }
      });
    },

    async delete(id) {
      const rows = await db.delete(designs).where(eq(designs.id, id)).returning({ id: designs.id });
      return rows.length > 0;
    },
  };
}
