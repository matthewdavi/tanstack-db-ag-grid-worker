import { describe, vi } from "vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/TestClock";
import { effect, expect } from "@effect/vitest";

import type {
  ColumnState,
  IViewportDatasourceParams,
} from "ag-grid-community";

import { createSqliteViewportDatasource } from "./ag-grid-adapters";
import type { RowRecord } from "./row-schema";

function makeViewportParams() {
  return {
    api: {
      getFilterModel: () => ({}),
      getColumnState: () => [] as ReadonlyArray<ColumnState>,
    } as never,
    context: {} as never,
    setRowCount: vi.fn(),
    setRowData: vi.fn(),
    getRow: vi.fn(),
  } as IViewportDatasourceParams<RowRecord>;
}

describe("sqlite ag-grid adapter", () => {
  effect("runs immediate refreshes without debounce", () =>
    Effect.gen(function* () {
      const runtime = yield* Effect.runtime<never>();
      const replace = vi.fn().mockResolvedValue({
        sessionId: "session-1",
        replaced: true,
      });
      const datasource = createSqliteViewportDatasource({
        openViewportSession: () => ({
          sessionId: "session-1",
          updates: Stream.empty,
          replace,
          close: vi.fn().mockResolvedValue({
            sessionId: "session-1",
            closed: true,
          }),
        }),
      }, {
        storeId: "store-1",
        runtime,
      });

      datasource.init(makeViewportParams());
      yield* Effect.promise(() => Promise.resolve());
      const baselineCalls = replace.mock.calls.length;
      datasource.refreshQuery();
      yield* Effect.promise(() => Promise.resolve());
      yield* Effect.promise(() => Promise.resolve());

      yield* Effect.sync(() => {
        expect(replace).toHaveBeenCalledTimes(baselineCalls + 1);
      });
    }),
  );

  effect("debounces query refresh when requested", () =>
    Effect.gen(function* () {
      const runtime = yield* Effect.runtime<never>();
      const replace = vi.fn().mockResolvedValue({
        sessionId: "session-1",
        replaced: true,
      });
      const datasource = createSqliteViewportDatasource({
        openViewportSession: () => ({
          sessionId: "session-1",
          updates: Stream.empty,
          replace,
          close: vi.fn().mockResolvedValue({
            sessionId: "session-1",
            closed: true,
          }),
        }),
      }, {
        storeId: "store-1",
        runtime,
      });

      datasource.init(makeViewportParams());
      yield* Effect.promise(() => Promise.resolve());
      const baselineCalls = replace.mock.calls.length;
      datasource.refreshQuery({ debounce: true });
      datasource.refreshQuery({ debounce: true });

      expect(replace).toHaveBeenCalledTimes(baselineCalls);

      yield* TestClock.adjust(Duration.millis(200));
      yield* Effect.promise(() => Promise.resolve());
      yield* Effect.promise(() => Promise.resolve());
      yield* Effect.sync(() => {
        expect(replace).toHaveBeenCalledTimes(baselineCalls + 1);
      });
    }),
  );

  effect("ignores non-numeric viewport ranges during startup", () =>
    Effect.gen(function* () {
      const runtime = yield* Effect.runtime<never>();
      const replace = vi.fn().mockResolvedValue({
        sessionId: "session-1",
        replaced: true,
      });
      const datasource = createSqliteViewportDatasource({
        openViewportSession: () => ({
          sessionId: "session-1",
          updates: Stream.empty,
          replace,
          close: vi.fn().mockResolvedValue({
            sessionId: "session-1",
            closed: true,
          }),
        }),
      }, {
        storeId: "store-1",
        runtime,
      });

      datasource.init(makeViewportParams());
      yield* Effect.promise(() => Promise.resolve());
      yield* Effect.promise(() => Promise.resolve());
      datasource.setViewportRange(undefined as never, undefined as never);
      yield* Effect.promise(() => Promise.resolve());
      yield* Effect.promise(() => Promise.resolve());

      yield* Effect.sync(() => {
        expect(replace).not.toHaveBeenCalledWith(expect.objectContaining({
          startRow: undefined,
        }));
        expect(replace).not.toHaveBeenCalledWith(expect.objectContaining({
          endRow: undefined,
        }));
      });
    }),
  );
});
