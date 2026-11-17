import { describe, expect, it } from "vitest";
import { isAuthorized, requireKey } from "./auth";

describe("MCP のキーの照合", () => {
  it("Bearer のキーが一致したときだけ通す", () => {
    expect(isAuthorized("Bearer secret-key", "secret-key")).toBe(true);
    expect(isAuthorized("bearer  secret-key ", "secret-key")).toBe(true);
    expect(isAuthorized("Bearer other", "secret-key")).toBe(false);
    expect(isAuthorized("Bearer secret-key-longer", "secret-key")).toBe(false);
    expect(isAuthorized("secret-key", "secret-key")).toBe(false);
    expect(isAuthorized(null, "secret-key")).toBe(false);
  });

  it("サーバーのキーが未設定なら、すべて拒否する", () => {
    expect(isAuthorized("Bearer ", "")).toBe(false);
    expect(isAuthorized("Bearer x", undefined)).toBe(false);
    expect(isAuthorized("Bearer x", "  ")).toBe(false);
  });

  it("通らない要求は 401 と WWW-Authenticate を返す", async () => {
    const denied = requireKey(new Request("https://book-mcp.example/mcp"), { POSTEXT_MCP_KEY: "k" });
    expect(denied?.status).toBe(401);
    expect(denied?.headers.get("WWW-Authenticate")).toContain("Bearer");
    expect(requireKey(new Request("https://book-mcp.example/mcp", { headers: { Authorization: "Bearer k" } }), { POSTEXT_MCP_KEY: "k" })).toBeNull();
  });
});
