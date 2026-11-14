import {
  mysqlTable,
  varchar,
  text,
  timestamp,
  mysqlEnum,
  index,
} from "drizzle-orm/mysql-core";
import { users } from "./users";

// A landlord's own GoCardless account, connected through Rentular's GoCardless
// partner app (OAuth). Used on a hosted multi-landlord install so that rent is
// collected into each landlord's own creditor, never into a shared one. The
// access token is stored AES-256-GCM encrypted with apps/api/src/lib/encryption.ts
// and never leaves the API.
export const gocardlessConnections = mysqlTable(
  "gocardless_connections",
  {
    id: varchar("id", { length: 36 }).primaryKey().notNull(),
    ownerId: varchar("owner_id", { length: 255 })
      .notNull()
      .unique()
      .references(() => users.id),
    organisationId: varchar("organisation_id", { length: 64 }).notNull(),
    creditorId: varchar("creditor_id", { length: 64 }),
    creditorName: varchar("creditor_name", { length: 255 }),
    accessTokenEncrypted: text("access_token_encrypted"),
    accessTokenIv: varchar("access_token_iv", { length: 64 }),
    accessTokenAuthTag: varchar("access_token_auth_tag", { length: 64 }),
    environment: mysqlEnum("environment", ["sandbox", "live"]).notNull(),
    scheme: varchar("scheme", { length: 32 }),
    status: mysqlEnum("status", ["active", "revoked", "error"])
      .default("active")
      .notNull(),
    connectedAt: timestamp("connected_at").defaultNow().notNull(),
    lastError: text("last_error"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    organisationIdx: index("gocardless_connections_organisation_idx").on(table.organisationId),
  }),
);
