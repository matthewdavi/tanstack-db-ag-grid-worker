import type { AgGridSqliteClient } from "@sandbox/sqlite-store";
import { createWorkerClient, type WorkerClient } from "@sandbox/worker-store";

import { SQLITE_STORE_ID } from "./demo-constants";
import { marketGrid, type MarketRow } from "./market-sqlite-store";

export interface DemoSqliteClient extends AgGridSqliteClient<MarketRow> {
  pushLiveUpdate(): void;
  setStressRate(rowsPerSecond: number): void;
}

export function makeBrowserWorkerClient(): Promise<WorkerClient> {
  return Promise.resolve(
    createWorkerClient(
      () =>
        new Worker(new URL("./grid.worker.ts", import.meta.url), {
          type: "module",
        }),
    ),
  );
}

export async function makeBrowserSqliteWorkerClient(): Promise<DemoSqliteClient> {
  const worker = new Worker(new URL("./sqlite.worker.ts", import.meta.url), {
    type: "module",
  });
  const controls = new MessageChannel();
  worker.postMessage(
    {
      type: "sqlite-demo-init-port",
    },
    [controls.port1],
  );

  const client = await marketGrid.connect(
    () => worker,
    {
      storeId: SQLITE_STORE_ID,
    },
  );

  return {
    ...client,
    pushLiveUpdate() {
      controls.port2.postMessage({ type: "sqlite-demo-push-update" });
    },
    setStressRate(rowsPerSecond: number) {
      controls.port2.postMessage({
        type: "sqlite-demo-set-stress-rate",
        rowsPerSecond,
      });
    },
    async close() {
      controls.port2.close();
      await client.close();
      worker.terminate();
    },
  };
}
