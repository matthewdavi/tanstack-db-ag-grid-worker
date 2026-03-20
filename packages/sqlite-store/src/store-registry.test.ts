import { describe, expect as vitestExpect, it } from "vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/TestClock";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { effect, expect } from "@effect/vitest";

import { defineSqliteStore } from "./store-config";
import { StoreRegistry } from "./store-registry";

const stocksTable = sqliteTable("inventory_items", {
  sku: text("sku").primaryKey(),
  active: integer("is_active", { mode: "boolean" }).notNull(),
  symbol: text("symbol_code").notNull(),
  company: text("company_name").notNull(),
  sector: text("sector_name").notNull(),
  venue: text("venue_code").notNull(),
  price: real("last_price").notNull(),
  volume: integer("share_volume").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

type StockRow = typeof stocksTable.$inferSelect;

const stockStore = defineSqliteStore({
  table: stocksTable,
  rowKey: "sku",
  rowFactory: {
    createStressRowFactory(seed, startIndex, options) {
      let index = startIndex;
      return () => {
        const nextIndex = index;
        index += 1;
        const timestamp = options?.realtimeTimestamps
          ? new Date(Date.UTC(2026, 2, 20, 12, 0, 0, nextIndex)).toISOString()
          : "2026-01-01T00:00:00.000Z";

        return {
          sku: `stress-${seed}-${nextIndex}`,
          active: true,
          symbol: `SYM${nextIndex}`,
          company: `Stress ${nextIndex}`,
          sector: "Technology",
          venue: "NASDAQ",
          price: 100 + nextIndex,
          volume: 1000 + nextIndex,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
      };
    },
  },
});

const STOCK_ROWS: ReadonlyArray<StockRow> = [
  {
    sku: "1",
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
    sku: "2",
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
    sku: "3",
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

function loadStocks(registry: StoreRegistry<StockRow>) {
  return Effect.promise(() =>
    registry.loadStore(
      {
        storeId: "stocks",
      },
      {
        kind: "rows",
        rows: STOCK_ROWS,
      },
    ),
  );
}

function withPatches<T>(
  registry: StoreRegistry<StockRow>,
  execute: (patches: Queue.Queue<{ rows: ReadonlyArray<StockRow>; rowCount: number; latencyMs: number }>) => Effect.Effect<T, string, never>,
) {
  return Effect.scoped(Effect.gen(function* () {
    const patches = yield* Queue.unbounded<{ rows: ReadonlyArray<StockRow>; rowCount: number; latencyMs: number }>();
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
      const registry = new StoreRegistry(stockStore);
      yield* loadStocks(registry);

      const patch = yield* withPatches(registry, (patches) => Queue.take(patches));

      expect(patch.rows.map((row: StockRow) => row.symbol)).toEqual(["ALFA", "BRAV"]);
      expect(patch.rowCount).toBe(3);
      expect(patch.latencyMs).toBe(0);
    }));

  effect("reruns the visible window immediately when the range changes", () =>
    Effect.gen(function* () {
      const registry = new StoreRegistry(stockStore);
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
            initial: initial.rows.map((row: StockRow) => row.symbol),
            shifted: shifted.rows.map((row: StockRow) => row.symbol),
          };
        }));

      expect(result.initial).toEqual(["ALFA", "BRAV"]);
      expect(result.shifted).toEqual(["BRAV", "ZETA"]);
    }));

  effect("reruns the query immediately when sort or filter changes", () =>
    Effect.gen(function* () {
      const registry = new StoreRegistry(stockStore);
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
          return filtered.rows.map((row: StockRow) => row.symbol);
        }));

      expect(result).toEqual(["ZETA", "BRAV"]);
    }));

  effect("deletes rows using the configured row key", () =>
    Effect.gen(function* () {
      const registry = new StoreRegistry(stockStore);
      yield* loadStocks(registry);

      const result = yield* withPatches(registry, (patches) =>
        Effect.gen(function* () {
          yield* Queue.take(patches);
          yield* Effect.promise(() =>
            registry.applyTransaction("stocks", {
              kind: "delete",
              ids: ["2"],
            }),
          );
          const patch = yield* Queue.take(patches);
          return patch.rows.map((row) => row.symbol);
        }));

      expect(result).toEqual(["BRAV", "ZETA"]);
    }));

  effect("coalesces write-driven refreshes to one patch per 100ms window", () =>
    Effect.gen(function* () {
      const runtime = yield* Effect.runtime<never>();
      const registry = new StoreRegistry(stockStore, { runtime });
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
                sku: "4",
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
                sku: "5",
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
      const registry = new StoreRegistry(stockStore, { runtime });
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
                sku: "4",
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
    const registry = new StoreRegistry(stockStore, {
      writeRefreshThrottleMs: 0,
    });
    await registry.loadStore(
      {
        storeId: "stocks",
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
