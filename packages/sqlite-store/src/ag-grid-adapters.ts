import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import type {
  ColumnState,
  IViewportDatasource,
  IViewportDatasourceParams,
  SortModelItem,
} from "ag-grid-community";

import { translateAgGridQuery } from "@sandbox/ag-grid-translator";

import type { SqliteRow } from "./store-config";
import type { ViewportIntent, ViewportPatch } from "./worker-contract";
import type {
  ReadOnlySqliteWorkerClient,
  SqliteViewportChannelHandle,
} from "./worker-client";

export interface GridStoreAdapterOptions {
  throttleMs?: number;
  onSnapshot?: (snapshot: {
    startRow: number;
    endRow: number;
    rowCount: number;
  }) => void;
  onViewportDiagnostics?: (diagnostics: ViewportDiagnostics) => void;
}

export interface ViewportDiagnostics {
  requestedRange: {
    startRow: number;
    endRow: number;
  };
  fulfilledRange: {
    startRow: number;
    endRow: number;
  } | null;
  isLoading: boolean;
  lastPatchLatencyMs: number | null;
  patchCount: number;
}

export interface SqliteViewportDatasource extends IViewportDatasource {
  queryChanged(): void;
}

const INITIAL_VIEWPORT_ROW_COUNT = 50;
const DEFAULT_THROTTLE_MS = 100;

function reportViewportError(error: unknown) {
  console.error("[sqlite-viewport]", error);
}

function columnStateToSortModel(
  columnState: ReadonlyArray<ColumnState>,
): ReadonlyArray<SortModelItem> {
  return [...columnState]
    .filter(
      (column): column is ColumnState & { colId: string; sort: "asc" | "desc" } =>
        typeof column.colId === "string" &&
        (column.sort === "asc" || column.sort === "desc"),
    )
    .sort((left, right) =>
      (left.sortIndex ?? Number.MAX_SAFE_INTEGER) - (right.sortIndex ?? Number.MAX_SAFE_INTEGER))
    .map((column) => ({
      colId: column.colId,
      sort: column.sort,
    }));
}

function toViewportRows<TRow extends SqliteRow>(
  startRow: number,
  rows: ReadonlyArray<TRow>,
): Record<number, TRow> {
  return Object.fromEntries(rows.map((row, index) => [startRow + index, row]));
}

function readQuery<TData extends SqliteRow>(
  params: IViewportDatasourceParams<TData>,
) {
  return translateAgGridQuery({
    filterModel: params.api.getFilterModel(),
    sortModel: columnStateToSortModel(params.api.getColumnState()),
  });
}

function isFiniteRowIndex(value: number) {
  return Number.isFinite(value) && value >= 0;
}

export function createSqliteViewportDatasource<TData extends SqliteRow = SqliteRow>(
  collection: Pick<ReadOnlySqliteWorkerClient<TData>, "storeId" | "openViewportChannel">,
  options: GridStoreAdapterOptions,
): SqliteViewportDatasource {
  let params: IViewportDatasourceParams<TData> | null = null;
  let channel: SqliteViewportChannelHandle<TData> | null = null;
  let updatesFiber: Fiber.Fiber<void, unknown> | null = null;
  let queryChangeQueued = false;
  let requestedRange = {
    startRow: 0,
    endRow: INITIAL_VIEWPORT_ROW_COUNT,
  };
  let diagnostics: ViewportDiagnostics = {
    requestedRange,
    fulfilledRange: null,
    isLoading: true,
    lastPatchLatencyMs: null,
    patchCount: 0,
  };

  const emitDiagnostics = () => {
    options.onViewportDiagnostics?.(diagnostics);
  };

  const updateDiagnostics = (
    next: Partial<ViewportDiagnostics>,
  ) => {
    diagnostics = {
      ...diagnostics,
      ...next,
    };
    emitDiagnostics();
  };

  const makeIntent = (range = requestedRange): ViewportIntent | null => {
    if (params === null) {
      return null;
    }

    return {
      storeId: collection.storeId,
      startRow: range.startRow,
      endRow: range.endRow,
      query: readQuery(params),
    };
  };

  const applyPatch = (patch: ViewportPatch<TData>) => {
    if (params === null) {
      return;
    }

    params.setRowCount(patch.rowCount, false);
    params.setRowData(toViewportRows(patch.startRow, patch.rows));
    options.onSnapshot?.({
      startRow: patch.startRow,
      endRow: patch.endRow,
      rowCount: patch.rowCount,
    });
    updateDiagnostics({
      fulfilledRange: {
        startRow: patch.startRow,
        endRow: patch.endRow,
      },
      isLoading: false,
      lastPatchLatencyMs: patch.latencyMs,
      patchCount: diagnostics.patchCount + 1,
    });
  };

  const sendLatestIntent = () => {
    if (channel === null) {
      return;
    }

    const intent = makeIntent();
    if (intent === null) {
      return;
    }

    updateDiagnostics({
      requestedRange,
      isLoading: true,
    });
    void channel.setIntent(intent).catch(reportViewportError);
  };

  const flushQueuedQueryChange = () => {
    queryChangeQueued = false;
    sendLatestIntent();
  };

  const destroy = () => {
    if (updatesFiber !== null) {
      Effect.runFork(Fiber.interrupt(updatesFiber));
      updatesFiber = null;
    }

    if (channel !== null) {
      void channel.close().catch(() => undefined);
      channel = null;
    }

    queryChangeQueued = false;
    params = null;
  };

  return {
    init(nextParams) {
      destroy();
      params = nextParams;
      requestedRange = {
        startRow: 0,
        endRow: INITIAL_VIEWPORT_ROW_COUNT,
      };
      diagnostics = {
        requestedRange,
        fulfilledRange: null,
        isLoading: true,
        lastPatchLatencyMs: null,
        patchCount: 0,
      };
      emitDiagnostics();

      const initialIntent = makeIntent(requestedRange);
      if (initialIntent === null) {
        return;
      }

      channel = collection.openViewportChannel({
        initialIntent,
        throttleMs: options.throttleMs ?? DEFAULT_THROTTLE_MS,
      });
      updatesFiber = Effect.runFork(
        Stream.runForEach(channel.updates, (patch) =>
          Effect.sync(() => {
            applyPatch(patch as ViewportPatch<TData>);
          })),
      );
    },
    setViewportRange(firstRow, lastRow) {
      if (!isFiniteRowIndex(firstRow) || !isFiniteRowIndex(lastRow)) {
        return;
      }

      requestedRange = {
        startRow: firstRow,
        endRow: lastRow + 1,
      };
      sendLatestIntent();
    },
    queryChanged() {
      if (queryChangeQueued) {
        return;
      }

      queryChangeQueued = true;
      queueMicrotask(flushQueuedQueryChange);
    },
    destroy,
  };
}
