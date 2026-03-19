import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Match from "effect/Match";
import * as Queue from "effect/Queue";
import * as Runtime from "effect/Runtime";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as ScopedRef from "effect/ScopedRef";
import { Stream } from "effect";

import type { GridQueryState } from "@sandbox/ag-grid-translator";
import type {
  CloseViewportSessionSuccess,
  DisposeStoreSuccess,
  OpenViewportSessionRequest,
  ReplaceViewportSessionRequest,
  ReplaceViewportSessionSuccess,
  SsrmBlockResponse,
  StoreDefinition,
  StoreSource,
  StoreTransaction,
  StressState,
  ViewportPatch,
} from "./worker-contract";
import { createDemoRowFactory, generateDemoRows } from "./demo-data";
import {
  collectWindowRows,
  createQueryCollection,
  createRowCountCollection,
  createRowCollection,
  executeGridQuery,
  type RowRecord,
} from "./query-runtime";
const DEFAULT_STRESS_TICK_MS = 100;

interface StoreEntry {
  definition: StoreDefinition;
  collection: ReturnType<typeof createRowCollection>;
  makeStressRow: () => RowRecord;
  rowsPerSecond: number;
  stressFiber: Fiber.RuntimeFiber<void, unknown> | null;
}

interface ViewportSessionState {
  readonly sessionId: string;
  readonly storeId: string;
  readonly queue: Queue.Queue<ViewportPatch>;
  request: ViewportRequest;
  revision: number;
  closed: boolean;
}

interface ViewportRequest {
  startRow: number;
  endRow: number;
  query: GridQueryState;
}

interface ViewportSessionBinding {
  readonly queryKey: string;
  publish(triggeredAtMs: number | null): Effect.Effect<void>;
}

interface ViewportSessionEntry {
  readonly state: ViewportSessionState;
  readonly scope: Scope.CloseableScope;
  readonly bindingRef: ScopedRef.ScopedRef<ViewportSessionBinding>;
}

export class StoreRegistry {
  private readonly stores = new Map<string, StoreEntry>();
  private readonly viewportSessions = new Map<string, ViewportSessionEntry>();

  loadStore(definition: StoreDefinition, source: StoreSource) {
    const rows = Match.value(source).pipe(
      Match.withReturnType<ReadonlyArray<RowRecord>>(),
      Match.when({ kind: "rows" }, ({ rows }) => rows),
      Match.when({ kind: "generator" }, ({ rowCount, seed }) =>
        generateDemoRows(rowCount, seed ?? 1),
      ),
      Match.exhaustive,
    );
    const seed = Match.value(source).pipe(
      Match.withReturnType<number>(),
      Match.when({ kind: "rows" }, () => 1),
      Match.when({ kind: "generator" }, ({ seed }) => seed ?? 1),
      Match.exhaustive,
    );

    const previous = this.stores.get(definition.storeId);
    if (previous?.stressFiber) {
      void Effect.runPromise(Fiber.interrupt(previous.stressFiber));
    }

    const collection = createRowCollection({
      id: definition.storeId,
      getKey: (row) => String(row[definition.rowKey] ?? row.id),
      rows,
    });

    this.stores.set(definition.storeId, {
      definition,
      collection,
      makeStressRow: createDemoRowFactory(seed + rows.length, rows.length, {
        realtimeTimestamps: true,
      }),
      rowsPerSecond: 0,
      stressFiber: null,
    });

    return {
      storeId: definition.storeId,
      rowCount: collection.size,
      metrics: collection.utils.getMetrics(),
    };
  }

  async getRows(
    storeId: string,
    query: GridQueryState,
    range: {
      startRow: number;
      endRow: number;
    },
  ): Promise<SsrmBlockResponse> {
    const entry = this.requireStore(storeId);
    const snapshot = await executeGridQuery(entry.collection, query, {
      startRow: range.startRow,
      endRow: range.endRow,
    });

    return {
      storeId,
      startRow: range.startRow,
      endRow: range.endRow,
      rowCount: snapshot.rowCount,
      metrics: entry.collection.utils.getMetrics(),
      rows: snapshot.rows as unknown as ReadonlyArray<RowRecord>,
    };
  }

  applyTransaction(storeId: string, transaction: StoreTransaction) {
    const entry = this.requireStore(storeId);
    entry.collection.utils.writeBatch(() => {
      Match.value(transaction).pipe(
        Match.when({ kind: "upsert" }, ({ rows }) => {
          entry.collection.utils.writeUpsert(rows);
        }),
        Match.when({ kind: "delete" }, ({ ids }) => {
          entry.collection.utils.writeDelete(ids);
        }),
        Match.exhaustive,
      );
    });

    return {
      storeId,
      rowCount: entry.collection.size,
      metrics: entry.collection.utils.getMetrics(),
    };
  }

