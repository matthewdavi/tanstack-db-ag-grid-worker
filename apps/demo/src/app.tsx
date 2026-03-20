import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-quartz.css";

import { startTransition, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import type {
  ColDef,
  FilterChangedEvent,
  GridApi,
  GridReadyEvent,
  GetRowIdParams,
  IViewportDatasource,
  StatusBar,
} from "ag-grid-community";
import { ModuleRegistry as AgGridModuleRegistry } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import {
  AllEnterpriseModule,
  LicenseManager,
} from "ag-grid-enterprise";

import {
  createServerSideDatasource,
  createViewportDatasource,
  createWorkerClient,
  type WorkerClient,
  type WorkerCollectionHandle,
} from "@sandbox/worker-store";
import { translateAgGridQuery } from "@sandbox/ag-grid-translator";
import {
  createSqliteViewportDatasource,
  createSqliteWorkerClient,
  type RowRecord as MarketRow,
  type SqliteCollectionHandle,
  type SqliteWorkerClient,
} from "@sandbox/sqlite-store";

const licenseKey = import.meta.env.VITE_AG_GRID_LICENSE_KEY;
if (typeof licenseKey === "string" && licenseKey.length > 0) {
  LicenseManager.setLicenseKey(licenseKey);
}

AgGridModuleRegistry.registerModules([AllEnterpriseModule]);

const STORE_ID = "olympic-athletes";
const SQLITE_STORE_ID = "sqlite-olympic-athletes";
const ROW_KEY = "id";
const INITIAL_DEMO_ROW_COUNT = 100_000;
function createViewportLoadingOverlay(title: string, body: string) {
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

interface WorkerMetrics {
  lastCommitDurationMs: number | null;
  lastCommitChangeCount: number;
  totalCommitCount: number;
}

interface ViewportStateDiagnostics {
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

interface ViewportLikeSessionHandle {
  replace(request: {
    startRow: number;
    endRow: number;
    query: ReturnType<typeof translateQuery>;
  }): Promise<unknown>;
  close(): Promise<unknown>;
}

interface ViewportLikeCollectionHandle {
  storeId: string;
  applyTransaction(transaction: {
    kind: "upsert";
    rows: ReadonlyArray<MarketRow>;
  }): Promise<unknown>;
  openViewportSession(request: {
    startRow: number;
    endRow: number;
    query: ReturnType<typeof translateQuery>;
    sessionId?: string;
  }): ViewportLikeSessionHandle & {
    updates: any;
    sessionId: string;
  };
  setStressRate(rowsPerSecond: number): Promise<unknown>;
}

function translateQuery(filterModel: unknown, sortModel: unknown) {
  return translateAgGridQuery({
    filterModel,
    sortModel,
  });
}

type ViewportDatasourceLike = IViewportDatasource & {
  refreshQuery(options?: {
    debounce?: boolean;
  }): void;
};

type ViewportDatasourceFactory = (
  collection: Pick<ViewportLikeCollectionHandle, "openViewportSession">,
  options: {
    storeId: string;
    onSnapshot?: (snapshot: {
      startRow: number;
      endRow: number;
      rowCount: number;
      metrics: WorkerMetrics;
    }) => void;
    onViewportDiagnostics?: (diagnostics: ViewportStateDiagnostics) => void;
  },
) => ViewportDatasourceLike;

const COLUMN_DEFS: ReadonlyArray<ColDef<MarketRow>> = [
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

const DEFAULT_COL_DEF: ColDef<MarketRow> = {
  sortable: true,
  filter: true,
  floatingFilter: true,
  resizable: true,
  flex: 1,
  minWidth: 120,
};

const getStableRowId = (params: GetRowIdParams<MarketRow>) =>
  params.data ? String(params.data.id) : "";

interface WorkerRowCountStatusPanelProps {
  label: string;
  rowCount: number;
  commitSummary: string;
}

function formatCommitSummary(metrics: WorkerMetrics) {
  if (metrics.lastCommitDurationMs === null) {
    return "Awaiting worker commit";
  }

  return `${metrics.lastCommitDurationMs.toFixed(2)} ms / ${metrics.lastCommitChangeCount.toLocaleString()} rows`;
}

function WorkerRowCountStatusPanel(props: WorkerRowCountStatusPanelProps) {
  return (
    <span className="worker-status-bar">
      <span className="worker-status-bar__label">{props.label}</span>
      <strong>{props.rowCount.toLocaleString()}</strong>
      <span className="worker-status-bar__label">Last commit</span>
      <strong>{props.commitSummary}</strong>
    </span>
  );
}

function createRowCountStatusBar(
  label: string,
  rowCount: number,
  metrics: WorkerMetrics,
): StatusBar {
  return {
    statusPanels: [
      {
        key: "worker-row-count",
        align: "left",
        statusPanel: WorkerRowCountStatusPanel,
        statusPanelParams: {
          label,
          rowCount,
          commitSummary: formatCommitSummary(metrics),
        },
      },
    ],
  };
}

function formatViewportRange(
  range: {
    startRow: number;
    endRow: number;
  } | null,
) {
  if (range === null) {
    return "Awaiting patch";
  }

  return `${range.startRow}-${Math.max(range.endRow - 1, range.startRow)}`;
}

function makeBrowserWorkerClient() {
  return createWorkerClient(
    () =>
      new Worker(new URL("./grid.worker.ts", import.meta.url), {
        type: "module",
      }),
  );
}

function makeBrowserSqliteWorkerClient() {
  return createSqliteWorkerClient(
    () =>
      new Worker(new URL("./sqlite.worker.ts", import.meta.url), {
        type: "module",
      }),
  );
}

function useWorkerClient<TClient extends { close(): Promise<void> }>(
  externalClient: TClient | undefined,
  factory: () => Promise<TClient>,
) {
  const [client, setClient] = useState<TClient | null>(externalClient ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (externalClient) {
      setClient(externalClient);
      setError(null);
      return;
    }

    let cancelled = false;
    let activeClient: TClient | null = null;

    void factory()
      .then((nextClient) => {
        if (cancelled) {
          void nextClient.close();
          return;
        }

        activeClient = nextClient;
        startTransition(() => {
          setClient(nextClient);
          setError(null);
        });
      })
      .catch((cause) => {
        const message = cause instanceof Error ? cause.message : "Failed to start worker client";
        startTransition(() => {
          setError(message);
        });
      });

    return () => {
      cancelled = true;
      if (activeClient) {
        void activeClient.close();
      }
    };
  }, [externalClient, factory]);

  return { client, error };
}

function useStoreBootstrap(
  client: Pick<WorkerClient, "loadStore"> | Pick<SqliteWorkerClient, "loadStore"> | null,
  storeId: string,
) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (client === null) {
      return;
    }

    let cancelled = false;

    setReady(false);
    void client
      .loadStore(
        {
          storeId,
          rowKey: ROW_KEY,
        },
        {
          kind: "generator",
          rowCount: INITIAL_DEMO_ROW_COUNT,
          seed: 7,
        },
      )
      .then(() => {
        if (cancelled) {
          return;
        }

        startTransition(() => {
          setReady(true);
          setError(null);
        });
      })
      .catch((cause) => {
        if (cancelled) {
          return;
        }

        const message = cause instanceof Error ? cause.message : "Failed to bootstrap store";
        startTransition(() => {
          setError(message);
          setReady(false);
        });
      });

    return () => {
      cancelled = true;
    };
  }, [client, storeId]);

  return { ready, error };
}

