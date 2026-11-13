import { fromBundle, toBundle } from "./bundle";
import type {
  Book,
  BookRepository,
  BookSummary,
  BookWrite,
  Result,
  VersionSummary,
} from "./model";

export async function listBooks(repo: BookRepository): Promise<BookSummary[]> {
  return repo.list();
}

export async function createBook(repo: BookRepository, input: BookWrite): Promise<Book> {
  return repo.create(input);
}

export async function getBook(repo: BookRepository, id: string): Promise<Result<{ book: Book }>> {
  const book = await repo.get(id);
  return book ? { ok: true, book } : { ok: false, reason: "not_found" };
}

/** baseRevision は呼び出し側が読んだときの revision。一致しなければ何も書き換えない。 */
export async function saveBook(
  repo: BookRepository,
  id: string,
  baseRevision: number,
  input: BookWrite,
): Promise<Result<{ revision: number }>> {
  return repo.replace(id, baseRevision, input);
}

export async function listVersions(
  repo: BookRepository,
  bookId: string,
): Promise<Result<{ versions: VersionSummary[] }>> {
  const versions = await repo.listVersions(bookId);
  return versions ? { ok: true, versions } : { ok: false, reason: "not_found" };
}

/** 現在の書籍を .postext にして保存する。書籍の revision は変えない。 */
export async function createVersion(
  repo: BookRepository,
  bookId: string,
  label: string,
): Promise<Result<{ version: VersionSummary }>> {
  const book = await repo.getWithAssetData(bookId);
  if (!book) return { ok: false, reason: "not_found" };
  const bundle = await toBundle(book);
  const version = await repo.addVersion(bookId, { label, revision: book.revision, bundle });
  return version ? { ok: true, version } : { ok: false, reason: "not_found" };
}

/** 版の内容を書籍へ書き戻し、revision を1増やす。baseRevision の照合は保存と同じ。 */
export async function restoreVersion(
  repo: BookRepository,
  bookId: string,
  versionId: string,
  baseRevision: number,
): Promise<Result<{ revision: number }>> {
  const bytes = await repo.getVersionBundle(bookId, versionId);
  if (!bytes) return { ok: false, reason: "not_found" };
  return repo.replace(bookId, baseRevision, await fromBundle(bytes));
}
