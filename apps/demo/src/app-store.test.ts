import { describe, expect, it, vi } from "vitest";

import { createDemoAppController } from "./app-store";
import type { DemoSqliteClient } from "./browser-clients";

function makeSqliteClient(): DemoSqliteClient {
  return {
    storeId: "sqlite-olympic-athletes",
    open: vi.fn(),
    pushLiveUpdate: vi.fn(),
    setStressRate: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("createDemoAppController", () => {
  it("boots the sqlite client exactly once when the host attaches", () => {
    const sqliteClient = makeSqliteClient();
    const controller = createDemoAppController({
      sqliteClient,
    });

    controller.attachHost({} as HTMLElement);
    controller.attachHost({} as HTMLElement);

    expect(controller.store.getSnapshot().context.lifecycle).toBe("running");
    expect(controller.store.getSnapshot().context.sqliteClient).toBe(sqliteClient);
  });

  it("does not close injected sqlite clients when the store is closed", () => {
    const sqliteClient = makeSqliteClient();
    const controller = createDemoAppController({
      sqliteClient,
    });

    controller.attachHost({} as HTMLElement);
    controller.store.trigger.closed();
    expect(sqliteClient.close).not.toHaveBeenCalled();
  });
});
