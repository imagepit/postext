// 環境変数から BlobStore を組み立てる。
//
// R2_ENDPOINT                                   https://<account>.r2.cloudflarestorage.com
// R2_OUTLINE_BUCKET                             既定 outline-originals（読み取り専用）
// R2_OUTLINE_ACCESS_KEY_ID / _SECRET_ACCESS_KEY outline バケットの読み取り鍵
// R2_ASSETS_BUCKET                              既定 postext-assets（読み書き）
// R2_ASSETS_ACCESS_KEY_ID / _SECRET_ACCESS_KEY  postext バケットの読み書き鍵
// ASSET_CACHE_DIR                               既定 /cache/assets
// ASSET_FS_DIR                                  R2 未設定の開発用の置き場。既定 .data/blobs

import type { BlobStore } from "./blobStore";
import { FsBlobStore } from "./blobStore";
import { CachedBlobStore } from "./cachedStore";
import { R2BlobStore } from "./r2";

type Env = Record<string, string | undefined>;

export const DEFAULT_OUTLINE_BUCKET = "outline-originals";
export const DEFAULT_ASSETS_BUCKET = "postext-assets";
export const DEFAULT_CACHE_DIR = "/cache/assets";

const R2_KEYS = [
  "R2_ENDPOINT",
  "R2_OUTLINE_ACCESS_KEY_ID",
  "R2_OUTLINE_SECRET_ACCESS_KEY",
  "R2_ASSETS_ACCESS_KEY_ID",
  "R2_ASSETS_SECRET_ACCESS_KEY",
] as const;

export const outlineBucketFromEnv = (env: Env = process.env): string =>
  env.R2_OUTLINE_BUCKET?.trim() || DEFAULT_OUTLINE_BUCKET;

export function blobStoreFromEnv(env: Env = process.env): BlobStore {
  const value = (key: string) => env[key]?.trim() || undefined;
  const missing = R2_KEYS.filter((k) => !value(k));
  if (missing.length === 0) {
    const r2 = new R2BlobStore({
      endpoint: value("R2_ENDPOINT")!,
      outlineBucket: outlineBucketFromEnv(env),
      assetsBucket: value("R2_ASSETS_BUCKET") ?? DEFAULT_ASSETS_BUCKET,
      outline: {
        accessKeyId: value("R2_OUTLINE_ACCESS_KEY_ID")!,
        secretAccessKey: value("R2_OUTLINE_SECRET_ACCESS_KEY")!,
      },
      assets: {
        accessKeyId: value("R2_ASSETS_ACCESS_KEY_ID")!,
        secretAccessKey: value("R2_ASSETS_SECRET_ACCESS_KEY")!,
      },
    });
    return new CachedBlobStore(r2, value("ASSET_CACHE_DIR") ?? DEFAULT_CACHE_DIR);
  }
  const anySet = missing.length < R2_KEYS.length;
  if (env.NODE_ENV === "production" || anySet) {
    throw new Error(
      `R2 の設定が足りません。次の環境変数を設定してください: ${missing.join(", ")}`,
    );
  }
  return new FsBlobStore(value("ASSET_FS_DIR") ?? ".data/blobs");
}

let cached: BlobStore | undefined;

/** 最初の要求まで作らない（next build が設定なしでルートを読み込めるように）。 */
export function getBlobStore(): BlobStore {
  cached ??= blobStoreFromEnv();
  return cached;
}
