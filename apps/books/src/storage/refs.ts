// 保存する資産に、バイト列の参照（BlobRef）を決める。DB を知らない純粋寄りの処理で、repository と移行スクリプトが共有する。

import { sha256Of } from "./blobStore";
import type { BlobRef, BlobStore } from "./blobStore";

export interface AssetBytes {
  path: string;
  mime: string;
  bytes: Uint8Array;
  /** 取得元がすでに分かっている参照。sha256 が一致するときだけ使う。 */
  ref?: BlobRef;
  /** Outline の添付なら、outline バケット内の鍵。 */
  outlineKey?: string;
}

/** すでに保存済みの参照。path で同じ資産を、sha256 で同じ内容を探せる。 */
export interface KnownRefs {
  byPath: Map<string, BlobRef>;
  bySha: Map<string, BlobRef>;
}

export function knownRefs(entries: { path: string; ref: BlobRef }[]): KnownRefs {
  const byPath = new Map<string, BlobRef>();
  const bySha = new Map<string, BlobRef>();
  for (const { path, ref } of entries) {
    byPath.set(path, ref);
    const other = bySha.get(ref.sha256);
    // 同じ内容なら、Outline 側の参照を残す（こちらは書き込み不要で、元の鍵も消えない）。
    if (!other || (other.storage !== "outline" && ref.storage === "outline")) bySha.set(ref.sha256, ref);
  }
  return { byPath, bySha };
}

export const noKnownRefs = (): KnownRefs => knownRefs([]);

const CONCURRENCY = 4;

/**
 * 資産ごとの参照を決める。順に:
 * 1. 取得元の参照（ref）が内容と一致すればそれ
 * 2. 同じ path の既存参照が同じ sha256 ならそれ（再アップロードしない。outline の参照も保つ）
 * 3. 同じ sha256 の既存参照
 * 4. Outline の鍵が分かっていれば outline 参照（書き込みなし）
 * 5. それ以外は postext バケットへ書く
 */
export async function resolveAssetRefs(
  store: BlobStore,
  assets: AssetBytes[],
  known: KnownRefs = noKnownRefs(),
): Promise<Map<string, BlobRef>> {
  const out = new Map<string, BlobRef>();
  async function decide(a: AssetBytes): Promise<BlobRef> {
    const sha256 = sha256Of(a.bytes);
    const withMime = (r: BlobRef): BlobRef => ({ ...r, mime: a.mime, size: a.bytes.length });
    if (a.ref && a.ref.sha256 === sha256) return withMime(a.ref);
    const samePath = known.byPath.get(a.path);
    if (samePath && samePath.sha256 === sha256) return withMime(samePath);
    const sameContent = known.bySha.get(sha256);
    if (sameContent) return withMime(sameContent);
    if (a.outlineKey) {
      return { storage: "outline", key: a.outlineKey, sha256, size: a.bytes.length, mime: a.mime };
    }
    return store.putPostext(a.bytes, a.mime);
  }

  const queue = [...assets];
  async function worker(): Promise<void> {
    for (let a = queue.shift(); a; a = queue.shift()) {
      out.set(a.path, await decide(a));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return out;
}
