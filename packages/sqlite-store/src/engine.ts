import type * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type {
  GridStoreAdapterOptions,
  SqliteViewportDatasource,
} from "./ag-grid-adapters";
import { createSqliteViewportDatasource } from "./ag-grid-adapters";
import {
  defineSqliteStore,
  type SqliteRow,
  type SqliteStoreDefinition,
} from "./store-config";
import type { SqliteRowFactoryHooks } from "./store-config";
import { createReadOnlySqliteWorkerClient } from "./worker-client";
import {
  makeSqliteWorkerService,
  type SqliteWorkerService,
  type SqliteWorkerServiceOptions,
} from "./worker-runtime";

type InferTableRow<TTable> = TTable extends { $inferSelect: infer TRow }
  ? Extract<TRow, SqliteRow>
  : SqliteRow;

type RowKeyOf<TRow extends SqliteRow> = Extract<keyof TRow, string>;

export interface AgGridSqliteEngineOptions<
  TTable extends object = object,
  TRow extends SqliteRow = InferTableRow<TTable>,
> {
  readonly table: TTable;
  readonly rowKey: RowKeyOf<TRow>;
  readonly rowFactory?: SqliteRowFactoryHooks<TRow>;
}

export interface AgGridSqliteClient<TRow extends SqliteRow = SqliteRow> {
  readonly storeId: string;
  open(options?: GridStoreAdapterOptions): SqliteViewportDatasource;
  close(): Promise<void>;
}

export interface AgGridSqliteWorkerRuntime {
  readonly storeId: string;
  readonly serve: Effect.Effect<never, unknown, never>;
  readonly invalidate: Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
}

export interface AgGridSqliteWorkerRuntimeOptions {
  storeId: string;
}

export interface AgGridSqliteEngine<
  TTable extends object = object,
  TRow extends SqliteRow = InferTableRow<TTable>,
> {
  readonly table: TTable;
  readonly rowKey: RowKeyOf<TRow>;
  readonly store: SqliteStoreDefinition<TTable, TRow>;
  makeWorkerService(
    options: AgGridSqliteWorkerRuntimeOptions,
  ): Effect.Effect<
    AgGridSqliteWorkerRuntime,
    never,
    SqlClient.SqlClient
  >;
  connect(
    spawn: (id: number) => globalThis.Worker | globalThis.SharedWorker | MessagePort,
    options: {
      storeId: string;
    },
  ): Promise<AgGridSqliteClient<TRow>>;
}

export function defineAgGridSqliteEngine<TTable extends object>(
  options: AgGridSqliteEngineOptions<TTable, InferTableRow<TTable>>,
): AgGridSqliteEngine<TTable, InferTableRow<TTable>> {
  const store = defineSqliteStore(options);

  return {
    table: options.table,
    rowKey: options.rowKey,
    store,
    makeWorkerService(runtimeOptions) {
      return makeSqliteWorkerService(
        store,
        runtimeOptions satisfies SqliteWorkerServiceOptions,
      ) as Effect.Effect<SqliteWorkerService, never, SqlClient.SqlClient>;
    },
    async connect(spawn, connectOptions) {
      const client = await createReadOnlySqliteWorkerClient<InferTableRow<TTable>>(spawn, {
        storeId: connectOptions.storeId,
      });

      return {
        storeId: connectOptions.storeId,
        open(viewportOptions = {}) {
          return createSqliteViewportDatasource(client, viewportOptions);
        },
        close() {
          return client.close();
        },
      };
    },
  };
}
