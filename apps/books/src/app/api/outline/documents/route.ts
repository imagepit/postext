import { createOutlineClient, OutlineHttpError, outlineConfigFromEnv } from "@/outline/client";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const config = outlineConfigFromEnv();
  if (!config) {
    return Response.json(
      { error: "Outlineに接続できません。環境変数 OUTLINE_URL と OUTLINE_API_TOKEN を設定してください" },
      { status: 503 },
    );
  }
  const parentId = new URL(request.url).searchParams.get("parentId") || undefined;
  try {
    const documents = await createOutlineClient(config).browse(parentId);
    return Response.json({ documents });
  } catch (error) {
    const status = error instanceof OutlineHttpError ? error.status : undefined;
    return Response.json(
      { error: status ? `Outlineがエラーを返しました (${status})` : "Outlineと通信できませんでした" },
      { status: 502 },
    );
  }
}
