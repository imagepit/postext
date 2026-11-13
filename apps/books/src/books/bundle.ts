import { bundleFileMime, createBundle, MANIFEST_FILE, openBundle } from "postext/bundle";
import type { PostextConfig, Resource } from "postext";
import { sha256Hex } from "./model";
import type { AssetData, BookContent, ChapterContent } from "./model";

const DEFAULT_LOCALE = "en";

export type BundleBook = BookContent & { assets: AssetData[] };

// 資産のパスは、設定と資源が参照する fileId と同じ値で保存している。
export async function toBundle(book: BundleBook): Promise<Buffer> {
  const locale = book.chapters[0]?.locale ?? DEFAULT_LOCALE;
  const files = new Map<string, Uint8Array>(book.assets.map((a) => [a.path, a.bytes]));
  const created = await createBundle({
    name: book.title,
    locale,
    chapters: book.chapters.map((c) => ({ title: c.title, markdown: c.markdown })),
    config: book.config as PostextConfig,
    resources: book.resources as unknown as Resource[],
    files,
  });
  return Buffer.from(created.bytes);
}

export async function fromBundle(bytes: Uint8Array): Promise<BundleBook> {
  const opened = await openBundle(bytes);
  const chapterFiles = new Set(opened.chapters.map((c) => c.file));
  const fontFiles = new Set(opened.fonts.map((f) => f.file));
  const chapters: ChapterContent[] = opened.chapters.map((c) => ({
    title: c.title,
    locale: opened.locale,
    markdown: c.markdown,
  }));
  const assets: AssetData[] = [];
  for (const [path, data] of opened.files) {
    if (path === MANIFEST_FILE || chapterFiles.has(path)) continue;
    const buffer = Buffer.from(data);
    assets.push({
      kind: fontFiles.has(path) ? "font" : "resource",
      path,
      mime: bundleFileMime(path),
      bytes: buffer,
      sha256: sha256Hex(buffer),
      size: buffer.length,
    });
  }
  return {
    title: opened.name,
    config: opened.config as unknown as Record<string, unknown>,
    resources: opened.resources as unknown as Record<string, unknown>[],
    chapters,
    assets,
  };
}
