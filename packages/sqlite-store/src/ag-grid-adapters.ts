import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Data from "effect/Data";
import type * as Fiber from "effect/Fiber";
import * as FiberApi from "effect/Fiber";
import * as Runtime from "effect/Runtime";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type {
  ColumnState,
  IViewportDatasource,
  IViewportDatasourceParams,
  SortModelItem,
} from "ag-grid-community";

import { translateAgGridQuery } from "@sandbox/ag-grid-translator";

import type { SqliteRow } from "./store-config";
import type { StoreMetrics } from "./worker-contract";
import type {
  ReadOnlySqliteWorkerClient,
  SqliteViewportSessionHandle,
} from "./worker-client";

export interface GridStoreAdapterOptions {
  storeId: string;
  queryDebounceMs?: number;
  runtime?: Runtime.Runtime<never>;
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
      readonly session: SqliteViewportSessionHandle;
      readonly startPromise: Promise<void>;
    }
  | {
      readonly _tag: "Live";
      readonly version: number;
      readonly session: SqliteViewportSessionHandle;
      readonly scope: Scope.CloseableScope;
    }
  | {
      readonly _tag: "Destroyed";
      readonly version: number;
    };

const ViewportDatasourceState = Data.taggedEnum<ViewportDatasourceState>();

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

export interface ViewportDatasourceHandle extends IViewportDatasource {
  refreshQuery(options?: {
    debounce?: boolean;
  }): void;
}

export function createSqliteViewportDatasource<TData extends SqliteRow = SqliteRow>(
  collection: Pick<ReadOnlySqliteWorkerClient<TData>, "openViewportSession">,
  options: GridStoreAdapterOptions,
): ViewportDatasourceHandle {
  let params: IViewportDatasourceParams<TData> | null = null;
  let state: ViewportDatasourceState = ViewportDatasourceState.Idle({
    version: 0,
  });
  let queryRefreshFiber: Fiber.RuntimeFiber<void, unknown> | null = null;
  let queryRefreshToken = 0;
  let patchCount = 0;
  let ignoredPatchCount = 0;
  let isLoading = true;
  let lastPatchLatencyMs: number | null = null;
  const queryDebounceMs = options.queryDebounceMs ?? DEFAULT_QUERY_DEBOUNCE_MS;
  const runtime = options.runtime ?? Runtime.defaultRuntime;
  let viewportRange = {
    startRow: 0,
    endRow: INITIAL_VIEWPORT_ROW_COUNT,
  };
  const readState = (): ViewportDatasourceState => state;
  const runFork = <A, E>(effect: Effect.Effect<A, E, never>) =>
    Runtime.runFork(runtime)(effect);
  const runPromise = <A, E>(effect: Effect.Effect<A, E, never>) =>
    Runtime.runPromise(runtime)(effect);
  const clearQueryRefreshFiber = () => {
    if (queryRefreshFiber === null) {
      return Promise.resolve();
    }

    const fiber = queryRefreshFiber;
    queryRefreshFiber = null;
    return runPromise(FiberApi.interrupt(fiber));
  };

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
    await clearQueryRefreshFiber();

    await ViewportDatasourceState.$match(currentState, {
      Idle: async () => undefined,
      Destroyed: async () => undefined,
      Starting: async ({ session }) => {
        await session.close().catch(() => undefined);
      },
      Live: async ({ session, scope }) => {
        await runPromise(Scope.close(scope, Exit.succeed(undefined)));
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
      rows: ReadonlyArray<TData>;
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
    currentParams.setRowData(toViewportRows(patch.startRow, patch.rows));
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
      const scope = await runPromise(Scope.make());
      const latestState = state;
      if (
        params !== currentParams ||
        latestState._tag !== "Starting" ||
        latestState.version !== version ||
        latestState.session !== nextSession
      ) {
        await runPromise(Scope.close(scope, Exit.succeed(undefined)));
        await nextSession.close().catch(() => undefined);
        return;
      }

      state = ViewportDatasourceState.Live({
        version,
        session: nextSession,
        scope,
      });
      await runPromise(
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
    const currentParams = params;
    if (currentParams === null) {
      return;
    }

    await ViewportDatasourceState.$match(readState(), {
      Destroyed: async () => undefined,
      Idle: async () => {
        beginLoading();
        await startViewportSession(currentParams);
      },
      Starting: async ({ startPromise }) => {
        await startPromise;
        await syncViewportQuery(kind);
      },
      Live: async ({ session }) => {
        if (kind === "query") {
          beginLoading();
        }

        if (!isFiniteRowIndex(viewportRange.startRow) || !isFiniteRowIndex(viewportRange.endRow)) {
          return;
        }

        await session.replace({
          startRow: viewportRange.startRow,
          endRow: viewportRange.endRow,
          query: readQuery(currentParams),
        }).catch(() => undefined);
      },
    });
  };

  const scheduleViewportQueryRefresh = async () => {
    const token = ++queryRefreshToken;
    await clearQueryRefreshFiber();
    if (token !== queryRefreshToken) {
      return;
    }

    if (queryDebounceMs <= 0) {
      await syncViewportQuery("query").catch(() => undefined);
      return;
    }

    let fiber: Fiber.RuntimeFiber<void, unknown>;
    fiber = runFork(
      Effect.sleep(Duration.millis(queryDebounceMs)).pipe(
        Effect.andThen(
          Effect.suspend(() => token === queryRefreshToken
            ? Effect.promise(() => syncViewportQuery("query"))
            : Effect.void),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (queryRefreshFiber === fiber) {
              queryRefreshFiber = null;
            }
          }),
        ),
      ),
    );
    queryRefreshFiber = fiber;
  };

  return {
    init(nextParams) {
      params = nextParams;
      void startViewportSession(nextParams).catch(reportViewportError);
    },
    setViewportRange(firstRow, lastRow) {
      if (!isFiniteRowIndex(firstRow) || !isFiniteRowIndex(lastRow)) {
        return;
      }

      queryRefreshToken += 1;
      viewportRange = {
        startRow: firstRow,
        endRow: lastRow + 1,
      };
      void clearQueryRefreshFiber()
        .then(() => syncViewportQuery("range"))
        .catch(reportViewportError);
    },
    refreshQuery(refreshOptions) {
      if (refreshOptions?.debounce) {
        void scheduleViewportQueryRefresh();
        return;
      }
      queryRefreshToken += 1;
      void clearQueryRefreshFiber()
        .then(() => syncViewportQuery("query"))
        .catch(reportViewportError);
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
