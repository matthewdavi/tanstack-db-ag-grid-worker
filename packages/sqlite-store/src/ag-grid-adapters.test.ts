import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as Stream from "effect/Stream";

import type {
  ColumnState,
  IViewportDatasourceParams,
} from "ag-grid-community";

import { createSqliteViewportDatasource } from "./ag-grid-adapters";

type TestRow = {
  id: string;
  symbol: string;
};

function makeViewportParams() {
  const listeners = new Map<string, Set<() => void>>();

  return {
    api: {
      getFilterModel: () => ({}),
      getColumnState: () => [] as Array<ColumnState>,
      addEventListener: (eventName: string, listener: () => void) => {
        const current = listeners.get(eventName) ?? new Set();
        current.add(listener);
        listeners.set(eventName, current);
      },
      removeEventListener: (eventName: string, listener: () => void) => {
        listeners.get(eventName)?.delete(listener);
      },
      emit: (eventName: string) => {
        for (const listener of listeners.get(eventName) ?? []) {
          listener();
        }
      },
    } as never,
    context: {} as never,
    setRowCount: vi.fn(),
    setRowData: vi.fn(),
    getRow: vi.fn(),
  } as IViewportDatasourceParams<TestRow> & {
    api: {
      emit(eventName: string): void;
    };
  };
}

function makeDatasource() {
  const setIntent = vi.fn().mockResolvedValue({
    connectionId: "connection-1",
    updated: true,
  });
  const close = vi.fn().mockResolvedValue({
    connectionId: "connection-1",
    closed: true,
  });
  const datasource = createSqliteViewportDatasource({
    storeId: "stocks",
    openViewportChannel: () => ({
      connectionId: "connection-1",
      updates: Stream.empty,
      setIntent,
      close,
    }),
  }, {
    throttleMs: 125,
  });

  return {
    close,
    datasource,
    setIntent,
  };
}

describe("sqlite ag-grid adapter", () => {
  it("opens a single worker channel with the provided throttle", () => {
    const openViewportChannel = vi.fn().mockReturnValue({
      connectionId: "connection-1",
      updates: Stream.empty,
      setIntent: vi.fn().mockResolvedValue({
        connectionId: "connection-1",
        updated: true,
      }),
      close: vi.fn().mockResolvedValue({
        connectionId: "connection-1",
        closed: true,
      }),
    });

    const datasource = createSqliteViewportDatasource({
      storeId: "stocks",
      openViewportChannel,
    }, {
      throttleMs: 125,
    });

    datasource.init(makeViewportParams());

    expect(openViewportChannel).toHaveBeenCalledWith({
      initialIntent: expect.objectContaining({
        storeId: "stocks",
        startRow: 0,
        endRow: 50,
      }),
      throttleMs: 125,
    });
  });

  it("forwards viewport changes immediately with no browser debounce", () => {
    const { datasource, setIntent } = makeDatasource();

    datasource.init(makeViewportParams());
    datasource.setViewportRange(20, 29);

    expect(setIntent).toHaveBeenLastCalledWith(expect.objectContaining({
      storeId: "stocks",
      startRow: 20,
      endRow: 30,
    }));
  });

  it("forwards filter and sort changes on the next microtask", async () => {
    const { datasource, setIntent } = makeDatasource();
    const params = makeViewportParams();

    datasource.init(params);
    setIntent.mockClear();

    datasource.queryChanged();
    datasource.queryChanged();
    await Promise.resolve();

    expect(setIntent).toHaveBeenCalledTimes(1);
  });

  it("queryChanged reads the latest sort model", async () => {
    const setIntent = vi.fn().mockResolvedValue({
      connectionId: "connection-1",
      updated: true,
    });
    const params = makeViewportParams();
    params.api.getColumnState = () => ([
      {
        colId: "updatedAt",
        sort: "desc",
        sortIndex: 0,
      },
    ] as Array<ColumnState>);

    const datasource = createSqliteViewportDatasource({
      storeId: "stocks",
      openViewportChannel: () => ({
        connectionId: "connection-1",
        updates: Stream.empty,
        setIntent,
        close: vi.fn().mockResolvedValue({
          connectionId: "connection-1",
          closed: true,
        }),
      }),
    }, {});

    datasource.init(params);
    setIntent.mockClear();
    datasource.queryChanged();
    await Promise.resolve();

    expect(setIntent).toHaveBeenLastCalledWith(expect.objectContaining({
      query: expect.objectContaining({
        sorts: [
          {
            field: "updatedAt",
            direction: "desc",
          },
        ],
      }),
    }));
  });

  it("queryChanged waits until the next microtask to read grid state", async () => {
    const setIntent = vi.fn().mockResolvedValue({
      connectionId: "connection-1",
      updated: true,
    });
    let sorted = false;
    const params = makeViewportParams();
    params.api.getColumnState = () =>
      sorted
        ? ([
            {
              colId: "updatedAt",
              sort: "desc",
              sortIndex: 0,
            },
          ] as Array<ColumnState>)
        : ([] as Array<ColumnState>);

    const datasource = createSqliteViewportDatasource({
      storeId: "stocks",
      openViewportChannel: () => ({
        connectionId: "connection-1",
        updates: Stream.empty,
        setIntent,
        close: vi.fn().mockResolvedValue({
          connectionId: "connection-1",
          closed: true,
        }),
      }),
    }, {});

    datasource.init(params);
    setIntent.mockClear();

    datasource.queryChanged();
    sorted = true;

    await Promise.resolve();

    expect(setIntent).toHaveBeenLastCalledWith(expect.objectContaining({
      query: expect.objectContaining({
        sorts: [
          {
            field: "updatedAt",
            direction: "desc",
          },
        ],
      }),
    }));
  });

  it("ignores non-numeric viewport ranges", () => {
    const { datasource, setIntent } = makeDatasource();

    datasource.init(makeViewportParams());
    setIntent.mockClear();

    datasource.setViewportRange(undefined as never, undefined as never);

    expect(setIntent).not.toHaveBeenCalled();
  });

  it("closes the single worker channel on destroy", () => {
    const { close, datasource } = makeDatasource();

    datasource.init(makeViewportParams());
    datasource.destroy?.();

    expect(close).toHaveBeenCalledTimes(1);
  });
});
