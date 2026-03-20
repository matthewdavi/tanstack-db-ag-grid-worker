import { describe, expect, it } from "vitest";

import { planViewportQuery } from "./sql-planner";

describe("sqlite sql planner", () => {
  it("builds count and rows SQL for sorted viewport queries", () => {
    const plan = planViewportQuery(
      {
        predicate: null,
        sorts: [{ field: "price", direction: "asc" }],
      },
      {
        startRow: 10,
        endRow: 25,
      },
    );

    expect(plan.countSql).toBe(`select count(*) as count from "demo_rows"`);
    expect(plan.rowsSql).toContain(`order by "price" asc`);
    expect(plan.rowsSql).toContain(`limit ? offset ?`);
    expect(plan.rowsParams).toEqual([15, 10]);
  });

  it("supports nested predicate groups and stable default ordering", () => {
    const plan = planViewportQuery(
      {
        predicate: {
          kind: "group",
          operator: "and",
          predicates: [
            {
              kind: "comparison",
              field: "sector",
              filterType: "text",
              operator: "eq",
              value: "Technology",
            },
            {
              kind: "group",
              operator: "or",
              predicates: [
                {
                  kind: "comparison",
                  field: "symbol",
                  filterType: "text",
                  operator: "startsWith",
                  value: "A",
                },
                {
                  kind: "comparison",
                  field: "company",
                  filterType: "text",
                  operator: "contains",
                  value: "Labs",
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
      `where ("sector" = ? and (lower("symbol") like ? escape '\\' or lower("company") like ? escape '\\'))`,
    );
    expect(plan.countParams).toEqual(["Technology", "a%", "%labs%"]);
    expect(plan.rowsSql).toContain(`order by "id" asc`);
    expect(plan.rowsParams).toEqual(["Technology", "a%", "%labs%", 50, 0]);
  });
});
