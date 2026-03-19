import { describe, expect, it } from "vitest";

import { translateAdvancedFilter, translateColumnFilters } from "@sandbox/ag-grid-translator";

import { createRowCollection, executeGridQuery } from "./query-runtime";

const rows = [
  {
    id: "1",
    athlete: "Michael Phelps",
    age: 23,
    year: 2008,
    country: "USA",
    sport: "Swimming",
    active: true,
    gold: 8,
  },
  {
    id: "2",
    athlete: "Usain Bolt",
    age: 22,
    year: 2008,
    country: "Jamaica",
    sport: "Sprinting",
    active: true,
    gold: 3,
  },
  {
    id: "3",
    athlete: "Missy Franklin",
    age: 17,
    year: 2012,
    country: "USA",
    sport: "Swimming",
    active: false,
    gold: 4,
  },
  {
    id: "4",
    athlete: "Allyson Felix",
    age: 26,
    year: 2012,
    country: "USA",
    sport: "Sprinting",
    active: true,
    gold: 3,
  },
];

describe("TanStack DB grid query runtime", () => {
  it("executes column filter translations against a TanStack DB collection", async () => {
    const collection = createRowCollection({
      id: "athletes",
      rows,
    });

    const predicate = translateColumnFilters({
      country: {
        filterType: "set",
        values: ["USA"],
      },
      age: {
        filterType: "number",
        operator: "AND",
        conditions: [
          { filterType: "number", type: "greaterThanOrEqual", filter: 20 },
          { filterType: "number", type: "lessThanOrEqual", filter: 26 },
        ],
      },
    });

    const results = await executeGridQuery(collection, {
      predicate,
      sorts: [
        { field: "year", direction: "asc" },
        { field: "athlete", direction: "asc" },
      ],
    });

    expect(results.rowCount).toBe(2);
    expect(results.rows.map((row) => row.id)).toEqual(["1", "4"]);
  });

  it("keeps parity between advanced-filter and column-filter translations", async () => {
    const collection = createRowCollection({
      id: "athletes-advanced",
      rows,
    });

    const advancedPredicate = translateAdvancedFilter({
      filterType: "join",
      type: "AND",
      conditions: [
        {
          filterType: "text",
          colId: "sport",
          type: "equals",
          filter: "Swimming",
        },
        {
          filterType: "number",
          colId: "gold",
          type: "greaterThan",
          filter: 4,
        },
      ],
    });

    const columnPredicate = translateColumnFilters({
      sport: {
        filterType: "text",
        type: "equals",
        filter: "Swimming",
      },
      gold: {
        filterType: "number",
        type: "greaterThan",
        filter: 4,
      },
    });

    const [advancedResults, columnResults] = await Promise.all([
      executeGridQuery(collection, {
        predicate: advancedPredicate,
        sorts: [{ field: "athlete", direction: "asc" }],
      }),
      executeGridQuery(collection, {
        predicate: columnPredicate,
        sorts: [{ field: "athlete", direction: "asc" }],
      }),
    ]);

    expect(advancedResults.rowCount).toBe(1);
    expect(columnResults.rowCount).toBe(1);
    expect(advancedResults.rows.map((row) => row.id)).toEqual(["1"]);
    expect(columnResults.rows.map((row) => row.id)).toEqual(["1"]);
  });

  it("returns the requested sorted window without materializing the caller-side slice", async () => {
    const collection = createRowCollection({
      id: "athletes-window",
      rows,
    });

    const results = await executeGridQuery(collection, {
      predicate: null,
      sorts: [{ field: "athlete", direction: "asc" }],
    }, {
      offset: 1,
      limit: 2,
    });

    expect(results.rowCount).toBe(4);
    expect(results.rows.map((row) => row.id)).toEqual(["1", "3"]);
  });

  it("applies direct writes atomically through writeBatch", () => {
    const collection = createRowCollection({
      id: "batched",
      rows: [],
    });

    const changes: Array<ReadonlyArray<{ type: string }>> = [];
    collection.subscribeChanges((nextChanges) => {
      changes.push(nextChanges.map((change) => ({ type: change.type })));
    });

    collection.utils.writeBatch(() => {
      collection.utils.writeInsert({
        id: "batched-1",
        athlete: "Queued",
      });
      collection.utils.writeInsert({
        id: "batched-2",
        athlete: "Replace me",
      });
      collection.utils.writeUpdate({
        id: "batched-2",
        athlete: "Updated",
      });
      collection.utils.writeDelete("batched-1");
    });

    expect(collection.size).toBe(1);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toHaveLength(1);
    expect(collection.get("batched-1")).toBeUndefined();
    expect(collection.get("batched-2")).toMatchObject({
      id: "batched-2",
      athlete: "Updated",
    });
    expect(collection.utils.getMetrics().lastCommitChangeCount).toBe(4);
    expect(collection.utils.getMetrics().totalCommitCount).toBeGreaterThan(0);
    expect(collection.utils.getMetrics().lastCommitDurationMs).not.toBeNull();
  });

  it("merges partial updates and collapses nested batches into one commit", () => {
    const collection = createRowCollection({
      id: "nested-batched",
      rows: [
        {
          id: "batched-1",
          athlete: "Queued",
          country: "USA",
          gold: 1,
        },
      ],
    });

    const changes: Array<ReadonlyArray<{ type: string }>> = [];
    collection.subscribeChanges((nextChanges) => {
      changes.push(nextChanges.map((change) => ({ type: change.type })));
    });

    collection.utils.writeBatch(() => {
      collection.utils.writeUpdate({
        id: "batched-1",
        gold: 2,
      });
      collection.utils.writeBatch(() => {
        collection.utils.writeUpsert({
          id: "batched-2",
          athlete: "New row",
          country: "Canada",
          gold: 3,
        });
      });
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toHaveLength(2);
    expect(collection.get("batched-1")).toMatchObject({
      id: "batched-1",
      athlete: "Queued",
      country: "USA",
      gold: 2,
    });
    expect(collection.get("batched-2")).toMatchObject({
      id: "batched-2",
      athlete: "New row",
      country: "Canada",
      gold: 3,
    });
    expect(collection.utils.getMetrics().lastCommitChangeCount).toBe(2);
    expect(collection.utils.getMetrics().totalCommitCount).toBeGreaterThan(0);
  });
});
