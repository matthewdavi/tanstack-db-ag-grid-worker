import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as ParseResult from "effect/ParseResult";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as BrowserWorker from "@effect/platform-browser/BrowserWorker";
import * as Worker from "@effect/platform/Worker";
import type { WorkerError } from "@effect/platform/WorkerError";

import type {
  ApplyTransactionSuccess,
  CloseViewportSessionSuccess,
  DisposeStoreSuccess,
  LoadStoreSuccess,
  OpenViewportSessionRequest,
  ReplaceViewportSessionSuccess,
  StoreDefinition,
  StoreSource,
  StoreTransaction,
  StressState,
  ViewportPatch,
  WorkerRequest,
} from "./worker-contract";
import {
  ApplyTransaction,
  CloseViewportSession,
  DisposeStore,
  LoadStore,
  OpenViewportSession,
  ReplaceViewportSession,
  SetStressRate,
} from "./worker-contract";

import type { SqliteRow } from "./store-config";

export interface SqliteViewportSessionHandle<TRow extends SqliteRow = SqliteRow> {
  readonly sessionId: string;
  readonly updates: Stream.Stream<
    ViewportPatch<TRow>,
    string | WorkerError | ParseResult.ParseError
  >;
  replace(
    request: Omit<OpenViewportSessionRequest, "sessionId" | "storeId">,
  ): Promise<ReplaceViewportSessionSuccess>;
  close(): Promise<CloseViewportSessionSuccess>;
}

export interface SqliteCollectionHandle<TRow extends SqliteRow = SqliteRow> {
  readonly storeId: string;
  applyTransaction(
    transaction: StoreTransaction<TRow>,
  ): Promise<ApplyTransactionSuccess>;
  openViewportSession(
    request: Omit<OpenViewportSessionRequest, "storeId" | "sessionId"> & {
      sessionId?: string;
    },
  ): SqliteViewportSessionHandle<TRow>;
  setStressRate(rowsPerSecond: number): Promise<StressState>;
  dispose(): Promise<DisposeStoreSuccess>;
}

export interface SqliteWorkerClient<TRow extends SqliteRow = SqliteRow> {
  loadStore(
    definition: StoreDefinition,
    source: StoreSource<TRow>,
  ): Promise<LoadStoreSuccess>;
  collection(storeId: string): SqliteCollectionHandle<TRow>;
  close(): Promise<void>;
}

function createSessionId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `sqlite-viewport-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function createSqliteWorkerClient<TRow extends SqliteRow = SqliteRow>(
  spawn: (id: number) => globalThis.Worker | globalThis.SharedWorker | MessagePort,
): Promise<SqliteWorkerClient<TRow>> {
  const scope = await Effect.runPromise(Scope.make());
  const worker = await Effect.runPromise(
    Scope.extend(
      Worker.makeSerialized<WorkerRequest>({}),
      scope,
    ).pipe(Effect.provide(BrowserWorker.layer(spawn))),
  );

  return {
    loadStore(definition, source) {
      return Effect.runPromise(worker.executeEffect(new LoadStore({ definition, source })));
    },
    collection(storeId) {
      return {
        storeId,
        applyTransaction(transaction) {
          return Effect.runPromise(worker.executeEffect(new ApplyTransaction({ storeId, transaction })));
        },
        openViewportSession(request) {
          const sessionId = request.sessionId ?? createSessionId();
          return {
            sessionId,
            updates: worker.execute(
              new OpenViewportSession({
                sessionId,
                storeId,
                startRow: request.startRow,
                endRow: request.endRow,
                query: request.query,
              }),
            ),
            replace(nextRequest) {
              return Effect.runPromise(
                worker.executeEffect(
                  new ReplaceViewportSession({
                    sessionId,
                    startRow: nextRequest.startRow,
                    endRow: nextRequest.endRow,
                    query: nextRequest.query,
                  }),
                ),
              );
            },
            close() {
              return Effect.runPromise(
                worker.executeEffect(new CloseViewportSession({ sessionId })),
              );
            },
          } as SqliteViewportSessionHandle<TRow>;
        },
        setStressRate(rowsPerSecond) {
          return Effect.runPromise(worker.executeEffect(new SetStressRate({ storeId, rowsPerSecond })));
        },
        dispose() {
          return Effect.runPromise(worker.executeEffect(new DisposeStore({ storeId })));
        },
      } as SqliteCollectionHandle<TRow>;
    },
    close() {
      return Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
    },
  };
}
