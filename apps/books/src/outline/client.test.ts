import { describe, expect, it } from "vitest";
import { createOutlineClient, outlineConfigFromEnv, OutlineHttpError, outlineObjectKeyFromUrl } from "./client";
import type { FetchFn } from "./client";

const config = { baseUrl: "https://outline.example", token: "tok" };

const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

describe("outline client", () => {
  it("環境変数が揃わなければ null", () => {
    expect(outlineConfigFromEnv({})).toBeNull();
    expect(outlineConfigFromEnv({ OUTLINE_URL: "https://o" })).toBeNull();
    expect(outlineConfigFromEnv({ OUTLINE_URL: "https://o/", OUTLINE_API_TOKEN: "t" })).toEqual({ baseUrl: "https://o", token: "t" });
  });

  it("子文書をコレクションの木の並び順で返す", async () => {
    const calls: string[] = [];
    const docs: Record<string, object> = {
      p: { id: "p", title: "親", text: "", updatedAt: "t", collectionId: "c" },
      x: { id: "x", title: "X", text: "xx", updatedAt: "t" },
      y: { id: "y", title: "Y", text: "yy", updatedAt: "t" },
    };
    const fetchFn: FetchFn = async (url, init) => {
      calls.push(url);
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
      const body = JSON.parse(String(init?.body));
      if (url.endsWith("/documents.info")) return json(docs[body.id]);
      if (url.endsWith("/collections.documents")) {
        return json([{ id: "z", title: "Z", children: [] }, { id: "p", title: "親", children: [{ id: "y", title: "Y" }, { id: "x", title: "X" }] }]);
      }
      return new Response("", { status: 404 });
    };
    const list = await createOutlineClient(config, fetchFn).listChildDocuments("p");
    expect(list.map((d) => d.id)).toEqual(["y", "x"]);
  });

  it("API の失敗は OutlineHttpError になり、トークンを含まない", async () => {
    const client = createOutlineClient(config, async () => new Response("", { status: 403 }));
    const error = await client.getDocument("a").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutlineHttpError);
    expect(String((error as Error).message)).not.toContain("tok");
  });

  it("添付ファイルはリダイレクトを辿り、別オリジンへは認証を送らない", async () => {
    const seen: { url: string; auth?: string }[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      seen.push({ url, auth: (init?.headers as Record<string, string>).Authorization });
      if (url.startsWith("https://outline.example")) {
        return new Response(null, { status: 302, headers: { location: "https://files.example/signed?x=1" } });
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
    };
    const file = await createOutlineClient(config, fetchFn).fetchAttachment("a b");
    expect([...file.bytes]).toEqual([1, 2, 3]);
    expect(file.contentType).toBe("image/png");
    expect(seen).toEqual([
      { url: "https://outline.example/api/attachments.redirect?id=a%20b", auth: "Bearer tok" },
      { url: "https://files.example/signed?x=1", auth: undefined },
    ]);
  });

  it("文書の本文を documents.update で置き換える", async () => {
    let sent: unknown;
    const fetchFn: FetchFn = async (url, init) => {
      expect(url).toBe("https://outline.example/api/documents.update");
      sent = JSON.parse(String(init?.body));
      return json({ id: "d", title: "題", text: "新しい本文", updatedAt: "2026-11-16T00:00:00Z" });
    };
    const doc = await createOutlineClient(config, fetchFn).updateDocument("d", "新しい本文");
    expect(sent).toEqual({ id: "d", text: "新しい本文" });
    expect(doc).toMatchObject({ id: "d", text: "新しい本文", updatedAt: "2026-11-16T00:00:00Z" });
  });

  it("添付は PUT の署名付き URL へ認証なしで送り、添付 ID と参照を返す", async () => {
    const seen: { url: string; method?: string; auth?: string; body?: unknown }[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url, method: init?.method, auth: headers.Authorization });
      if (url.endsWith("/attachments.create")) {
        expect(JSON.parse(String(init?.body))).toEqual({ documentId: "d", name: "fig.png", contentType: "image/png", size: 3, preset: "documentAttachment" });
        return json({ mode: "put", url: "https://r2.example/b/k?sig=1", headers: { "Content-Type": "image/png" }, attachment: { id: "att-1", url: "/api/attachments.redirect?id=att-1" } });
      }
      expect(headers["Content-Type"]).toBe("image/png");
      return new Response(null, { status: 200 });
    };
    const created = await createOutlineClient(config, fetchFn).createAttachment({ documentId: "d", name: "fig.png", contentType: "image/png", bytes: new Uint8Array([1, 2, 3]) });
    expect(created).toEqual({ id: "att-1", url: "/api/attachments.redirect?id=att-1" });
    expect(seen.map(({ url, method, auth }) => ({ url, method, auth }))).toEqual([
      { url: "https://outline.example/api/attachments.create", method: "POST", auth: "Bearer tok" },
      { url: "https://r2.example/b/k?sig=1", method: "PUT", auth: undefined },
    ]);
  });

  it("POST の送り先が Outline 自身なら、フォームに file を足して認証つきで送る", async () => {
    let form: FormData | undefined;
    let auth: string | undefined;
    const fetchFn: FetchFn = async (url, init) => {
      if (url.endsWith("/attachments.create")) {
        return json({ uploadUrl: "/api/files.create", form: { key: "uploads/k" }, attachment: { id: "att-2", url: "/api/attachments.redirect?id=att-2" } });
      }
      expect(url).toBe("https://outline.example/api/files.create");
      auth = (init?.headers as Record<string, string>).Authorization;
      form = init?.body as FormData;
      return new Response(null, { status: 200 });
    };
    const created = await createOutlineClient(config, fetchFn).createAttachment({ documentId: "d", name: "a.svg", contentType: "image/svg+xml", bytes: new Uint8Array([60]) });
    expect(created.id).toBe("att-2");
    expect(auth).toBe("Bearer tok");
    expect(form?.get("key")).toBe("uploads/k");
    expect(form?.get("file")).toBeInstanceOf(Blob);
  });

  it("送り先が失敗したら OutlineHttpError", async () => {
    const fetchFn: FetchFn = async (url) =>
      url.endsWith("/attachments.create")
        ? json({ mode: "put", url: "https://r2.example/x", attachment: { id: "a", url: "/u" } })
        : new Response(null, { status: 403 });
    const error = await createOutlineClient(config, fetchFn)
      .createAttachment({ documentId: "d", name: "x.png", contentType: "image/png", bytes: new Uint8Array([1]) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutlineHttpError);
  });
});

