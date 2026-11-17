// MCP の入口の認証（CORE-203）。Authorization: Bearer のキーを、環境変数 POSTEXT_MCP_KEY と照合する。
// Cloudflare Access のサービストークンは Access が確かめるので、ここではアプリのキーだけを見る。

import { createHash, timingSafeEqual } from "node:crypto";

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/** キーが一致すれば true。期待するキーが空なら、すべて拒否する。比較は長さに依らない時間で行う。 */
export function isAuthorized(authorization: string | null, expected: string | undefined): boolean {
  const key = expected?.trim();
  if (!key) return false;
  const m = /^Bearer\s+(.+)$/i.exec(authorization?.trim() ?? "");
  if (!m) return false;
  return timingSafeEqual(digest(m[1]!.trim()), digest(key));
}

export const unauthorized = (): Response =>
  Response.json(
    { error: "unauthorized" },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="postext-mcp"', "Cache-Control": "no-store" } },
  );

/** 要求の認証。通らなければ 401 の応答、通れば null。 */
export function requireKey(request: Request, env: Record<string, string | undefined> = process.env): Response | null {
  return isAuthorized(request.headers.get("authorization"), env.POSTEXT_MCP_KEY) ? null : unauthorized();
}
