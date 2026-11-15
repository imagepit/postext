// Cloudflare R2（S3 互換）を読み書きする BlobStore。SigV4 署名は aws4fetch に任せる。

import { AwsClient } from "aws4fetch";
import { postextRef, verifyBlob } from "./blobStore";
import type { BlobRef, BlobStore } from "./blobStore";

export type FetchLike = (request: Request) => Promise<Response>;

export interface R2Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface R2Config {
  /** 例: https://<account>.r2.cloudflarestorage.com */
  endpoint: string;
  outlineBucket: string;
  assetsBucket: string;
  /** outline バケットの読み取り専用の鍵。 */
  outline: R2Credentials;
  /** postext バケットの読み書きの鍵。 */
  assets: R2Credentials;
}

export class R2HttpError extends Error {
  constructor(
    readonly status: number,
    action: string,
    target: string,
  ) {
    super(`R2 ${action} ${target} が ${status} を返しました`);
  }
}

const encodeKey = (key: string): string => key.split("/").map(encodeURIComponent).join("/");

export class R2BlobStore implements BlobStore {
  private readonly clients: { outline: AwsClient; postext: AwsClient };

  constructor(
    private readonly config: R2Config,
    private readonly fetchFn: FetchLike = (request) => fetch(request),
  ) {
    const client = (c: R2Credentials) =>
      new AwsClient({ accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, service: "s3", region: "auto" });
    this.clients = { outline: client(config.outline), postext: client(config.assets) };
  }

  private urlOf(ref: Pick<BlobRef, "storage" | "key">): string {
    const bucket = ref.storage === "outline" ? this.config.outlineBucket : this.config.assetsBucket;
    // パス形式。バケット名をホストに入れない。
    return `${this.config.endpoint.replace(/\/+$/, "")}/${bucket}/${encodeKey(ref.key)}`;
  }

  private async send(
    storage: "outline" | "postext",
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: Uint8Array },
  ): Promise<Response> {
    const signed = await this.clients[storage].sign(url, {
      method: init.method,
      ...(init.headers ? { headers: init.headers } : {}),
      ...(init.body ? { body: init.body as BodyInit } : {}),
    });
    return this.fetchFn(signed);
  }

  async get(ref: BlobRef): Promise<Uint8Array> {
    const response = await this.send(ref.storage, this.urlOf(ref), { method: "GET" });
    if (!response.ok) throw new R2HttpError(response.status, "GET", `${ref.storage}:${ref.key}`);
    return verifyBlob(ref, new Uint8Array(await response.arrayBuffer()));
  }

  async putPostext(bytes: Uint8Array, mime: string): Promise<BlobRef> {
    const ref = postextRef(bytes, mime);
    const url = this.urlOf(ref);
    const head = await this.send("postext", url, { method: "HEAD" });
    if (head.ok) return ref;
    if (head.status !== 404) throw new R2HttpError(head.status, "HEAD", ref.key);
    const put = await this.send("postext", url, {
      method: "PUT",
      headers: { "Content-Type": mime },
      body: bytes,
    });
    if (!put.ok) throw new R2HttpError(put.status, "PUT", ref.key);
    return ref;
  }
}
