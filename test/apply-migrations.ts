import type { D1Migration } from "cloudflare:test";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

const testMigrations = (env as typeof env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;

await applyD1Migrations(env.D1, testMigrations)
