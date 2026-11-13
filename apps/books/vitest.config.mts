import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.join(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    // 同じ DB を共有するので、ファイルは直列に実行する。
    fileParallelism: false,
  },
});
