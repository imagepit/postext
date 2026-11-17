// 書籍のPDFとEPUBを、サーバーで作る（CORE-206）。
// 組版は同梱した postext CLI（単体の実行ファイル）に任せ、ここでは .postext を渡して出力を受け取るだけにする。

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { toBundle } from "@/books/bundle";
import type { BookRepository } from "@/books/model";

export type ExportFormat = "pdf" | "epub";
export type EpubLayout = "fixed" | "reflowable";

export interface ExportRequest {
  bookId: string;
  format: ExportFormat;
  /** EPUB のときだけ使う。既定は fixed（印刷と同じ頁）。 */
  layout?: EpubLayout;
  /** 版の ID。省くと書籍の今の内容。 */
  versionId?: string;
}

export interface ExportWarning {
  kind: string;
  message: string;
}

export interface ExportResult {
  bytes: Buffer;
  /** 書籍の題（ファイル名に使う）。 */
  title: string;
  pages?: number;
  warnings: ExportWarning[];
}

export type ExportOutcome =
  | ({ ok: true } & ExportResult)
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "version_not_found" }
  | { ok: false; reason: "failed"; message: string };

/** CLI を1回動かした結果。 */
export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type Runner = (command: string, args: string[], timeoutMs: number) => Promise<RunResult>;

export interface ExportOptions {
  /** CLI の場所。既定は POSTEXT_CLI_PATH、なければ /app/bin/postext。 */
  cliPath?: string;
  /** 本に入っていない字を補うフォントの場所。既定は POSTEXT_FONT_DIR、なければ /app/fonts。 */
  fontDir?: string;
  timeoutMs?: number;
  run?: Runner;
  /** 一時フォルダを作る場所（テスト用）。 */
  tmpRoot?: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT = 64 * 1024;

/** 子プロセスを動かし、打ち切りの時間を過ぎたら止める。出力は末尾だけを残す。 */
export const spawnRunner: Runner = (command, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const keep = (prev: string, chunk: Buffer) => (prev + chunk.toString("utf8")).slice(-MAX_OUTPUT);
    child.stdout.on("data", (c: Buffer) => (stdout = keep(stdout, c)));
    child.stderr.on("data", (c: Buffer) => (stderr = keep(stderr, c)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });

/** 生成は重いので、同時に1件だけにする。後から来たものは順番を待つ。 */
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

/** CLI の引数。 */
export function cliArgs(input: string, output: string, format: ExportFormat, layout: EpubLayout | undefined, fontDir: string): string[] {
  return [
    format,
    input,
    ...(format === "epub" ? ["--layout", layout ?? "fixed"] : []),
    "--offline",
    "--font-dir",
    fontDir,
    "-o",
    output,
    "--json",
  ];
}

/** `--json` の出力から頁数と警告を読む。読めなければ空。 */
function readReport(stdout: string): { pages?: number; warnings: ExportWarning[] } {
  try {
    const report = JSON.parse(stdout) as { pages?: unknown; warnings?: unknown };
    const warnings = Array.isArray(report.warnings)
      ? report.warnings.flatMap((w) => {
          const x = w as { kind?: unknown; message?: unknown };
          return typeof x.kind === "string" ? [{ kind: x.kind, message: typeof x.message === "string" ? x.message : "" }] : [];
        })
      : [];
    return { ...(typeof report.pages === "number" ? { pages: report.pages } : {}), warnings };
  } catch {
    return { warnings: [] };
  }
}

export function exportBook(repo: BookRepository, request: ExportRequest, options: ExportOptions = {}): Promise<ExportOutcome> {
  return serialize(() => run(repo, request, options));
}

async function run(repo: BookRepository, request: ExportRequest, options: ExportOptions): Promise<ExportOutcome> {
  const book = await repo.getWithAssetData(request.bookId);
  if (!book) return { ok: false, reason: "not_found" };
  let bundle: Buffer;
  if (request.versionId !== undefined) {
    const got = await repo.getVersionBundle(request.bookId, request.versionId);
    if (!got) return { ok: false, reason: "version_not_found" };
    bundle = got;
  } else {
    bundle = await toBundle(book);
  }

  const cli = options.cliPath ?? (process.env.POSTEXT_CLI_PATH?.trim() || "/app/bin/postext");
  const fontDir = options.fontDir ?? (process.env.POSTEXT_FONT_DIR?.trim() || "/app/fonts");
  const dir = await mkdtemp(path.join(options.tmpRoot ?? tmpdir(), "postext-export-"));
  try {
    const input = path.join(dir, "book.postext");
    const output = path.join(dir, `book.${request.format}`);
    await writeFile(input, bundle);
    let result: RunResult;
    try {
      result = await (options.run ?? spawnRunner)(cli, cliArgs(input, output, request.format, request.layout, fontDir), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    } catch (error) {
      return { ok: false, reason: "failed", message: `postext を起動できませんでした: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (result.timedOut) return { ok: false, reason: "failed", message: "生成が時間内に終わりませんでした" };
    if (result.code !== 0) {
      const tail = result.stderr.trim().split("\n").slice(-3).join(" / ");
      return { ok: false, reason: "failed", message: `postext が終了コード ${result.code} で止まりました${tail ? `: ${tail}` : ""}` };
    }
    const bytes = await readFile(output);
    return { ok: true, bytes, title: book.title, ...readReport(result.stdout) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
