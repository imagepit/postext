// 変換で集めた画像と表を、Postext のリソースと資産（AssetData）にする。

import type { AssetData } from "@/books/model";
import { sha256Hex } from "@/books/model";
import type { ConvertedImage, ConvertedTable } from "./convert";

export interface ImageHeader {
  format: "png" | "jpeg" | "gif" | "webp";
  mime: string;
  ext: string;
  width: number;
  height: number;
}

const be32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const be16 = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const le16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const le24 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.slice(o, o + n));

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) {
      o++;
      continue;
    }
    const type = b[o + 1]!;
    if (type === 0xff) {
      o++;
      continue;
    }
    if (type === 0xd8 || type === 0x01 || (type >= 0xd0 && type <= 0xd7)) {
      o += 2;
      continue;
    }
    const length = be16(b, o + 2);
    if (type >= 0xc0 && type <= 0xcf && type !== 0xc4 && type !== 0xc8 && type !== 0xcc) {
      return { height: be16(b, o + 5), width: be16(b, o + 7) };
    }
    o += 2 + length;
  }
  return null;
}

function webpSize(b: Uint8Array): { width: number; height: number } | null {
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 " && b.length >= 30) return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  if (chunk === "VP8L" && b.length >= 25 && b[20] === 0x2f) {
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X" && b.length >= 30) return { width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
  return null;
}

/** ファイル先頭のバイトから形式と画素数を読む。読めなければ null。 */
export function readImageHeader(b: Uint8Array): ImageHeader | null {
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG") {
    const width = be32(b, 16);
    const height = be32(b, 20);
    return width > 0 && height > 0 ? { format: "png", mime: "image/png", ext: "png", width, height } : null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    const size = jpegSize(b);
    return size && size.width > 0 && size.height > 0 ? { format: "jpeg", mime: "image/jpeg", ext: "jpg", ...size } : null;
  }
  if (b.length >= 10 && ascii(b, 0, 4) === "GIF8") {
    const width = le16(b, 6);
    const height = le16(b, 8);
    return width > 0 && height > 0 ? { format: "gif", mime: "image/gif", ext: "gif", width, height } : null;
  }
  if (b.length >= 16 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const size = webpSize(b);
    return size && size.width > 0 && size.height > 0 ? { format: "webp", mime: "image/webp", ext: "webp", ...size } : null;
  }
  return null;
}

export const assetPathOf = (attachmentId: string, ext: string): string => `outline/${attachmentId}.${ext}`;

export function buildImageResource(
  image: ConvertedImage,
  header: ImageHeader,
  now: number,
): Record<string, unknown> {
  return {
    id: image.resourceId,
    typeId: "figure",
    kind: "bitmap",
    ...(image.alt ? { caption: image.alt, altText: image.alt } : {}),
    createdAt: now,
    updatedAt: now,
    bitmap: {
      fileId: assetPathOf(image.attachmentId, header.ext),
      format: header.format,
      width: header.width,
      height: header.height,
    },
    placement: {
      position: "here",
      ...(image.widthPercent !== undefined ? { width: image.widthPercent / 100 } : {}),
    },
  };
}

export function buildTableResource(table: ConvertedTable, now: number): Record<string, unknown> {
  const cell = (content: string, col: number, isHeader: boolean) => ({
    content,
    ...(isHeader ? { isHeader: true } : {}),
    ...(table.align[col] ? { align: table.align[col] } : {}),
  });
  return {
    id: table.id,
    typeId: "table",
    kind: "table",
    createdAt: now,
    updatedAt: now,
    table: {
      model: {
        rows: [
          table.header.map((c, i) => cell(c, i, true)),
          ...table.rows.map((r) => r.map((c, i) => cell(c, i, false))),
        ],
        headerRowCount: 1,
      },
    },
    placement: { position: "here" },
  };
}

export interface FetchedAttachment {
  bytes: Uint8Array;
  contentType: string;
}

export interface BuiltResources {
  resources: Record<string, unknown>[];
  assets: AssetData[];
  warnings: string[];
}

/** 画像は attachmentId ごとに1度だけ取得する。取得や解析に失敗した画像はリソースを作らず警告にする。 */
export async function buildResources(
  input: { images: ConvertedImage[]; tables: ConvertedTable[] },
  fetchAttachment: (attachmentId: string) => Promise<FetchedAttachment>,
  now: number,
): Promise<BuiltResources> {
  const resources: Record<string, unknown>[] = [];
  const assets = new Map<string, AssetData>();
  const warnings: string[] = [];
  const fetched = new Map<string, { header: ImageHeader; bytes: Uint8Array } | null>();
  for (const image of input.images) {
    if (!fetched.has(image.attachmentId)) {
      try {
        const file = await fetchAttachment(image.attachmentId);
        const header = readImageHeader(file.bytes);
        if (!header) {
          warnings.push(`画像 ${image.attachmentId} の形式を読み取れませんでした（${file.contentType || "不明"}）`);
          fetched.set(image.attachmentId, null);
        } else {
          fetched.set(image.attachmentId, { header, bytes: file.bytes });
          const bytes = Buffer.from(file.bytes);
          const path = assetPathOf(image.attachmentId, header.ext);
          assets.set(path, {
            kind: "resource",
            path,
            mime: header.mime,
            bytes,
            sha256: sha256Hex(bytes),
            size: bytes.length,
          });
        }
      } catch (error) {
        warnings.push(`画像 ${image.attachmentId} を取得できませんでした: ${error instanceof Error ? error.message : "不明なエラー"}`);
        fetched.set(image.attachmentId, null);
      }
    }
    const got = fetched.get(image.attachmentId);
    if (got) resources.push(buildImageResource(image, got.header, now));
  }
  for (const table of input.tables) resources.push(buildTableResource(table, now));
  return { resources, assets: [...assets.values()], warnings };
}
