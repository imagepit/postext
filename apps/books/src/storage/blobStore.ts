// 画像・フォントのバイト列の置き場。DB には参照（BlobRef）だけを持つ。
//
// - "outline": Outline が自分の添付に使う R2 バケット（outline-originals）。読み取り専用で、鍵は Outline が決める。
// - "postext": このアプリが書き込むバケット（postext-assets）。鍵は内容の sha256 で、同じ内容は1つしか持たない。

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type BlobStorage = "outline" | "postext";

export interface BlobRef {
  storage: BlobStorage;
  key: string;
  sha256: string;
  size: number;
  mime: string;
}

export interface BlobStore {
  /** 参照先のバイト列を返す。sha256 が参照と違えば例外。 */
  get(ref: BlobRef): Promise<Uint8Array>;
  /** postext 側へ書く。鍵は `sha256/<hex>`。すでにあれば書かない。 */
  putPostext(bytes: Uint8Array, mime: string): Promise<BlobRef>;
}

export const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export const postextKey = (sha256: string): string => `sha256/${sha256}`;

export class BlobIntegrityError extends Error {
  constructor(ref: BlobRef, actual: string) {
    super(`blob ${ref.storage}:${ref.key} の sha256 が一致しません（期待 ${ref.sha256}、実際 ${actual}）`);
  }
}

export function verifyBlob(ref: BlobRef, bytes: Uint8Array): Uint8Array {
  const actual = sha256Of(bytes);
  if (actual !== ref.sha256) throw new BlobIntegrityError(ref, actual);
  return bytes;
}

export function postextRef(bytes: Uint8Array, mime: string): BlobRef {
  const sha256 = sha256Of(bytes);
  return { storage: "postext", key: postextKey(sha256), sha256, size: bytes.length, mime };
}

/** ".." などで保存先の外へ出る鍵を拒否する。 */
function safeKey(key: string): string {
  const parts = key.split("/");
  if (key === "" || parts.some((p) => p === "" || p === "." || p === "..") || key.includes("\0")) {
    throw new Error(`不正な blob 鍵です: ${key}`);
  }
  return key;
}

export async function writeFileAtomic(file: string, bytes: Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, file);
}

/** ディレクトリを保存先にする実装。開発とテスト用で、storage ごとに下位ディレクトリを分ける。 */
export class FsBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private fileOf(storage: BlobStorage, key: string): string {
    return path.join(this.root, storage, ...safeKey(key).split("/"));
  }

  async get(ref: BlobRef): Promise<Uint8Array> {
    const bytes = await readFile(this.fileOf(ref.storage, ref.key));
    return verifyBlob(ref, new Uint8Array(bytes));
  }

  async putPostext(bytes: Uint8Array, mime: string): Promise<BlobRef> {
    const ref = postextRef(bytes, mime);
    const file = this.fileOf("postext", ref.key);
    const exists = await stat(file).then(() => true, () => false);
    if (!exists) await writeFileAtomic(file, bytes);
    return ref;
  }

  /** テスト用。Outline 側のオブジェクトを置く。 */
  async putOutline(key: string, bytes: Uint8Array): Promise<void> {
    await writeFileAtomic(this.fileOf("outline", key), bytes);
  }
}
