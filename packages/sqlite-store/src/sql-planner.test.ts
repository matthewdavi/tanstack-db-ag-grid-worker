import { describe, expect, it } from "vitest";
import { sqliteTable, integer, real, text } from "drizzle-orm/sqlite-core";

import { defineSqliteStore } from "./store-config";
import { planViewportQuery } from "./sql-planner";

const inventoryTable = sqliteTable("inventory_items", {
  sku: text("sku").primaryKey(),
  label: text("label").notNull(),
  quantity: integer("quantity").notNull(),
  price: real("unit_price").notNull(),
  active: integer("is_active", { mode: "boolean" }).notNull(),
  updatedAt: text("updated_at").notNull(),
});

const inventoryStore = defineSqliteStore({
  table: inventoryTable,
  rowKey: "sku",
});

describe("sqlite sql planner", () => {
  it("builds count and rows SQL for sorted viewport queries", () => {
    const plan = planViewportQuery(
      inventoryStore,
      {
        predicate: null,
        sorts: [{ field: "price", direction: "asc" }],
      },
      {
        startRow: 10,
        endRow: 25,
      },
    );

    expect(plan.countSql).toBe(`select count(*) as count from "inventory_items"`);
    expect(plan.rowsSql).toContain(`order by "unit_price" asc`);
    expect(plan.rowsSql).toContain(`limit ? offset ?`);
    expect(plan.rowsParams).toEqual([15, 10]);
  });

  it("supports nested predicate groups and stable default ordering", () => {
    const plan = planViewportQuery(
      inventoryStore,
      {
        predicate: {
          kind: "group",
          operator: "and",
          predicates: [
            {
              kind: "comparison",
                field: "active",
                filterType: "text",
                operator: "true",
              },
              {
                kind: "group",
                operator: "or",
                predicates: [
                  {
                    kind: "comparison",
                    field: "label",
                    filterType: "text",
                    operator: "startsWith",
                    value: "A",
                  },
                  {
                    kind: "comparison",
                    field: "updatedAt",
                    filterType: "text",
                    operator: "contains",
                    value: "2026",
                  },
                ],
              },
          ],
        },
        sorts: [],
      },
      {
        startRow: 0,
        endRow: 50,
      },
    );

    expect(plan.countSql).toContain(
      `where ("is_active" = true and (lower("label") like ? escape '\\' or lower("updated_at") like ? escape '\\'))`,
    );
    expect(plan.countParams).toEqual(["a%", "%2026%"]);
    expect(plan.rowsSql).toContain(`order by "sku" asc`);
    expect(plan.rowsParams).toEqual(["a%", "%2026%", 50, 0]);
  });
});
