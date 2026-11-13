import { createHash } from "node:crypto";

export type AssetKind = "resource" | "font";

export interface ChapterContent {
  title: string;
  locale: string;
  markdown: string;
}

export interface AssetMeta {
  kind: AssetKind;
  path: string;
  mime: string;
  sha256: string;
  size: number;
}

export interface AssetData extends AssetMeta {
  bytes: Buffer;
}

/** 主言語以外の言語の版。主言語の題名・設定・資源は BookContent 本体にある。 */
export interface BookEdition {
  locale: string;
  name: string;
  description?: string;
  config: Record<string, unknown>;
  resources: Record<string, unknown>[];
  start?: Record<string, unknown>;
}

/**
 * 書籍の中身。版の復元と保存はこの単位で書き戻す。
 * chapters は全言語の章で、主言語の章を先に並べる。locale などを省くと単一言語として扱う。
 */
export interface BookContent {
  title: string;
  config: Record<string, unknown>;
  resources: Record<string, unknown>[];
  chapters: ChapterContent[];
  /** 主言語。省くと先頭の章の言語。 */
  locale?: string;
  sharedConfig?: Record<string, unknown> | null;
  editions?: BookEdition[];
}

export interface Book extends BookContent {
  id: string;
  revision: number;
  assets: AssetMeta[];
  createdAt: Date;
  updatedAt: Date;
}

export interface BookWithAssetData extends BookContent {
  id: string;
  revision: number;
  assets: AssetData[];
}

export interface BookSummary {
  id: string;
  title: string;
  revision: number;
  updatedAt: Date;
}

export interface VersionSummary {
  id: string;
  number: number;
  label: string;
  revision: number;
  createdAt: Date;
}

export type Failure =
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "conflict"; revision: number };

export type Result<T> = ({ ok: true } & T) | Failure;

/** 保存側の入力。assets を省くと既存の資産を残す。 */
export interface BookWrite extends BookContent {
  assets?: AssetData[];
}

/** usecases が必要とする保存先。PostgreSQL 版は repository.ts にある。 */
export interface BookRepository {
  create(content: BookWrite): Promise<Book>;
  list(): Promise<BookSummary[]>;
  get(id: string): Promise<Book | null>;
  getWithAssetData(id: string): Promise<BookWithAssetData | null>;
  /** revision が baseRevision と一致するときだけ書き換えて revision を1増やす。判定と書き換えは原子的。 */
  replace(
    id: string,
    baseRevision: number,
    content: BookWrite,
  ): Promise<Result<{ revision: number }>>;
  addVersion(
    bookId: string,
    version: { label: string; revision: number; bundle: Buffer },
  ): Promise<VersionSummary | null>;
  listVersions(bookId: string): Promise<VersionSummary[] | null>;
  getVersionBundle(bookId: string, versionId: string): Promise<Buffer | null>;
}

export const INITIAL_REVISION = 0;

export function nextRevision(current: number): number {
  return current + 1;
}

export function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= INITIAL_REVISION;
}

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 不正な形の ID は PostgreSQL が型エラーにするので、境界で存在しない ID として扱う。 */
export const isUuid = (value: string): boolean => UUID.test(value);

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function parseAsset(input: unknown, index: number): Parsed<AssetData> {
  if (!isRecord(input)) return fail(`assets[${index}] must be an object`);
  const { kind, path, mime, dataBase64 } = input;
  if (kind !== "resource" && kind !== "font") return fail(`assets[${index}].kind must be "resource" or "font"`);
  if (typeof path !== "string" || path === "") return fail(`assets[${index}].path must be a non-empty string`);
  if (typeof mime !== "string" || mime === "") return fail(`assets[${index}].mime must be a non-empty string`);
  if (typeof dataBase64 !== "string") return fail(`assets[${index}].dataBase64 must be a string`);
  const bytes = Buffer.from(dataBase64, "base64");
  return {
    ok: true,
    value: { kind, path, mime, bytes, sha256: sha256Hex(bytes), size: bytes.length },
  };
}

