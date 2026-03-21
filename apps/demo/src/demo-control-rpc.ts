import * as Effect from "effect/Effect";
import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { DemoControlService } from "./demo-control-service";

const PushLiveUpdateSuccessSchema = Schema.Struct({
  applied: Schema.Literal(true),
});
type PushLiveUpdateSuccess = typeof PushLiveUpdateSuccessSchema.Type;

const SetStressRateSuccessSchema = Schema.Struct({
  rowsPerSecond: Schema.Number,
});
type SetStressRateSuccess = typeof SetStressRateSuccessSchema.Type;

export class PushLiveUpdate extends Rpc.make("PushLiveUpdate", {
  payload: {},
  success: PushLiveUpdateSuccessSchema,
  error: Schema.String,
}) {}

export class SetStressRate extends Rpc.make("SetStressRate", {
  payload: {
    rowsPerSecond: Schema.Number,
  },
  success: SetStressRateSuccessSchema,
  error: Schema.String,
}) {}

export const DemoControlRpcs = RpcGroup.make(
  PushLiveUpdate,
  SetStressRate,
);

export const DemoControlRpcLive = DemoControlRpcs.toLayer(
  Effect.gen(function* () {
    const controls = yield* DemoControlService;

    return DemoControlRpcs.of({
      PushLiveUpdate: () =>
        controls.pushLiveUpdate.pipe(
          Effect.mapError((error) => error.message),
          Effect.as({ applied: true } satisfies PushLiveUpdateSuccess),
        ),
      SetStressRate: (request) =>
        controls.setStressRate(request.rowsPerSecond).pipe(
          Effect.mapError((error) => error.message),
          Effect.as({
            rowsPerSecond: request.rowsPerSecond,
          } satisfies SetStressRateSuccess),
        ),
    });
  }),
);
