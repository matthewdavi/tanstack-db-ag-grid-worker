import { describe, expect, it, vi } from "vitest";

import type { WorkerClient, WorkerCollectionHandle } from "@sandbox/worker-store";

import { createDemoAppController } from "./app-store";
import type { DemoSqliteClient } from "./browser-clients";

function makeWorkerClient(): WorkerClient {
  const collection: WorkerCollectionHandle = {
    storeId: "olympic-athletes",
    applyTransaction: vi.fn(),
    getRows: vi.fn(),
    openViewportSession: vi.fn(),
    setStressRate: vi.fn(),
    dispose: vi.fn(),
  } as unknown as WorkerCollectionHandle;

  return {
    loadStore: vi.fn().mockResolvedValue({
      storeId: "olympic-athletes",
      rowCount: 2,
      metrics: {
        lastCommitDurationMs: 1,
        lastCommitChangeCount: 2,
        totalCommitCount: 1,
      },
    }),
    collection: vi.fn().mockReturnValue(collection),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeSqliteClient(): DemoSqliteClient {
  return {
    storeId: "sqlite-olympic-athletes",
    viewportDatasource: vi.fn(),
    pushLiveUpdate: vi.fn(),
    setStressRate: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("createDemoAppController", () => {
  it("boots clients exactly once when the host attaches", async () => {
    const client = makeWorkerClient();
    const sqliteClient = makeSqliteClient();
    const controller = createDemoAppController({
      client,
      sqliteClient,
    });

    controller.attachHost({} as HTMLElement);
    controller.attachHost({} as HTMLElement);

    await vi.waitFor(() => {
      expect(client.loadStore).toHaveBeenCalledTimes(1);
    });

    expect(controller.store.getSnapshot().context.lifecycle).toBe("running");
    expect(controller.store.getSnapshot().context.tanstackClient).toBe(client);
    expect(controller.store.getSnapshot().context.sqliteClient).toBe(sqliteClient);
  });

  it("closes owned clients when the store is closed", async () => {
    const client = makeWorkerClient();
    const sqliteClient = makeSqliteClient();
    const controller = createDemoAppController({
      client,
      sqliteClient,
    });

    controller.attachHost({} as HTMLElement);

    await vi.waitFor(() => {
      expect(client.loadStore).toHaveBeenCalledTimes(1);
    });

    controller.store.trigger.closed();

    await vi.waitFor(() => {
      expect(client.close).not.toHaveBeenCalled();
      expect(sqliteClient.close).not.toHaveBeenCalled();
    });
  });
});
