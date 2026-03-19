import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type {
  ColumnState,
  IServerSideGetRowsParams,
  IViewportDatasourceParams,
} from "ag-grid-community";

import type { GridQueryState } from "@sandbox/ag-grid-translator";

import { createServerSideDatasource, createViewportDatasource } from "./ag-grid-adapters";
import { StoreRegistry } from "./store-registry";
import type { RowRecord } from "./query-runtime";

function createRegistryBackedCollection(registry: StoreRegistry, storeId: string) {
  let sessionCount = 0;

  return {
    storeId,
    getRows: (request: {
      startRow: number;
      endRow: number;
      query: GridQueryState;
    }) =>
      registry.getRows(storeId, request.query, {
        startRow: request.startRow,
        endRow: request.endRow,
      }),
    openViewportSession: (request: {
      startRow: number;
      endRow: number;
      query: GridQueryState;
      sessionId?: string;
    }) => {
      const sessionId = request.sessionId ?? `viewport-session-${++sessionCount}`;

      return {
        sessionId,
        updates: registry.openViewportSession({
          sessionId,
          storeId,
          startRow: request.startRow,
          endRow: request.endRow,
          query: request.query,
        }),
        replace: (nextRequest: {
          startRow: number;
          endRow: number;
          query: GridQueryState;
        }) =>
          Effect.runPromise(
            registry.replaceViewportSession({
              sessionId,
              startRow: nextRequest.startRow,
              endRow: nextRequest.endRow,
              query: nextRequest.query,
            }),
          ),
        close: () => Effect.runPromise(registry.closeViewportSession(sessionId)),
      };
    },
  };
}

function waitFor<T>(callback: () => T | undefined, timeoutMs = 250) {
  return new Promise<T>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    const poll = () => {
      const result = callback();
      if (result !== undefined) {
        resolve(result);
        return;
      }

      if (Date.now() > deadline) {
        reject(new Error("Timed out waiting for condition"));
        return;
      }

      setTimeout(poll, 5);
    };

    poll();
  });
}

