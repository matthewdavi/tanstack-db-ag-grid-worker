import * as Effect from "effect/Effect";

import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import * as WorkerRunner from "@effect/platform/WorkerRunner";

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

export function createSqliteWorkerHandlers(registry = new StoreRegistry()) {
  const handlers = {
    LoadStore: (request: LoadStore) =>
      Effect.tryPromise({
        try: () => registry.loadStore(request.definition, request.source),
        catch: (error) => error instanceof Error ? error.message : "Failed to load store",
      }),
    ApplyTransaction: (request: ApplyTransaction) =>
      Effect.tryPromise({
        try: () => registry.applyTransaction(request.storeId, request.transaction),
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

export function makeSqliteWorkerLayer(registry = new StoreRegistry()) {
  return WorkerRunner.layerSerialized(
    WorkerRequestSchema,
    createSqliteWorkerHandlers(registry),
  );
}

export function launchSqliteBrowserWorker(registry = new StoreRegistry()) {
  return BrowserWorkerRunner.launch(makeSqliteWorkerLayer(registry)).pipe(
    Effect.provide(BrowserWorkerRunner.layer),
  );
}
