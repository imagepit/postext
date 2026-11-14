import { describe, expect, it } from "vitest";
import { convertOutlineMarkdown, type ConvertedImage } from "./convert";
import { buildImageResource, buildResources, buildTableResource, readImageHeader } from "./resources";

const png = (width: number, height: number): Uint8Array => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
};

const jpeg = (width: number, height: number): Uint8Array => {
  // SOI, APP0（長さ 16）, SOF0
  const b = new Uint8Array(2 + 18 + 19);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  const sof = 20;
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08], sof);
  new DataView(b.buffer).setUint16(sof + 5, height);
  new DataView(b.buffer).setUint16(sof + 7, width);
  return b;
};

const gif = (width: number, height: number): Uint8Array => {
  const b = new Uint8Array(13);
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  new DataView(b.buffer).setUint16(6, width, true);
  new DataView(b.buffer).setUint16(8, height, true);
  return b;
};

const webpLossy = (width: number, height: number): Uint8Array => {
  const b = new Uint8Array(30);
  b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
  new DataView(b.buffer).setUint16(26, width, true);
  new DataView(b.buffer).setUint16(28, height, true);
  return b;
};

const webpLossless = (width: number, height: number): Uint8Array => {
  const b = new Uint8Array(30);
  b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c]);
  b[20] = 0x2f;
  new DataView(b.buffer).setUint32(21, ((width - 1) | ((height - 1) << 14)) >>> 0, true);
  return b;
};

describe("readImageHeader", () => {
  it("PNG / JPEG / GIF / WebP の形式と画素数を読む", () => {
    expect(readImageHeader(png(640, 480))).toMatchObject({ format: "png", mime: "image/png", ext: "png", width: 640, height: 480 });
    expect(readImageHeader(jpeg(1200, 800))).toMatchObject({ format: "jpeg", mime: "image/jpeg", ext: "jpg", width: 1200, height: 800 });
    expect(readImageHeader(gif(32, 16))).toMatchObject({ format: "gif", width: 32, height: 16 });
    expect(readImageHeader(webpLossy(300, 200))).toMatchObject({ format: "webp", width: 300, height: 200 });
    expect(readImageHeader(webpLossless(301, 201))).toMatchObject({ format: "webp", width: 301, height: 201 });
  });

  it("画像でないバイト列や、画素数 0 は null", () => {
    expect(readImageHeader(new TextEncoder().encode("<html></html>"))).toBeNull();
    expect(readImageHeader(png(0, 10))).toBeNull();
    expect(readImageHeader(new Uint8Array(0))).toBeNull();
  });

  it("SVG は width/height か viewBox から寸法を読み、宣言がなければ 0 にする", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(readImageHeader(enc('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="320px" height="200"></svg>'))).toMatchObject({ format: "svg", ext: "svg", width: 320, height: 200 });
    expect(readImageHeader(enc('<svg viewBox="0 0 640 480" width="100%"></svg>'))).toMatchObject({ format: "svg", width: 640, height: 480 });
    expect(readImageHeader(enc("<svg></svg>"))).toMatchObject({ format: "svg", width: 0, height: 0 });
  });

  it("draw.io のように開始タグが長く、属性の中に > がある SVG も寸法を読む", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const content = `&lt;mxfile&gt;${"x".repeat(20000)}&lt;/mxfile&gt; a>b`;
    const svg = `<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg" content="${content}" width="561px" height="321px" viewBox="-0.5 -0.5 561 321"><g/></svg>`;
    expect(readImageHeader(enc(svg))).toMatchObject({ format: "svg", width: 561, height: 321 });
  });
});

