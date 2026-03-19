import {
  createCollection,
  type ChangeMessageOrDeleteKeyMessage,
  type Collection,
  type SyncConfig,
} from "@tanstack/db";

import {
  createDemoRowFactory,
  generateDemoRows,
} from "../src/demo-data";
import type { GridQueryState } from "@sandbox/ag-grid-translator";
import {
  createQueryCollection,
  type RowRecord,
} from "../src/query-runtime";

type ChangeMessage = ChangeMessageOrDeleteKeyMessage<RowRecord, string>;

interface BenchmarkConfig {
  initialRows: number;
  windows: number;
  eventsPerWindow: number;
  rowsPerEvent: number;
  warmupWindows: number;
}

interface BenchmarkScenario {
  name: string;
  query: GridQueryState | null;
}

interface SyncAdapter {
  begin: NonNullable<Parameters<SyncConfig<RowRecord, string>["sync"]>[0]["begin"]>;
  write: NonNullable<Parameters<SyncConfig<RowRecord, string>["sync"]>[0]["write"]>;
  commit: NonNullable<Parameters<SyncConfig<RowRecord, string>["sync"]>[0]["commit"]>;
}

interface Harness {
  name: string;
  collection: Collection<RowRecord, string>;
  ingest(rows: ReadonlyArray<RowRecord>): number;
  flush(): number | null;
  dispose(): void;
}

interface BenchmarkResult {
  strategy: string;
  scenario: string;
  liveQueryRuns: number;
  liveQueryChanges: number;
  committedRows: number;
  commitCount: number;
  avgIngressMs: number;
  avgFlushMs: number;
  avgTotalMsPerWindow: number;
  maxFlushMs: number;
}

const DEFAULTS: BenchmarkConfig = {
  initialRows: 100_000,
  windows: 20,
  eventsPerWindow: 10,
  rowsPerEvent: 25,
  warmupWindows: 2,
};

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function parseArgs(argv: ReadonlyArray<string>): BenchmarkConfig {
  const overrides = new Map<string, number>();

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current?.startsWith("--")) {
      continue;
    }

    const [flag, inlineValue] = current.split("=");
    const value = inlineValue ?? argv[index + 1];
    if (value === undefined) {
      continue;
    }

    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
      continue;
    }

    overrides.set(flag, numericValue);
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return {
    initialRows: overrides.get("--initialRows") ?? DEFAULTS.initialRows,
    windows: overrides.get("--windows") ?? DEFAULTS.windows,
    eventsPerWindow: overrides.get("--eventsPerWindow") ?? DEFAULTS.eventsPerWindow,
    rowsPerEvent: overrides.get("--rowsPerEvent") ?? DEFAULTS.rowsPerEvent,
    warmupWindows: overrides.get("--warmupWindows") ?? DEFAULTS.warmupWindows,
  };
}

function createSyncCollection(
  id: string,
  initialRows: ReadonlyArray<RowRecord>,
) {
  let syncAdapter: SyncAdapter | null = null;

  const collection = createCollection<RowRecord, string>({
    id,
    getKey: (row) => row.id,
    sync: {
      sync({ begin, write, commit, markReady }) {
        syncAdapter = {
          begin,
          write,
          commit,
        };

        if (initialRows.length > 0) {
          begin();
          for (const row of initialRows) {
            write({
              type: "insert",
              value: row,
            });
          }
          commit();
        }

        markReady();
        return () => {
          syncAdapter = null;
        };
      },
      getSyncMetadata() {
        return {};
      },
    },
  });

  return {
    collection,
    getSyncAdapter() {
      if (syncAdapter === null) {
        throw new Error(`Sync adapter not ready for ${id}`);
      }
      return syncAdapter;
    },
  };
}

function toInsertMessages(rows: ReadonlyArray<RowRecord>): Array<ChangeMessage> {
  return rows.map((row) => ({
    type: "insert" as const,
    value: row,
  }));
}

function createBufferedHarness(
  id: string,
  initialRows: ReadonlyArray<RowRecord>,
): Harness {
  const { collection, getSyncAdapter } = createSyncCollection(id, initialRows);
  let pendingChanges: Array<ChangeMessage> = [];

  return {
    name: "buffered-begin-write-commit",
    collection,
    ingest(rows) {
      const startedAt = nowMs();
      pendingChanges.push(...toInsertMessages(rows));
      return nowMs() - startedAt;
    },
    flush() {
      if (pendingChanges.length === 0) {
        return null;
      }

      const sync = getSyncAdapter();
      const changes = pendingChanges;
      pendingChanges = [];
      const startedAt = nowMs();
      sync.begin();
      for (const change of changes) {
        sync.write(change);
      }
      sync.commit();
      return nowMs() - startedAt;
    },
    dispose() {},
  };
}

function createOpenTransactionHarness(
  id: string,
  initialRows: ReadonlyArray<RowRecord>,
): Harness {
  const { collection, getSyncAdapter } = createSyncCollection(id, initialRows);
  let isOpen = false;

  return {
    name: "open-transaction-delayed-commit",
    collection,
    ingest(rows) {
      const sync = getSyncAdapter();
      const startedAt = nowMs();
      if (!isOpen) {
        sync.begin();
        isOpen = true;
      }

      for (const change of toInsertMessages(rows)) {
        sync.write(change);
      }

      return nowMs() - startedAt;
    },
    flush() {
      if (!isOpen) {
        return null;
      }

      const sync = getSyncAdapter();
      const startedAt = nowMs();
      sync.commit();
      isOpen = false;
      return nowMs() - startedAt;
    },
    dispose() {
      if (isOpen) {
        getSyncAdapter().commit();
        isOpen = false;
      }
    },
  };
}

