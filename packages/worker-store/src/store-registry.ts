import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Match from "effect/Match";
import * as Queue from "effect/Queue";
import * as Runtime from "effect/Runtime";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
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
import {
  makeBootingViewportState,
  makeBuildBindingCommand,
  toViewportQueryKey,
  transitionViewportSession,
  type ViewportBindingHandle,
  type ViewportRequest,
  type ViewportSessionCommand,
  type ViewportSessionEvent,
  type ViewportSessionState,
} from "./viewport-session-machine";

const DEFAULT_STRESS_TICK_MS = 100;

interface StoreEntry {
  definition: StoreDefinition;
  collection: ReturnType<typeof createRowCollection>;
  makeStressRow: () => RowRecord;
  rowsPerSecond: number;
  stressFiber: Fiber.RuntimeFiber<void, unknown> | null;
}

type ViewportReplaceReply = Deferred.Deferred<ReplaceViewportSessionSuccess, string>;
type ViewportCloseReply = Deferred.Deferred<CloseViewportSessionSuccess, never>;

interface ViewportSessionBinding extends ViewportBindingHandle {
  publish(
    request: ViewportRequest,
    triggeredAtMs: number | null,
  ): Effect.Effect<void>;
  close(): Effect.Effect<void>;
}

type ViewportMachineState = ViewportSessionState<
  ViewportReplaceReply,
  ViewportSessionBinding
>;
type ViewportMachineEvent = ViewportSessionEvent<
  ViewportReplaceReply,
  ViewportCloseReply,
  ViewportSessionBinding
>;
type ViewportMachineCommand = ViewportSessionCommand<
  ViewportReplaceReply,
  ViewportCloseReply,
  ViewportSessionBinding
>;

