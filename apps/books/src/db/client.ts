import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

let cached: { pool: Pool; db: Db } | undefined;

// next build がルートを読み込むだけで接続しないよう、最初の要求まで作らない。
export function getDb(): Db {
  if (!cached) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const pool = new Pool({ connectionString: url });
    cached = { pool, db: drizzle(pool, { schema }) };
  }
  return cached.db;
}