interface GridCardProps {
  title: string;
  body: string;
  status: string;
  children: ReactNode;
}

function GridCard(props: GridCardProps) {
  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <p className="eyebrow">{props.status}</p>
          <h2>{props.title}</h2>
        </div>
        <p className="panel-copy">{props.body}</p>
      </header>
      {props.children}
    </section>
  );
}

interface LoadingGridCardProps {
  title: string;
  body: string;
  status: string;
  message: string;
}

function LoadingGridCard(props: LoadingGridCardProps) {
  return (
    <GridCard
      title={props.title}
      body={props.body}
      status={props.status}
    >
      <div className="panel-empty-state">
        <p>{props.message}</p>
      </div>
    </GridCard>
  );
}

interface ServerSideGridPanelProps {
  collection: WorkerCollectionHandle;
}

function ServerSideGridPanel(props: ServerSideGridPanelProps) {
  const apiRef = useRef<GridApi<MarketRow> | null>(null);
  const [rowCount, setRowCount] = useState(0);
  const [metrics, setMetrics] = useState<WorkerMetrics>({
    lastCommitDurationMs: null,
    lastCommitChangeCount: 0,
    totalCommitCount: 0,
  });

  useEffect(() => {
    if (apiRef.current === null) {
      return;
    }

    apiRef.current.setGridOption(
      "serverSideDatasource",
      createServerSideDatasource(props.collection, {
        storeId: props.collection.storeId,
        onSnapshot: (snapshot) => {
          startTransition(() => {
            setRowCount(snapshot.rowCount);
            setMetrics(snapshot.metrics);
          });
        },
      }),
    );
  }, [props.collection]);

  const handleReady = (event: GridReadyEvent<MarketRow>) => {
    apiRef.current = event.api;
    event.api.setGridOption(
      "serverSideDatasource",
      createServerSideDatasource(props.collection, {
        storeId: props.collection.storeId,
        onSnapshot: (snapshot) => {
          startTransition(() => {
            setRowCount(snapshot.rowCount);
            setMetrics(snapshot.metrics);
          });
        },
      }),
    );
  };

  return (
    <GridCard
      title="Server-Side Pull"
      body="AG Grid asks for row windows, the worker resolves the translated query, and SSRM stays ignorant of the full dataset."
      status="SSRM / pull model"
    >
      <div className="grid-shell ag-theme-quartz">
        <AgGridReact<MarketRow>
          columnDefs={COLUMN_DEFS as ColDef<MarketRow>[]}
          defaultColDef={DEFAULT_COL_DEF}
          rowModelType="serverSide"
          cacheBlockSize={50}
          blockLoadDebounceMillis={0}
          getRowId={getStableRowId}
          rowBuffer={0}
          onGridReady={handleReady}
          statusBar={createRowCountStatusBar("Worker rows", rowCount, metrics)}
        />
      </div>
    </GridCard>
  );
}