interface ViewportSessionEntry {
  readonly sessionId: string;
  readonly storeId: string;
  readonly queue: Queue.Queue<ViewportPatch>;
  readonly events: Queue.Queue<ViewportMachineEvent>;
  readonly bootReady: Deferred.Deferred<void, string>;
  readonly actorFiber: Fiber.RuntimeFiber<void, never>;
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
        (session) => this.closeViewportSession(session.sessionId),
      ).pipe(Effect.map((session) => Stream.fromQueue(session.queue))),
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
      const reply = yield* Deferred.make<ReplaceViewportSessionSuccess, string>();
      yield* Queue.offer(session.events, {
        _tag: "Replace",
        request: self.toViewportRequest(request),
        reply,
      }).pipe(
        Effect.catchAll(() => Effect.fail("Viewport session closed")),
      );
      return yield* Deferred.await(reply);
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

      const reply = yield* Deferred.make<CloseViewportSessionSuccess>();
      yield* Queue.offer(session.events, {
        _tag: "Close",
        reply,
      }).pipe(Effect.catchAll(() => Effect.void));
      yield* Deferred.await(reply);
      yield* Fiber.await(session.actorFiber).pipe(Effect.ignore);
      self.viewportSessions.delete(sessionId);

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
      if (session.storeId === storeId) {
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
        return yield* Effect.fail(
          `Viewport session already exists: ${request.sessionId}`,
        );
      }

      yield* Effect.try({
        try: () => self.requireStore(request.storeId),
        catch: (error) =>
          error instanceof Error ? error.message : "Unknown store",
      });

      const queue = yield* Queue.unbounded<ViewportPatch>();
      const events = yield* Queue.unbounded<ViewportMachineEvent>();
      const bootReady = yield* Deferred.make<void, string>();
      const sessionBase = {
        sessionId: request.sessionId,
        storeId: request.storeId,
        queue,
        events,
        bootReady,
      };
      const actorFiber = yield* self.runViewportSessionActor(
        sessionBase,
        self.toViewportRequest(request),
      ).pipe(
        Effect.catchAll((error) =>
          Deferred.fail(bootReady, error).pipe(
            Effect.zipRight(Queue.shutdown(queue)),
            Effect.zipRight(Queue.shutdown(events)),
            Effect.asVoid,
          ),
        ),
        Effect.forkScoped,
      );

      const session: ViewportSessionEntry = {
        ...sessionBase,
        actorFiber,
      };
      self.viewportSessions.set(request.sessionId, session);
      yield* Deferred.await(bootReady).pipe(
        Effect.tapError(() => {
          self.viewportSessions.delete(request.sessionId);
          return Fiber.await(actorFiber).pipe(Effect.ignore);
        }),
      );
      return session;
    });
  }

  private runViewportSessionActor(
    session: Pick<ViewportSessionEntry, "sessionId" | "storeId" | "queue" | "events" | "bootReady">,
    request: ViewportRequest,
  ): Effect.Effect<void, string> {
    const initialState = makeBootingViewportState<ViewportReplaceReply>(
      request,
    ) as ViewportMachineState;

    const process = (
      state: ViewportMachineState,
    ): Effect.Effect<void, string> => {
      if (state._tag === "Closed") {
        return Queue.shutdown(session.queue).pipe(
          Effect.zipRight(Queue.shutdown(session.events)),
          Effect.asVoid,
        );
      }

      return Queue.take(session.events).pipe(
        Effect.flatMap((event) => {
          const result = transitionViewportSession(state, event);
          return this.interpretViewportCommands(session, result.commands).pipe(
            Effect.zipRight(
              this.resolveViewportBootTransition(
                session.bootReady,
                state,
                result.state as ViewportMachineState,
                event,
              ),
            ),
            Effect.zipRight(process(result.state as ViewportMachineState)),
          );
        }),
      );
    };

    return this.interpretViewportCommands(session, [
      makeBuildBindingCommand<
        ViewportReplaceReply,
        ViewportCloseReply,
        ViewportSessionBinding
      >(request),
    ]).pipe(
      Effect.zipRight(process(initialState)),
    );
  }

  private resolveViewportBootTransition(
    bootReady: Deferred.Deferred<void, string>,
    previous: ViewportMachineState,
    next: ViewportMachineState,
    event: ViewportMachineEvent,
  ) {
    if (previous._tag !== "Booting" || next._tag === "Booting") {
      return Effect.void;
    }

    if (next._tag === "Live") {
      return Deferred.succeed(bootReady, undefined).pipe(Effect.ignore);
    }

    if (event._tag === "BindingFailed" && event.queryKey === previous.queryKey) {
      return Deferred.fail(bootReady, event.error).pipe(Effect.ignore);
    }

    return Deferred.fail(bootReady, "Viewport session closed").pipe(Effect.ignore);
  }

  private interpretViewportCommands(
    session: Pick<ViewportSessionEntry, "sessionId" | "storeId" | "queue" | "events">,
    commands: ReadonlyArray<ViewportMachineCommand>,
  ): Effect.Effect<void, string> {
    return Effect.forEach(commands, (command) =>
      Match.value(command).pipe(
        Match.when({ _tag: "BuildBinding" }, ({ request }) =>
          Effect.fork(
            this.makeViewportBinding(session, request.query).pipe(
              Effect.flatMap((binding) =>
                Queue.offer(session.events, {
                  _tag: "BindingReady",
                  request,
                  queryKey: binding.queryKey,
                  binding,
                }),
              ),
              Effect.catchAll((error) =>
                Queue.offer(session.events, {
                  _tag: "BindingFailed",
                  queryKey: toViewportQueryKey(request.query),
                  error,
                }).pipe(Effect.catchAll(() => Effect.void)),
              ),
              Effect.asVoid,
            ),
          ).pipe(Effect.asVoid),
        ),
        Match.when({ _tag: "Publish" }, ({ binding, request, triggeredAtMs }) =>
          binding.publish(request, triggeredAtMs),
        ),
        Match.when({ _tag: "CloseBinding" }, ({ binding }) =>
          binding.close().pipe(Effect.catchAll(() => Effect.void)),
        ),
        Match.when({ _tag: "ResolveReplace" }, ({ reply }) =>
          Deferred.succeed(reply, {
            sessionId: session.sessionId,
            replaced: true,
          }).pipe(Effect.asVoid),
        ),
        Match.when({ _tag: "ResolveReplaceMany" }, ({ replies }) =>
          Effect.forEach(replies, (reply) =>
            Deferred.succeed(reply, {
              sessionId: session.sessionId,
              replaced: true,
            }).pipe(Effect.asVoid),
          ).pipe(Effect.asVoid),
        ),
        Match.when({ _tag: "RejectReplace" }, ({ reply, error }) =>
          Deferred.fail(reply, error).pipe(Effect.asVoid),
        ),
        Match.when({ _tag: "RejectReplaceMany" }, ({ replies, error }) =>
          Effect.forEach(replies, (reply) =>
            Deferred.fail(reply, error).pipe(Effect.asVoid),
          ).pipe(Effect.asVoid),
        ),
        Match.when({ _tag: "ResolveClose" }, ({ reply }) =>
          Deferred.succeed(reply, {
            sessionId: session.sessionId,
            closed: true,
          }).pipe(Effect.asVoid),
        ),
        Match.exhaustive,
      ), { concurrency: 1 },
    ).pipe(Effect.asVoid);
  }

  private makeViewportBinding(
    session: Pick<ViewportSessionEntry, "storeId" | "queue" | "events">,
    query: GridQueryState,
  ): Effect.Effect<ViewportSessionBinding, string> {
    const store = this.requireStore(session.storeId);
    const rowCountCollection = createRowCountCollection(store.collection, query);
    const queryCollection = createQueryCollection(store.collection, query);
    const queryKey = toViewportQueryKey(query);

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
      const scope = yield* Scope.make();
      yield* Scope.extend(
        Effect.acquireRelease(
          Effect.tryPromise({
            try: async () => {
              await Promise.all([
                rowCountCollection.preload(),
                queryCollection.preload(),
              ]);

              let publishScheduled = false;
              let scheduledPatchAtMs: number | null = null;
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
                    Queue.offer(session.events, {
                      _tag: "SourceChanged",
                      queryKey,
                      triggeredAtMs,
                    }).pipe(Effect.catchAll(() => Effect.void)),
                  );
                });
              };

              const rowCountSubscription = rowCountCollection.subscribeChanges(schedulePublish);
              const querySubscription = queryCollection.subscribeChanges(schedulePublish);

              return {
                rowCountSubscription,
                querySubscription,
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
        ),
        scope,
      );

      return {
        queryKey,
        publish: (request, triggeredAtMs) =>
          this.publishViewportPatch(
            runtime,
            session.storeId,
            session.queue,
            rowCountCollection,
            queryCollection,
            request,
            triggeredAtMs,
          ),
        close: () => Scope.close(scope, Exit.void),
      };
    });
  }

  private publishViewportPatch(
    runtime: Runtime.Runtime<any>,
    storeId: string,
    queue: Queue.Queue<ViewportPatch>,
    rowCountCollection: ReturnType<typeof createQueryCollection>,
    queryCollection: ReturnType<typeof createQueryCollection>,
    request: ViewportRequest,
    triggeredAtMs: number | null,
  ) {
    if (!queue.isActive()) {
      return Effect.void;
    }

    return Effect.sync(() => Runtime.runSync(runtime, Clock.currentTimeMillis)).pipe(
      Effect.flatMap((emittedAtMs) =>
        Queue.offer(queue, {
          storeId,
          startRow: request.startRow,
          endRow: request.endRow,
          rowCount: rowCountCollection.size,
          latencyMs: triggeredAtMs === null ? 0 : Math.max(0, emittedAtMs - triggeredAtMs),
          metrics: this.requireStore(storeId).collection.utils.getMetrics(),
          rows: collectWindowRows(queryCollection, request) as unknown as ReadonlyArray<RowRecord>,
        }).pipe(
          Effect.catchAll(() => Effect.void),
        )),
    );
  }

  private toViewportRequest(
    request: Pick<OpenViewportSessionRequest, "startRow" | "endRow" | "query">,
  ): ViewportRequest {
    return {
      startRow: request.startRow,
      endRow: request.endRow,
      query: request.query,
    };
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
