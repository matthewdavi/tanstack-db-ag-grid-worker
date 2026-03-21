import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";

import { SqliteViewportChannelService } from "@sandbox/sqlite-store";

import {
  INITIAL_DEMO_ROW_COUNT,
} from "./demo-constants";
import {
  createMarketRowFactory,
  type MarketRow,
  marketGrid,
} from "./market-sqlite-store";

const UPSERT_BATCH_SIZE = 200;
const INITIAL_BOOT_SEED_ROW_COUNT = 5_000;
const BACKGROUND_BOOT_BATCH_SIZE = 10_000;

function getTableNameSql() {
  return `"${marketGrid.store.tableName.replaceAll(`"`, `""`)}"`;
}

function getUpsertAssignmentsSql() {
  return marketGrid.store.columnOrder
    .filter((field) => field !== marketGrid.store.rowKey)
    .map((field) => {
      const column = marketGrid.store.columns[field];
      return `${column.columnSql} = excluded.${column.columnSql}`;
    })
    .join(", ");
}

function makeBatchedUpsertSql(rowCount: number) {
  const columnsSql = marketGrid.store.columnOrder
    .map((field) => marketGrid.store.columns[field].columnSql)
    .join(", ");
  const placeholders = `(${marketGrid.store.columnOrder.map(() => "?").join(", ")})`;
  const valuesSql = Array.from({ length: rowCount }, () => placeholders).join(", ");
  const assignmentsSql = getUpsertAssignmentsSql();

  return [
    `insert into ${getTableNameSql()} (${columnsSql})`,
    `values ${valuesSql}`,
    assignmentsSql.length > 0
      ? `on conflict (${marketGrid.store.rowKeyColumn.columnSql}) do update set ${assignmentsSql}`
      : `on conflict (${marketGrid.store.rowKeyColumn.columnSql}) do nothing`,
  ].join(" ");
}

function chunkRows(rows: ReadonlyArray<MarketRow>, size: number) {
  const chunks: Array<ReadonlyArray<MarketRow>> = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

function takeRows(count: number, makeRow: () => MarketRow) {
  return Array.from({ length: count }, () => makeRow()) as ReadonlyArray<MarketRow>;
}

function getStressBatchSize(rowsPerSecond: number) {
  return Math.max(1, Math.round((rowsPerSecond * 100) / 1000));
}

function upsertBatch(sql: SqlClient.SqlClient, rows: ReadonlyArray<MarketRow>) {
  const upsertSql = makeBatchedUpsertSql(rows.length);
  const params = rows.flatMap((row) => marketGrid.store.encodeRow(row));
  return sql.unsafe(upsertSql, params);
}

function replaceAllRows(
  sql: SqlClient.SqlClient,
  rows: ReadonlyArray<MarketRow>,
) {
  return Effect.gen(function* () {
    const tableName = getTableNameSql();
    const insertRows = Effect.forEach(
      chunkRows(rows, UPSERT_BATCH_SIZE),
      (chunk) => upsertBatch(sql, chunk),
      { concurrency: 1, discard: true },
    );

    yield* sql.unsafe(`drop table if exists ${tableName}`);
    yield* sql.unsafe(marketGrid.store.createTableSql);
    yield* sql.withTransaction(insertRows);
    yield* sql.unsafe(`analyze ${tableName}`);
  });
}

function upsertRows(
  sql: SqlClient.SqlClient,
  rows: ReadonlyArray<MarketRow>,
) {
  return Effect.gen(function* () {
    const insertRows = Effect.forEach(
      chunkRows(rows, UPSERT_BATCH_SIZE),
      (chunk) => upsertBatch(sql, chunk),
      { concurrency: 1, discard: true },
    );

    yield* sql.withTransaction(insertRows);
  });
}

export class DemoWriteService extends ServiceMap.Service<
  DemoWriteService,
  {
    readonly pushLiveUpdate: Effect.Effect<void, SqlError.SqlError>;
    readonly writeStressBatch: (rowsPerSecond: number) => Effect.Effect<void, SqlError.SqlError>;
  }
>()("@apps/demo/DemoWriteService") {
  static readonly layer = Layer.effect(
    DemoWriteService,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const queryService = yield* SqliteViewportChannelService;
      const makeLiveRow = createMarketRowFactory(7, INITIAL_DEMO_ROW_COUNT, {
        realtimeTimestamps: true,
      });
      const makeBootRow = createMarketRowFactory(7);

      const writeRows = Effect.fn("DemoWriteService.writeRows")(
        function* (rows: ReadonlyArray<MarketRow>) {
          yield* upsertRows(sql, rows);
          yield* queryService.invalidate;
        },
      );

      const pushLiveUpdate = writeRows([makeLiveRow()]);

      const writeStressBatch = Effect.fn("DemoWriteService.writeStressBatch")(
        function* (rowsPerSecond: number) {
          const batchSize = getStressBatchSize(rowsPerSecond);
          yield* writeRows(takeRows(batchSize, makeLiveRow));
        },
      );

      const backfillRows = Effect.fn("DemoWriteService.backfillRows")(
        function* () {
          let rowsLeft = INITIAL_DEMO_ROW_COUNT - INITIAL_BOOT_SEED_ROW_COUNT;

          while (rowsLeft > 0) {
            const nextBatchSize = Math.min(rowsLeft, BACKGROUND_BOOT_BATCH_SIZE);
            yield* upsertRows(sql, takeRows(nextBatchSize, makeBootRow));
            yield* queryService.invalidate;
            rowsLeft -= nextBatchSize;
          }
        },
      );

      yield* replaceAllRows(
        sql,
        takeRows(INITIAL_BOOT_SEED_ROW_COUNT, makeBootRow),
      );
      yield* queryService.invalidate;

      if (INITIAL_DEMO_ROW_COUNT > INITIAL_BOOT_SEED_ROW_COUNT) {
        yield* Effect.forkScoped(backfillRows());
      }

      return {
        pushLiveUpdate,
        writeStressBatch,
      };
    }),
  );
}