describe("outlineObjectKeyFromUrl", () => {
  const host = "https://acct.r2.cloudflarestorage.com";
  it("R2 の署名付き URL から outline バケット内の鍵（URL デコード済み）を取り出す", () => {
    expect(outlineObjectKeyFromUrl(`${host}/outline-originals/uploads/u1/a1/${encodeURIComponent("図 1.png")}?X-Amz-Signature=x`)).toBe("uploads/u1/a1/図 1.png");
  });
  it("R2 でないホスト、別のバケット、鍵なし、壊れた URL は undefined", () => {
    expect(outlineObjectKeyFromUrl("https://files.example/outline-originals/k?x=1")).toBeUndefined();
    expect(outlineObjectKeyFromUrl(`${host}/other-bucket/k`)).toBeUndefined();
    expect(outlineObjectKeyFromUrl(`${host}/outline-originals/`)).toBeUndefined();
    expect(outlineObjectKeyFromUrl(`${host}/outline-originals`)).toBeUndefined();
    expect(outlineObjectKeyFromUrl("not a url")).toBeUndefined();
    expect(outlineObjectKeyFromUrl(`${host}/outline-originals/%E0%A4%A`)).toBeUndefined();
  });
  it("バケット名は引数で変えられる", () => {
    expect(outlineObjectKeyFromUrl(`${host}/b2/k.png`, "b2")).toBe("k.png");
  });
});

describe("fetchAttachment の objectKey", () => {
  const signed = "https://acct.r2.cloudflarestorage.com/outline-originals/uploads/u/a/x.png?X-Amz-Signature=s";
  const fetchTo = (target: string): FetchFn => async (url) =>
    url.startsWith("https://outline.example")
      ? new Response(null, { status: 302, headers: { location: target } })
      : new Response(new Uint8Array([9]), { status: 200 });

  it("最後のリダイレクト先が R2 なら objectKey を返す", async () => {
    const file = await createOutlineClient(config, fetchTo(signed)).fetchAttachment("a");
    expect(file.objectKey).toBe("uploads/u/a/x.png");
  });
  it("R2 でなければ objectKey を持たない", async () => {
    const file = await createOutlineClient(config, fetchTo("https://files.example/signed?x=1")).fetchAttachment("a");
    expect("objectKey" in file).toBe(false);
  });
});