  setStressRate(storeId: string, rowsPerSecond: number): StressState {
    const entry = this.requireStore(storeId);
    this.stopStress(entry);
    entry.rowsPerSecond = Math.max(0, Math.round(rowsPerSecond));

    if (entry.rowsPerSecond > 0) {
      entry.stressFiber = Effect.runFork(
        Stream.runForEach(
          Stream.repeatEffect(
            Effect.sync(() =>
              this.applyTransaction(storeId, {
                kind: "upsert",
                rows: this.makeStressBatch(entry),
              }),
            ),
          ).pipe(
            Stream.schedule(
              Schedule.spaced(Duration.millis(this.getStressIntervalMs(entry.rowsPerSecond))),
            ),
          ),
          () => Effect.void,
        ),
      );
    }

    return {
      storeId,
      rowsPerSecond: entry.rowsPerSecond,
      running: entry.rowsPerSecond > 0,
      rowCount: entry.collection.size,
      metrics: entry.collection.utils.getMetrics(),
    };
  }

  openViewportSession(request: OpenViewportSessionRequest) {
    return Stream.unwrapScoped(
      Effect.acquireRelease(
        this.makeViewportSession(request),
        (session) => this.closeViewportSession(session.state.sessionId),
      ).pipe(Effect.map((session) => Stream.fromQueue(session.state.queue))),
    );
  }

  replaceViewportSession(
    request: ReplaceViewportSessionRequest,
  ): Effect.Effect<ReplaceViewportSessionSuccess, string> {
    const self = this;
    return Effect.gen(function* () {
      const session = yield* Effect.try({
        try: () => self.requireViewportSession(request.sessionId),
        catch: (error) =>
          error instanceof Error ? error.message : "Unknown viewport session",
      });
      session.state.request = {
        startRow: request.startRow,
        endRow: request.endRow,
        query: request.query,
      };

      const binding = yield* ScopedRef.get(session.bindingRef);
      if (binding.queryKey === self.toQueryKey(request.query)) {
        yield* binding.publish(null);
      } else {
        session.state.revision += 1;
        yield* ScopedRef.set(
          session.bindingRef,
          self.makeViewportBinding(session.state, request.query),
        );
      }

      return {
        sessionId: request.sessionId,
        replaced: true,
      };
    });
  }

  closeViewportSession(
    sessionId: string,
  ): Effect.Effect<CloseViewportSessionSuccess> {
    const self = this;
    return Effect.gen(function* () {
      const session = self.viewportSessions.get(sessionId);
      if (!session) {
        return {
          sessionId,
          closed: true,
        };
      }

      session.state.closed = true;
      self.viewportSessions.delete(sessionId);
      yield* Scope.close(session.scope, Exit.void);
      yield* Queue.shutdown(session.state.queue);

      return {
        sessionId,
        closed: true,
      };
    });
  }

  disposeStore(storeId: string): DisposeStoreSuccess {
    const entry = this.stores.get(storeId);
    if (entry) {
      this.stopStress(entry);
    }
    this.stores.delete(storeId);
    for (const [sessionId, session] of this.viewportSessions.entries()) {
      if (session.state.storeId === storeId) {
        void Effect.runPromise(this.closeViewportSession(sessionId));
      }
    }
    return {
      storeId,
      disposed: true,
    };
  }

  private makeStressBatch(entry: StoreEntry) {
    const batchSize = this.getStressBatchSize(entry.rowsPerSecond);
    return Array.from({ length: batchSize }, () => entry.makeStressRow());
  }

  private getStressBatchSize(rowsPerSecond: number) {
    return Math.max(1, Math.round((rowsPerSecond * DEFAULT_STRESS_TICK_MS) / 1000));
  }

  private getStressIntervalMs(rowsPerSecond: number) {
    const batchSize = this.getStressBatchSize(rowsPerSecond);
    return Math.max(
      16,
      Math.round((1000 * batchSize) / Math.max(rowsPerSecond, 1)),
    );
  }

  private stopStress(entry: StoreEntry) {
    if (entry.stressFiber === null) {
      return;
    }

    const fiber = entry.stressFiber;
    entry.stressFiber = null;
    void Effect.runPromise(Fiber.interrupt(fiber));
  }

