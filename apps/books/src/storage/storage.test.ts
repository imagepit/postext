import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlobIntegrityError, FsBlobStore, sha256Of } from "./blobStore";
import type { BlobRef, BlobStore } from "./blobStore";
import { CachedBlobStore } from "./cachedStore";
import { blobStoreFromEnv } from "./config";
import { R2BlobStore } from "./r2";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "blob-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const bytes = new TextEncoder().encode("画像のつもりのバイト列");

describe("FsBlobStore", () => {
  it("putPostext は sha256/<hex> の鍵で書き、同じ内容は何度書いても同じ参照", async () => {
    const store = new FsBlobStore(dir);
    const a = await store.putPostext(bytes, "image/png");
    const b = await store.putPostext(bytes, "image/png");
    expect(a).toEqual(b);
    expect(a).toEqual({ storage: "postext", key: `sha256/${sha256Of(bytes)}`, sha256: sha256Of(bytes), size: bytes.length, mime: "image/png" });
    expect([...(await store.get(a))]).toEqual([...bytes]);
    expect(await readdir(path.join(dir, "postext", "sha256"))).toHaveLength(1);
  });

  it("outline の鍵から読め、内容が参照の sha256 と違えば例外", async () => {
    const store = new FsBlobStore(dir);
    await store.putOutline("uploads/u/a/x.png", bytes);
    const ref: BlobRef = { storage: "outline", key: "uploads/u/a/x.png", sha256: sha256Of(bytes), size: bytes.length, mime: "image/png" };
    expect([...(await store.get(ref))]).toEqual([...bytes]);
    await expect(store.get({ ...ref, sha256: "0".repeat(64) })).rejects.toBeInstanceOf(BlobIntegrityError);
  });

  it("保存先の外へ出る鍵は拒否する", async () => {
    const store = new FsBlobStore(dir);
    const ref: BlobRef = { storage: "outline", key: "../x", sha256: "0".repeat(64), size: 1, mime: "x" };
    await expect(store.get(ref)).rejects.toThrow("不正な blob 鍵");
  });
});

class CountingStore implements BlobStore {
  gets = 0;
  failing = false;
  constructor(private readonly inner: BlobStore) {}
  async get(ref: BlobRef) {
    this.gets++;
    if (this.failing) throw new Error("R2 down");
    return this.inner.get(ref);
  }
  putPostext(b: Uint8Array, mime: string) {
    return this.inner.putPostext(b, mime);
  }
}

describe("CachedBlobStore", () => {
  it("1度読んだら R2 へ行かず、R2 が落ちていてもキャッシュから返す", async () => {
    const inner = new CountingStore(new FsBlobStore(path.join(dir, "origin")));
    const cached = new CachedBlobStore(inner, path.join(dir, "cache"));
    const ref = await inner.putPostext(bytes, "image/png");
    expect([...(await cached.get(ref))]).toEqual([...bytes]);
    expect(inner.gets).toBe(1);
    inner.failing = true;
    expect([...(await cached.get(ref))]).toEqual([...bytes]);
    expect(inner.gets).toBe(1);
  });

  it("キャッシュにないものは R2 の失敗がそのまま出る", async () => {
    const inner = new CountingStore(new FsBlobStore(path.join(dir, "origin")));
    const ref = await inner.putPostext(bytes, "image/png");
    inner.failing = true;
    await expect(new CachedBlobStore(inner, path.join(dir, "cache")).get(ref)).rejects.toThrow("R2 down");
  });

  it("壊れたキャッシュは捨てて取り直し、書き込み後に一時ファイルが残らない", async () => {
    const inner = new CountingStore(new FsBlobStore(path.join(dir, "origin")));
    const cacheDir = path.join(dir, "cache");
    const cached = new CachedBlobStore(inner, cacheDir);
    const ref = await inner.putPostext(bytes, "image/png");
    const sha = ref.sha256;
    await mkdir(path.join(cacheDir, sha.slice(0, 2)), { recursive: true });
    await writeFile(path.join(cacheDir, sha.slice(0, 2), sha), "corrupt");
    expect([...(await cached.get(ref))]).toEqual([...bytes]);
    expect(inner.gets).toBe(1);
    expect(await readdir(path.join(cacheDir, sha.slice(0, 2)))).toEqual([sha]);
  });

  it("キャッシュに書けなくても読み出しは成功する", async () => {
    const inner = new FsBlobStore(path.join(dir, "origin"));
    const ref = await inner.putPostext(bytes, "image/png");
    const blocker = path.join(dir, "file");
    await writeFile(blocker, "x");
    const cached = new CachedBlobStore(inner, path.join(blocker, "cache"));
    expect([...(await cached.get(ref))]).toEqual([...bytes]);
  });
});

