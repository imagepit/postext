import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BookRepository } from "@/books/model";
import { createPgRepository } from "@/books/repository";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import type { Runner } from "@/export/render";
import { FsBlobStore } from "@/storage/blobStore";
import { createExportStore } from "./exportStore";
import { createMcpServer } from "./server";
import * as tools from "./tools";
import type { ToolDeps } from "./tools";

const url = process.env.TEST_DATABASE_URL ?? "postgres://books:books-local-only@127.0.0.1:55439/books";

let pool: Pool;
let repo: BookRepository;

beforeAll(async () => {
  pool = new Pool({ connectionString: url });
  const db: Db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.join(__dirname, "../../drizzle") });
  repo = createPgRepository(db, new FsBlobStore(mkdtempSync(path.join(tmpdir(), "books-mcp-"))));
});

afterAll(async () => {
  await pool.end();
});

const fakeCli: Runner = async (_command, args) => {
  writeFileSync(args[args.indexOf("-o") + 1]!, `${args[0]}-bytes`);
  return { code: 0, stdout: JSON.stringify({ pages: 12, warnings: [{ kind: "codeOverflow", message: "x" }, { kind: "codeOverflow", message: "y" }] }), stderr: "", timedOut: false };
};

let now = 1_000_000;
const deps = (): ToolDeps => ({
  repo,
  exports: createExportStore(mkdtempSync(path.join(tmpdir(), "mcp-exports-")), () => now),
  exportOptions: { run: fakeCli },
});

async function seed() {
  return repo.create({
    title: "MCPの本",
    config: {},
    resources: [],
    locale: "ja",
    chapters: [
      { title: "第1章", locale: "ja", markdown: '---\noutline:\n  id: "doc-1"\n---\n# 第1章\n\nGitは分散型です。\n\nGitを使います。\n' },
      { title: "第2章", locale: "ja", markdown: "# 第2章\n\nブランチの話。\n" },
    ],
  });
}

describe("MCP のツール", () => {
  it("書籍の一覧と概要、章の本文（frontmatter なし）を返す", async () => {
    const book = await seed();
    const d = deps();
    const list = await tools.listBooks(d);
    expect((list.books as { id: string }[]).some((b) => b.id === book.id)).toBe(true);
    const got = await tools.getBook(d, book.id);
    expect(got).toMatchObject({ ok: true, title: "MCPの本", revision: book.revision, chapters: [{ chapter: 1, title: "第1章" }, { chapter: 2, title: "第2章" }] });
    const ch = await tools.readChapter(d, book.id, 1);
    expect(ch).toMatchObject({ ok: true, revision: book.revision, markdown: "# 第1章\n\nGitは分散型です。\n\nGitを使います。\n" });
    expect(await tools.readChapter(d, book.id, 3)).toMatchObject({ ok: false, error: "bad_chapter" });
    expect(await tools.getBook(d, "00000000-0000-4000-8000-000000000000")).toMatchObject({ ok: false, error: "not_found" });
  });

  it("本文を探し、章と行を返す", async () => {
    const book = await seed();
    const found = await tools.searchText(deps(), book.id, "git");
    expect(found).toMatchObject({ ok: true, total: 2, matches: [{ chapter: 1, line: 3, text: "Gitは分散型です。" }, { chapter: 1, line: 5 }] });
  });

  it("章を書き換えても frontmatter は残り、revision が上がる。古い revision なら保存しない", async () => {
    const book = await seed();
    const d = deps();
    const written = await tools.writeChapter(d, book.id, 1, "# 第1章\n\n書き換えた。\n", book.revision);
    expect(written).toEqual({ ok: true, revision: book.revision + 1 });
    const saved = await repo.get(book.id);
    expect(saved!.chapters[0]!.markdown).toBe('---\noutline:\n  id: "doc-1"\n---\n# 第1章\n\n書き換えた。\n');
    const stale = await tools.writeChapter(d, book.id, 1, "x", book.revision);
    expect(stale).toMatchObject({ ok: false, error: "conflict", revision: book.revision + 1 });
    expect((await repo.get(book.id))!.chapters[0]!.markdown).toContain("書き換えた。");
  });

  it("語を置き換えて数を返す。0件なら保存しない。章を指定するとその章だけ", async () => {
    const book = await seed();
    const d = deps();
    expect(await tools.replaceText(d, book.id, "Git", "ギット", book.revision)).toEqual({ ok: true, revision: book.revision + 1, replaced: 2 });
    expect(await tools.replaceText(d, book.id, "存在しない語", "x", book.revision + 1)).toMatchObject({ ok: false, error: "no_match", replaced: 0 });
    expect((await repo.get(book.id))!.revision).toBe(book.revision + 1);
    expect(await tools.replaceText(d, book.id, "話", "説明", book.revision + 1, 1)).toMatchObject({ ok: false, error: "no_match" });
    expect(await tools.replaceText(d, book.id, "話", "説明", book.revision + 1, 2)).toMatchObject({ ok: true, replaced: 1 });
    // frontmatter の中の語は置き換えない。
    expect((await repo.get(book.id))!.chapters[0]!.markdown).toContain('id: "doc-1"');
  });

  it("版を作れる", async () => {
    const book = await seed();
    const d = deps();
    expect(await tools.makeVersion(d, book.id, "MCPの控え")).toMatchObject({ ok: true, version: { label: "MCPの控え", revision: book.revision } });
    expect(await tools.getBook(d, book.id)).toMatchObject({ versions: [{ label: "MCPの控え" }] });
  });

  it("export_book は生成物を置き場に入れ、ID・頁数・警告を返す。生成物は1時間で消える", async () => {
    const book = await seed();
    const d = deps();
    const out = await tools.exportBookTool(d, book.id, "pdf");
    expect(out).toMatchObject({ ok: true, fileName: "MCPの本.pdf", pages: 12, warnings: 2, warningKinds: ["codeOverflow"], size: 9 });
    const id = out.exportId as string;
    expect((await d.exports.get(id))?.bytes.toString()).toBe("pdf-bytes");
    now += 61 * 60 * 1000;
    expect(await d.exports.get(id)).toBeNull();
    expect(await d.exports.get("../../etc/passwd")).toBeNull();
  });
});

describe("MCP サーバー", () => {
  it("ツールを登録し、クライアントから呼べる", async () => {
    const book = await seed();
    const server = createMcpServer(deps());
    const client = new Client({ name: "test", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["create_version", "export_book", "get_book", "list_books", "read_chapter", "replace_text", "search_text", "write_chapter"]);
    const res = await client.callTool({ name: "read_chapter", arguments: { bookId: book.id, chapter: 2 } });
    const body = JSON.parse((res.content as { text: string }[])[0]!.text);
    expect(body).toMatchObject({ ok: true, title: "第2章" });
    const bad = await client.callTool({ name: "read_chapter", arguments: { bookId: book.id, chapter: 9 } });
    expect(bad.isError).toBe(true);
    await client.close();
  });
});