describe("ag-grid worker adapters", () => {
  it("returns the same first-page ids through the SSRM adapter and viewport adapter", async () => {
    const registry = new StoreRegistry();
    registry.loadStore(
      {
        storeId: "athletes",
        rowKey: "id",
      },
      {
        kind: "rows",
        rows: [
          {
            id: "1",
            athlete: "Adam",
            country: "USA",
            sport: "Swimming",
            year: 2012,
          },
          {
            id: "2",
            athlete: "Bianca",
            country: "Canada",
            sport: "Rowing",
            year: 2016,
          },
          {
            id: "3",
            athlete: "Cara",
            country: "USA",
            sport: "Gymnastics",
            year: 2020,
          },
        ] as ReadonlyArray<RowRecord>,
      },
    );

    const collection = createRegistryBackedCollection(registry, "athletes");
    const serverSideDatasource = createServerSideDatasource(collection, {
      storeId: "athletes",
    });
    const viewportDatasource = createViewportDatasource(collection, {
      storeId: "athletes",
    });

    const serverRows = await new Promise<ReadonlyArray<RowRecord>>((resolve, reject) => {
      serverSideDatasource.getRows({
        request: {
          startRow: 0,
          endRow: 10,
          rowGroupCols: [],
          valueCols: [],
          pivotCols: [],
          pivotMode: false,
          groupKeys: [],
          filterModel: {
            country: {
              filterType: "text",
              type: "equals",
              filter: "USA",
            },
          },
          sortModel: [{ colId: "athlete", sort: "asc" }],
        },
        parentNode: {} as never,
        success: ({ rowData }) => resolve(rowData as ReadonlyArray<RowRecord>),
        fail: () => reject(new Error("SSRM request failed")),
        api: {} as never,
        context: {} as never,
      } as IServerSideGetRowsParams<RowRecord>);
    });

    let latestRowCount = 0;
    let latestViewportRows: Record<number, RowRecord> | null = null;
    viewportDatasource.init({
      api: {
        getFilterModel: () => ({
          country: {
            filterType: "text",
            type: "equals",
            filter: "USA",
          },
        }),
        getColumnState: () =>
          [
            {
              colId: "athlete",
              sort: "asc",
              sortIndex: 0,
            },
          ] as ReadonlyArray<ColumnState>,
      } as never,
      context: {} as never,
      setRowCount: (rowCount) => {
        latestRowCount = rowCount;
      },
      setRowData: (rowData) => {
        latestViewportRows = rowData as Record<number, RowRecord>;
      },
      getRow: vi.fn(),
    } as IViewportDatasourceParams<RowRecord>);

    viewportDatasource.setViewportRange(0, 9);

    const viewportRows = await waitFor(() =>
      latestViewportRows ? Object.values(latestViewportRows) : undefined,
    );

    expect(serverRows.map((row) => row.id)).toEqual(
      viewportRows.map((row) => row.id),
    );
    expect(latestRowCount).toBe(2);

    viewportDatasource.destroy?.();
  });

  it("stops pushing viewport updates after the datasource is destroyed", async () => {
    const registry = new StoreRegistry();
    registry.loadStore(
      {
        storeId: "viewport",
        rowKey: "id",
      },
      {
        kind: "rows",
        rows: [
          {
            id: "1",
            athlete: "A",
            country: "USA",
            sport: "Swimming",
            year: 2012,
          },
        ] as ReadonlyArray<RowRecord>,
      },
    );

    const collection = createRegistryBackedCollection(registry, "viewport");
    const datasource = createViewportDatasource(collection, {
      storeId: "viewport",
    });

    const updates: Array<Record<number, RowRecord>> = [];
    datasource.init({
      api: {
        getFilterModel: () => ({}),
        getColumnState: () => [] as ReadonlyArray<ColumnState>,
      } as never,
      context: {} as never,
      setRowCount: vi.fn(),
      setRowData: (rowData) => {
        updates.push(rowData as Record<number, RowRecord>);
      },
      getRow: vi.fn(),
    } as IViewportDatasourceParams<RowRecord>);

    datasource.setViewportRange(0, 9);
    await waitFor(() => (updates.length > 0 ? updates.length : undefined));

    datasource.destroy?.();
    const updateCountBeforeMutation = updates.length;
    registry.applyTransaction("viewport", {
      kind: "upsert",
      rows: [
        {
          id: "2",
          athlete: "B",
          country: "Canada",
          sport: "Rowing",
          year: 2016,
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(updates).toHaveLength(updateCountBeforeMutation);
  });

  it("bootstraps viewport row count during init so the grid can request a range", async () => {
    const registry = new StoreRegistry();
    registry.loadStore(
      {
        storeId: "bootstrap",
        rowKey: "id",
      },
      {
        kind: "rows",
        rows: [
          {
            id: "1",
            athlete: "Alpha",
            country: "USA",
            sport: "Swimming",
            year: 2012,
          },
          {
            id: "2",
            athlete: "Beta",
            country: "Canada",
            sport: "Rowing",
            year: 2016,
          },
        ] as ReadonlyArray<RowRecord>,
      },
    );

    const collection = createRegistryBackedCollection(registry, "bootstrap");
    const datasource = createViewportDatasource(collection, {
      storeId: "bootstrap",
    });

    let rowCount = 0;
    let initialRows: Record<number, RowRecord> | null = null;
    datasource.init({
      api: {
        getFilterModel: () => ({}),
        getColumnState: () => [] as ReadonlyArray<ColumnState>,
      } as never,
      context: {} as never,
      setRowCount: (nextRowCount) => {
        rowCount = nextRowCount;
      },
      setRowData: (rowData) => {
        initialRows = rowData as Record<number, RowRecord>;
      },
      getRow: vi.fn(),
    } as IViewportDatasourceParams<RowRecord>);

    const bootstrappedRows = await waitFor(() =>
      initialRows ? Object.values(initialRows) : undefined,
    );

    expect(rowCount).toBe(2);
    expect(bootstrappedRows.map((row) => row.id)).toEqual(["1", "2"]);
  });

  it("reports viewport range diagnostics when a requested slice is fulfilled", async () => {
    const rows = Array.from({ length: 80 }, (_, index) => ({
      id: `${index + 1}`,
      athlete: `Athlete ${index + 1}`,
      country: index % 2 === 0 ? "USA" : "Canada",
      sport: "Rowing",
      year: 2012 + (index % 3),
    })) as ReadonlyArray<RowRecord>;
    const queue = await Effect.runPromise(
      Queue.unbounded<{
        storeId: string;
        startRow: number;
        endRow: number;
        rowCount: number;
        metrics: {
          lastCommitDurationMs: number | null;
          lastCommitChangeCount: number;
          totalCommitCount: number;
        };
        rows: ReadonlyArray<RowRecord>;
      }>(),
    );
    const collection = {
      storeId: "diagnostics",
      openViewportSession: (request: {
        startRow: number;
        endRow: number;
        query: GridQueryState;
        sessionId?: string;
      }) => {
        void Effect.runPromise(
          Queue.offer(queue, {
            storeId: "diagnostics",
            startRow: request.startRow,
            endRow: request.endRow,
            rowCount: rows.length,
            metrics: {
              lastCommitDurationMs: 1,
              lastCommitChangeCount: 20,
              totalCommitCount: 1,
            },
            rows: rows.slice(request.startRow, request.endRow),
          }),
        );

        return {
          sessionId: request.sessionId ?? "diagnostics-session",
          updates: Stream.fromQueue(queue),
          replace: async (nextRequest: {
            startRow: number;
            endRow: number;
            query: GridQueryState;
          }) => {
            await Effect.runPromise(
              Queue.offer(queue, {
                storeId: "diagnostics",
                startRow: nextRequest.startRow,
                endRow: nextRequest.endRow,
                rowCount: rows.length,
                metrics: {
                  lastCommitDurationMs: 2,
                  lastCommitChangeCount: 20,
                  totalCommitCount: 2,
                },
                rows: rows.slice(nextRequest.startRow, nextRequest.endRow),
              }),
            );

            return {
              sessionId: "diagnostics-session",
              replaced: true,
            };
          },
          close: async () => {
            await Effect.runPromise(Queue.shutdown(queue));
            return {
              sessionId: "diagnostics-session",
              closed: true,
            };
          },
        };
      },
    };
    const diagnostics: Array<{
      requestedRange: { startRow: number; endRow: number };
      fulfilledRange: { startRow: number; endRow: number } | null;
      lastPatchLatencyMs: number | null;
    }> = [];
    const datasource = createViewportDatasource(collection, {
      storeId: "diagnostics",
      onViewportDiagnostics: (nextDiagnostics) => {
        diagnostics.push({
          requestedRange: nextDiagnostics.requestedRange,
          fulfilledRange: nextDiagnostics.fulfilledRange,
          lastPatchLatencyMs: nextDiagnostics.lastPatchLatencyMs,
        });
      },
    });

    datasource.init({
      api: {
        getFilterModel: () => ({}),
        getColumnState: () => [] as ReadonlyArray<ColumnState>,
      } as never,
      context: {} as never,
      setRowCount: vi.fn(),
      setRowData: vi.fn(),
      getRow: vi.fn(),
    } as IViewportDatasourceParams<RowRecord>);

    datasource.setViewportRange(20, 39);

    const fulfilledDiagnostics = await waitFor(() =>
      diagnostics.find(
        (entry) =>
          entry.requestedRange.startRow === 20 &&
          entry.fulfilledRange?.startRow === 20,
      ),
    );

    expect(fulfilledDiagnostics.requestedRange).toEqual({
      startRow: 20,
      endRow: 40,
    });
    expect(fulfilledDiagnostics.fulfilledRange).toEqual({
      startRow: 20,
      endRow: 40,
    });
    expect(fulfilledDiagnostics.lastPatchLatencyMs).not.toBeNull();
  });

  it("coalesces rapid refreshes into one latest-only viewport replace", async () => {
    vi.useFakeTimers();

    try {
      let filterValue = "";
      const replaceCalls: Array<GridQueryState> = [];
      const collection = {
        storeId: "debounced-refresh",
        openViewportSession: (request: {
          startRow: number;
          endRow: number;
          query: GridQueryState;
          sessionId?: string;
        }) => ({
          sessionId: request.sessionId ?? "debounced-refresh-session",
          updates: Stream.empty,
          replace: async (nextRequest: {
            startRow: number;
            endRow: number;
            query: GridQueryState;
          }) => {
            replaceCalls.push(nextRequest.query);

            return {
              sessionId: "debounced-refresh-session",
              replaced: true,
            };
          },
          close: async () => ({
            sessionId: "debounced-refresh-session",
            closed: true,
          }),
        }),
      };
      const datasource = createViewportDatasource(collection, {
        storeId: "debounced-refresh",
        queryDebounceMs: 200,
      });

      datasource.init({
        api: {
          getFilterModel: () =>
            filterValue.length === 0
              ? {}
              : {
                  company: {
                    filterType: "text",
                    type: "contains",
                    filter: filterValue,
                  },
                },
          getColumnState: () => [] as ReadonlyArray<ColumnState>,
        } as never,
        context: {} as never,
        setRowCount: vi.fn(),
        setRowData: vi.fn(),
        getRow: vi.fn(),
      } as IViewportDatasourceParams<RowRecord>);

      filterValue = "R";
      datasource.refreshQuery();
      filterValue = "Re";
      datasource.refreshQuery();
      filterValue = "Reilly";
      datasource.refreshQuery();

      await vi.advanceTimersByTimeAsync(199);
      expect(replaceCalls).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();

      expect(replaceCalls).toHaveLength(1);
      expect(replaceCalls[0]).toEqual(
        expect.objectContaining({
          predicate: expect.objectContaining({
            kind: "comparison",
            field: "company",
            operator: "contains",
            value: "Reilly",
          }),
        }),
      );

      datasource.destroy?.();
    } finally {
      vi.useRealTimers();
    }
  });
});
