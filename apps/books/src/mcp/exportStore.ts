// export_book の生成物を、短い間だけ置いておく場所（CORE-203）。
// 端末の AI は Access の内側の URL を直接取れないので、起動役（claude-env の save_export）がこの ID で取りに来る。

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const EXPORT_TTL_MS = 60 * 60 * 1000;

export interface StoredExport {
  id: string;
  fileName: string;
  contentType: string;
  size: number;
  expiresAt: Date;
}

export interface ExportStore {
  put(bytes: Buffer, fileName: string, contentType: string): Promise<StoredExport>;
  get(id: string): Promise<(StoredExport & { bytes: Buffer }) | null>;
}

const ID = /^[A-Za-z0-9_-]{32}$/;

export function createExportStore(dir = path.join(tmpdir(), "postext-mcp-exports"), now: () => number = Date.now, ttlMs = EXPORT_TTL_MS): ExportStore {
  const index = new Map<string, StoredExport>();

  /** 期限を過ぎたものを消す。記録のないファイル（再起動の前の生成物）も、古ければ消す。 */
  async function sweep(): Promise<void> {
    const t = now();
    for (const [id, item] of index) {
      if (item.expiresAt.getTime() <= t) {
        index.delete(id);
        await rm(path.join(dir, id), { force: true });
      }
    }
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (index.has(name)) continue;
      const s = await stat(path.join(dir, name)).catch(() => null);
      if (s && t - s.mtimeMs > ttlMs) await rm(path.join(dir, name), { force: true });
    }
  }

  return {
    async put(bytes, fileName, contentType) {
      await mkdir(dir, { recursive: true });
      await sweep();
      const id = randomBytes(24).toString("base64url");
      await writeFile(path.join(dir, id), bytes);
      const item: StoredExport = { id, fileName, contentType, size: bytes.length, expiresAt: new Date(now() + ttlMs) };
      index.set(id, item);
      return item;
    },
    async get(id) {
      if (!ID.test(id)) return null;
      await sweep();
      const item = index.get(id);
      if (!item) return null;
      const bytes = await readFile(path.join(dir, id)).catch(() => null);
      return bytes ? { ...item, bytes } : null;
    },
  };
}

/** サーバーの中で1つだけ使う置き場。 */
let shared: ExportStore | undefined;
export const sharedExportStore = (): ExportStore => (shared ??= createExportStore());
