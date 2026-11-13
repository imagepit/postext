import { bundleFileMime, createBundle, MANIFEST_FILE, openBundle } from "postext/bundle";
import type { PostextConfig, Resource } from "postext";
import type { BundleStart } from "postext/bundle";
import { sha256Hex } from "./model";
import type { AssetData, BookContent, ChapterContent } from "./model";

const DEFAULT_LOCALE = "en";

// Sandbox が書き出しのたびに .postext へ足すキャッシュ（組版結果と表紙）。書籍の内容ではなく、
// 資産として保存すると保存のたびに増え、版の .postext にも混ざる。
const LAYOUTS_FILE = /^layouts(\.[^/]+)?\.json$/;

export type BundleBook = BookContent & { assets: AssetData[] };

// 資産のパスは、設定と資源が参照する fileId と同じ値で保存している。
export async function toBundle(book: BundleBook): Promise<Buffer> {
  const locale = book.locale ?? book.chapters[0]?.locale ?? DEFAULT_LOCALE;
  const files = new Map<string, Uint8Array>(book.assets.map((a) => [a.path, a.bytes]));
  const plain = (list: ChapterContent[]) => list.map((c) => ({ title: c.title, markdown: c.markdown }));
  const editions = book.editions ?? [];
  const created = await createBundle({
    name: book.title,
    locale,
    chapters: plain(book.chapters.filter((c) => c.locale === locale)),
    config: book.config as PostextConfig,
    resources: book.resources as unknown as Resource[],
    ...(book.sharedConfig ? { sharedConfig: book.sharedConfig as PostextConfig } : {}),
    ...(editions.length > 0
      ? {
          localized: Object.fromEntries(
            editions.map((e) => [
              e.locale,
              {
                name: e.name,
                ...(e.description ? { description: e.description } : {}),
                chapters: plain(book.chapters.filter((c) => c.locale === e.locale)),
                config: e.config as PostextConfig,
                resources: e.resources as unknown as Resource[],
                ...(e.start ? { start: e.start as unknown as BundleStart } : {}),
              },
            ]),
          ),
        }
      : {}),
    files,
  });
  return Buffer.from(created.bytes);
}

export async function fromBundle(bytes: Uint8Array): Promise<BundleBook> {
  const opened = await openBundle(bytes);
  const tags = (opened.locales ?? []).filter((tag) => tag !== opened.locale);
  const others = await Promise.all(tags.map((tag) => openBundle(bytes, { locale: tag })));
  const chapterFiles = new Set([opened, ...others].flatMap((o) => o.chapters.map((c) => c.file)));
  const fontFiles = new Set(opened.fonts.map((f) => f.file));
  const chaptersOf = (o: typeof opened): ChapterContent[] =>
    o.chapters.map((c) => ({ title: c.title, locale: o.locale, markdown: c.markdown }));
  const assets: AssetData[] = [];
  for (const [path, data] of opened.files) {
    if (path === MANIFEST_FILE || chapterFiles.has(path)) continue;
    if (LAYOUTS_FILE.test(path) || path === opened.thumbnail) continue;
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
    chapters: [opened, ...others].flatMap(chaptersOf),
    locale: opened.locale,
    sharedConfig: (opened.sharedConfig as unknown as Record<string, unknown> | undefined) ?? null,
    editions: others.map((o) => ({
      locale: o.locale,
      name: o.name,
      ...(o.description ? { description: o.description } : {}),
      config: o.config as unknown as Record<string, unknown>,
      resources: o.resources as unknown as Record<string, unknown>[],
      ...(o.start ? { start: o.start as unknown as Record<string, unknown> } : {}),
    })),
    assets,
  };
}
