import { requireKey } from "@/mcp/auth";
import { OutlineHttpError } from "@/outline/client";
import { publishCourse } from "@/outline/publish";
import { publishDeps, readCourseInput } from "../input";

// CORE-229: Outline のサーバーが「書籍出版」の欄のために呼ぶ。MCP と同じキーと Access のサービストークンで守る。

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const denied = requireKey(request);
  if (denied) return denied;
  const input = readCourseInput(await request.json().catch(() => undefined));
  if (typeof input === "string") return Response.json({ error: input }, { status: 400 });
  const deps = publishDeps();
  if (!deps) return Response.json({ error: "Outlineに接続する設定がありません" }, { status: 503 });
  try {
    return Response.json(await publishCourse(deps, input), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof OutlineHttpError) return Response.json({ error: `Outlineがエラーを返しました (${error.status})` }, { status: 502 });
    return Response.json({ error: error instanceof Error ? error.message : "失敗しました" }, { status: 500 });
  }
}
