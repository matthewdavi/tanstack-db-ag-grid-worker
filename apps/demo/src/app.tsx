import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-quartz.css";

import { startTransition, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import type {
  ColDef,
  GridApi,
  GridReadyEvent,
  GetRowIdParams,
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
  type RowRecord,
  type StoreMetrics,
  type ViewportDiagnostics,
  type ViewportDatasourceHandle,
  type WorkerClient,
  type WorkerCollectionHandle,
} from "@sandbox/worker-store";

const licenseKey = import.meta.env.VITE_AG_GRID_LICENSE_KEY;
if (typeof licenseKey === "string" && licenseKey.length > 0) {
  LicenseManager.setLicenseKey(licenseKey);
}

AgGridModuleRegistry.registerModules([AllEnterpriseModule]);

const STORE_ID = "olympic-athletes";
const ROW_KEY = "id";
const INITIAL_DEMO_ROW_COUNT = 100_000;

const COLUMN_DEFS: ReadonlyArray<ColDef<RowRecord>> = [
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

const DEFAULT_COL_DEF: ColDef<RowRecord> = {
  sortable: true,
  filter: true,
  floatingFilter: true,
  resizable: true,
  flex: 1,
  minWidth: 120,
};

const getStableRowId = (params: GetRowIdParams<RowRecord>) =>
  params.data ? String(params.data.id) : "";

interface WorkerRowCountStatusPanelProps {
  label: string;
  rowCount: number;
  commitSummary: string;
}

function formatCommitSummary(metrics: StoreMetrics) {
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
  metrics: StoreMetrics,
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

function useSandboxClient(externalClient?: WorkerClient) {
  const [client, setClient] = useState<WorkerClient | null>(externalClient ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (externalClient) {
      setClient(externalClient);
      setError(null);
      return;
    }

    let cancelled = false;
    let activeClient: WorkerClient | null = null;

    void makeBrowserWorkerClient()
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
  }, [externalClient]);

  return { client, error };
}

function useStoreBootstrap(client: WorkerClient | null) {
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
          storeId: STORE_ID,
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
  }, [client]);

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

interface ServerSideGridPanelProps {
  collection: WorkerCollectionHandle;
}

function ServerSideGridPanel(props: ServerSideGridPanelProps) {
  const apiRef = useRef<GridApi<RowRecord> | null>(null);
  const [rowCount, setRowCount] = useState(0);
  const [metrics, setMetrics] = useState<StoreMetrics>({
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

  const handleReady = (event: GridReadyEvent<RowRecord>) => {
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
        <AgGridReact<RowRecord>
          columnDefs={COLUMN_DEFS as ColDef<RowRecord>[]}
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
  collection: WorkerCollectionHandle;
}

function ViewportGridPanel(props: ViewportGridPanelProps) {
  const apiRef = useRef<GridApi<RowRecord> | null>(null);
  const datasourceRef = useRef<ViewportDatasourceHandle | null>(null);
  const [rowsPerSecond, setRowsPerSecond] = useState(0);
  const [rowCount, setRowCount] = useState(0);
  const [metrics, setMetrics] = useState<StoreMetrics>({
    lastCommitDurationMs: null,
    lastCommitChangeCount: 0,
    totalCommitCount: 0,
  });
  const [diagnostics, setDiagnostics] = useState<ViewportDiagnostics>({
    requestedRange: {
      startRow: 0,
      endRow: 50,
    },
    fulfilledRange: null,
    requestVersion: 0,
    lastPatchLatencyMs: null,
    ignoredPatchCount: 0,
    patchCount: 0,
  });

  useEffect(() => {
    if (apiRef.current === null) {
      return;
    }

    const datasource = createViewportDatasource(props.collection, {
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
  }, [props.collection]);

  const handleReady = (event: GridReadyEvent<RowRecord>) => {
    apiRef.current = event.api;
    const datasource = createViewportDatasource(props.collection, {
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
  };

  const refreshViewport = () => {
    datasourceRef.current?.refreshQuery();
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
      title="Viewport Push"
      body="The grid only owns the visible slice. The worker keeps the live query hot and streams patches back through the viewport datasource."
      status="Viewport / push model"
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
          onClick={refreshViewport}
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
      <div className="grid-shell ag-theme-quartz">
        <AgGridReact<RowRecord>
          columnDefs={COLUMN_DEFS as ColDef<RowRecord>[]}
          defaultColDef={DEFAULT_COL_DEF}
          getRowId={getStableRowId}
          rowModelType="viewport"
          statusBar={createRowCountStatusBar("Worker rows", rowCount, metrics)}
          viewportRowModelPageSize={50}
          viewportRowModelBufferSize={20}
          rowBuffer={0}
          onGridReady={handleReady}
          onFilterChanged={refreshViewport}
          onSortChanged={refreshViewport}
        />
      </div>
    </GridCard>
  );
}

export interface AppProps {
  client?: WorkerClient;
}

export function App(props: AppProps) {
  const { client, error: clientError } = useSandboxClient(props.client);
  const { ready, error: bootstrapError } = useStoreBootstrap(client);
  const collection = client ? client.collection(STORE_ID) : null;

  return (
    <main className="app-shell">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">worker-hosted tanstack db + ag grid enterprise</p>
          <h1>One authoritative row store, two row models, zero main-thread ownership.</h1>
          <p>
            Filters and sorting are decoded in the translator package, normalized into a
            single query state, and executed inside the worker-backed store.
          </p>
        </div>
        <dl className="hero-metrics">
          <div>
            <dt>Transport</dt>
            <dd>Effect serialized worker</dd>
          </div>
          <div>
            <dt>Query compiler</dt>
            <dd>AG Grid to TanStack DB</dd>
          </div>
          <div>
            <dt>Dataset</dt>
            <dd>{INITIAL_DEMO_ROW_COUNT.toLocaleString()} synthetic market rows</dd>
          </div>
        </dl>
      </section>

      {clientError ? <p className="error-banner">{clientError}</p> : null}
      {bootstrapError ? <p className="error-banner">{bootstrapError}</p> : null}
      {!ready || collection === null ? (
        <section className="loading-card">
          <p className="eyebrow">booting</p>
          <h2>Starting worker store</h2>
          <p>The dataset is being generated inside the worker before the grids attach.</p>
        </section>
      ) : (
        <section className="grid-stack">
          <ServerSideGridPanel
            collection={collection}
          />
          <ViewportGridPanel
            collection={collection}
          />
        </section>
      )}
    </main>
  );
}
