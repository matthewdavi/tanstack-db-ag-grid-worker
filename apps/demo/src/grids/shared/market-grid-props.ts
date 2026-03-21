import type {
  ColDef,
  GetRowIdParams,
} from "ag-grid-community";

import type { MarketRow } from "../../market-sqlite-store";

export const marketColumnDefs: ReadonlyArray<ColDef<MarketRow>> = [
  {
    field: "symbol",
    minWidth: 120,
    filter: "agTextColumnFilter",
  },
  {
    field: "company",
    minWidth: 220,
    filter: "agTextColumnFilter",
  },
  {
    field: "sector",
    minWidth: 160,
    filter: "agTextColumnFilter",
  },
  {
    field: "venue",
    minWidth: 120,
    filter: "agTextColumnFilter",
  },
  {
    field: "price",
    minWidth: 100,
    filter: "agNumberColumnFilter",
  },
  {
    field: "volume",
    minWidth: 140,
    filter: "agNumberColumnFilter",
  },
  {
    field: "updatedAt",
    minWidth: 220,
    filter: "agTextColumnFilter",
  },
];

export const defaultMarketColumnDef: ColDef<MarketRow> = {
  sortable: true,
  filter: true,
  floatingFilter: true,
  resizable: true,
  flex: 1,
  minWidth: 120,
};

export const getStableMarketRowId = (params: GetRowIdParams<MarketRow>) =>
  params.data ? String(params.data.id) : "";

export function createViewportLoadingOverlay(title: string, body: string) {
  return `
    <div class="viewport-loading-overlay" role="status" aria-live="polite">
      <span class="viewport-loading-overlay__pulse"></span>
      <div class="viewport-loading-overlay__copy">
        <strong>${title}</strong>
        <span>${body}</span>
      </div>
    </div>
  `;
}
