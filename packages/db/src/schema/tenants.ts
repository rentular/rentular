import {
  mysqlTable,
  varchar,
  text,
  timestamp,
  mysqlEnum,
  boolean,
  index,
} from "drizzle-orm/mysql-core";
import { users } from "./users";

export const tenants = mysqlTable("tenants", {
  id: varchar("id", { length: 36 }).primaryKey().notNull(),
  ownerId: varchar("owner_id", { length: 255 })
    .notNull()
    .references(() => users.id),
  firstName: varchar("first_name", { length: 255 }).notNull(),
  lastName: varchar("last_name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }),
  phone: varchar("phone", { length: 50 }),
  language: mysqlEnum("language", ["nl", "fr", "de", "en"])
    .default("nl")
    .notNull(),
  // Preferred reminder channel (some tenants are only reachable on WhatsApp)
  preferredChannel: mysqlEnum("preferred_channel", ["email", "sms", "whatsapp"])
    .default("email")
    .notNull(),
  // Correspondence address, overrides the rented property's address on letters.
  // correspondenceCountry has no default on purpose, so "no correspondence
  // address on file" stays distinguishable from "lives in Belgium".
  correspondenceStreet: varchar("correspondence_street", { length: 255 }),
  correspondenceStreetNumber: varchar("correspondence_street_number", { length: 20 }),
  correspondenceBox: varchar("correspondence_box", { length: 20 }),
  correspondencePostalCode: varchar("correspondence_postal_code", { length: 10 }),
  correspondenceCity: varchar("correspondence_city", { length: 255 }),
  correspondenceCountry: varchar("correspondence_country", { length: 2 }),
  // Belgian-specific
  nationalRegister: varchar("national_register", { length: 20 }), // Rijksregisternummer
  iban: varchar("iban", { length: 34 }),
  // GoCardless
  gocardlessCustomerId: varchar("gocardless_customer_id", { length: 255 }),
  gocardlessMandateId: varchar("gocardless_mandate_id", { length: 255 }),
  // Metadata
  notes: text("notes"),
  isArchived: boolean("is_archived").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  ownerIdx: index("tenants_owner_idx").on(table.ownerId),
}));
