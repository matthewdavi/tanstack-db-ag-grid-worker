import type { GridApi } from "ag-grid-community";
import type {
  AgGridSqliteClient,
  SqliteViewportDatasource,
} from "@sandbox/sqlite-store";

import type { MarketRow } from "../../market-sqlite-store";

export interface ViewportStateDiagnostics {
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

export interface ViewportSnapshot {
  startRow: number;
  endRow: number;
  rowCount: number;
}

export type ViewportDatasourceLike = SqliteViewportDatasource;

export interface ViewportDatasourceClient {
  readonly storeId: string;
  open(options?: {
    throttleMs?: number;
    onSnapshot?: (snapshot: ViewportSnapshot) => void;
    onViewportDiagnostics?: (diagnostics: ViewportStateDiagnostics) => void;
  }): ViewportDatasourceLike;
}

export type SqliteViewportClient = AgGridSqliteClient<MarketRow> & {
  pushLiveUpdate(): void;
  setStressRate(rowsPerSecond: number): void;
};

export function createInitialViewportDiagnostics(): ViewportStateDiagnostics {
  return {
    requestedRange: {
      startRow: 0,
      endRow: 50,
    },
    fulfilledRange: null,
    isLoading: true,
    lastPatchLatencyMs: null,
    patchCount: 0,
  };
}

export function setGridLoading(
  api: GridApi<MarketRow> | null,
  loading: boolean,
) {
  api?.setGridOption("loading", loading);
}
