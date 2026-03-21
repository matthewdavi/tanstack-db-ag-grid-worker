import type {
  GridApi,
  IViewportDatasource,
} from "ag-grid-community";
import type { AgGridSqliteClient } from "@sandbox/sqlite-store";

import type { MarketRow } from "../../market-sqlite-store";

export interface WorkerMetrics {
  lastCommitDurationMs: number | null;
  lastCommitChangeCount: number;
  totalCommitCount: number;
}

export interface ViewportStateDiagnostics {
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

export interface ViewportSnapshot {
  startRow: number;
  endRow: number;
  rowCount: number;
  metrics: WorkerMetrics;
}

export interface ViewportDatasourceLike extends IViewportDatasource {
  refreshQuery(options?: {
    debounce?: boolean;
  }): void;
}

export interface ViewportDatasourceClient {
  readonly storeId: string;
  viewportDatasource(options?: {
    onSnapshot?: (snapshot: ViewportSnapshot) => void;
    onViewportDiagnostics?: (diagnostics: ViewportStateDiagnostics) => void;
  }): ViewportDatasourceLike;
}

export type SqliteViewportClient = AgGridSqliteClient<MarketRow> & {
  pushLiveUpdate(): void;
  setStressRate(rowsPerSecond: number): void;
};

export function createInitialMetrics(): WorkerMetrics {
  return {
    lastCommitDurationMs: null,
    lastCommitChangeCount: 0,
    totalCommitCount: 0,
  };
}

export function createInitialViewportDiagnostics(): ViewportStateDiagnostics {
  return {
    requestedRange: {
      startRow: 0,
      endRow: 50,
    },
    fulfilledRange: null,
    requestVersion: 0,
    isLoading: true,
    lastPatchLatencyMs: null,
    ignoredPatchCount: 0,
    patchCount: 0,
  };
}

export function setGridLoading(
  api: GridApi<MarketRow> | null,
  loading: boolean,
) {
  api?.setGridOption("loading", loading);
}
