import * as Effect from "effect/Effect";

import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import * as WorkerRunner from "@effect/platform/WorkerRunner";

import type { SqliteRow, SqliteStoreDefinition } from "./store-config";
import { StoreRegistry } from "./store-registry";
import {
  ApplyTransaction,
  CloseViewportSession,
  DisposeStore,
  LoadStore,
  OpenViewportSession,
  ReplaceViewportSession,
  SetStressRate,
  type WorkerRequest,
  WorkerRequestSchema,
} from "./worker-contract";

export function createSqliteWorkerHandlers<TRow extends SqliteRow = SqliteRow>(
  store: SqliteStoreDefinition<object, TRow>,
  registry = new StoreRegistry(store),
) {
  const loadStore = (request: LoadStore) =>
    registry.loadStore(
      request.definition,
      request.source as Parameters<typeof registry.loadStore>[1],
    );

  const applyTransaction = (request: ApplyTransaction) =>
    registry.applyTransaction(
      request.storeId,
      request.transaction as Parameters<typeof registry.applyTransaction>[1],
    );

  const handlers = {
    LoadStore: (request: LoadStore) =>
      Effect.tryPromise({
        try: () => loadStore(request),
        catch: (error) => error instanceof Error ? error.message : "Failed to load store",
      }),
    ApplyTransaction: (request: ApplyTransaction) =>
      Effect.tryPromise({
        try: () => applyTransaction(request),
        catch: (error) => error instanceof Error ? error.message : "Failed to apply transaction",
      }),
    OpenViewportSession: (request: OpenViewportSession) =>
      registry.openViewportSession(request),
    ReplaceViewportSession: (request: ReplaceViewportSession) =>
      registry.replaceViewportSession(request),
    CloseViewportSession: (request: CloseViewportSession) =>
      Effect.tryPromise({
        try: () => registry.closeViewportSession(request.sessionId),
        catch: (error) => error instanceof Error ? error.message : "Failed to close viewport session",
      }),
    SetStressRate: (request: SetStressRate) =>
      Effect.sync(() => registry.setStressRate(request.storeId, request.rowsPerSecond)),
    DisposeStore: (request: DisposeStore) =>
      Effect.sync(() => registry.disposeStore(request.storeId)),
  } satisfies WorkerRunner.SerializedRunner.Handlers<WorkerRequest>;

  return handlers;
}

export function makeSqliteWorkerLayer<TRow extends SqliteRow = SqliteRow>(
  store: SqliteStoreDefinition<object, TRow>,
  registry = new StoreRegistry(store),
) {
  return WorkerRunner.layerSerialized(
    WorkerRequestSchema,
    createSqliteWorkerHandlers(store, registry),
  );
}

export function launchSqliteBrowserWorker<TRow extends SqliteRow = SqliteRow>(
  store: SqliteStoreDefinition<object, TRow>,
  registry = new StoreRegistry(store),
) {
  return BrowserWorkerRunner.launch(makeSqliteWorkerLayer(store, registry)).pipe(
    Effect.provide(BrowserWorkerRunner.layer),
  );
}
