import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const demoRowsTable = sqliteTable("demo_rows", {
  id: text("id").primaryKey(),
  active: integer("active", { mode: "boolean" }).notNull(),
  symbol: text("symbol").notNull(),
  company: text("company").notNull(),
  sector: text("sector").notNull(),
  venue: text("venue").notNull(),
  price: real("price").notNull(),
  volume: integer("volume").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type RowRecord = typeof demoRowsTable.$inferSelect;
