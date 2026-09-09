import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Minimal `fileURLToPath` — importing `node:url` would pull Node types into a
 * tsconfig that intentionally has none.
 * `new URL(...).pathname` is not usable here: on Windows it yields
 * "/D:/...", which the migration reader then resolves to "D:\D:\...".
 */
function localPath(url: URL): string {
  return decodeURIComponent(url.href.replace(/^file:\/+/u, ""));
}

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      bindings: {
        APP_SECRET: "integration-app-secret",
        DATA_ENCRYPTION_KEY: "integration-data-secret",
        TEST_MIGRATIONS: await readD1Migrations(localPath(new URL("./migrations", import.meta.url))),
      },
    },
  }))],
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
