import { requireKey } from "@/mcp/auth";
import { sharedExportStore } from "@/mcp/exportStore";

// CORE-203: export_book の生成物を返す。MCP と同じキーで守る（claude-env の save_export が取りに来る）。

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ exportId: string }> };

export async function GET(request: Request, { params }: Context) {
  const denied = requireKey(request);
  if (denied) return denied;
  const { exportId } = await params;
  const item = await sharedExportStore().get(exportId);
  if (!item) return Response.json({ error: "export not found or expired" }, { status: 404 });
  return new Response(new Uint8Array(item.bytes), {
    headers: {
      "Content-Type": item.contentType,
      "Content-Length": String(item.size),
      "Content-Disposition": `attachment; filename="export"; filename*=UTF-8''${encodeURIComponent(item.fileName)}`,
      "Cache-Control": "no-store",
    },
  });
}
