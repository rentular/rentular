import {
  mysqlTable,
  varchar,
  timestamp,
  boolean,
  json,
  mysqlEnum,
  index,
} from "drizzle-orm/mysql-core";
import { leases } from "./leases";

// One row per time a rent month was marked paid by hand (overview, API, the
// landlord email link, MCP). Keeps the exact state of the payment row before
// and after the mark so the mark can be undone exactly. payment_id has no
// foreign key on purpose: undoing a mark that created its row deletes that row.
export const paymentManualMarks = mysqlTable(
  "payment_manual_marks",
  {
    id: varchar("id", { length: 36 }).primaryKey().notNull(),
    leaseId: varchar("lease_id", { length: 36 })
      .notNull()
      .references(() => leases.id),
    // The rent month that was marked paid: YYYY-MM.
    month: varchar("month", { length: 7 }).notNull(),
    paymentId: varchar("payment_id", { length: 36 }).notNull(),
    // True when the mark inserted the payment row (undo deletes it).
    createdRow: boolean("created_row").default(false).notNull(),
    // The row's fields before the mark; null when the mark created the row.
    beforeState: json("before_state"),
    // The row's fields right after the mark, to see whether it changed since.
    afterState: json("after_state"),
    source: mysqlEnum("source", ["overview", "api", "magic_link", "mcp", "other"])
      .default("other")
      .notNull(),
    // The user who marked; for the email link, the landlord the link was sent to.
    markedBy: varchar("marked_by", { length: 255 }),
    markedAt: timestamp("marked_at").defaultNow().notNull(),
    undoneAt: timestamp("undone_at"),
    undoneBy: varchar("undone_by", { length: 255 }),
  },
  (table) => ({
    leaseMonthIdx: index("pmm_lease_month_undone_idx").on(table.leaseId, table.month, table.undoneAt),
    paymentIdx: index("pmm_payment_idx").on(table.paymentId),
  }),
);
