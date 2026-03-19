import { describe } from "vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/TestClock";
import { effect, expect } from "@effect/vitest";

import { StoreRegistry } from "./store-registry";
import type { RowRecord } from "./query-runtime";

describe("store registry", () => {
  effect("does not accumulate viewport patch latency from request age", () =>
    Effect.gen(function* () {
      const registry = new StoreRegistry();
      registry.loadStore(
        {
          storeId: "clocked",
          rowKey: "id",
        },
        {
          kind: "rows",
          rows: [
            {
              id: "1",
              athlete: "A",
              country: "USA",
              sport: "Swimming",
              year: 2012,
            },
          ] as ReadonlyArray<RowRecord>,
        },
      );

      const patch = yield* Effect.scoped(
        Effect.gen(function* () {
          const patches = yield* Queue.unbounded<{ latencyMs: number }>();
          yield* Stream.runForEachScoped(
            registry.openViewportSession({
              sessionId: "clocked-session",
              storeId: "clocked",
              startRow: 0,
              endRow: 5,
              query: {
                predicate: null,
                sorts: [],
              },
            }),
            (nextPatch) => patches.offer(nextPatch),
          ).pipe(Effect.forkScoped);

          yield* patches.take;

          yield* TestClock.setTime(25);
          registry.applyTransaction("clocked", {
            kind: "upsert",
            rows: [
              {
                id: "2",
                athlete: "B",
                country: "USA",
                sport: "Swimming",
                year: 2016,
              },
            ],
          });
          yield* Effect.promise(() => Promise.resolve());

          return (yield* patches.take).latencyMs;
        }),
      );

      expect(patch).toBe(0);
    }),
  );
});
