import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import type { DesignPart } from "postext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import * as schema from "../db/schema";
import { parseDesignMeta } from "./model";
import type { DesignRecord, DesignRepository } from "./model";
import { createPgDesignRepository } from "./repository";

const url =
  process.env.TEST_DATABASE_URL ?? "postgres://books:books-local-only@127.0.0.1:55439/books";

let pool: Pool;
let repo: DesignRepository;

beforeAll(async () => {
  pool = new Pool({ connectionString: url });
  const db: Db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.join(__dirname, "../../drizzle") });
  repo = createPgDesignRepository(db);
});

afterAll(async () => {
  await pool.end();
});

const bytesOf = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7) % 256));

describe("designs repository", () => {
  it("upserts, lists, reads identical bytes, updates, and deletes", async () => {
    const id = `design-test-${Date.now().toString(36)}`;
    const bytes = bytesOf(5000);
    const first: DesignRecord = {
      id,
      name: "和文の本",
      description: "説明",
      source: "元の本",
      parts: ["page", "text"] as DesignPart[],
      createdAt: 1_700_000_000_123,
      updatedAt: 1_700_000_000_456,
      bytes,
    };
    await repo.upsert(first);

    const listed = (await repo.list()).find((d) => d.id === id);
    expect(listed).toEqual({
      id,
      name: "和文の本",
      description: "説明",
      source: "元の本",
      parts: ["page", "text"] as DesignPart[],
      createdAt: 1_700_000_000_123,
      updatedAt: 1_700_000_000_456,
      size: 5000,
    });

    const got = await repo.get(id);
    expect(got?.bytes.equals(bytes)).toBe(true);
    expect(got?.createdAt).toBe(1_700_000_000_123);
    expect(got?.updatedAt).toBe(1_700_000_000_456);

    const newer = bytesOf(10);
    await repo.upsert({ ...first, name: "改名", description: undefined, updatedAt: 1_700_000_999_999, bytes: newer });
    const updated = await repo.get(id);
    expect(updated?.name).toBe("改名");
    expect(updated?.description).toBeUndefined();
    expect(updated?.createdAt).toBe(1_700_000_000_123);
    expect(updated?.updatedAt).toBe(1_700_000_999_999);
    expect(updated?.bytes.equals(newer)).toBe(true);

    expect(await repo.delete(id)).toBe(true);
    expect(await repo.get(id)).toBeNull();
    expect(await repo.delete(id)).toBe(false);
  });

  it("lists newest first", async () => {
    const tag = Date.now().toString(36);
    const a = `design-order-a-${tag}`;
    const b = `design-order-b-${tag}`;
    const base = { parts: [], createdAt: 1, bytes: bytesOf(3) };
    await repo.upsert({ ...base, id: a, name: "a", updatedAt: 9_000_000_000_001 });
    await repo.upsert({ ...base, id: b, name: "b", updatedAt: 9_000_000_000_002 });
    const ids = (await repo.list()).map((d) => d.id).filter((i) => i === a || i === b);
    expect(ids).toEqual([b, a]);
    await repo.delete(a);
    await repo.delete(b);
  });
});

describe("design metadata validation", () => {
  const ok = { name: "x", parts: ["page"], createdAt: 1, updatedAt: 2 };
  it("accepts valid metadata", () => {
    expect(parseDesignMeta("design-abc_1", ok).ok).toBe(true);
  });
  it("rejects bad ids and metadata", () => {
    expect(parseDesignMeta("", ok).ok).toBe(false);
    expect(parseDesignMeta("../x", ok).ok).toBe(false);
    expect(parseDesignMeta("a".repeat(129), ok).ok).toBe(false);
    expect(parseDesignMeta("a", { ...ok, name: " " }).ok).toBe(false);
    expect(parseDesignMeta("a", { ...ok, parts: [1] }).ok).toBe(false);
    expect(parseDesignMeta("a", { ...ok, updatedAt: 1.5 }).ok).toBe(false);
  });
});
