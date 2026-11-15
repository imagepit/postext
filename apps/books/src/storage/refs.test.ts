import { describe, expect, it } from "vitest";
import { createBundle, openBundle } from "postext/bundle";
import { splitBookBundle } from "../books/bundle";
import { FsBlobStore, sha256Of } from "./blobStore";
import type { BlobRef } from "./blobStore";
import { knownRefs, resolveAssetRefs } from "./refs";
import { joinZipFiles, stripZipFiles } from "./zipSplit";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const store = () => new FsBlobStore(mkdtempSync(path.join(tmpdir(), "refs-")));
const a = new TextEncoder().encode("AAA");
const b = new TextEncoder().encode("BBB");
const outlineRef = (bytes: Uint8Array, key: string): BlobRef => ({ storage: "outline", key, sha256: sha256Of(bytes), size: bytes.length, mime: "image/png" });

describe("resolveAssetRefs", () => {
  it("既知の参照がなければ postext へ書き、outlineKey があれば書かずに outline 参照", async () => {
    const s = store();
    const refs = await resolveAssetRefs(s, [
      { path: "fonts/a.woff2", mime: "font/woff2", bytes: a },
      { path: "outline/x.png", mime: "image/png", bytes: b, outlineKey: "uploads/u/x.png" },
    ]);
    expect(refs.get("fonts/a.woff2")).toMatchObject({ storage: "postext", key: `sha256/${sha256Of(a)}` });
    expect(refs.get("outline/x.png")).toEqual(outlineRef(b, "uploads/u/x.png"));
    await expect(s.get(refs.get("outline/x.png")!)).rejects.toThrow(); // outline へは書いていない
  });

  it("同じ path・同じ sha256 の既存参照は使い回し、outline のまま保つ", async () => {
    const s = store();
    const existing = outlineRef(a, "uploads/u/a.png");
    const refs = await resolveAssetRefs(s, [{ path: "outline/a.png", mime: "image/png", bytes: a }], knownRefs([{ path: "outline/a.png", ref: existing }]));
    expect(refs.get("outline/a.png")).toEqual(existing);
  });

  it("path が違っても同じ内容なら、postext より outline の参照を選ぶ", async () => {
    const s = store();
    const pg = await s.putPostext(a, "image/png");
    const known = knownRefs([
      { path: "x", ref: pg },
      { path: "y", ref: outlineRef(a, "uploads/a.png") },
    ]);
    const refs = await resolveAssetRefs(s, [{ path: "z", mime: "image/png", bytes: a }], known);
    expect(refs.get("z")!.storage).toBe("outline");
  });

  it("同じ path でも内容が変わっていれば既存参照を使わない", async () => {
    const s = store();
    const refs = await resolveAssetRefs(s, [{ path: "outline/a.png", mime: "image/png", bytes: b }], knownRefs([{ path: "outline/a.png", ref: outlineRef(a, "k") }]));
    expect(refs.get("outline/a.png")).toMatchObject({ storage: "postext", sha256: sha256Of(b) });
  });

  it("渡された ref は内容の sha256 が合うときだけ使う", async () => {
    const s = store();
    const good = outlineRef(a, "k");
    const out = await resolveAssetRefs(s, [
      { path: "p", mime: "image/png", bytes: a, ref: good },
      { path: "q", mime: "image/png", bytes: b, ref: good },
    ]);
    expect(out.get("p")).toEqual(good);
    expect(out.get("q")!.storage).toBe("postext");
  });
});

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

describe("bundle の分割と結合", () => {
  async function sample() {
    const created = await createBundle({
      name: "本",
      locale: "ja",
      chapters: [{ title: "章", markdown: "# 章\n\n本文" }],
      resources: [{ id: "fig", typeId: "figure", kind: "bitmap", createdAt: 0, updatedAt: 0, bitmap: { fileId: "outline/a.png", format: "png", width: 1, height: 1 } }] as never,
      files: new Map([["outline/a.png", new Uint8Array(png)]]),
    });
    return created.bytes;
  }

  it("画像を除いた zip と、除いたファイルに分かれ、戻すと元と同じ内容で開ける", async () => {
    const full = await sample();
    const { stripped, assets } = await splitBookBundle(full);
    // createBundle は資源の画像を resources/<id>.<ext> に置く。
    expect(assets.map((x) => x.path)).toEqual(["resources/fig.png"]);
    expect(stripped.length).toBeLessThan(full.length);
    // 画像を除いた zip は、資源が参照するファイルがないので openBundle では開けない。
    await expect(openBundle(stripped)).rejects.toThrow();
    const joined = joinZipFiles(stripped, new Map(assets.map((x) => [x.path, x.bytes])));
    const opened = await openBundle(joined);
    expect([...opened.files.get("resources/fig.png")!]).toEqual([...png]);
    expect(opened.chapters.map((c) => c.markdown)).toEqual(["# 章\n\n本文"]);
  });

  it("除くものがなければ結合は元の zip をそのまま返す", () => {
    const zip = new Uint8Array([1, 2, 3]);
    expect(joinZipFiles(zip, new Map())).toBe(zip);
  });

  it("マニフェストは除かない", async () => {
    const full = await sample();
    const { stripped, files } = stripZipFiles(full, () => true);
    expect([...files.keys()]).not.toContain("preset.json");
    expect(stripped.length).toBeGreaterThan(0);
  });
});
