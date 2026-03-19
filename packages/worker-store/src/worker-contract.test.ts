import { describe, expect, it } from "vitest";
import * as Chunk from "effect/Chunk";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as BrowserWorker from "@effect/platform-browser/BrowserWorker";
import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import * as Worker from "@effect/platform/Worker";

import { makeWorkerLayer } from "./worker-handlers";
import {
  ApplyTransaction,
  CloseViewportSession,
  GetRows,
  LoadStore,
  OpenViewportSession,
  ReplaceViewportSession,
  SetStressRate,
  type WorkerRequest,
} from "./worker-contract";

function makeMessagePortWorker() {
  const runnerFibers: Array<Fiber.RuntimeFiber<void, unknown>> = [];

  const layer = BrowserWorker.layer(() => {
    const channel = new MessageChannel();
    const fiber = Effect.runFork(
      BrowserWorkerRunner.launch(makeWorkerLayer()).pipe(
        Effect.provide(BrowserWorkerRunner.layerMessagePort(channel.port1)),
      ),
    );
    runnerFibers.push(fiber);
    return channel.port2;
  });

  return {
    layer,
    async shutdown() {
      await Effect.runPromise(Fiber.interruptAll(runnerFibers));
    },
  };
}

describe("worker contract", () => {
  it("loads a store and serves SSRM row requests over the worker transport", async () => {
    const harness = makeMessagePortWorker();

    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const worker = yield* Worker.makeSerialized<WorkerRequest>({});
            yield* worker.executeEffect(
              new LoadStore({
                definition: {
                  storeId: "athletes",
                  rowKey: "id",
                },
                source: {
                  kind: "generator",
                  rowCount: 32,
                  seed: 4,
                },
              }),
            );

            return yield* worker.executeEffect(
              new GetRows({
                storeId: "athletes",
                startRow: 0,
                endRow: 10,
                query: {
                  predicate: {
                    kind: "comparison",
                    field: "sector",
                    filterType: "text",
                    operator: "eq",
                    value: "Technology",
                  },
                  sorts: [{ field: "price", direction: "desc" }],
                },
              }),
            );
          }).pipe(Effect.provide(harness.layer)),
        ),
      );

      expect(result.rows.length).toBeLessThanOrEqual(10);
      expect(result.rowCount).toBeGreaterThan(0);
      expect(result.rows.every((row) => row.sector === "Technology")).toBe(true);
    } finally {
      await harness.shutdown();
    }
  });

  it("keeps filtered row ids and row counts in parity between SSRM and viewport sessions on seeded data", async () => {
    const harness = makeMessagePortWorker();

    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const worker = yield* Worker.makeSerialized<WorkerRequest>({});
            const patches = yield* Queue.unbounded<{
              readonly rowCount: number;
              readonly rows: ReadonlyArray<Record<string, unknown> & { id: string }>;
            }>();
            const query = {
              predicate: {
                kind: "comparison" as const,
                field: "sector",
                filterType: "text" as const,
                operator: "eq" as const,
                value: "Technology",
              },
              sorts: [{ field: "updatedAt", direction: "desc" as const }],
            };

            yield* worker.executeEffect(
              new LoadStore({
                definition: {
                  storeId: "parity-seeded",
                  rowKey: "id",
                },
                source: {
                  kind: "generator",
                  rowCount: 4_000,
                  seed: 19,
                },
              }),
            );

            yield* Stream.runForEachScoped(
              worker.execute(
                new OpenViewportSession({
                  sessionId: "parity-session",
                  storeId: "parity-seeded",
                  startRow: 0,
                  endRow: 25,
                  query,
                }),
              ),
              (patch) => patches.offer(patch),
            ).pipe(Effect.forkScoped);

            const viewportPatch = yield* patches.take;
            const ssrmResponse = yield* worker.executeEffect(
              new GetRows({
                storeId: "parity-seeded",
                startRow: 0,
                endRow: 25,
                query,
              }),
            );
            yield* worker.executeEffect(
              new CloseViewportSession({
                sessionId: "parity-session",
              }),
            );

            const remainingPatches = Chunk.toReadonlyArray(yield* patches.takeAll);

            return {
              viewportPatch,
              ssrmResponse,
              remainingPatches,
            };
          }).pipe(Effect.provide(harness.layer)),
        ),
      );

      expect(result.viewportPatch.rowCount).toBe(result.ssrmResponse.rowCount);
      expect(result.viewportPatch.rows.map((row) => row.id)).toEqual(
        result.ssrmResponse.rows.map((row) => row.id),
      );
      expect(result.remainingPatches).toHaveLength(0);
    } finally {
      await harness.shutdown();
    }
  });

  it("streams viewport updates after worker-side transactions", async () => {
    const harness = makeMessagePortWorker();

    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const worker = yield* Worker.makeSerialized<WorkerRequest>({});
            const patches = yield* Queue.unbounded<{
              readonly rowCount: number;
              readonly rows: ReadonlyArray<Record<string, unknown> & { id: string }>;
            }>();

            yield* worker.executeEffect(
              new LoadStore({
                definition: {
                  storeId: "viewport",
                  rowKey: "id",
                },
                source: {
                  kind: "rows",
                  rows: [
                    {
                      id: "1",
                      athlete: "A",
                      country: "USA",
                      sport: "Swimming",
                      age: 20,
                      year: 2008,
                      gold: 1,
                      active: true,
                      createdAt: "2008-08-01",
                    },
                  ],
                },
              }),
            );

            yield* Stream.runForEachScoped(
              worker.execute(
                new OpenViewportSession({
                  sessionId: "viewport-session",
                  storeId: "viewport",
                  startRow: 0,
                  endRow: 5,
                  query: {
                    predicate: null,
                    sorts: [{ field: "athlete", direction: "asc" }],
                  },
                }),
              ),
              (patch) => patches.offer(patch),
            ).pipe(Effect.forkScoped);

            const initialPatch = yield* patches.take;

            yield* worker.executeEffect(
              new ApplyTransaction({
                storeId: "viewport",
                transaction: {
                  kind: "upsert",
                  rows: [
                    {
                      id: "2",
                      athlete: "B",
                      country: "Canada",
                      sport: "Rowing",
                      age: 21,
                      year: 2012,
                      gold: 2,
                      active: true,
                      createdAt: "2012-08-01",
                    },
                  ],
                },
              }),
            );

            const updatedPatch = yield* patches.take;

            return [initialPatch, updatedPatch] as const;
          }).pipe(Effect.provide(harness.layer)),
        ),
      );

      const [initialPatch, updatedPatch] = result;
      expect(initialPatch.rows).toHaveLength(1);
      expect(updatedPatch.rows).toHaveLength(2);
    } finally {
      await harness.shutdown();
    }
  });

  it("replaces the active viewport query session and drops stale subset updates", async () => {
    const harness = makeMessagePortWorker();

    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const worker = yield* Worker.makeSerialized<WorkerRequest>({});
            const patches = yield* Queue.unbounded<{
              readonly rowCount: number;
              readonly rows: ReadonlyArray<Record<string, unknown> & { id: string }>;
            }>();

            yield* worker.executeEffect(
              new LoadStore({
                definition: {
                  storeId: "session-replace",
                  rowKey: "id",
                },
                source: {
                  kind: "rows",
                  rows: [
                    {
                      id: "1",
                      symbol: "AAA",
                      company: "Alpha Holdings",
                      sector: "Technology",
                      venue: "NASDAQ",
                      price: 100,
                      volume: 1_000,
                      updatedAt: "2026-03-08T12:00:00.000Z",
                    },
                    {
                      id: "2",
                      symbol: "BBB",
                      company: "Beta Finance",
                      sector: "Financials",
                      venue: "NYSE",
                      price: 90,
                      volume: 1_500,
                      updatedAt: "2026-03-08T12:00:00.000Z",
                    },
                  ],
                },
              }),
            );

            yield* Stream.runForEachScoped(
              worker.execute(
                new OpenViewportSession({
                  sessionId: "replace-session",
                  storeId: "session-replace",
                  startRow: 0,
                  endRow: 10,
                  query: {
                    predicate: {
                      kind: "comparison",
                      field: "sector",
                      filterType: "text",
                      operator: "eq",
                      value: "Technology",
                    },
                    sorts: [{ field: "updatedAt", direction: "desc" }],
                  },
                }),
              ),
              (patch) => patches.offer(patch),
            ).pipe(Effect.forkScoped);

            const initialPatch = yield* patches.take;

            yield* worker.executeEffect(
              new ReplaceViewportSession({
                sessionId: "replace-session",
                startRow: 0,
                endRow: 10,
                query: {
                  predicate: {
                    kind: "comparison",
                    field: "sector",
                    filterType: "text",
                    operator: "eq",
                    value: "Financials",
                  },
                  sorts: [{ field: "updatedAt", direction: "desc" }],
                },
              }),
            );

            const replacedPatch = yield* patches.take;

            yield* worker.executeEffect(
              new ApplyTransaction({
                storeId: "session-replace",
                transaction: {
                  kind: "upsert",
                  rows: [
                    {
                      id: "3",
                      symbol: "CCC",
                      company: "Gamma Tech",
                      sector: "Technology",
                      venue: "NASDAQ",
                      price: 110,
                      volume: 2_000,
                      updatedAt: new Date().toISOString(),
                    },
                  ],
                },
              }),
            );

            yield* Effect.sleep("50 millis");

            yield* worker.executeEffect(
              new ApplyTransaction({
                storeId: "session-replace",
                transaction: {
                  kind: "upsert",
                  rows: [
                    {
                      id: "4",
                      symbol: "DDD",
                      company: "Delta Finance",
                      sector: "Financials",
                      venue: "NYSE",
                      price: 95,
                      volume: 2_500,
                      updatedAt: new Date().toISOString(),
                    },
                  ],
                },
              }),
            );

            const financePatch = yield* patches.take;
            yield* worker.executeEffect(new CloseViewportSession({ sessionId: "replace-session" }));

            return {
              initialPatch,
              replacedPatch,
              financePatch,
            };
          }).pipe(Effect.provide(harness.layer)),
        ),
      );

      expect(result.initialPatch.rows.map((row) => row.id)).toEqual(["1"]);
      expect(result.replacedPatch.rows.map((row) => row.id)).toEqual(["2"]);
      expect(result.financePatch.rows.map((row) => row.id)).toEqual(["4", "2"]);
      expect(
        result.financePatch.rows.every((row) => row.sector === "Financials"),
      ).toBe(true);
    } finally {
      await harness.shutdown();
    }
  });

  it("can drive a worker-side stress stream that grows the viewport result set", async () => {
    const harness = makeMessagePortWorker();

    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const worker = yield* Worker.makeSerialized<WorkerRequest>({});
            const patches = yield* Queue.unbounded<{
              readonly rowCount: number;
              readonly rows: ReadonlyArray<Record<string, unknown> & { id: string }>;
            }>();

            yield* worker.executeEffect(
              new LoadStore({
                definition: {
                  storeId: "stress",
                  rowKey: "id",
                },
                source: {
                  kind: "rows",
                  rows: [],
                },
              }),
            );

            yield* Stream.runForEachScoped(
              worker.execute(
                new OpenViewportSession({
                  sessionId: "stress-session",
                  storeId: "stress",
                  startRow: 0,
                  endRow: 10,
                  query: {
                    predicate: null,
                    sorts: [{ field: "updatedAt", direction: "desc" }],
                  },
                }),
              ),
              (patch) => patches.offer(patch),
            ).pipe(Effect.forkScoped);

            const initialPatch = yield* patches.take;

            const stressState = yield* worker.executeEffect(
              new SetStressRate({
                storeId: "stress",
                rowsPerSecond: 20,
              }),
            );

            yield* Effect.sleep("250 millis");
            const updatedPatch = yield* patches.take;
            yield* worker.executeEffect(
              new SetStressRate({
                storeId: "stress",
                rowsPerSecond: 0,
              }),
            );
            yield* worker.executeEffect(new CloseViewportSession({ sessionId: "stress-session" }));

            return {
              initialPatch,
              updatedPatch,
              stressState,
            };
          }).pipe(Effect.provide(harness.layer)),
        ),
      );

      expect(result.initialPatch.rows).toHaveLength(0);
      expect(result.stressState.running).toBe(true);
      expect(result.stressState.rowsPerSecond).toBe(20);
      expect(result.updatedPatch.rowCount).toBeGreaterThan(0);
      expect(result.updatedPatch.rows.length).toBeGreaterThan(0);
      expect(typeof result.updatedPatch.rows[0]?.price).toBe("number");
      expect(
        Date.parse(String(result.updatedPatch.rows[0]?.updatedAt)),
      ).toBeGreaterThan(Date.now() - 5_000);
    } finally {
      await harness.shutdown();
    }
  });
});
