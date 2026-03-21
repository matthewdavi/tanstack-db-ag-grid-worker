import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { SqliteRow, SqliteStoreDefinition } from "./store-config";
import {
  makeSqliteViewportChannelService,
  SqliteViewportChannelService,
} from "./store-registry";
import { makeSqliteWorkerLayer } from "./worker-handlers";

export interface SqliteWorkerServiceOptions {
  storeId: string;
}

export interface SqliteWorkerService {
  readonly storeId: string;
  readonly serve: Effect.Effect<never, unknown, never>;
  readonly invalidate: Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
}

export function makeSqliteWorkerService<TRow extends SqliteRow = SqliteRow>(
  store: SqliteStoreDefinition<object, TRow>,
  options: SqliteWorkerServiceOptions,
): Effect.Effect<SqliteWorkerService, never, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const channelService = yield* makeSqliteViewportChannelService(store, {
      storeId: options.storeId,
    });
    const serviceLayer = Layer.succeed(
      SqliteViewportChannelService,
      channelService,
    );
    const workerLayer = makeSqliteWorkerLayer().pipe(
      Layer.provide(serviceLayer),
    );

    return {
      storeId: options.storeId,
      serve: Layer.launch(workerLayer) as Effect.Effect<never, unknown, never>,
      invalidate: channelService.invalidate,
      close: channelService.closeAll,
    } satisfies SqliteWorkerService;
  });
}
