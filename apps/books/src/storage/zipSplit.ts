// .postext（zip）から資産ファイルを取り除く／戻す。取り除いた zip は DB に残し、ファイルの中身は BlobStore に置く。

import { MANIFEST_FILE, openBundleZip, zipBundle } from "postext/bundle";

export interface SplitZip {
  /** 指定したファイルを除いた zip。 */
  stripped: Uint8Array;
  /** 除いたファイル（zip 内のパス → 中身）。 */
  files: Map<string, Uint8Array>;
}

export function stripZipFiles(bytes: Uint8Array, shouldStrip: (path: string) => boolean): SplitZip {
  const zip = openBundleZip(bytes);
  const keep: Record<string, Uint8Array> = {};
  const files = new Map<string, Uint8Array>();
  for (const [path, data] of zip.files) {
    if (path !== MANIFEST_FILE && shouldStrip(path)) files.set(path, data);
    else keep[path] = data;
  }
  return { stripped: zipBundle(keep), files };
}

export function joinZipFiles(stripped: Uint8Array, files: Map<string, Uint8Array>): Uint8Array {
  if (files.size === 0) return stripped;
  const zip = openBundleZip(stripped);
  const all: Record<string, Uint8Array> = Object.fromEntries(zip.files);
  for (const [path, data] of files) all[path] = data;
  return zipBundle(all);
}
