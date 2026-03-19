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

  effect("republishes a new viewport slice when only the requested range changes", () =>
    Effect.gen(function* () {
      const registry = new StoreRegistry();
      registry.loadStore(
        {
          storeId: "range-shift",
          rowKey: "id",
        },
        {
          kind: "rows",
          rows: [
            {
              id: "1",
              athlete: "Alpha",
              country: "USA",
              sport: "Swimming",
              year: 2012,
            },
            {
              id: "2",
              athlete: "Bravo",
              country: "Canada",
              sport: "Rowing",
              year: 2016,
            },
            {
              id: "3",
              athlete: "Charlie",
              country: "USA",
              sport: "Gymnastics",
              year: 2020,
            },
            {
              id: "4",
              athlete: "Delta",
              country: "Canada",
              sport: "Cycling",
              year: 2024,
            },
          ] as ReadonlyArray<RowRecord>,
        },
      );

      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const patches = yield* Queue.unbounded<{
            rowCount: number;
            rows: ReadonlyArray<RowRecord>;
          }>();
          yield* Stream.runForEachScoped(
            registry.openViewportSession({
              sessionId: "range-shift-session",
              storeId: "range-shift",
              startRow: 0,
              endRow: 2,
              query: {
                predicate: null,
                sorts: [{ field: "athlete", direction: "asc" }],
              },
            }),
            (patch) => patches.offer(patch),
          ).pipe(Effect.forkScoped);

          const initial = yield* patches.take;
          yield* registry.replaceViewportSession({
            sessionId: "range-shift-session",
            startRow: 1,
            endRow: 3,
            query: {
              predicate: null,
              sorts: [{ field: "athlete", direction: "asc" }],
            },
          });

          const shifted = yield* patches.take;

          return {
            initialIds: initial.rows.map((row) => row.id),
            shiftedIds: shifted.rows.map((row) => row.id),
            rowCount: shifted.rowCount,
          };
        }),
      );

      expect(result.initialIds).toEqual(["1", "2"]);
      expect(result.shiftedIds).toEqual(["2", "3"]);
      expect(result.rowCount).toBe(4);
    }),
  );

  effect("rebuilds the viewport query when filters or sorts change", () =>
    Effect.gen(function* () {
      const registry = new StoreRegistry();
      registry.loadStore(
        {
          storeId: "query-shift",
          rowKey: "id",
        },
        {
          kind: "rows",
          rows: [
            {
              id: "1",
              athlete: "Alpha",
              country: "USA",
              sport: "Swimming",
              year: 2012,
            },
            {
              id: "2",
              athlete: "Bravo",
              country: "Canada",
              sport: "Rowing",
              year: 2016,
            },
            {
              id: "3",
              athlete: "Charlie",
              country: "USA",
              sport: "Gymnastics",
              year: 2020,
            },
            {
              id: "4",
              athlete: "Delta",
              country: "Canada",
              sport: "Cycling",
              year: 2024,
            },
          ] as ReadonlyArray<RowRecord>,
        },
      );

      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const patches = yield* Queue.unbounded<{
            rowCount: number;
            rows: ReadonlyArray<RowRecord>;
          }>();
          yield* Stream.runForEachScoped(
            registry.openViewportSession({
              sessionId: "query-shift-session",
              storeId: "query-shift",
              startRow: 0,
              endRow: 2,
              query: {
                predicate: null,
                sorts: [{ field: "athlete", direction: "asc" }],
              },
            }),
            (patch) => patches.offer(patch),
          ).pipe(Effect.forkScoped);

          yield* patches.take;
          yield* registry.replaceViewportSession({
            sessionId: "query-shift-session",
            startRow: 0,
            endRow: 2,
            query: {
              predicate: {
                kind: "comparison",
                field: "country",
                filterType: "text",
                operator: "eq",
                value: "Canada",
              },
              sorts: [{ field: "athlete", direction: "desc" }],
            },
          });

          const nextPatch = yield* patches.take;

          return {
            ids: nextPatch.rows.map((row) => row.id),
            rowCount: nextPatch.rowCount,
          };
        }),
      );

      expect(result.ids).toEqual(["4", "2"]);
      expect(result.rowCount).toBe(2);
    }),
  );
});