/** PUT と POST の本文を検証する。保存は全置き換えなので、章は1つ以上を要求する（.postext は章なしで作れない）。 */
export function parseBookWrite(input: unknown): Parsed<BookWrite> {
  if (!isRecord(input)) return fail("body must be a JSON object");
  const { title, config = {}, resources = [], chapters, assets, locale, sharedConfig, editions } = input;
  if (typeof title !== "string" || title.trim() === "") return fail("title must be a non-empty string");
  if (!isRecord(config)) return fail("config must be an object");
  if (!Array.isArray(resources) || !resources.every(isRecord)) return fail("resources must be an array of objects");
  if (!Array.isArray(chapters) || chapters.length === 0) return fail("chapters must be a non-empty array");
  const parsedChapters: ChapterContent[] = [];
  for (const [i, c] of chapters.entries()) {
    if (!isRecord(c)) return fail(`chapters[${i}] must be an object`);
    if (typeof c.title !== "string") return fail(`chapters[${i}].title must be a string`);
    if (typeof c.locale !== "string" || c.locale === "") return fail(`chapters[${i}].locale must be a non-empty string`);
    if (typeof c.markdown !== "string") return fail(`chapters[${i}].markdown must be a string`);
    parsedChapters.push({ title: c.title, locale: c.locale, markdown: c.markdown });
  }
  const value: BookWrite = {
    title,
    config,
    resources: resources as Record<string, unknown>[],
    chapters: parsedChapters,
  };
  if (locale !== undefined && (typeof locale !== "string" || locale === "")) {
    return fail("locale must be a non-empty string");
  }
  if (sharedConfig !== undefined && sharedConfig !== null && !isRecord(sharedConfig)) {
    return fail("sharedConfig must be an object or null");
  }
  if (editions !== undefined && !Array.isArray(editions)) return fail("editions must be an array");
  if (locale !== undefined || sharedConfig !== undefined || editions !== undefined) {
    const primary = locale ?? parsedChapters[0]!.locale;
    const parsedEditions: BookEdition[] = [];
    const locales = new Set<string>([primary]);
    for (const [i, e] of (editions ?? []).entries()) {
      if (!isRecord(e)) return fail(`editions[${i}] must be an object`);
      if (typeof e.locale !== "string" || e.locale === "") return fail(`editions[${i}].locale must be a non-empty string`);
      if (locales.has(e.locale)) return fail(`editions[${i}].locale is duplicated or equals the primary locale`);
      locales.add(e.locale);
      if (typeof e.name !== "string") return fail(`editions[${i}].name must be a string`);
      if (e.description !== undefined && typeof e.description !== "string") return fail(`editions[${i}].description must be a string`);
      if (!isRecord(e.config)) return fail(`editions[${i}].config must be an object`);
      if (!Array.isArray(e.resources) || !e.resources.every(isRecord)) return fail(`editions[${i}].resources must be an array of objects`);
      if (e.start !== undefined && e.start !== null && !isRecord(e.start)) return fail(`editions[${i}].start must be an object`);
      parsedEditions.push({
        locale: e.locale,
        name: e.name,
        ...(e.description !== undefined ? { description: e.description } : {}),
        config: e.config,
        resources: e.resources as Record<string, unknown>[],
        ...(e.start ? { start: e.start } : {}),
      });
    }
    if (editions !== undefined) {
      for (const [i, c] of parsedChapters.entries()) {
        if (!locales.has(c.locale)) return fail(`chapters[${i}].locale must be the primary locale or an edition locale`);
      }
    }
    value.locale = primary;
    if (sharedConfig !== undefined) value.sharedConfig = sharedConfig;
    if (editions !== undefined) value.editions = parsedEditions;
  }
  if (assets !== undefined) {
    if (!Array.isArray(assets)) return fail("assets must be an array");
    const parsedAssets: AssetData[] = [];
    const seen = new Set<string>();
    for (const [i, a] of assets.entries()) {
      const parsed = parseAsset(a, i);
      if (!parsed.ok) return parsed;
      if (seen.has(parsed.value.path)) return fail(`assets[${i}].path is duplicated`);
      seen.add(parsed.value.path);
      parsedAssets.push(parsed.value);
    }
    value.assets = parsedAssets;
  }
  return { ok: true, value };
}
