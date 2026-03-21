import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as ServiceMap from "effect/ServiceMap";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlError from "effect/unstable/sql/SqlError";

import { DemoWriteService } from "./demo-write-service";

function getStressBatchSize(rowsPerSecond: number) {
  return Math.max(1, Math.round((rowsPerSecond * 100) / 1000));
}

function getStressIntervalMs(rowsPerSecond: number) {
  const batchSize = getStressBatchSize(rowsPerSecond);
  return Math.max(16, Math.round((1000 * batchSize) / Math.max(rowsPerSecond, 1)));
}

export class DemoControlService extends ServiceMap.Service<
  DemoControlService,
  {
    readonly pushLiveUpdate: Effect.Effect<void, SqlError.SqlError>;
    readonly setStressRate: (rowsPerSecond: number) => Effect.Effect<void, SqlError.SqlError>;
  }
>()("@apps/demo/DemoControlService") {
  static readonly layer = Layer.effect(
    DemoControlService,
    Effect.gen(function* () {
      const writes = yield* DemoWriteService;
      const stressRateRef = yield* SubscriptionRef.make(0);

      const writeStressBatch = Effect.fn("DemoControlService.writeStressBatch")(
        function* (rowsPerSecond: number) {
          yield* writes.writeStressBatch(rowsPerSecond);
        },
      );

      const setStressRate = Effect.fn("DemoControlService.setStressRate")(
        function* (rowsPerSecond: number) {
          yield* SubscriptionRef.set(stressRateRef, rowsPerSecond);
        },
      );

      const runStressLoop = SubscriptionRef.changes(stressRateRef).pipe(
        Stream.changes,
        Stream.switchMap((rowsPerSecond) => {
          if (rowsPerSecond <= 0) {
            return Stream.empty;
          }

          return Stream.fromEffectSchedule(
            writeStressBatch(rowsPerSecond),
            Schedule.spaced(Duration.millis(getStressIntervalMs(rowsPerSecond))),
          );
        }),
        Stream.runDrain,
      );

      yield* Effect.forkScoped(runStressLoop);

      return {
        pushLiveUpdate: writes.pushLiveUpdate,
        setStressRate,
      };
    }),
  );
}
