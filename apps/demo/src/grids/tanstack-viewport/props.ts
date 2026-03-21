import { createAtom } from "@xstate/store";
import type { AgGridReactProps } from "ag-grid-react";

import { createViewportDatasource, type WorkerCollectionHandle } from "@sandbox/worker-store";

import { demoGridTheme } from "../../ag-grid-theme";
import type { MarketRow } from "../../market-sqlite-store";
import { createRowCountStatusBar } from "../shared/status-bar";
import { createViewportGridController } from "../shared/viewport-controller";
import {
  createViewportLoadingOverlay,
  defaultMarketColumnDef,
  getStableMarketRowId,
  marketColumnDefs,
} from "../shared/market-grid-props";

export const tanstackViewportGridProps: AgGridReactProps<MarketRow> = {
  theme: demoGridTheme,
  columnDefs: [...marketColumnDefs],
  defaultColDef: defaultMarketColumnDef,
  getRowId: getStableMarketRowId,
  overlayLoadingTemplate: createViewportLoadingOverlay(
    "Refreshing live query",
    "Recomputing filters and sort in the worker.",
  ),
  rowModelType: "viewport",
  viewportRowModelPageSize: 50,
  viewportRowModelBufferSize: 20,
  rowBuffer: 0,
};

const controllerAtom = createAtom<ReturnType<typeof createViewportGridController> | null>(null);

export function getTanstackViewportGridModel(collection: WorkerCollectionHandle) {
  let controller = controllerAtom.get();
  if (!controller) {
    controller = createViewportGridController({
      datasourceClient: {
        storeId: collection.storeId,
        viewportDatasource(options) {
          return createViewportDatasource(collection, {
            storeId: collection.storeId,
            onSnapshot: options?.onSnapshot,
            onViewportDiagnostics: options?.onViewportDiagnostics,
          });
        },
      },
      useGridLoadingOverlay: true,
      onPushLiveUpdate() {
        const timestamp = Date.now();
        void collection.applyTransaction({
          kind: "upsert",
          rows: [
            {
              id: `live-${timestamp}`,
              symbol: `L${String(timestamp).slice(-3)}`,
              company: `Live Market ${String(timestamp).slice(-4)}`,
              sector: "Technology",
              venue: "NASDAQ",
              price: 100 + ((timestamp / 1000) % 250),
              volume: 50_000,
              active: true,
              createdAt: new Date(timestamp).toISOString(),
              updatedAt: new Date(timestamp).toISOString(),
            },
          ],
        });
      },
      onSetStressRate(rowsPerSecond) {
        void collection.setStressRate(rowsPerSecond);
      },
    });
    controllerAtom.set(controller);
  }

  return {
    controller,
    gridProps: {
      ...tanstackViewportGridProps,
      onFilterChanged: controller.onFilterChanged,
      onGridReady: controller.onGridReady,
      onSortChanged: controller.onSortChanged,
      statusBar: createRowCountStatusBar(
        "TanStack rows",
        controller.store.getSnapshot().context.rowCount,
        controller.store.getSnapshot().context.metrics,
      ),
    } satisfies AgGridReactProps<MarketRow>,
  };
}
