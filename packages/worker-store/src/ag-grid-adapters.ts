import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Data from "effect/Data";
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
  isLoading: boolean;
  lastPatchLatencyMs: number | null;
  ignoredPatchCount: number;
  patchCount: number;
}

const INITIAL_VIEWPORT_ROW_COUNT = 50;
const DEFAULT_QUERY_DEBOUNCE_MS = 200;
type ViewportRefreshKind = "range" | "query";

type ViewportDatasourceState =
  | {
      readonly _tag: "Idle";
      readonly version: number;
    }
  | {
      readonly _tag: "Starting";
      readonly version: number;
      readonly session: WorkerViewportSessionHandle;
      readonly startPromise: Promise<void>;
    }
  | {
      readonly _tag: "Live";
      readonly version: number;
      readonly session: WorkerViewportSessionHandle;
      readonly scope: Scope.CloseableScope;
    }
  | {
      readonly _tag: "Destroyed";
      readonly version: number;
    };

const ViewportDatasourceState = Data.taggedEnum<ViewportDatasourceState>();

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
  refreshQuery(options?: {
    debounce?: boolean;
  }): void;
}

export function createViewportDatasource<TData extends RowRecord = RowRecord>(
  collection: Pick<WorkerCollectionHandle, "openViewportSession">,
  options: GridStoreAdapterOptions,
): ViewportDatasourceHandle {
  let params: IViewportDatasourceParams<TData> | null = null;
  let state: ViewportDatasourceState = ViewportDatasourceState.Idle({
    version: 0,
  });
  let queryRefreshHandle: ReturnType<typeof setTimeout> | null = null;
  let patchCount = 0;
  let ignoredPatchCount = 0;
  let isLoading = true;
  let lastPatchLatencyMs: number | null = null;
  const queryDebounceMs = options.queryDebounceMs ?? DEFAULT_QUERY_DEBOUNCE_MS;
  let viewportRange = {
    startRow: 0,
    endRow: INITIAL_VIEWPORT_ROW_COUNT,
  };
  const readState = (): ViewportDatasourceState => state;

  const emitDiagnostics = (
    fulfilledRange: ViewportDiagnostics["fulfilledRange"] = null,
  ) => {
    options.onViewportDiagnostics?.({
      requestedRange: { ...viewportRange },
      fulfilledRange,
      requestVersion: state.version,
      isLoading,
      lastPatchLatencyMs,
      ignoredPatchCount,
      patchCount,
    });
  };

  const beginLoading = () => {
    isLoading = true;
    emitDiagnostics();
  };

  const closeResources = async (currentState: ViewportDatasourceState) => {
    if (queryRefreshHandle !== null) {
      clearTimeout(queryRefreshHandle);
      queryRefreshHandle = null;
    }

    await ViewportDatasourceState.$match(currentState, {
      Idle: async () => undefined,
      Destroyed: async () => undefined,
      Starting: async ({ session }) => {
        await session.close().catch(() => undefined);
      },
      Live: async ({ session, scope }) => {
        await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
        await session.close().catch(() => undefined);
      },
    });
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
    isLoading = false;
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
    const version = state.version + 1;
    const nextSession = collection.openViewportSession({
      startRow: viewportRange.startRow,
      endRow: viewportRange.endRow,
      query: readQuery(currentParams),
    });

    let startPromise = Promise.resolve();
    state = ViewportDatasourceState.Starting({
      version,
      session: nextSession,
      startPromise,
    });
    startPromise = (async () => {
      const scope = await Effect.runPromise(Scope.make());
      const latestState = state;
      if (
        params !== currentParams ||
        latestState._tag !== "Starting" ||
        latestState.version !== version ||
        latestState.session !== nextSession
      ) {
        await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
        await nextSession.close().catch(() => undefined);
        return;
      }

      state = ViewportDatasourceState.Live({
        version,
        session: nextSession,
        scope,
      });
      await Effect.runPromise(
        Scope.extend(
          Stream.runForEachScoped(nextSession.updates, (patch) =>
            Effect.sync(() => {
              const currentState = state;
              if (
                params === null ||
                params !== currentParams ||
                currentState._tag !== "Live" ||
                currentState.version !== version ||
                currentState.session !== nextSession
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
    })().finally(() => {
      const latestState = state;
      if (
        latestState._tag === "Starting" &&
        latestState.version === version &&
        latestState.session === nextSession
      ) {
        state = ViewportDatasourceState.Idle({
          version,
        });
      }
    });
    state = ViewportDatasourceState.Starting({
      version,
      session: nextSession,
      startPromise,
    });
    return startPromise;
  };

  const syncViewportQuery = async (kind: ViewportRefreshKind) => {
    if (params === null || state._tag === "Destroyed") {
      return;
    }

    if (state._tag === "Idle") {
      beginLoading();
      await startViewportSession(params);
      return;
    }

    if (state._tag === "Starting") {
      await state.startPromise;
      const latestState = readState();
      if (params === null || latestState._tag !== "Live") {
        return;
      }
    }

    if (kind === "query") {
      beginLoading();
    }
    if (state._tag !== "Live") {
      return;
    }

    await state.session.replace({
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
      void syncViewportQuery("query").catch(() => undefined);
      return;
    }

    queryRefreshHandle = setTimeout(() => {
      queryRefreshHandle = null;
      void syncViewportQuery("query").catch(() => undefined);
    }, queryDebounceMs);
  };

  return {
    init(nextParams) {
      params = nextParams;
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
      void syncViewportQuery("range").catch(() => undefined);
    },
    refreshQuery(options) {
      if (options?.debounce) {
        scheduleViewportQueryRefresh();
        return;
      }

      if (queryRefreshHandle !== null) {
        clearTimeout(queryRefreshHandle);
        queryRefreshHandle = null;
      }
      void syncViewportQuery("query").catch(() => undefined);
    },
    destroy() {
      const currentState = state;
      params = null;
      state = ViewportDatasourceState.Destroyed({
        version: currentState.version + 1,
      });
      void closeResources(currentState);
    },
  };
}
