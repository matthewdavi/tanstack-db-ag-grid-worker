import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";
import { describe } from "vitest";

import { defineAgGridSqliteEngine } from "./engine";

const inventoryTable = sqliteTable("inventory_items", {
  sku: text("sku").primaryKey(),
  label: text("label").notNull(),
  quantity: integer("quantity").notNull(),
  price: real("unit_price").notNull(),
  active: integer("is_active", { mode: "boolean" }).notNull(),
});

type InventoryRow = typeof inventoryTable.$inferSelect;

const inventoryRows: ReadonlyArray<InventoryRow> = [
  {
    sku: "sku-1",
    label: "Alpha",
    quantity: 10,
    price: 12.5,
    active: true,
  },
  {
    sku: "sku-2",
    label: "Bravo",
    quantity: 20,
    price: 8.25,
    active: false,
  },
];

describe("ag grid sqlite engine", () => {
  it.effect("uses the configured row key for worker-side writes", () =>
    Effect.gen(function* () {
      const engine = defineAgGridSqliteEngine({
        table: inventoryTable,
        rowKey: "sku",
      });
      const runtime = engine.createWorkerRuntime({
        storeId: "inventory",
      });

      const initial = yield* Effect.promise(() => runtime.replaceAll(inventoryRows));
      const afterUpsert = yield* Effect.promise(() =>
        runtime.upsert([
          {
            sku: "sku-3",
            label: "Charlie",
            quantity: 5,
            price: 30,
            active: true,
          },
        ]));
      const afterDelete = yield* Effect.promise(() => runtime.delete(["sku-1"]));

      expect(engine.rowKey).toBe("sku");
      expect(initial.rowCount).toBe(2);
      expect(afterUpsert.rowCount).toBe(3);
      expect(afterDelete.rowCount).toBe(2);
    }));
});
