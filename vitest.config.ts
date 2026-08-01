import {
	cloudflareTest,
	type D1Migration,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig, defineProject } from "vitest/config";
import fs from "node:fs";
import path from "node:path";

// drizzle-kit writes each migration into its own `<timestamp>_<name>/migration.sql`
// folder, not the flat `NNNN_name.sql` layout `readD1Migrations` expects, so the
// migrations are read and split manually here instead.
function readDrizzleMigrations(migrationsPath: string): D1Migration[] {
  const dirs = fs
    .readdirSync(migrationsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  return dirs.map((dir) => {
    const migrationPath = path.join(migrationsPath, dir, "migration.sql");
    const sql = fs.readFileSync(migrationPath, "utf8");
    const queries = sql
      .split("--> statement-breakpoint")
      .map((query) => query.trim())
      .filter(Boolean);
    return { name: dir, queries };
  });
}

export default defineConfig(async () => {
  const migrationsPath = path.join(import.meta.dirname, "drizzle");
  const migrations = readDrizzleMigrations(migrationsPath);
  return defineProject({
    plugins: [cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { TEST_MIGRATIONS: migrations },
      },
    })],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      reporters: ['default', 'junit'],
      outputFile: './junit.xml',
      coverage: {
        provider: 'istanbul',
        reporter: ['text', 'json',]
      }
    },
  });
})