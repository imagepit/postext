// BlobStore の前段に置くディスクキャッシュ。内容の sha256 で引くので、中身は変わらず無効化は要らない。

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { sha256Of, verifyBlob, writeFileAtomic } from "./blobStore";
import type { BlobRef, BlobStore } from "./blobStore";

export class CachedBlobStore implements BlobStore {
  constructor(
    private readonly inner: BlobStore,
    private readonly dir: string,
  ) {}

  private fileOf(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`不正な sha256 です: ${sha256}`);
    return path.join(this.dir, sha256.slice(0, 2), sha256);
  }

  private async readCache(ref: BlobRef): Promise<Uint8Array | null> {
    try {
      const bytes = new Uint8Array(await readFile(this.fileOf(ref.sha256)));
      // 壊れたキャッシュは使わず、取り直す。
      return sha256Of(bytes) === ref.sha256 ? bytes : null;
    } catch {
      return null;
    }
  }

  private async writeCache(sha256: string, bytes: Uint8Array): Promise<void> {
    try {
      const file = this.fileOf(sha256);
      if (await stat(file).then(() => true, () => false)) return;
      await writeFileAtomic(file, bytes);
    } catch (error) {
      // キャッシュは最適化なので、書けなくても読み出しは成功させる。
      console.warn("asset cache write failed:", error instanceof Error ? error.message : error);
    }
  }

  async get(ref: BlobRef): Promise<Uint8Array> {
    // 鍵が sha256 なので、キャッシュにあれば R2 へ行かない。R2 が落ちていても読める。
    const cached = await this.readCache(ref);
    if (cached) return cached;
    const bytes = verifyBlob(ref, await this.inner.get(ref));
    await this.writeCache(ref.sha256, bytes);
    return bytes;
  }

  async putPostext(bytes: Uint8Array, mime: string): Promise<BlobRef> {
    const ref = await this.inner.putPostext(bytes, mime);
    await this.writeCache(ref.sha256, bytes);
    return ref;
  }
}
