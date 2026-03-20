import * as Effect from "effect/Effect";
import * as Runtime from "effect/Runtime";

import type { SqliteRow, SqliteStoreDefinition } from "./store-config";
import { StoreRegistry } from "./store-registry";
import { launchSqliteBrowserWorker } from "./worker-handlers";
import type {
  ApplyTransactionSuccess,
  LoadStoreSuccess,
} from "./worker-contract";

export interface SqliteWorkerRuntimeOptions {
  storeId: string;
  runtime?: Runtime.Runtime<never>;
  writeRefreshThrottleMs?: number;
}

export class SqliteWorkerRuntime<TRow extends SqliteRow = SqliteRow> {
  readonly storeId: string;
  private readonly runtime: Runtime.Runtime<never>;
  private readonly registry: StoreRegistry<TRow>;
  private ready = false;

  constructor(
    private readonly store: SqliteStoreDefinition<object, TRow>,
    options: SqliteWorkerRuntimeOptions,
  ) {
    this.storeId = options.storeId;
    this.runtime = options.runtime ?? Runtime.defaultRuntime;
    this.registry = new StoreRegistry(store, {
      runtime: this.runtime,
      writeRefreshThrottleMs: options.writeRefreshThrottleMs,
    });
  }

  replaceAll(rows: ReadonlyArray<TRow>): Promise<LoadStoreSuccess> {
    return this.runPromise(Effect.tryPromise({
      try: async () => {
        if (this.ready) {
          this.registry.disposeStore(this.storeId);
        }
        const result = await this.registry.loadStore(
          { storeId: this.storeId },
          { kind: "rows", rows },
        );
        this.ready = true;
        return result;
      },
      catch: (error) => error instanceof Error ? error : new Error("Failed to replace rows"),
    }));
  }

  upsert(rows: ReadonlyArray<TRow>): Promise<ApplyTransactionSuccess> {
    return this.runPromise(Effect.tryPromise({
      try: async () => {
        await this.ensureLoaded();
        return this.registry.applyTransaction(this.storeId, {
          kind: "upsert",
          rows,
        });
      },
      catch: (error) => error instanceof Error ? error : new Error("Failed to upsert rows"),
    }));
  }

  delete(ids: ReadonlyArray<string | number>): Promise<ApplyTransactionSuccess> {
    return this.runPromise(Effect.tryPromise({
      try: async () => {
        await this.ensureLoaded();
        return this.registry.applyTransaction(this.storeId, {
          kind: "delete",
          ids,
        });
      },
      catch: (error) => error instanceof Error ? error : new Error("Failed to delete rows"),
    }));
  }

  async setStressRate(rowsPerSecond: number) {
    await this.ensureLoaded();
    return this.registry.setStressRate(this.storeId, rowsPerSecond);
  }

  launchBrowserWorker() {
    return Effect.gen(this, function* () {
      yield* Effect.promise(() => this.ensureLoaded());
      yield* launchSqliteBrowserWorker(this.registry);
    });
  }

  private async ensureLoaded() {
    if (this.ready) {
      return;
    }

    await this.registry.loadStore(
      { storeId: this.storeId },
      { kind: "rows", rows: [] },
    );
    this.ready = true;
  }

  private runPromise<A, E>(effect: Effect.Effect<A, E, never>) {
    return Runtime.runPromise(this.runtime)(effect);
  }
}
