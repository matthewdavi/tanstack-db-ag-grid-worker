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

  it("keeps the loading overlay limited to the initial viewport boot", () => {
    let emitDiagnostics:
      | ((diagnostics: {
          requestedRange: { startRow: number; endRow: number };
          fulfilledRange: { startRow: number; endRow: number } | null;
          isLoading: boolean;
          lastPatchLatencyMs: number | null;
          patchCount: number;
        }) => void)
      | null = null;
    const loadingStates: Array<boolean> = [];

    const client: DemoSqliteClient = {
      storeId: "sqlite-olympic-athletes",
      open: vi.fn(),
      pushLiveUpdate: vi.fn(),
      setStressRate: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createViewportGridController({
      datasourceClient: client,
      createDatasource({ onViewportDiagnostics }) {
        emitDiagnostics = onViewportDiagnostics;

        return {
          init: vi.fn(),
          setViewportRange: vi.fn(),
          queryChanged: vi.fn(),
          destroy: vi.fn(),
        };
      },
      useGridLoadingOverlay: true,
      onPushLiveUpdate() {},
      onSetStressRate() {},
    });

    controller.onGridReady({
      api: {
        setGridOption(key: string, value: unknown) {
          if (key === "loading") {
            loadingStates.push(Boolean(value));
          }
        },
        addEventListener() {},
      },
    } as never);

    emitDiagnostics?.({
      requestedRange: { startRow: 0, endRow: 50 },
      fulfilledRange: { startRow: 0, endRow: 50 },
      isLoading: false,
      lastPatchLatencyMs: 1,
      patchCount: 1,
    });
    emitDiagnostics?.({
      requestedRange: { startRow: 50, endRow: 100 },
      fulfilledRange: { startRow: 0, endRow: 50 },
      isLoading: true,
      lastPatchLatencyMs: 1,
      patchCount: 1,
    });

    expect(loadingStates).toEqual([true, false, false]);
  });
});
