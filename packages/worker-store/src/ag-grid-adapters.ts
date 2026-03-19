import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type {
  ColumnState,
  IServerSideDatasource,
  IServerSideGetRowsParams,
  IViewportDatasource,
  IViewportDatasourceParams,
  SortModelItem,
} from "ag-grid-community";

import { translateAgGridQuery } from "@sandbox/ag-grid-translator";

import type { RowRecord } from "./query-runtime";
import type { StoreMetrics } from "./worker-contract";
import type {
  WorkerCollectionHandle,
  WorkerViewportSessionHandle,
} from "./worker-client";

export interface GridStoreAdapterOptions {
  storeId: string;
  queryDebounceMs?: number;
  onSnapshot?: (snapshot: {
    startRow: number;
    endRow: number;
    rowCount: number;
    metrics: StoreMetrics;
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
  requestVersion: number;
  lastPatchLatencyMs: number | null;
  ignoredPatchCount: number;
  patchCount: number;
}

const INITIAL_VIEWPORT_ROW_COUNT = 50;
const DEFAULT_QUERY_DEBOUNCE_MS = 200;

function columnStateToSortModel(
  columnState: ReadonlyArray<ColumnState>,
): ReadonlyArray<SortModelItem> {
  return [...columnState]
    .filter(
      (column): column is ColumnState & { colId: string; sort: "asc" | "desc" } =>
        typeof column.colId === "string" &&
        (column.sort === "asc" || column.sort === "desc"),
    )
    .sort((left, right) => (left.sortIndex ?? Number.MAX_SAFE_INTEGER) - (right.sortIndex ?? Number.MAX_SAFE_INTEGER))
    .map((column) => ({
      colId: column.colId,
      sort: column.sort,
    }));
}

function toViewportRows(
  startRow: number,
  rows: ReadonlyArray<RowRecord>,
): Record<number, RowRecord> {
  return Object.fromEntries(
    rows.map((row, index) => [startRow + index, row]),
  );
}

function isUnsupportedServerSideRequest(
  params: IServerSideGetRowsParams,
): boolean {
  const { request } = params;
  return (
    request.rowGroupCols.length > 0 ||
    request.valueCols.length > 0 ||
    request.pivotCols.length > 0 ||
    request.pivotMode ||
    request.groupKeys.length > 0
  );
}

function readQuery<TData extends RowRecord>(
  params: IViewportDatasourceParams<TData>,
) {
  return translateAgGridQuery({
    filterModel: params.api.getFilterModel(),
    sortModel: columnStateToSortModel(params.api.getColumnState()),
  });
}

export function createServerSideDatasource<TData extends RowRecord = RowRecord>(
  collection: Pick<WorkerCollectionHandle, "getRows">,
  options: GridStoreAdapterOptions,
): IServerSideDatasource<TData> {
  return {
    getRows(params) {
      if (isUnsupportedServerSideRequest(params)) {
        params.fail();
        return;
      }

      const query = translateAgGridQuery({
        filterModel: params.request.filterModel,
        sortModel: params.request.sortModel,
      });

      void collection
        .getRows({
          startRow: params.request.startRow ?? 0,
          endRow: params.request.endRow ?? params.request.startRow ?? 0,
          query,
        })
        .then((response) => {
          options.onSnapshot?.({
            startRow: response.startRow,
            endRow: response.endRow,
            rowCount: response.rowCount,
            metrics: response.metrics,
          });
          params.success({
            rowData: response.rows as TData[],
            rowCount: response.rowCount,
          });
        })
        .catch(() => {
          params.fail();
        });
    },
  };
}

export interface ViewportDatasourceHandle extends IViewportDatasource {
  refreshQuery(): void;
}

export function createViewportDatasource<TData extends RowRecord = RowRecord>(
  collection: Pick<WorkerCollectionHandle, "openViewportSession">,
  options: GridStoreAdapterOptions,
): ViewportDatasourceHandle {
  let params: IViewportDatasourceParams<TData> | null = null;
  let activeScope: Scope.CloseableScope | null = null;
  let viewportSession: WorkerViewportSessionHandle | null = null;
  let sessionStart: Promise<void> | null = null;
  let queryRefreshHandle: ReturnType<typeof setTimeout> | null = null;
  let lifecycleVersion = 0;
  let patchCount = 0;
  let ignoredPatchCount = 0;
  let lastPatchLatencyMs: number | null = null;
  const queryDebounceMs = options.queryDebounceMs ?? DEFAULT_QUERY_DEBOUNCE_MS;
  let viewportRange = {
    startRow: 0,
    endRow: INITIAL_VIEWPORT_ROW_COUNT,
  };

  const emitDiagnostics = (
    fulfilledRange: ViewportDiagnostics["fulfilledRange"] = null,
  ) => {
    options.onViewportDiagnostics?.({
      requestedRange: { ...viewportRange },
      fulfilledRange,
      requestVersion: lifecycleVersion,
      lastPatchLatencyMs,
      ignoredPatchCount,
      patchCount,
    });
  };

  const closeActiveResources = async () => {
    if (queryRefreshHandle !== null) {
      clearTimeout(queryRefreshHandle);
      queryRefreshHandle = null;
    }

    if (activeScope === null) {
      if (viewportSession !== null) {
        const session = viewportSession;
        viewportSession = null;
        await session.close().catch(() => undefined);
      }
      return;
    }

    const scope = activeScope;
    activeScope = null;
    const session = viewportSession;
    viewportSession = null;
    sessionStart = null;
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
    if (session !== null) {
      await session.close().catch(() => undefined);
    }
  };

  const applyPatch = (
    currentParams: IViewportDatasourceParams<TData>,
    patch: {
      startRow: number;
      endRow: number;
      rowCount: number;
      latencyMs: number;
      metrics: StoreMetrics;
      rows: ReadonlyArray<RowRecord>;
    },
  ) => {
    patchCount += 1;
    lastPatchLatencyMs = patch.latencyMs;
    options.onSnapshot?.({
      startRow: patch.startRow,
      endRow: patch.endRow,
      rowCount: patch.rowCount,
      metrics: patch.metrics,
    });
    emitDiagnostics({
      startRow: patch.startRow,
      endRow: patch.endRow,
    });
    currentParams.setRowCount(patch.rowCount, true);
    currentParams.setRowData(
      toViewportRows(patch.startRow, patch.rows) as Record<number, TData>,
    );
  };

  const startViewportSession = (currentParams: IViewportDatasourceParams<TData>) => {
    const start = async () => {
      const version = ++lifecycleVersion;
      const nextSession = collection.openViewportSession({
        startRow: viewportRange.startRow,
        endRow: viewportRange.endRow,
        query: readQuery(currentParams),
      });
      viewportSession = nextSession;

      const scope = await Effect.runPromise(Scope.make());
      if (params !== currentParams || version !== lifecycleVersion) {
        await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
        await nextSession.close().catch(() => undefined);
        if (viewportSession === nextSession) {
          viewportSession = null;
        }
        return;
      }

      activeScope = scope;
      await Effect.runPromise(
        Scope.extend(
          Stream.runForEachScoped(nextSession.updates, (patch) =>
            Effect.sync(() => {
              if (
                params === null ||
                params !== currentParams ||
                version !== lifecycleVersion ||
                viewportSession !== nextSession
              ) {
                ignoredPatchCount += 1;
                emitDiagnostics();
                return;
              }

              applyPatch(currentParams, patch);
            }),
          ).pipe(Effect.forkScoped),
          scope,
        ),
      );
    };

    const startPromise = start();
    sessionStart = startPromise.finally(() => {
      if (sessionStart === startPromise) {
        sessionStart = null;
      }
    });
    return startPromise;
  };

  const syncViewportQuery = async () => {
    if (params === null) {
      return;
    }

    if (viewportSession === null) {
      await startViewportSession(params);
      return;
    }

    if (sessionStart !== null) {
      await sessionStart;
      if (params === null || viewportSession === null) {
        return;
      }
    }

    await viewportSession.replace({
      startRow: viewportRange.startRow,
      endRow: viewportRange.endRow,
      query: readQuery(params),
    }).catch(() => undefined);
  };

  const scheduleViewportQueryRefresh = () => {
    if (queryRefreshHandle !== null) {
      clearTimeout(queryRefreshHandle);
      queryRefreshHandle = null;
    }

    if (queryDebounceMs <= 0) {
      void syncViewportQuery().catch(() => undefined);
      return;
    }

    queryRefreshHandle = setTimeout(() => {
      queryRefreshHandle = null;
      void syncViewportQuery().catch(() => undefined);
    }, queryDebounceMs);
  };

  return {
    init(nextParams) {
      params = nextParams;
      emitDiagnostics();
      void startViewportSession(nextParams).catch(() => undefined);
    },
    setViewportRange(firstRow, lastRow) {
      if (queryRefreshHandle !== null) {
        clearTimeout(queryRefreshHandle);
        queryRefreshHandle = null;
      }
      viewportRange = {
        startRow: firstRow,
        endRow: lastRow + 1,
      };
      emitDiagnostics();
      void syncViewportQuery().catch(() => undefined);
    },
    refreshQuery() {
      emitDiagnostics();
      scheduleViewportQueryRefresh();
    },
    destroy() {
      lifecycleVersion += 1;
      params = null;
      void closeActiveResources();
    },
  };
}