describe("SVG のリソース", () => {
  it("SVG は svg リソースになり、寸法がなければ width/height を持たない", () => {
    const image: ConvertedImage = { resourceId: "outline-img-a", attachmentId: "a", alt: "図", widthPercent: 80 };
    const withSize = buildImageResource(image, { format: "svg", mime: "image/svg+xml", ext: "svg", width: 640, height: 480 }, 0);
    expect(withSize).toMatchObject({ kind: "svg", svg: { fileId: "outline/a.svg", width: 640, height: 480 }, placement: { position: "here", width: 0.8 } });
    expect(withSize).not.toHaveProperty("bitmap");
    const noSize = buildImageResource(image, { format: "svg", mime: "image/svg+xml", ext: "svg", width: 0, height: 0 }, 0);
    expect(noSize).toMatchObject({ kind: "svg", svg: { fileId: "outline/a.svg" } });
    expect((noSize as { svg: Record<string, unknown> }).svg).not.toHaveProperty("width");
  });
});

describe("リソースの組み立て", () => {
  it("画像は here 配置のビットマップになり、{w} は割合になる", () => {
    const header = readImageHeader(png(800, 600))!;
    const resource = buildImageResource(
      { attachmentId: "abc", resourceId: "outline-img-abc", alt: "図の説明", widthPercent: 80 },
      header,
      1000,
    );
    expect(resource).toEqual({
      id: "outline-img-abc",
      typeId: "figure",
      kind: "bitmap",
      caption: "図の説明",
      altText: "図の説明",
      createdAt: 1000,
      updatedAt: 1000,
      bitmap: { fileId: "outline/abc.png", format: "png", width: 800, height: 600 },
      placement: { position: "here", width: 0.8 },
    });
  });

  it("alt も幅もない画像は caption と width を持たない", () => {
    const r = buildImageResource({ attachmentId: "a", resourceId: "outline-img-a", alt: "" }, readImageHeader(png(1, 1))!, 0);
    expect(r).not.toHaveProperty("caption");
    expect(r.placement).toEqual({ position: "here" });
  });

  it("表は見出し行つきの table リソースになる", () => {
    const converted = convertOutlineMarkdown("| 項目 | 内容 |\n|:--|--:|\n| `a` | **b** |\n", { docId: "12345678-0000" });
    const resource = buildTableResource(converted.tables[0]!, 5);
    expect(resource).toEqual({
      id: "outline-table-12345678-1",
      typeId: "table",
      kind: "table",
      createdAt: 5,
      updatedAt: 5,
      table: {
        model: {
          rows: [
            [
              { content: "項目", isHeader: true, align: "left" },
              { content: "内容", isHeader: true, align: "right" },
            ],
            [
              { content: "`a`", align: "left" },
              { content: "**b**", align: "right" },
            ],
          ],
          headerRowCount: 1,
        },
      },
      placement: { position: "here" },
    });
  });

  it("画像は attachmentId ごとに1度だけ取得し、資産に sha256 を付ける", async () => {
    const fetched: string[] = [];
    const built = await buildResources(
      {
        images: [
          { attachmentId: "a", resourceId: "outline-img-a", alt: "" },
          { attachmentId: "a", resourceId: "outline-img-a-2", alt: "", widthPercent: 50 },
        ],
        tables: [],
      },
      async (id) => {
        fetched.push(id);
        return { bytes: png(2, 3), contentType: "image/png" };
      },
      0,
    );
    expect(fetched).toEqual(["a"]);
    expect(built.resources.map((r) => r.id)).toEqual(["outline-img-a", "outline-img-a-2"]);
    expect(built.assets).toHaveLength(1);
    expect(built.assets[0]).toMatchObject({ kind: "resource", path: "outline/a.png", mime: "image/png", size: 33 });
    expect(built.assets[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("取得や解析に失敗した画像は警告にして、リソースを作らない", async () => {
    const built = await buildResources(
      {
        images: [
          { attachmentId: "bad", resourceId: "outline-img-bad", alt: "" },
          { attachmentId: "html", resourceId: "outline-img-html", alt: "" },
        ],
        tables: [],
      },
      async (id) => {
        if (id === "bad") throw new Error("404");
        return { bytes: new TextEncoder().encode("<html>"), contentType: "text/html" };
      },
      0,
    );
    expect(built.resources).toEqual([]);
    expect(built.assets).toEqual([]);
    expect(built.warnings).toHaveLength(2);
  });
});
