import { describe, expect as vitestExpect, it } from "vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/TestClock";
import { effect, expect } from "@effect/vitest";

import type { RowRecord } from "./row-schema";
import { StoreRegistry } from "./store-registry";

const STOCK_ROWS: ReadonlyArray<RowRecord> = [
  {
    id: "1",
    active: true,
    symbol: "ZETA",
    company: "Zeta Corp",
    sector: "Technology",
    venue: "NASDAQ",
    price: 150,
    volume: 1000,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "2",
    active: true,
    symbol: "ALFA",
    company: "Alfa Corp",
    sector: "Financials",
    venue: "NYSE",
    price: 90,
    volume: 1000,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "3",
    active: true,
    symbol: "BRAV",
    company: "Bravo Corp",
    sector: "Technology",
    venue: "NASDAQ",
    price: 120,
    volume: 1000,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

function loadStocks(registry: StoreRegistry) {
  return Effect.promise(() =>
    registry.loadStore(
      {
        storeId: "stocks",
        rowKey: "id",
      },
      {
        kind: "rows",
        rows: STOCK_ROWS,
      },
    ),
  );
}

function withPatches<T>(
  registry: StoreRegistry,
  execute: (patches: Queue.Queue<any>) => Effect.Effect<T, string, never>,
) {
  return Effect.scoped(Effect.gen(function* () {
    const patches = yield* Queue.unbounded<any>();
    yield* Stream.runForEachScoped(
      registry.openViewportSession({
        sessionId: "session-1",
        storeId: "stocks",
        startRow: 0,
        endRow: 2,
        query: {
          predicate: null,
          sorts: [{ field: "symbol", direction: "asc" }],
        },
      }),
      (patch) => Queue.offer(patches, patch),
    ).pipe(Effect.forkScoped);

    return yield* execute(patches);
  }));
}

describe("sqlite store registry", () => {
  effect("opens a viewport session and returns the initial sorted slice", () =>
    Effect.gen(function* () {
      const registry = new StoreRegistry();
      yield* loadStocks(registry);

      const patch = yield* withPatches(registry, (patches) => Queue.take(patches));

      expect(patch.rows.map((row: RowRecord) => row.symbol)).toEqual(["ALFA", "BRAV"]);
      expect(patch.rowCount).toBe(3);
      expect(patch.latencyMs).toBe(0);
    }));

  effect("reruns the visible window immediately when the range changes", () =>
    Effect.gen(function* () {
      const registry = new StoreRegistry();
      yield* loadStocks(registry);

      const result = yield* withPatches(registry, (patches) =>
        Effect.gen(function* () {
          const initial = yield* Queue.take(patches);
          yield* registry.replaceViewportSession({
            sessionId: "session-1",
            startRow: 1,
            endRow: 3,
            query: {
              predicate: null,
              sorts: [{ field: "symbol", direction: "asc" }],
            },
          });
          const shifted = yield* Queue.take(patches);

          return {
            initial: initial.rows.map((row: RowRecord) => row.symbol),
            shifted: shifted.rows.map((row: RowRecord) => row.symbol),
          };
        }));

      expect(result.initial).toEqual(["ALFA", "BRAV"]);
      expect(result.shifted).toEqual(["BRAV", "ZETA"]);
    }));

  effect("reruns the query immediately when sort or filter changes", () =>
    Effect.gen(function* () {
      const registry = new StoreRegistry();
      yield* loadStocks(registry);

      const result = yield* withPatches(registry, (patches) =>
        Effect.gen(function* () {
          yield* Queue.take(patches);

          yield* registry.replaceViewportSession({
            sessionId: "session-1",
            startRow: 0,
            endRow: 2,
            query: {
              predicate: {
                kind: "comparison",
                field: "sector",
                filterType: "text",
                operator: "eq",
                value: "Technology",
              },
              sorts: [{ field: "price", direction: "desc" }],
            },
          });

          const filtered = yield* Queue.take(patches);
          return filtered.rows.map((row: RowRecord) => row.symbol);
        }));

      expect(result).toEqual(["ZETA", "BRAV"]);
    }));

  effect("coalesces write-driven refreshes to one patch per 100ms window", () =>
    Effect.gen(function* () {
      const runtime = yield* Effect.runtime<never>();
      const registry = new StoreRegistry({ runtime });
      yield* loadStocks(registry);

      const seen = yield* Effect.scoped(Effect.gen(function* () {
        const patches = yield* Queue.unbounded<number>();
        yield* Stream.runForEachScoped(
          registry.openViewportSession({
            sessionId: "session-1",
            storeId: "stocks",
            startRow: 0,
            endRow: 2,
            query: {
              predicate: null,
              sorts: [{ field: "symbol", direction: "asc" }],
            },
          }),
          (patch) => Queue.offer(patches, patch.rowCount),
        ).pipe(Effect.forkScoped);

        const counts: Array<number> = [];
        counts.push(yield* Queue.take(patches));

        yield* Effect.promise(() =>
          registry.applyTransaction("stocks", {
            kind: "upsert",
            rows: [
              {
                id: "4",
                active: true,
                symbol: "CHAR",
                company: "Charlie Corp",
                sector: "Energy",
                venue: "IEX",
                price: 180,
                volume: 1000,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          }),
        );
        yield* Effect.promise(() =>
          registry.applyTransaction("stocks", {
            kind: "upsert",
            rows: [
              {
                id: "5",
                active: true,
                symbol: "DELT",
                company: "Delta Corp",
                sector: "Healthcare",
                venue: "NYSE",
                price: 210,
                volume: 1000,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          }),
        );

        expect(counts).toEqual([3]);

        yield* TestClock.adjust(Duration.millis(100));
        counts.push(yield* Queue.take(patches));
        return counts;
      }));

      expect(seen).toEqual([3, 5]);
    }));

  effect("reports write refresh latency from query execution, not throttle delay", () =>
    Effect.gen(function* () {
      const runtime = yield* Effect.runtime<never>();
      const registry = new StoreRegistry({ runtime });
      yield* loadStocks(registry);

      const patch = yield* Effect.scoped(Effect.gen(function* () {
        const patches = yield* Queue.unbounded<any>();
        yield* Stream.runForEachScoped(
          registry.openViewportSession({
            sessionId: "session-1",
            storeId: "stocks",
            startRow: 0,
            endRow: 2,
            query: {
              predicate: null,
              sorts: [{ field: "updatedAt", direction: "desc" }],
            },
          }),
          (nextPatch) => Queue.offer(patches, nextPatch),
        ).pipe(Effect.forkScoped);

        yield* Queue.take(patches);
        yield* Effect.promise(() =>
          registry.applyTransaction("stocks", {
            kind: "upsert",
            rows: [
              {
                id: "4",
                active: true,
                symbol: "CHAR",
                company: "Charlie Corp",
                sector: "Energy",
                venue: "IEX",
                price: 180,
                volume: 1000,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          }),
        );

        yield* TestClock.adjust(Duration.millis(100));
        return yield* Queue.take(patches);
      }));

      expect(patch.latencyMs).toBe(0);
    }));

  it("keeps generating fresh stress batches on each tick", async () => {
    const registry = new StoreRegistry({
      writeRefreshThrottleMs: 0,
    });
    await registry.loadStore(
      {
        storeId: "stocks",
        rowKey: "id",
      },
      {
        kind: "rows",
        rows: STOCK_ROWS,
      },
    );

    const scope = await Effect.runPromise(Effect.scoped(Scope.make()));
    const patches = await Effect.runPromise(Queue.unbounded<number>());
    await Effect.runPromise(
      Scope.extend(
        Stream.runForEachScoped(
          registry.openViewportSession({
            sessionId: "session-1",
            storeId: "stocks",
            startRow: 0,
            endRow: 2,
            query: {
              predicate: null,
              sorts: [{ field: "updatedAt", direction: "desc" }],
            },
          }),
          (patch) => Queue.offer(patches, patch.rowCount),
        ).pipe(Effect.forkScoped),
        scope,
      ),
    );

    await Effect.runPromise(Queue.take(patches));
    const state = registry.setStressRate("stocks", 600);
    vitestExpect(state.running).toBe(true);

    await Effect.runPromise(Effect.sleep(Duration.millis(150)));
    const firstCount = await Effect.runPromise(
      Queue.take(patches).pipe(
        Effect.timeoutFail({
          duration: Duration.seconds(1),
          onTimeout: () => "timed out waiting for first stress patch",
        }),
      ),
    );
    vitestExpect(firstCount).toBeGreaterThan(3);

    await Effect.runPromise(Effect.sleep(Duration.millis(150)));
    const secondCount = await Effect.runPromise(
      Queue.take(patches).pipe(
        Effect.timeoutFail({
          duration: Duration.seconds(1),
          onTimeout: () => "timed out waiting for second stress patch",
        }),
      ),
    );
    vitestExpect(secondCount).toBeGreaterThan(firstCount);

    registry.setStressRate("stocks", 0);
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
  });
});
