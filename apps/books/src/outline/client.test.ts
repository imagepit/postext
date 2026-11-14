import { describe, expect, it } from "vitest";
import { createOutlineClient, outlineConfigFromEnv, OutlineHttpError } from "./client";
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
});