interface ViewportGridPanelProps {
  title: string;
  body: string;
  status: string;
  rowLabel: string;
  loadingOverlayTitle: string;
  loadingOverlayBody: string;
  collection: ViewportLikeCollectionHandle;
  createDatasource: ViewportDatasourceFactory;
}

function ViewportGridPanel(props: ViewportGridPanelProps) {
  const apiRef = useRef<GridApi<MarketRow> | null>(null);
  const datasourceRef = useRef<ViewportDatasourceLike | null>(null);
  const [rowsPerSecond, setRowsPerSecond] = useState(0);
  const [rowCount, setRowCount] = useState(0);
  const [metrics, setMetrics] = useState<WorkerMetrics>({
    lastCommitDurationMs: null,
    lastCommitChangeCount: 0,
    totalCommitCount: 0,
  });
  const [diagnostics, setDiagnostics] = useState<ViewportStateDiagnostics>({
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
  });

  useEffect(() => {
    apiRef.current?.setGridOption("loading", diagnostics.isLoading);
  }, [diagnostics.isLoading]);

  useEffect(() => {
    if (apiRef.current === null) {
      return;
    }

    const datasource = props.createDatasource(props.collection, {
      storeId: props.collection.storeId,
      onSnapshot: (snapshot) => {
        startTransition(() => {
          setRowCount(snapshot.rowCount);
          setMetrics(snapshot.metrics);
        });
      },
      onViewportDiagnostics: (nextDiagnostics) => {
        startTransition(() => {
          setDiagnostics(nextDiagnostics);
        });
      },
    });
    datasourceRef.current = datasource;
    apiRef.current.setGridOption(
      "viewportDatasource",
      datasource,
    );
    apiRef.current.setGridOption("loading", diagnostics.isLoading);
  }, [props.collection]);

  const handleReady = (event: GridReadyEvent<MarketRow>) => {
    apiRef.current = event.api;
    const datasource = props.createDatasource(props.collection, {
      storeId: props.collection.storeId,
      onSnapshot: (snapshot) => {
        startTransition(() => {
          setRowCount(snapshot.rowCount);
          setMetrics(snapshot.metrics);
        });
      },
      onViewportDiagnostics: (nextDiagnostics) => {
        startTransition(() => {
          setDiagnostics(nextDiagnostics);
        });
      },
    });
    datasourceRef.current = datasource;
    event.api.setGridOption(
      "viewportDatasource",
      datasource,
    );
    event.api.setGridOption("loading", diagnostics.isLoading);
  };

  const refreshViewport = (options?: {
    debounce?: boolean;
  }) => {
    datasourceRef.current?.refreshQuery(options);
  };

  const handleFilterChanged = (event: FilterChangedEvent<MarketRow>) => {
    refreshViewport({
      debounce: event.afterFloatingFilter === true,
    });
  };

  const injectUpdate = () => {
    const timestamp = Date.now();
    void props.collection
      .applyTransaction({
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
      })
      .then(() => undefined);
  };

  const updateStressRate = (nextRowsPerSecond: number) => {
    startTransition(() => {
      setRowsPerSecond(nextRowsPerSecond);
    });
    void props.collection
      .setStressRate(nextRowsPerSecond)
      .then(() => undefined);
  };
  const handleStressInput = (value: string) => {
    updateStressRate(Number(value));
  };

  return (
    <GridCard
      title={props.title}
      body={props.body}
      status={props.status}
    >
      <div className="panel-actions">
        <button
          className="action-button"
          onClick={injectUpdate}
          type="button"
        >
          Push live update
        </button>
        <label className="stress-control">
          <span>Rows per second</span>
          <input
            aria-label="Rows per second"
            max={2500}
            min={0}
            onInput={(event) => {
              handleStressInput(event.currentTarget.value);
            }}
            step={10}
            type="range"
            value={rowsPerSecond}
          />
          <strong>{rowsPerSecond}</strong>
        </label>
        <button
          className="action-button action-button--ghost"
          onClick={() => {
            refreshViewport();
          }}
          type="button"
        >
          Refresh query snapshot
        </button>
        <button
          className="action-button action-button--ghost"
          onClick={() => {
            updateStressRate(0);
          }}
          type="button"
        >
          Stop stress stream
        </button>
      </div>
      <div className="viewport-diagnostics">
        <span>
          Requested range <strong>{formatViewportRange(diagnostics.requestedRange)}</strong>
        </span>
        <span>
          Fulfilled range <strong>{formatViewportRange(diagnostics.fulfilledRange)}</strong>
        </span>
        <span>
          Patch latency{" "}
          <strong>
            {diagnostics.lastPatchLatencyMs === null
              ? "Awaiting patch"
              : `${diagnostics.lastPatchLatencyMs.toFixed(2)} ms`}
          </strong>
        </span>
        <span>
          Ignored patches <strong>{diagnostics.ignoredPatchCount}</strong>
        </span>
      </div>
      <div className="grid-shell grid-shell--viewport ag-theme-quartz">
        <AgGridReact<MarketRow>
          columnDefs={COLUMN_DEFS as ColDef<MarketRow>[]}
          defaultColDef={DEFAULT_COL_DEF}
          getRowId={getStableRowId}
          overlayLoadingTemplate={createViewportLoadingOverlay(
            props.loadingOverlayTitle,
            props.loadingOverlayBody,
          )}
          rowModelType="viewport"
          statusBar={createRowCountStatusBar(props.rowLabel, rowCount, metrics)}
          viewportRowModelPageSize={50}
          viewportRowModelBufferSize={20}
          rowBuffer={0}
          onGridReady={handleReady}
          onFilterChanged={handleFilterChanged}
          onSortChanged={() => {
            refreshViewport();
          }}
        />
      </div>
    </GridCard>
  );
}

