import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      bindings: {
        APP_SECRET: "integration-app-secret",
        DATA_ENCRYPTION_KEY: "integration-data-secret",
        // `new URL(...).pathname` yields "/D:/..." on Windows, which the
        // migration reader then resolves to the non-existent "D:\D:\...".
        TEST_MIGRATIONS: await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url))),
      },
    },
  }))],
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
