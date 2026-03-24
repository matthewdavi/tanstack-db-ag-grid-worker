import { createAtom } from "@xstate/store";
import type { AgGridReactProps } from "ag-grid-react";

import { demoGridTheme } from "../../ag-grid-theme";
import type { DemoSqliteClient } from "../../browser-clients";
import type { MarketRow } from "../../market-sqlite-store";
import { createRowCountStatusBar } from "../shared/status-bar";
import { createViewportGridController } from "../shared/viewport-controller";
import {
  createViewportLoadingOverlay,
  defaultMarketColumnDef,
  marketColumnDefs,
} from "../shared/market-grid-props";

export const sqliteViewportGridProps: AgGridReactProps<MarketRow> = {
  theme: demoGridTheme,
  columnDefs: [...marketColumnDefs],
  defaultColDef: defaultMarketColumnDef,
  overlayLoadingTemplate: createViewportLoadingOverlay(
    "Initializing DB",
    "Starting SQLite in the worker and loading the first viewport.",
  ),
  rowModelType: "viewport",
  viewportRowModelPageSize: 50,
  viewportRowModelBufferSize: 20,
  rowBuffer: 0,
};

const controllerAtom = createAtom<ReturnType<typeof createViewportGridController> | null>(null);

export function getSqliteViewportGridModel(client: DemoSqliteClient) {
  let controller = controllerAtom.get();
  if (!controller) {
    controller = createViewportGridController({
      datasourceClient: client,
      useGridLoadingOverlay: true,
      onPushLiveUpdate() {
        client.pushLiveUpdate();
      },
      onSetStressRate(rowsPerSecond) {
        client.setStressRate(rowsPerSecond);
      },
    });
    controllerAtom.set(controller);
  }

  return {
    controller,
    gridProps: {
      ...sqliteViewportGridProps,
      onFilterChanged: controller.onFilterChanged,
      onGridReady: controller.onGridReady,
      onSortChanged: controller.onSortChanged,
      statusBar: createRowCountStatusBar(
        "SQLite rows",
        controller.store.getSnapshot().context.rowCount,
      ),
    } satisfies AgGridReactProps<MarketRow>,
  };
}
