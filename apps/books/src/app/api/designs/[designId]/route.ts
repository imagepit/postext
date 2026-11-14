import { getDb } from "@/db/client";
import {
  DESIGN_META_HEADER,
  MAX_DESIGN_BYTES,
  isValidDesignId,
  parseDesignMeta,
} from "@/designs/model";
import { createPgDesignRepository } from "@/designs/repository";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ designId: string }> };

const bad = (error: string, status = 400) => Response.json({ error }, { status });

// GET: デザインファイル本体を返す。メタデータは X-Design-Meta（encodeURIComponent した JSON）。
export async function GET(_request: Request, { params }: Ctx) {
  const { designId } = await params;
  if (!isValidDesignId(designId)) return bad("invalid design id");
  const d = await createPgDesignRepository(getDb()).get(designId);
  if (!d) return bad("design not found", 404);
  const { bytes, ...meta } = d;
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(bytes.byteLength),
      [DESIGN_META_HEADER]: encodeURIComponent(JSON.stringify(meta)),
      "cache-control": "no-store",
    },
  });
}

// PUT: 本体は生のバイナリ、メタデータは X-Design-Meta。50 MB まで。
export async function PUT(request: Request, { params }: Ctx) {
  const { designId } = await params;
  if (!isValidDesignId(designId)) return bad("invalid design id");
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_DESIGN_BYTES) return bad("design file too large", 413);

  let raw: unknown;
  try {
    raw = JSON.parse(decodeURIComponent(request.headers.get(DESIGN_META_HEADER) ?? ""));
  } catch {
    return bad("X-Design-Meta must be URL-encoded JSON");
  }
  const meta = parseDesignMeta(designId, raw);
  if (!meta.ok) return bad(meta.error);

  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.byteLength === 0) return bad("design file is empty");
  if (bytes.byteLength > MAX_DESIGN_BYTES) return bad("design file too large", 413);

  await createPgDesignRepository(getDb()).upsert({ ...meta.value, bytes });
  return new Response(null, { status: 204 });
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const { designId } = await params;
  if (!isValidDesignId(designId)) return bad("invalid design id");
  const removed = await createPgDesignRepository(getDb()).delete(designId);
  return removed ? new Response(null, { status: 204 }) : bad("design not found", 404);
}
