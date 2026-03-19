import * as Effect from "effect/Effect";

import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import * as WorkerRunner from "@effect/platform/WorkerRunner";

import { StoreRegistry } from "./store-registry";
import {
  ApplyTransaction,
  CloseViewportSession,
  DisposeStore,
  GetRows,
  LoadStore,
  OpenViewportSession,
  ReplaceViewportSession,
  SetStressRate,
  type WorkerRequest,
  WorkerRequestSchema,
} from "./worker-contract";

export function createWorkerHandlers(registry = new StoreRegistry()) {
  const handlers = {
    LoadStore: (request: LoadStore) =>
      Effect.sync(() => registry.loadStore(request.definition, request.source)),
    ApplyTransaction: (request: ApplyTransaction) =>
      Effect.sync(() =>
        registry.applyTransaction(request.storeId, request.transaction),
      ),
    GetRows: (request: GetRows) =>
      Effect.tryPromise({
        try: () =>
          registry.getRows(request.storeId, request.query, {
            startRow: request.startRow,
            endRow: request.endRow,
          }),
        catch: (error) =>
          error instanceof Error ? error.message : "Failed to get rows",
      }),
    OpenViewportSession: (request: OpenViewportSession) =>
      registry.openViewportSession(request),
    ReplaceViewportSession: (request: ReplaceViewportSession) =>
      registry.replaceViewportSession(request),
    CloseViewportSession: (request: CloseViewportSession) =>
      registry.closeViewportSession(request.sessionId),
    SetStressRate: (request: SetStressRate) =>
      Effect.sync(() => registry.setStressRate(request.storeId, request.rowsPerSecond)),
    DisposeStore: (request: DisposeStore) =>
      Effect.sync(() => registry.disposeStore(request.storeId)),
  } satisfies WorkerRunner.SerializedRunner.Handlers<WorkerRequest>;

  return handlers;
}

export function makeWorkerLayer(registry = new StoreRegistry()) {
  return WorkerRunner.layerSerialized(
    WorkerRequestSchema,
    createWorkerHandlers(registry),
  );
}

export function launchBrowserWorker(registry = new StoreRegistry()) {
  return BrowserWorkerRunner.launch(makeWorkerLayer(registry)).pipe(
    Effect.provide(BrowserWorkerRunner.layer),
  );
}
