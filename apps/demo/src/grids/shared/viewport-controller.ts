import { createStore } from "@xstate/store";
import type { Subscription } from "@xstate/store";
import type {
  FilterChangedEvent,
  GridApi,
  GridReadyEvent,
} from "ag-grid-community";

import type { MarketRow } from "../../market-sqlite-store";
import {
  createInitialMetrics,
  createInitialViewportDiagnostics,
  setGridLoading,
  type ViewportDatasourceClient,
  type ViewportDatasourceLike,
} from "./types";

interface CreateViewportGridControllerOptions {
  datasourceClient: ViewportDatasourceClient;
  createDatasource?: (options: {
    storeId: string;
    onSnapshot: (snapshot: {
      startRow: number;
      endRow: number;
      rowCount: number;
      metrics: ReturnType<typeof createInitialMetrics>;
    }) => void;
    onViewportDiagnostics: (diagnostics: ReturnType<typeof createInitialViewportDiagnostics>) => void;
  }) => ViewportDatasourceLike;
  useGridLoadingOverlay: boolean;
  onPushLiveUpdate?: () => void;
  onSetStressRate?: (rowsPerSecond: number) => void;
}

export function createViewportGridController(
  options: CreateViewportGridControllerOptions,
){
  let api: GridApi<MarketRow> | null = null;
  let datasource: ViewportDatasourceLike | null = null;
  let subscription: Subscription | null = null;

  const refreshQuery = (queryOptions?: {
    debounce?: boolean;
  }) => {
    datasource?.refreshQuery(queryOptions);
  };

  const cleanup = () => {
    subscription?.unsubscribe();
    subscription = null;
    datasource?.destroy?.();
    datasource = null;
    api = null;
  };

  const bindDatasource = (gridApi: GridApi<MarketRow>) => {
    datasource = options.createDatasource
      ? options.createDatasource({
          storeId: options.datasourceClient.storeId,
          onSnapshot(snapshot) {
            store.trigger.snapshot({ snapshot });
          },
          onViewportDiagnostics(diagnostics) {
            store.trigger.diagnostics({ diagnostics });
          },
        })
      : options.datasourceClient.viewportDatasource({
          onSnapshot(snapshot) {
            store.trigger.snapshot({ snapshot });
          },
          onViewportDiagnostics(diagnostics) {
            store.trigger.diagnostics({ diagnostics });
          },
        });
    gridApi.setGridOption("viewportDatasource", datasource);
    setGridLoading(
      gridApi,
      options.useGridLoadingOverlay &&
        store.getSnapshot().context.diagnostics.isLoading,
    );
  };

  const store = createStore({
    context: {
      rowsPerSecond: 0,
      rowCount: 0,
      metrics: createInitialMetrics(),
      diagnostics: createInitialViewportDiagnostics(),
    },
    on: {
      snapshot: (context, event: {
        snapshot: {
          rowCount: number;
          metrics: ReturnType<typeof createInitialMetrics>;
        };
      }) => ({
        ...context,
        rowCount: event.snapshot.rowCount,
        metrics: event.snapshot.metrics,
      }),
      diagnostics: (context, event: {
        diagnostics: ReturnType<typeof createInitialViewportDiagnostics>;
      }) => ({
        ...context,
        diagnostics: event.diagnostics,
      }),
      refreshRequested: (context, event: { debounce?: boolean }, enqueue) => {
        enqueue.effect(() => {
          refreshQuery({
            debounce: event.debounce,
          });
        });

        return context;
      },
      pushLiveUpdateRequested: (context, _event, enqueue) => {
        enqueue.effect(() => {
          options.onPushLiveUpdate?.();
        });

        return context;
      },
      stressRateInputChanged: (context, event: { rowsPerSecond: number }, enqueue) => {
        enqueue.effect(() => {
          options.onSetStressRate?.(event.rowsPerSecond);
        });

        return {
          ...context,
          rowsPerSecond: event.rowsPerSecond,
        };
      },
      stopStressRequested: (context, _event, enqueue) => {
        enqueue.effect(() => {
          options.onSetStressRate?.(0);
        });

        return {
          ...context,
          rowsPerSecond: 0,
        };
      },
    },
  });

  return {
    store,
    onGridReady(event: GridReadyEvent<MarketRow>) {
      cleanup();
      api = event.api;
      bindDatasource(event.api);
      subscription = store.subscribe((snapshot) => {
        setGridLoading(
          api,
          options.useGridLoadingOverlay && snapshot.context.diagnostics.isLoading,
        );
      });
      event.api.addEventListener("gridPreDestroyed", cleanup);
    },
    onFilterChanged(event: FilterChangedEvent<MarketRow>) {
      store.trigger.refreshRequested({
        debounce: event.afterFloatingFilter === true,
      });
    },
    onSortChanged() {
      store.trigger.refreshRequested({});
    },
    onPushLiveUpdate: options.onPushLiveUpdate
      ? () => {
          store.trigger.pushLiveUpdateRequested();
        }
      : undefined,
    onStopStressStream: options.onSetStressRate
      ? () => {
          store.trigger.stopStressRequested();
        }
      : undefined,
    onStressRateInput(value: string) {
      const rowsPerSecond = Number(value);
      store.trigger.stressRateInputChanged({ rowsPerSecond });
    },
  };
}