export interface AppProps {
  client?: WorkerClient;
  sqliteClient?: SqliteWorkerClient;
}

export function App(props: AppProps) {
  const { client, error: clientError } = useWorkerClient(props.client, makeBrowserWorkerClient);
  const { client: sqliteClient, error: sqliteClientError } = useWorkerClient(
    props.sqliteClient,
    makeBrowserSqliteWorkerClient,
  );
  const { ready, error: bootstrapError } = useStoreBootstrap(client, STORE_ID);
  const { ready: sqliteReady, error: sqliteBootstrapError } = useStoreBootstrap(
    sqliteClient,
    SQLITE_STORE_ID,
  );
  const collection = client ? client.collection(STORE_ID) : null;
  const sqliteCollection = sqliteClient ? sqliteClient.collection(SQLITE_STORE_ID) : null;
  const tanstackReady = ready && collection !== null;
  const sqliteStoreReady = sqliteReady && sqliteCollection !== null;

  return (
    <main className="app-shell">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">worker-hosted query engines + ag grid enterprise</p>
          <h1>Same grid, two worker-side query engines, one direct comparison.</h1>
          <p>
            Filters and sorting are decoded once, then executed inside either the TanStack
            worker store or a SQLite Wasm worker store.
          </p>
        </div>
        <dl className="hero-metrics">
          <div>
            <dt>Transport</dt>
            <dd>Effect serialized worker</dd>
          </div>
          <div>
            <dt>Query compiler</dt>
            <dd>AG Grid to TanStack DB and AG Grid to SQL</dd>
          </div>
          <div>
            <dt>Dataset</dt>
            <dd>{INITIAL_DEMO_ROW_COUNT.toLocaleString()} synthetic market rows</dd>
          </div>
        </dl>
      </section>

      {clientError ? <p className="error-banner">{clientError}</p> : null}
      {sqliteClientError ? <p className="error-banner">{sqliteClientError}</p> : null}
      {bootstrapError ? <p className="error-banner">{bootstrapError}</p> : null}
      {sqliteBootstrapError ? <p className="error-banner">{sqliteBootstrapError}</p> : null}
      <section className="grid-stack">
        {tanstackReady ? (
          <ServerSideGridPanel
            collection={collection}
          />
        ) : (
          <LoadingGridCard
            title="Server-Side Pull"
            body="AG Grid asks for row windows, the worker resolves the translated query, and SSRM stays ignorant of the full dataset."
            status="SSRM / pull model"
            message="Starting the TanStack worker store and generating the shared dataset."
          />
        )}
        {tanstackReady ? (
          <ViewportGridPanel
            title="Viewport Push"
            body="The grid only owns the visible slice. The TanStack worker keeps the live query hot and streams patches back through the viewport datasource."
            status="Viewport / TanStack push"
            rowLabel="TanStack rows"
            loadingOverlayTitle="Refreshing live query"
            loadingOverlayBody="Recomputing filters and sort in the worker."
            collection={collection}
            createDatasource={createViewportDatasource as ViewportDatasourceFactory}
          />
        ) : (
          <LoadingGridCard
            title="Viewport Push"
            body="The grid only owns the visible slice. The TanStack worker keeps the live query hot and streams patches back through the viewport datasource."
            status="Viewport / TanStack push"
            message="Waiting for the TanStack viewport store to finish booting."
          />
        )}
        {sqliteStoreReady ? (
          <ViewportGridPanel
            title="SQLite SQL Viewport"
            body="The grid asks the SQLite worker for count plus window rows, and write-driven refreshes are coalesced before patching the UI."
            status="Viewport / SQLite Wasm"
            rowLabel="SQLite rows"
            loadingOverlayTitle="Refreshing SQL query"
            loadingOverlayBody="Running the latest filter and sort against the worker database."
            collection={sqliteCollection as unknown as ViewportLikeCollectionHandle}
            createDatasource={createSqliteViewportDatasource as ViewportDatasourceFactory}
          />
        ) : (
          <LoadingGridCard
            title="SQLite SQL Viewport"
            body="The grid asks the SQLite worker for count plus window rows, and write-driven refreshes are coalesced before patching the UI."
            status="Viewport / SQLite Wasm"
            message="Starting the SQLite worker store in the background. TanStack panels stay interactive while it catches up."
          />
        )}
      </section>
    </main>
  );
}
