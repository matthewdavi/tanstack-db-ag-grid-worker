import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as SqliteClient from "@effect/sql-sqlite-wasm/SqliteClient";

import {
  CloseViewportChannel,
  ConnectViewportChannel,
  layerSqliteViewportChannelService,
  SetViewportIntent,
  SqliteViewportChannelService,
} from "@sandbox/sqlite-store";

import {
  SQLITE_STORE_ID,
} from "./demo-constants";
import { PushLiveUpdate, SetStressRate } from "./demo-control-rpc";
import { DemoControlService } from "./demo-control-service";
import { DemoWriteService } from "./demo-write-service";
import { marketGrid } from "./market-sqlite-store";

const WorkerRpcs = RpcGroup.make(
  ConnectViewportChannel,
  SetViewportIntent,
  CloseViewportChannel,
  PushLiveUpdate,
  SetStressRate,
);

const sqliteLayer = SqliteClient.layerMemory({});

const queryRuntimeLayer = layerSqliteViewportChannelService(marketGrid.store, {
  storeId: SQLITE_STORE_ID,
}).pipe(
  Layer.provideMerge(sqliteLayer),
);

const demoWriteLayer = DemoWriteService.layer.pipe(
  Layer.provideMerge(queryRuntimeLayer),
);

const demoControlRuntimeLayer = DemoControlService.layer.pipe(
  Layer.provideMerge(demoWriteLayer),
);

const workerRpcLive = WorkerRpcs.toLayer(
  Effect.gen(function* () {
    const queryService = yield* SqliteViewportChannelService;
    const demoControls = yield* DemoControlService;

    return WorkerRpcs.of({
      ConnectViewportChannel: (request) =>
        queryService.connect(
          request.connectionId,
          request.intent,
          { throttleMs: request.throttleMs },
        ),
      SetViewportIntent: (request) =>
        queryService.setIntent(request.connectionId, request.intent),
      CloseViewportChannel: (request) =>
        queryService.close(request.connectionId),
      PushLiveUpdate: () =>
        demoControls.pushLiveUpdate.pipe(
          Effect.mapError((error) => error.message),
          Effect.as({ applied: true } as const),
        ),
      SetStressRate: (request) =>
        demoControls.setStressRate(request.rowsPerSecond).pipe(
          Effect.mapError((error) => error.message),
          Effect.as({ rowsPerSecond: request.rowsPerSecond }),
        ),
    });
  }),
).pipe(
  Layer.provide(demoControlRuntimeLayer),
);

const workerLayer = RpcServer.layer(WorkerRpcs).pipe(
  Layer.provide(workerRpcLive),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(BrowserWorkerRunner.layer),
);

Effect.runFork(
  // RpcServer.layer still leaks an `unknown` input in the current beta typing here.
  (Layer.launch(workerLayer).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        console.error("[sqlite-worker] boot failed", Cause.pretty(cause));
      })
    ),
  ) as unknown as Effect.Effect<void, never, never>),
);
