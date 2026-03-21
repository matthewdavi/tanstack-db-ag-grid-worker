// @vitest-environment jsdom

import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";
import { describe } from "vitest";

import { defineAgGridSqliteEngine } from "./engine";
import { installFileFetchShim } from "./test-file-fetch";

const inventoryTable = sqliteTable("inventory_items", {
  sku: text("sku").primaryKey(),
  label: text("label").notNull(),
  quantity: integer("quantity").notNull(),
  price: real("unit_price").notNull(),
  active: integer("is_active", { mode: "boolean" }).notNull(),
});

installFileFetchShim();

describe("ag grid sqlite engine", () => {
  it.effect("defines engine metadata", () =>
    Effect.gen(function* () {
      const engine = defineAgGridSqliteEngine({
        table: inventoryTable,
        rowKey: "sku",
      });

      expect(engine.rowKey).toBe("sku");
      expect(typeof engine.makeWorkerService).toBe("function");
    }),
  );
});
