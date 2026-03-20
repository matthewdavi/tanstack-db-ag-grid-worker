import * as Effect from "effect/Effect";

import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import * as WorkerRunner from "@effect/platform/WorkerRunner";

import type { SqliteRow } from "./store-config";
import { StoreRegistry } from "./store-registry";
import {
  CloseViewportSession,
  OpenViewportSession,
  ReplaceViewportSession,
  type WorkerRequest,
  WorkerRequestSchema,
} from "./worker-contract";

export function createSqliteWorkerHandlers<TRow extends SqliteRow = SqliteRow>(
  registry: StoreRegistry<TRow>,
) {
  return {
    OpenViewportSession: (request: OpenViewportSession) =>
      registry.openViewportSession(request),
    ReplaceViewportSession: (request: ReplaceViewportSession) =>
      registry.replaceViewportSession(request),
    CloseViewportSession: (request: CloseViewportSession) =>
      Effect.tryPromise({
        try: () => registry.closeViewportSession(request.sessionId),
        catch: (error) =>
          error instanceof Error ? error.message : "Failed to close viewport session",
      }),
  } satisfies WorkerRunner.SerializedRunner.Handlers<WorkerRequest>;
}

export function makeSqliteWorkerLayer<TRow extends SqliteRow = SqliteRow>(
  registry: StoreRegistry<TRow>,
) {
  return WorkerRunner.layerSerialized(
    WorkerRequestSchema,
    createSqliteWorkerHandlers(registry),
  );
}

export function launchSqliteBrowserWorker<TRow extends SqliteRow = SqliteRow>(
  registry: StoreRegistry<TRow>,
) {
  return BrowserWorkerRunner.launch(makeSqliteWorkerLayer(registry)).pipe(
    Effect.provide(BrowserWorkerRunner.layer),
  );
}
