// MCP サーバーの組み立て（CORE-203）。ツールの中身は tools.ts にあり、ここでは入力の形と説明を決めて登録する。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as tools from "./tools";
import type { ToolDeps, ToolResult } from "./tools";

const asContent = (result: ToolResult) => ({
  content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  ...(result.ok === false ? { isError: true } : {}),
});

const bookId = z.string().describe("書籍の ID（list_books で分かる）");
const chapter = z.number().int().min(1).describe("章の番号（1 から。get_book で分かる）");
const baseRevision = z.number().int().min(0).describe("読んだときの revision（read_chapter や get_book で分かる）");

export function createMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: "postext-books", version: "1.0.0" });

  server.registerTool(
    "list_books",
    { title: "書籍の一覧", description: "Postext の書籍の ID・題・revision・更新日時を返す。", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => asContent(await tools.listBooks(deps)),
  );
  server.registerTool(
    "get_book",
    {
      title: "書籍の概要",
      description: "書籍の題・revision・章の一覧（番号・題・言語・文字数）・版の一覧を返す。",
      inputSchema: { bookId },
      annotations: { readOnlyHint: true },
    },
    async (a) => asContent(await tools.getBook(deps, a.bookId)),
  );
  server.registerTool(
    "read_chapter",
    {
      title: "章を読む",
      description: "章の本文（Postext の Markdown）と revision を返す。取り込み元の記録などの frontmatter は含めない。",
      inputSchema: { bookId, chapter },
      annotations: { readOnlyHint: true },
    },
    async (a) => asContent(await tools.readChapter(deps, a.bookId, a.chapter)),
  );
  server.registerTool(
    "search_text",
    {
      title: "本文を探す",
      description: "書籍の全章の本文から語を探し（大文字と小文字は区別しない）、章・行・その行の本文を返す。",
      inputSchema: { bookId, query: z.string().min(1), limit: z.number().int().min(1).max(200).optional() },
      annotations: { readOnlyHint: true },
    },
    async (a) => asContent(await tools.searchText(deps, a.bookId, a.query, a.limit)),
  );
  server.registerTool(
    "write_chapter",
    {
      title: "章を書き換える",
      description:
        "章の本文を、渡した Markdown で置き換えて保存する。frontmatter は今のものを保つ。baseRevision が今の revision と違えば保存せず、読み直すよう返す。",
      inputSchema: { bookId, chapter, markdown: z.string(), baseRevision },
      annotations: { destructiveHint: true },
    },
    async (a) => asContent(await tools.writeChapter(deps, a.bookId, a.chapter, a.markdown, a.baseRevision)),
  );
  server.registerTool(
    "replace_text",
    {
      title: "本文の語を置き換える",
      description:
        "本文の find をすべて replace に置き換えて保存する（chapter を渡すとその章だけ）。置き換えた数を返し、0件なら保存しない。baseRevision の扱いは write_chapter と同じ。",
      inputSchema: { bookId, find: z.string().min(1), replace: z.string(), baseRevision, chapter: chapter.optional() },
      annotations: { destructiveHint: true },
    },
    async (a) => asContent(await tools.replaceText(deps, a.bookId, a.find, a.replace, a.baseRevision, a.chapter)),
  );
  server.registerTool(
    "list_resources",
    {
      title: "画像・表の一覧",
      description:
        "書籍のリソース（画像・表など）の ID・種類・使っている章・キャプション・置き方・幅（本文幅に対する%）・揃えを返す。chapter や kind（bitmap・svg・table など）で絞れる。",
      inputSchema: { bookId, chapter: chapter.optional(), kind: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async (a) => asContent(await tools.listResources(deps, a.bookId, a.chapter, a.kind)),
  );
  server.registerTool(
    "set_resource_placement",
    {
      title: "画像の幅・揃え・キャプションを変える",
      description:
        "リソースの幅（本文幅に対する %、1〜100。null で外して幅いっぱい）・揃え（left・center・right。null で外す）・置き方・キャプション（null か空で外す）を変えて保存する。渡した項目だけを変える。baseRevision の扱いは write_chapter と同じ。",
      inputSchema: {
        bookId,
        resourceId: z.string().min(1).describe("リソースの ID（list_resources で分かる）"),
        widthPercent: z.number().min(1).max(100).nullable().optional(),
        align: z.enum(["left", "center", "right"]).nullable().optional(),
        position: z.enum(["here", "top", "bottom", "auto", "paragraph"]).optional(),
        caption: z.string().nullable().optional(),
        baseRevision,
      },
      annotations: { destructiveHint: true },
    },
    async (a) => {
      const change: tools.PlacementChange = {
        ...(a.widthPercent !== undefined ? { widthPercent: a.widthPercent } : {}),
        ...(a.align !== undefined ? { align: a.align } : {}),
        ...(a.position !== undefined ? { position: a.position } : {}),
        ...(a.caption !== undefined ? { caption: a.caption } : {}),
      };
      return asContent(await tools.setResourcePlacement(deps, a.bookId, a.resourceId, change, a.baseRevision));
    },
  );
  server.registerTool(
    "create_version",
    {
      title: "版を作る",
      description: "書籍の今の内容を版として保存する。書き換える前の控えに使う。",
      inputSchema: { bookId, label: z.string().max(200).describe("版の名前") },
    },
    async (a) => asContent(await tools.makeVersion(deps, a.bookId, a.label)),
  );
  server.registerTool(
    "export_book",
    {
      title: "PDF・EPUB を作る",
      description:
        "書籍（または版）を PDF か EPUB にし、生成物の exportId・頁数・警告の数を返す。生成物は1時間だけ保管される。手元に保存するには save_export を使う。",
      inputSchema: {
        bookId,
        format: z.enum(["pdf", "epub"]),
        layout: z.enum(["fixed", "reflowable"]).optional().describe("EPUB のとき。既定は fixed"),
        versionId: z.string().optional().describe("版の ID。省くと今の内容"),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => asContent(await tools.exportBookTool(deps, a.bookId, a.format, a.layout, a.versionId)),
  );
  return server;
}
