// @vitest-environment jsdom

import { describe } from "vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "@effect/sql-sqlite-wasm/SqliteClient";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { effect, expect } from "@effect/vitest";

import { defineSqliteStore } from "./store-config";
import {
  layerSqliteViewportChannelService,
  seedSqliteStore,
  SqliteViewportChannelService,
} from "./store-registry";
import { installFileFetchShim } from "./test-file-fetch";
import type { ViewportPatch } from "./worker-contract";

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

installFileFetchShim();

function testLayer() {
  return layerSqliteViewportChannelService(stockStore, {
    storeId: "stocks",
  }).pipe(Layer.provideMerge(SqliteClient.layerMemory({})));
}

const seedStocks = seedSqliteStore(stockStore, STOCK_ROWS);

function upsertStocks(rows: ReadonlyArray<StockRow>) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const row of rows) {
      yield* sql.unsafe(stockStore.upsertSql, stockStore.encodeRow(row));
    }
  });
}

function withPatches<T, E, R>(
  execute: (context: {
    patches: Queue.Queue<ViewportPatch<StockRow>>;
    channelService: SqliteViewportChannelService<StockRow>;
  }) => Effect.Effect<T, E, R>,
): Effect.Effect<T, E, SqliteViewportChannelService<StockRow> | R> {
  return Effect.scoped(
    Effect.gen(function* () {
      const channelService =
        (yield* SqliteViewportChannelService) as SqliteViewportChannelService<StockRow>;
      const patches = yield* Queue.unbounded<ViewportPatch<StockRow>>();

      yield* Stream.runForEach(
        channelService.connect(
          "connection-1",
          {
            storeId: "stocks",
            startRow: 0,
            endRow: 2,
            query: {
              predicate: null,
              sorts: [{ field: "symbol", direction: "asc" }],
            },
          },
          { throttleMs: 100 },
        ),
        (patch) => Queue.offer(patches, patch as ViewportPatch<StockRow>),
      ).pipe(Effect.forkScoped);

      return yield* execute({
        patches,
        channelService,
      });
    }),
  ) as Effect.Effect<T, E, SqliteViewportChannelService<StockRow> | R>;
}

describe("sqlite viewport channel service", () => {
  effect("connect emits the initial sorted slice", () =>
    Effect.gen(function* () {
      yield* seedStocks;

      const patch = yield* withPatches(({ patches }) => Queue.take(patches));

      expect(patch.rows.map((row) => row.symbol)).toEqual(["ALFA", "BRAV"]);
      expect(patch.rowCount).toBe(3);
    }).pipe(Effect.provide(testLayer())));

  effect("setIntent reruns the visible window for the latest range", () =>
    Effect.gen(function* () {
      yield* seedStocks;

      const result = yield* withPatches(({ patches, channelService }) =>
        Effect.gen(function* () {
          const initial = yield* Queue.take(patches);

          yield* channelService.setIntent("connection-1", {
            storeId: "stocks",
            startRow: 1,
            endRow: 3,
            query: {
              predicate: null,
              sorts: [{ field: "symbol", direction: "asc" }],
            },
          });

          const shifted = yield* Queue.take(patches);
          return {
            initial: initial.rows.map((row) => row.symbol),
            shifted: shifted.rows.map((row) => row.symbol),
          };
        }),
      );

      expect(result.initial).toEqual(["ALFA", "BRAV"]);
      expect(result.shifted).toEqual(["BRAV", "ZETA"]);
    }).pipe(Effect.provide(testLayer())));

  effect("invalidate reruns the current viewport", () =>
    Effect.gen(function* () {
      yield* seedStocks;

      const patch = yield* withPatches(({ patches, channelService }) =>
        Effect.gen(function* () {
          yield* Queue.take(patches);

          yield* upsertStocks([
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
          ]);

          yield* channelService.invalidate;
          return yield* Queue.take(patches);
        }),
      );

      expect(patch.rowCount).toBe(4);
    }).pipe(Effect.provide(testLayer())));

  effect("throttles repeated invalidations in the worker", () =>
    Effect.gen(function* () {
      yield* seedStocks;

      const counts = yield* withPatches(({ patches, channelService }) =>
        Effect.gen(function* () {
          const seen: Array<number> = [];

          seen.push((yield* Queue.take(patches)).rowCount);

          yield* upsertStocks([
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
          ]);
          yield* channelService.invalidate;

          yield* upsertStocks([
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
          ]);
          yield* channelService.invalidate;

          expect(seen).toEqual([3]);

          yield* TestClock.adjust(Duration.millis(100));
          seen.push((yield* Queue.take(patches)).rowCount);
          return seen;
        }),
      );

      expect(counts).toEqual([3, 4]);
    }).pipe(Effect.provide(testLayer())));

  effect("close removes the channel and stops future updates", () =>
    Effect.gen(function* () {
      yield* seedStocks;
      const channelService = yield* SqliteViewportChannelService;

      yield* Stream.runDrain(
        channelService.connect(
          "connection-1",
          {
            storeId: "stocks",
            startRow: 0,
            endRow: 2,
            query: {
              predicate: null,
              sorts: [],
            },
          },
          { throttleMs: 100 },
        ).pipe(Stream.take(1)),
      );

      const result = yield* channelService.close("connection-1");
      expect(result.closed).toBe(true);
    }).pipe(Effect.provide(testLayer())));
});
