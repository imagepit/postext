import type { SavedDesign, SavedDesignStorage, SavedDesignSummary } from "postext-sandbox";
import { DESIGN_META_HEADER, type DesignMeta, type DesignSummary } from "./model";

async function fail(res: Response, what: string): Promise<never> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") detail = `: ${body.error}`;
  } catch {
    // 本文が JSON でなければ状態コードだけを示す。
  }
  throw new Error(`${what} failed (${res.status})${detail}`);
}

const summary = ({ size: _size, ...d }: DesignSummary): SavedDesignSummary => d;

/** books アプリの /api/designs を保存先にする。一覧はメタデータだけで、ファイルは get() で取る。 */
export function createServerDesignStore(base = "/api/designs"): SavedDesignStorage {
  return {
    async list() {
      const res = await fetch(base, { cache: "no-store" });
      if (!res.ok) return fail(res, "Listing saved designs");
      const { designs } = (await res.json()) as { designs: DesignSummary[] };
      return designs.map(summary);
    },

    async get(id) {
      const res = await fetch(`${base}/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (res.status === 404) return null;
      if (!res.ok) return fail(res, "Loading the saved design");
      const meta = JSON.parse(decodeURIComponent(res.headers.get(DESIGN_META_HEADER) ?? "")) as DesignMeta;
      return { ...meta, bytes: await res.arrayBuffer() } satisfies SavedDesign;
    },

    async put(d) {
      const { bytes, ...meta } = d;
      const res = await fetch(`${base}/${encodeURIComponent(d.id)}`, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          [DESIGN_META_HEADER]: encodeURIComponent(JSON.stringify(meta)),
        },
        body: bytes,
      });
      if (!res.ok) return fail(res, "Saving the design");
    },

    async delete(id) {
      const res = await fetch(`${base}/${encodeURIComponent(id)}`, { method: "DELETE" });
      // すでに無いものを消す要求は成功とみなす。
      if (!res.ok && res.status !== 404) return fail(res, "Deleting the saved design");
    },
  };
}
