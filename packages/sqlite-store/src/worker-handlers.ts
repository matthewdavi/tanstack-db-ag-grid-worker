import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import { SqliteViewportChannelService } from "./store-registry";
import { ViewportChannelRpcs } from "./worker-contract";

export const SqliteViewportRpcLive = ViewportChannelRpcs.toLayer(
  Effect.gen(function* () {
    const service = yield* SqliteViewportChannelService;

    return ViewportChannelRpcs.of({
      ConnectViewportChannel: (request) =>
        service.connect(
          request.connectionId,
          request.intent,
          { throttleMs: request.throttleMs },
        ),
      SetViewportIntent: (request) =>
        service.setIntent(request.connectionId, request.intent),
      CloseViewportChannel: (request) =>
        service.close(request.connectionId),
    });
  }),
);

export const makeSqliteWorkerLayer = () =>
  RpcServer.layer(ViewportChannelRpcs).pipe(
    Layer.provide(SqliteViewportRpcLive),
    Layer.provide(RpcServer.layerProtocolWorkerRunner),
    Layer.provide(BrowserWorkerRunner.layer),
  );
