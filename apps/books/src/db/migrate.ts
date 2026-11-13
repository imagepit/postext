import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

// コンテナ起動時に呼ぶ。drizzle は適用済みの移行を記録するので何度実行しても同じ結果になる。
// DATABASE_URL がなければ DB なしで起動できるよう、何もしない。
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("DATABASE_URL is not set; skipping migrations");
    return;
  }
  const folder = process.env.MIGRATIONS_DIR ?? path.join(process.cwd(), "drizzle");
  const pool = new Pool({ connectionString: url });
  try {
    await migrate(drizzle(pool), { migrationsFolder: folder });
    console.log("migrations applied");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
