// 既存の画像・フォント（PostgreSQL の bytea）を R2 の参照へ移す。
//
// 使い方（ローカルまたはコンテナ内）:
//   pnpm --dir apps/books exec esbuild scripts/migrate-assets-to-r2.ts --bundle --platform=node --format=cjs \
//     --target=node22 --external:pg-native --outfile=/tmp/migrate-assets-to-r2.cjs
//   DATABASE_URL=... R2_ENDPOINT=... R2_*_ACCESS_KEY_ID=... R2_*_SECRET_ACCESS_KEY=... \
//   OUTLINE_URL=... OUTLINE_API_TOKEN=... node /tmp/migrate-assets-to-r2.cjs --dry-run
//
// --dry-run は DB と R2 へ書かず、何が変わるかとバイト数だけを出す。
// 移行済みの行は飛ばすので、途中で止まっても同じコマンドで続けられる。
// bytea を消しても領域は戻らないので、終わったら別途 VACUUM FULL assets, book_versions, designs を検討する。

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/db/schema";
import { createOutlineClient, outlineConfigFromEnv } from "../src/outline/client";
import { blobStoreFromEnv } from "../src/storage/config";
import { migrateAssetsToR2 } from "../src/storage/migrate";

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const outlineConfig = outlineConfigFromEnv();
  const outline = outlineConfig ? createOutlineClient(outlineConfig) : undefined;
  if (!outline) console.warn("OUTLINE_URL / OUTLINE_API_TOKEN がないため、Outline の画像も自前のバケットへ移します");

  const pool = new Pool({ connectionString: url });
  try {
    const stats = await migrateAssetsToR2({
      db: drizzle(pool, { schema }),
      store: blobStoreFromEnv(),
      ...(outline ? { fetchOutline: (id: string) => outline.fetchAttachment(id) } : {}),
      dryRun,
      log: (line) => console.log(line),
    });
    console.log(dryRun ? "--- dry-run（何も書き込んでいません）---" : "--- 完了 ---");
    console.log(JSON.stringify(stats, null, 2));
    if (stats.assetsFailed + stats.versionsFailed + stats.designsFailed > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
