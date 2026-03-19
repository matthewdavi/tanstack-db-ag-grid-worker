import { afterEach, describe, expect, it, vi } from "vitest";

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
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("batches sync writes through the custom collection creator before committing", async () => {
    vi.useFakeTimers();

    const collection = createRowCollection({
      id: "batched",
      rows: [],
      commitDebounceMs: 100,
    });

    const changes: Array<ReadonlyArray<{ type: string }>> = [];
    collection.subscribeChanges((nextChanges) => {
      changes.push(nextChanges.map((change) => ({ type: change.type })));
    });

    collection.utils.writeChanges([
      {
        type: "insert",
        value: {
          id: "batched-1",
          athlete: "Queued",
        },
      },
    ]);

    expect(collection.size).toBe(0);
    expect(changes).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(99);
    expect(collection.size).toBe(0);
    expect(changes).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(collection.size).toBe(1);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.map((change) => change.type)).toEqual(["insert"]);
    expect(collection.utils.getMetrics().lastCommitChangeCount).toBe(1);
    expect(collection.utils.getMetrics().totalCommitCount).toBeGreaterThan(0);
    expect(collection.utils.getMetrics().lastCommitDurationMs).not.toBeNull();
  });
});
