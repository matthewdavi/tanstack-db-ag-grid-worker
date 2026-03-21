import { describe, expect, it, vi } from "vitest";

import type { DemoSqliteClient } from "./browser-clients";
import { createViewportGridController } from "./grids/shared/viewport-controller";

describe("sqlite viewport grid sorting", () => {
  it("forwards sort changes to the datasource", () => {
    const queryChanged = vi.fn();

    const client: DemoSqliteClient = {
      storeId: "sqlite-olympic-athletes",
      open: vi.fn().mockReturnValue({
        init: vi.fn(),
        setViewportRange: vi.fn(),
        queryChanged,
        destroy: vi.fn(),
      }),
      pushLiveUpdate: vi.fn(),
      setStressRate: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createViewportGridController({
      datasourceClient: client,
      useGridLoadingOverlay: false,
      onPushLiveUpdate() {},
      onSetStressRate() {},
    });

    controller.onGridReady({
      api: {
        setGridOption(_key: string, datasource: { init?: (params: unknown) => void }) {
          datasource.init?.({
            api: {
              getFilterModel: () => ({}),
              getColumnState: () => [],
            },
            setRowCount() {},
            setRowData() {},
          });
        },
        addEventListener() {},
      },
    } as never);

    controller.onSortChanged();
    expect(queryChanged).toHaveBeenCalledTimes(1);
  });
});
