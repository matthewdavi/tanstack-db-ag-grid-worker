import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Match from "effect/Match";
import * as Queue from "effect/Queue";
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
  createQueryCollection,
  createRowCollection,
  executeGridQuery,
  type RowRecord,
} from "./query-runtime";

const DEFAULT_COMMIT_DEBOUNCE_MS = 100;
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
  revision: number;
  closed: boolean;
}

interface ViewportSessionBinding {
  readonly request: {
    startRow: number;
    endRow: number;
    query: GridQueryState;
  };
}

interface ViewportSessionEntry {
  readonly state: ViewportSessionState;
  readonly scope: Scope.CloseableScope;
  readonly bindingRef: ScopedRef.ScopedRef<ViewportSessionBinding>;
}

export interface StoreRegistryOptions {
  commitDebounceMs?: number;
}

export class StoreRegistry {
  private readonly stores = new Map<string, StoreEntry>();
  private readonly viewportSessions = new Map<string, ViewportSessionEntry>();
  private readonly commitDebounceMs: number;

  constructor(options: StoreRegistryOptions = {}) {
    this.commitDebounceMs = options.commitDebounceMs ?? DEFAULT_COMMIT_DEBOUNCE_MS;
  }

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
      commitDebounceMs: this.commitDebounceMs,
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
      offset: range.startRow,
      limit: Math.max(0, range.endRow - range.startRow),
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
    entry.collection.utils.writeChanges(this.toChangeMessages(entry, transaction));

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
      session.state.revision += 1;

      yield* ScopedRef.set(
        session.bindingRef,
        self.makeViewportBinding(session.state, {
          startRow: request.startRow,
          endRow: request.endRow,
          query: request.query,
        }),
      );

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
        revision: 1,
        closed: false,
      };
      const bindingRef = yield* Scope.extend(
        ScopedRef.fromAcquire(
          self.makeViewportBinding(state, {
            startRow: request.startRow,
            endRow: request.endRow,
            query: request.query,
          }),
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
    request: ViewportSessionBinding["request"],
  ): Effect.Effect<ViewportSessionBinding, string, Scope.Scope> {
    const revision = session.revision;
    const store = this.requireStore(session.storeId);
    const rowCountCollection = createQueryCollection(store.collection, request.query);
    const windowCollection = createQueryCollection(store.collection, request.query, {
      offset: request.startRow,
      limit: Math.max(0, request.endRow - request.startRow),
    });

    return Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          await Promise.all([
            rowCountCollection.preload(),
            windowCollection.preload(),
          ]);

          let publishScheduled = false;
          const schedulePublish = () => {
            if (publishScheduled) {
              return;
            }

            publishScheduled = true;
            queueMicrotask(() => {
              publishScheduled = false;
              void Effect.runPromise(
                this.publishViewportPatch(
                  session,
                  revision,
                  request,
                  rowCountCollection,
                  windowCollection,
                ),
              );
            });
          };

          await Effect.runPromise(
            this.publishViewportPatch(
              session,
              revision,
              request,
              rowCountCollection,
              windowCollection,
            ),
          );
          const rowCountSubscription = rowCountCollection.subscribeChanges(schedulePublish);
          const windowSubscription = windowCollection.subscribeChanges(schedulePublish);

          return {
            request,
            rowCountSubscription,
            windowSubscription,
          };
        },
        catch: (error) =>
          error instanceof Error ? error.message : "Failed to preload viewport session",
      }),
      ({ rowCountSubscription, windowSubscription }) =>
        Effect.sync(() => {
          rowCountSubscription.unsubscribe();
          windowSubscription.unsubscribe();
        }),
    ).pipe(
      Effect.map(({ request }) => ({
        request,
      })),
    );
  }

  private publishViewportPatch(
    session: ViewportSessionState,
    revision: number,
    request: ViewportSessionBinding["request"],
    rowCountCollection: ReturnType<typeof createQueryCollection>,
    windowCollection: ReturnType<typeof createQueryCollection>,
  ) {
    if (session.closed || revision !== session.revision || !session.queue.isActive()) {
      return Effect.void;
    }

    return Queue.offer(session.queue, {
      storeId: session.storeId,
      startRow: request.startRow,
      endRow: request.endRow,
      rowCount: rowCountCollection.size,
      metrics: this.requireStore(session.storeId).collection.utils.getMetrics(),
      rows: windowCollection.toArray as unknown as ReadonlyArray<RowRecord>,
    }).pipe(
      Effect.asVoid,
      Effect.catchAll(() => Effect.void),
    );
  }

  private toChangeMessages(entry: StoreEntry, transaction: StoreTransaction) {
    return Match.value(transaction).pipe(
      Match.withReturnType<
        Array<
          | {
              type: "delete";
              key: string;
            }
          | {
              type: "insert" | "update";
              value: RowRecord;
            }
        >
      >(),
      Match.when({ kind: "upsert" }, ({ rows }) =>
        rows.map((row) => {
          const key = String(row[entry.definition.rowKey] ?? row.id);
          return entry.collection.has(key)
            ? {
                type: "update" as const,
                value: row,
              }
            : {
                type: "insert" as const,
                value: row,
              };
        }),
      ),
      Match.when({ kind: "delete" }, ({ ids }) =>
        ids.map((id) => ({
          type: "delete" as const,
          key: id,
        })),
      ),
      Match.exhaustive,
    );
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