function createPerEventCommitHarness(
  id: string,
  initialRows: ReadonlyArray<RowRecord>,
): Harness {
  const { collection, getSyncAdapter } = createSyncCollection(id, initialRows);

  return {
    name: "commit-per-event",
    collection,
    ingest(rows) {
      const sync = getSyncAdapter();
      const startedAt = nowMs();
      sync.begin();
      for (const change of toInsertMessages(rows)) {
        sync.write(change);
      }
      sync.commit();
      return nowMs() - startedAt;
    },
    flush() {
      return null;
    },
    dispose() {},
  };
}

async function buildLiveQuery(
  collection: Collection<RowRecord, string>,
  query: GridQueryState | null,
) {
  if (query === null) {
    return null;
  }

  const liveCollection = createQueryCollection(collection, query);
  await liveCollection.preload();

  let changeCount = 0;
  const subscription = liveCollection.subscribeChanges(() => {
    changeCount += 1;
  });

  return {
    liveCollection,
    subscription,
    getRunCount() {
      return (liveCollection.utils as { getRunCount?: () => number }).getRunCount?.() ?? 0;
    },
    getChangeCount() {
      return changeCount;
    },
  };
}

async function runBenchmark(
  makeHarness: (id: string, initialRows: ReadonlyArray<RowRecord>) => Harness,
  scenario: BenchmarkScenario,
  config: BenchmarkConfig,
  initialRows: ReadonlyArray<RowRecord>,
): Promise<BenchmarkResult> {
  const harness = makeHarness(`${scenario.name}-${Math.random().toString(36).slice(2)}`, initialRows);
  await harness.collection.preload();
  const liveQuery = await buildLiveQuery(harness.collection, scenario.query);
  const makeRow = createDemoRowFactory(91, initialRows.length, {
    realtimeTimestamps: true,
  });

  let committedRows = 0;
  let commitCount = 0;
  let totalIngressMs = 0;
  let totalFlushMs = 0;
  let maxFlushMs = 0;

  const totalWindows = config.warmupWindows + config.windows;
  const isMeasuredWindow = (index: number) => index >= config.warmupWindows;

  try {
    for (let windowIndex = 0; windowIndex < totalWindows; windowIndex += 1) {
      let windowRows = 0;
      let windowIngressMs = 0;

      for (let eventIndex = 0; eventIndex < config.eventsPerWindow; eventIndex += 1) {
        const rows = Array.from({ length: config.rowsPerEvent }, () => makeRow());
        windowRows += rows.length;
        windowIngressMs += harness.ingest(rows);
      }

      const flushMs = harness.flush();
      await Promise.resolve();

      if (!isMeasuredWindow(windowIndex)) {
        continue;
      }

      committedRows += windowRows;
      totalIngressMs += windowIngressMs;
      if (flushMs !== null) {
        commitCount += 1;
        totalFlushMs += flushMs;
        maxFlushMs = Math.max(maxFlushMs, flushMs);
      }
    }
  } finally {
    liveQuery?.subscription.unsubscribe();
    harness.dispose();
  }

  const measuredWindows = Math.max(config.windows, 1);

  return {
    strategy: harness.name,
    scenario: scenario.name,
    liveQueryRuns: liveQuery?.getRunCount() ?? 0,
    liveQueryChanges: liveQuery?.getChangeCount() ?? 0,
    committedRows,
    commitCount,
    avgIngressMs: totalIngressMs / measuredWindows,
    avgFlushMs: commitCount === 0 ? 0 : totalFlushMs / commitCount,
    avgTotalMsPerWindow: (totalIngressMs + totalFlushMs) / measuredWindows,
    maxFlushMs,
  };
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const initialRows = generateDemoRows(config.initialRows, 7);

  const scenarios: ReadonlyArray<BenchmarkScenario> = [
    {
      name: "no-live-query",
      query: null,
    },
    {
      name: "sorted-updatedAt-desc",
      query: {
        predicate: null,
        sorts: [{ field: "updatedAt", direction: "desc" }],
      },
    },
    {
      name: "technology-filter-sorted-updatedAt-desc",
      query: {
        predicate: {
          kind: "comparison",
          field: "sector",
          filterType: "text",
          operator: "eq",
          value: "Technology",
        },
        sorts: [{ field: "updatedAt", direction: "desc" }],
      },
    },
  ];

  const strategies = [
    createBufferedHarness,
    createOpenTransactionHarness,
    createPerEventCommitHarness,
  ];

  console.log("TanStack DB insert benchmark");
  console.log(JSON.stringify(config, null, 2));

  const results: Array<BenchmarkResult> = [];
  for (const scenario of scenarios) {
    for (const strategy of strategies) {
      const result = await runBenchmark(strategy, scenario, config, initialRows);
      results.push(result);
      console.log(
        `${scenario.name} / ${result.strategy}: total=${result.avgTotalMsPerWindow.toFixed(2)}ms window, flush=${result.avgFlushMs.toFixed(2)}ms, ingress=${result.avgIngressMs.toFixed(2)}ms, liveRuns=${result.liveQueryRuns}, liveChanges=${result.liveQueryChanges}`,
      );
    }
  }

  console.log("\nSummary");
  console.table(
    results.map((result) => ({
      scenario: result.scenario,
      strategy: result.strategy,
      rows: result.committedRows,
      commits: result.commitCount,
      "avg ingress ms/window": result.avgIngressMs.toFixed(2),
      "avg flush ms": result.avgFlushMs.toFixed(2),
      "avg total ms/window": result.avgTotalMsPerWindow.toFixed(2),
      "max flush ms": result.maxFlushMs.toFixed(2),
      "live query runs": result.liveQueryRuns,
      "live query changes": result.liveQueryChanges,
    })),
  );
}

await main();
process.exit(0);
