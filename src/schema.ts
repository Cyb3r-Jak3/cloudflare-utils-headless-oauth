import { int, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const registrationsTable = sqliteTable("registrations", {
  registrationId: text().notNull(),
  codeVerifier: text(),
  accessToken: text(),
  expiresAt: int().notNull(),
  retrieveToken: text(),
}, (table) => [
  uniqueIndex("idx_registrationId").on(table.registrationId)
]);
