import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openBundle } from "postext/bundle";
import { describe, expect, it } from "vitest";
import type { BookRepository, BookWithAssetData } from "@/books/model";
import { cliArgs, exportBook, spawnRunner } from "./render";
import type { Runner } from "./render";

const book: BookWithAssetData = {
  id: "11111111-1111-4111-8111-111111111111",
  revision: 3,
  title: "出力の本",
  config: {},
  resources: [],
  chapters: [{ title: "章", locale: "ja", markdown: "# 章\n\n本文\n" }],
  locale: "ja",
  assets: [],
} as unknown as BookWithAssetData;

const versionBundle = Buffer.from("version-bytes");

const repo = {
  async getWithAssetData(id: string) {
    return id === book.id ? book : null;
  },
  async getVersionBundle(bookId: string, versionId: string) {
    return bookId === book.id && versionId === "v1" ? versionBundle : null;
  },
} as unknown as BookRepository;

/** CLI の代わり: 受け取った引数を記録し、-o の先へ出力を書き、--json の報告を返す。 */
function fakeCli(report: unknown = { pages: 7, warnings: [{ kind: "codeOverflow", message: "長い行" }] }) {
  const calls: { command: string; args: string[]; input: Buffer }[] = [];
  const run: Runner = async (command, args) => {
    const input = args[1]!;
    const { readFileSync } = await import("node:fs");
    calls.push({ command, args, input: readFileSync(input) });
    writeFileSync(args[args.indexOf("-o") + 1]!, `${args[0]}-output`);
    return { code: 0, stdout: JSON.stringify(report), stderr: "", timedOut: false };
  };
  return { run, calls };
}

const tmpRoot = () => mkdtempSync(path.join(tmpdir(), "export-test-"));

describe("cliArgs", () => {
  it("PDF は --offline と --font-dir を付け、EPUB は既定で fixed", () => {
    expect(cliArgs("in.postext", "out.pdf", "pdf", undefined, "/fonts")).toEqual(["pdf", "in.postext", "--offline", "--font-dir", "/fonts", "-o", "out.pdf", "--json"]);
    expect(cliArgs("in.postext", "out.epub", "epub", undefined, "/fonts").slice(0, 4)).toEqual(["epub", "in.postext", "--layout", "fixed"]);
    expect(cliArgs("in.postext", "out.epub", "epub", "reflowable", "/fonts")).toContain("reflowable");
  });
});

describe("exportBook", () => {
  it("書籍の今の内容を .postext にして CLI に渡し、出力と頁数・警告を返し、一時フォルダを消す", async () => {
    const root = tmpRoot();
    const { run, calls } = fakeCli();
    const result = await exportBook(repo, { bookId: book.id, format: "pdf" }, { run, cliPath: "/bin/postext", fontDir: "/fonts", tmpRoot: root });
    expect(result).toMatchObject({ ok: true, title: "出力の本", pages: 7, warnings: [{ kind: "codeOverflow", message: "長い行" }] });
    expect(result.ok && result.bytes.toString()).toBe("pdf-output");
    expect(calls[0]!.command).toBe("/bin/postext");
    const opened = await openBundle(new Uint8Array(calls[0]!.input));
    expect(opened.chapters.map((c) => c.title)).toEqual(["章"]);
    expect(readdirSync(root)).toEqual([]);
  });

  it("版を指定すると、その版の .postext を渡す", async () => {
    const { run, calls } = fakeCli();
    const result = await exportBook(repo, { bookId: book.id, format: "epub", layout: "reflowable", versionId: "v1" }, { run, tmpRoot: tmpRoot() });
    expect(result.ok && result.bytes.toString()).toBe("epub-output");
    expect(calls[0]!.input.equals(versionBundle)).toBe(true);
    expect(calls[0]!.args).toContain("reflowable");
  });

  it("書籍や版がなければ CLI を動かさない", async () => {
    const { run, calls } = fakeCli();
    expect(await exportBook(repo, { bookId: "x", format: "pdf" }, { run })).toEqual({ ok: false, reason: "not_found" });
    expect(await exportBook(repo, { bookId: book.id, format: "pdf", versionId: "nope" }, { run })).toEqual({ ok: false, reason: "version_not_found" });
    expect(calls).toEqual([]);
  });

  it("CLI の失敗・打ち切り・起動の失敗は、理由つきの失敗にし、一時フォルダを消す", async () => {
    const root = tmpRoot();
    const fail: Runner = async () => ({ code: 2, stdout: "", stderr: "line1\nfont missing\n", timedOut: false });
    expect(await exportBook(repo, { bookId: book.id, format: "pdf" }, { run: fail, tmpRoot: root })).toEqual({
      ok: false,
      reason: "failed",
      message: "postext が終了コード 2 で止まりました: line1 / font missing",
    });
    const slow: Runner = async () => ({ code: null, stdout: "", stderr: "", timedOut: true });
    expect(await exportBook(repo, { bookId: book.id, format: "pdf" }, { run: slow, tmpRoot: root })).toMatchObject({ ok: false, reason: "failed", message: "生成が時間内に終わりませんでした" });
    const missing: Runner = async () => {
      throw new Error("spawn ENOENT");
    };
    expect(await exportBook(repo, { bookId: book.id, format: "pdf" }, { run: missing, tmpRoot: root })).toMatchObject({ ok: false, reason: "failed" });
    expect(readdirSync(root)).toEqual([]);
  });

  it("同時に頼まれても、CLI は1件ずつ動く", async () => {
    let running = 0;
    let peak = 0;
    const run: Runner = async (_command, args) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 20));
      writeFileSync(args[args.indexOf("-o") + 1]!, "x");
      running--;
      return { code: 0, stdout: "{}", stderr: "", timedOut: false };
    };
    const results = await Promise.all([1, 2, 3].map(() => exportBook(repo, { bookId: book.id, format: "pdf" }, { run, tmpRoot: tmpRoot() })));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(peak).toBe(1);
  });
});

describe("spawnRunner", () => {
  const script = (body: string) => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "fake-cli-")), "cli.sh");
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };

  it("終了コードと出力を返す", async () => {
    const result = await spawnRunner(script('echo "{\\"pages\\":1}"; echo warn >&2; exit 3'), [], 5000);
    expect(result).toEqual({ code: 3, stdout: '{"pages":1}\n', stderr: "warn\n", timedOut: false });
  });

  it("時間を過ぎたら止める", async () => {
    const result = await spawnRunner(script("sleep 5"), [], 100);
    expect(result.timedOut).toBe(true);
  });
});
