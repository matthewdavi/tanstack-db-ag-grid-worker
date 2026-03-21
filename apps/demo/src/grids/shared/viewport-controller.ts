import { createStore } from "@xstate/store";
import type { Subscription } from "@xstate/store";
import type { GridApi, GridReadyEvent } from "ag-grid-community";

import type { MarketRow } from "../../market-sqlite-store";
import {
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
      : options.datasourceClient.open({
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
      diagnostics: createInitialViewportDiagnostics(),
    },
    on: {
      snapshot: (context, event: {
        snapshot: {
          rowCount: number;
        };
      }) => ({
        ...context,
        rowCount: event.snapshot.rowCount,
      }),
      diagnostics: (context, event: {
        diagnostics: ReturnType<typeof createInitialViewportDiagnostics>;
      }) => ({
        ...context,
        diagnostics: event.diagnostics,
      }),
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
    onFilterChanged() {
      datasource?.queryChanged?.();
    },
    onSortChanged() {
      datasource?.queryChanged?.();
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
