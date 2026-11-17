import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getDb } from "@/db/client";
import { createPgRepository } from "@/books/repository";
import { requireKey } from "@/mcp/auth";
import { sharedExportStore } from "@/mcp/exportStore";
import { createMcpServer } from "@/mcp/server";

// CORE-203: 端末の AI 向けの MCP の入口（Streamable HTTP、状態を持たない）。
// 公開は book-mcp.image-pit.com の /mcp だけで、Cloudflare Access のサービストークンと Bearer キーの両方を通る。

export const dynamic = "force-dynamic";
// export_book は数十秒かかる。
export const maxDuration = 300;

async function handle(request: Request): Promise<Response> {
  const denied = requireKey(request);
  if (denied) return denied;
  const server = createMcpServer({ repo: createPgRepository(getDb()), exports: sharedExportStore() });
  // 要求ごとにサーバーと送受信を作る（セッションを持たない）。応答は JSON で返す。
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    void server.close();
  }
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
