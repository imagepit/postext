import type { DesignPart } from "postext";
// 保存したデザインの型と入力検査。サーバーとブラウザ側の保存先で共有する。

export const MAX_DESIGN_BYTES = 50 * 1024 * 1024;
export const DESIGN_META_HEADER = "x-design-meta";

export interface DesignMeta {
  id: string;
  name: string;
  description?: string;
  source?: string;
  parts: DesignPart[];
  createdAt: number;
  updatedAt: number;
}

export interface DesignSummary extends DesignMeta {
  size: number;
}

export interface DesignRecord extends DesignMeta {
  bytes: Buffer;
}

export interface DesignRepository {
  list(): Promise<DesignSummary[]>;
  get(id: string): Promise<DesignRecord | null>;
  upsert(design: DesignRecord): Promise<void>;
  delete(id: string): Promise<boolean>;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidDesignId(id: unknown): id is string {
  return typeof id === "string" && ID_PATTERN.test(id);
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const isTimestamp = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export function parseDesignMeta(id: string, raw: unknown): Result<DesignMeta> {
  if (!isValidDesignId(id)) return { ok: false, error: "invalid design id" };
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "metadata must be an object" };
  const m = raw as Record<string, unknown>;
  if (typeof m.name !== "string" || m.name.trim() === "" || m.name.length > 500) {
    return { ok: false, error: "name must be a non-empty string up to 500 characters" };
  }
  for (const key of ["description", "source"] as const) {
    const v = m[key];
    if (v !== undefined && v !== null && (typeof v !== "string" || v.length > 10000)) {
      return { ok: false, error: `${key} must be a string` };
    }
  }
  if (!Array.isArray(m.parts) || !m.parts.every((p) => typeof p === "string")) {
    return { ok: false, error: "parts must be an array of strings" };
  }
  if (!isTimestamp(m.createdAt) || !isTimestamp(m.updatedAt)) {
    return { ok: false, error: "createdAt and updatedAt must be millisecond integers" };
  }
  return {
    ok: true,
    value: {
      id,
      name: m.name,
      ...(typeof m.description === "string" && m.description ? { description: m.description } : {}),
      ...(typeof m.source === "string" && m.source ? { source: m.source } : {}),
      parts: m.parts as DesignPart[],
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    },
  };
}
