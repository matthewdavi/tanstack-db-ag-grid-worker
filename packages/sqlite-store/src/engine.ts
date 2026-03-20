import * as Effect from "effect/Effect";

import type { GridStoreAdapterOptions, ViewportDatasourceHandle } from "./ag-grid-adapters";
import { createSqliteViewportDatasource } from "./ag-grid-adapters";
import { defineSqliteStore, type SqliteRow } from "./store-config";
import type { SqliteRowFactoryHooks } from "./store-config";
import { createReadOnlySqliteWorkerClient } from "./worker-client";
import { SqliteWorkerRuntime, type SqliteWorkerRuntimeOptions } from "./worker-runtime";

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
  viewportDatasource(
    options?: Omit<GridStoreAdapterOptions, "storeId">,
  ): ViewportDatasourceHandle;
  close(): Promise<void>;
}

export interface AgGridSqliteEngine<
  TTable extends object = object,
  TRow extends SqliteRow = InferTableRow<TTable>,
> {
  readonly table: TTable;
  readonly rowKey: RowKeyOf<TRow>;
  createWorkerRuntime(
    options: SqliteWorkerRuntimeOptions,
  ): SqliteWorkerRuntime<TRow>;
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
    createWorkerRuntime(runtimeOptions) {
      return new SqliteWorkerRuntime(store, runtimeOptions);
    },
    async connect(spawn, connectOptions) {
      const client = await createReadOnlySqliteWorkerClient<InferTableRow<TTable>>(spawn, {
        storeId: connectOptions.storeId,
      });

      return {
        storeId: connectOptions.storeId,
        viewportDatasource(viewportOptions = {}) {
          return createSqliteViewportDatasource(client, {
            ...viewportOptions,
            storeId: connectOptions.storeId,
          });
        },
        close() {
          return client.close();
        },
      };
    },
  };
}