describe("R2BlobStore", () => {
  const config = {
    endpoint: "https://acct.r2.cloudflarestorage.com/",
    outlineBucket: "outline-originals",
    assetsBucket: "postext-assets",
    outline: { accessKeyId: "OUTLINEKEY", secretAccessKey: "outline-secret" },
    assets: { accessKeyId: "ASSETSKEY", secretAccessKey: "assets-secret" },
  };

  function recorder(respond: (req: Request) => Response) {
    const seen: { method: string; url: string; headers: Headers; body: Uint8Array }[] = [];
    const fetchFn = async (req: Request) => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: new Uint8Array(await req.clone().arrayBuffer()) });
      return respond(req);
    };
    return { seen, fetchFn };
  }

  it("putPostext は HEAD が 404 のときだけ PUT し、パス形式 URL と SigV4 ヘッダーを付ける", async () => {
    const { seen, fetchFn } = recorder((req) => new Response(null, { status: req.method === "HEAD" ? 404 : 200 }));
    const ref = await new R2BlobStore(config, fetchFn).putPostext(bytes, "image/png");
    expect(seen.map((s) => s.method)).toEqual(["HEAD", "PUT"]);
    for (const s of seen) {
      expect(s.url).toBe(`https://acct.r2.cloudflarestorage.com/postext-assets/sha256/${ref.sha256}`);
      const auth = s.headers.get("authorization")!;
      expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=ASSETSKEY\/\d{8}\/auto\/s3\/aws4_request,/);
      expect(s.headers.get("x-amz-date")).toMatch(/^\d{8}T\d{6}Z$/);
      expect(s.headers.get("x-amz-content-sha256")).toBeTruthy();
    }
    expect(seen[1]!.headers.get("content-type")).toBe("image/png");
    expect([...seen[1]!.body]).toEqual([...bytes]);
  });

  it("すでにあれば PUT しない", async () => {
    const { seen, fetchFn } = recorder(() => new Response(null, { status: 200 }));
    await new R2BlobStore(config, fetchFn).putPostext(bytes, "image/png");
    expect(seen.map((s) => s.method)).toEqual(["HEAD"]);
  });

  it("HEAD が 404 以外の失敗なら書かずに例外", async () => {
    const { seen, fetchFn } = recorder(() => new Response(null, { status: 403 }));
    await expect(new R2BlobStore(config, fetchFn).putPostext(bytes, "image/png")).rejects.toThrow("403");
    expect(seen).toHaveLength(1);
  });

  it("outline の読み出しは outline バケットと読み取り用の鍵を使い、鍵はセグメントごとに符号化する", async () => {
    const { seen, fetchFn } = recorder(() => new Response(bytes, { status: 200 }));
    const ref: BlobRef = { storage: "outline", key: "uploads/u/a/図 1.png", sha256: sha256Of(bytes), size: bytes.length, mime: "image/png" };
    expect([...(await new R2BlobStore(config, fetchFn).get(ref))]).toEqual([...bytes]);
    expect(seen[0]!.url).toBe(`https://acct.r2.cloudflarestorage.com/outline-originals/uploads/u/a/${encodeURIComponent("図 1.png")}`);
    expect(seen[0]!.headers.get("authorization")).toContain("Credential=OUTLINEKEY/");
    expect(JSON.stringify([...seen[0]!.headers])).not.toContain("secret");
  });

  it("取得した内容の sha256 が違えば例外", async () => {
    const { fetchFn } = recorder(() => new Response("tampered", { status: 200 }));
    const ref: BlobRef = { storage: "postext", key: "k", sha256: sha256Of(bytes), size: 1, mime: "x" };
    await expect(new R2BlobStore(config, fetchFn).get(ref)).rejects.toBeInstanceOf(BlobIntegrityError);
  });

  it("GET の失敗は状態コードを含む例外", async () => {
    const { fetchFn } = recorder(() => new Response(null, { status: 404 }));
    const ref: BlobRef = { storage: "postext", key: "k", sha256: sha256Of(bytes), size: 1, mime: "x" };
    await expect(new R2BlobStore(config, fetchFn).get(ref)).rejects.toThrow("404");
  });
});

describe("blobStoreFromEnv", () => {
  const r2 = {
    R2_ENDPOINT: "https://a.r2.cloudflarestorage.com",
    R2_OUTLINE_ACCESS_KEY_ID: "a",
    R2_OUTLINE_SECRET_ACCESS_KEY: "b",
    R2_ASSETS_ACCESS_KEY_ID: "c",
    R2_ASSETS_SECRET_ACCESS_KEY: "d",
  };
  it("R2 の設定が揃えばキャッシュつきの R2", () => {
    expect(blobStoreFromEnv(r2)).toBeInstanceOf(CachedBlobStore);
  });
  it("設定がなく本番でなければ FS", () => {
    expect(blobStoreFromEnv({})).toBeInstanceOf(FsBlobStore);
    expect(blobStoreFromEnv({ NODE_ENV: "test" })).toBeInstanceOf(FsBlobStore);
  });
  it("本番で設定がなければ、足りない変数名を示して例外", () => {
    expect(() => blobStoreFromEnv({ NODE_ENV: "production" })).toThrow(/R2_ENDPOINT/);
  });
  it("一部だけの設定は環境を問わず例外", () => {
    const { R2_ENDPOINT, ...rest } = r2;
    expect(() => blobStoreFromEnv(rest)).toThrow(/R2_ENDPOINT/);
    expect(R2_ENDPOINT).toBeTruthy();
  });
});