  private makeViewportSession(
    request: OpenViewportSessionRequest,
  ): Effect.Effect<ViewportSessionEntry, string, Scope.Scope> {
    const self = this;
    return Effect.gen(function* () {
      if (self.viewportSessions.has(request.sessionId)) {
        yield* Effect.fail(`Viewport session already exists: ${request.sessionId}`);
      }

      yield* Effect.try({
        try: () => self.requireStore(request.storeId),
        catch: (error) =>
          error instanceof Error ? error.message : "Unknown store",
      });

      const queue = yield* Queue.unbounded<ViewportPatch>();
      const scope = yield* Scope.make();
      const state: ViewportSessionState = {
        sessionId: request.sessionId,
        storeId: request.storeId,
        queue,
        request: {
          startRow: request.startRow,
          endRow: request.endRow,
          query: request.query,
        },
        revision: 1,
        closed: false,
      };
      const bindingRef = yield* Scope.extend(
        ScopedRef.fromAcquire(
          self.makeViewportBinding(state, request.query),
        ),
        scope,
      );

      const session: ViewportSessionEntry = {
        state,
        scope,
        bindingRef,
      };
      self.viewportSessions.set(request.sessionId, session);
      return session;
    });
  }

  private makeViewportBinding(
    session: ViewportSessionState,
    query: GridQueryState,
  ): Effect.Effect<ViewportSessionBinding, string, Scope.Scope> {
    const revision = session.revision;
    const store = this.requireStore(session.storeId);
    const rowCountCollection = createRowCountCollection(store.collection, query);
    const queryCollection = createQueryCollection(store.collection, query);
    const queryKey = this.toQueryKey(query);

    return Effect.gen(this, function* () {
      const runtime = (yield* Effect.withFiberRuntime((fiber, status) =>
        Effect.succeed(
          Runtime.make({
            context: fiber.currentDefaultServices,
            runtimeFlags: status.runtimeFlags,
            fiberRefs: fiber.getFiberRefs(),
          }),
        ),
      )) as Runtime.Runtime<any>;
      return yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            await Promise.all([
              rowCountCollection.preload(),
              queryCollection.preload(),
            ]);

            let publishScheduled = false;
            let scheduledPatchAtMs: number | null = null;
            const publish = (triggeredAtMs: number | null) =>
              this.publishViewportPatch(
                runtime,
                session,
                revision,
                rowCountCollection,
                queryCollection,
                triggeredAtMs,
              );
            const schedulePublish = () => {
              if (publishScheduled) {
                return;
              }

              publishScheduled = true;
              scheduledPatchAtMs = Runtime.runSync(runtime, Clock.currentTimeMillis);
              queueMicrotask(() => {
                publishScheduled = false;
                const triggeredAtMs = scheduledPatchAtMs;
                scheduledPatchAtMs = null;
                void Runtime.runPromise(
                  runtime,
                  publish(triggeredAtMs),
                );
              });
            };

            await Runtime.runPromise(
              runtime,
              publish(null),
            );
            const rowCountSubscription = rowCountCollection.subscribeChanges(schedulePublish);
            const querySubscription = queryCollection.subscribeChanges(schedulePublish);

            return {
              queryKey,
              rowCountSubscription,
              querySubscription,
              publish,
            };
          },
          catch: (error) =>
            error instanceof Error ? error.message : "Failed to preload viewport session",
        }),
        ({ rowCountSubscription, querySubscription }) =>
          Effect.sync(() => {
            rowCountSubscription.unsubscribe();
            querySubscription.unsubscribe();
          }),
      ).pipe(
        Effect.map(({ queryKey, publish }) => ({
          queryKey,
          publish,
        })),
      );
    });
  }

  private publishViewportPatch(
    runtime: Runtime.Runtime<any>,
    session: ViewportSessionState,
    revision: number,
    rowCountCollection: ReturnType<typeof createQueryCollection>,
    queryCollection: ReturnType<typeof createQueryCollection>,
    triggeredAtMs: number | null,
  ) {
    if (session.closed || revision !== session.revision || !session.queue.isActive()) {
      return Effect.void;
    }

    const request = session.request;
    return Effect.sync(() => Runtime.runSync(runtime, Clock.currentTimeMillis)).pipe(
      Effect.flatMap((emittedAtMs) =>
        Queue.offer(session.queue, {
          storeId: session.storeId,
          startRow: request.startRow,
          endRow: request.endRow,
          rowCount: rowCountCollection.size,
          latencyMs: triggeredAtMs === null ? 0 : Math.max(0, emittedAtMs - triggeredAtMs),
          metrics: this.requireStore(session.storeId).collection.utils.getMetrics(),
          rows: collectWindowRows(queryCollection, request) as unknown as ReadonlyArray<RowRecord>,
        }).pipe(
          Effect.catchAll(() => Effect.void),
        )),
    );
  }

  private toQueryKey(query: GridQueryState) {
    return JSON.stringify(query);
  }

  private requireStore(storeId: string): StoreEntry {
    const entry = this.stores.get(storeId);
    if (!entry) {
      throw new Error(`Unknown store: ${storeId}`);
    }
    return entry;
  }

  private requireViewportSession(sessionId: string): ViewportSessionEntry {
    const session = this.viewportSessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown viewport session: ${sessionId}`);
    }
    return session;
  }
}
