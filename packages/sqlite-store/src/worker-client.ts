import * as BrowserWorker from "@effect/platform-browser/BrowserWorker";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as ServiceMap from "effect/ServiceMap";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import type { SqliteRow } from "./store-config";
import {
  type CloseViewportChannelSuccess,
  type SetViewportIntentSuccess,
  type ViewportIntent,
  type ViewportPatch,
  ViewportChannelRpcs,
} from "./worker-contract";

export interface SqliteViewportChannelHandle<
  TRow extends SqliteRow = SqliteRow,
> {
  readonly connectionId: string;
  readonly updates: Stream.Stream<ViewportPatch<TRow>, RpcClientError>;
  setIntent(intent: ViewportIntent): Promise<SetViewportIntentSuccess>;
  close(): Promise<CloseViewportChannelSuccess>;
}

export interface ReadOnlySqliteWorkerClient<
  TRow extends SqliteRow = SqliteRow,
> {
  readonly storeId: string;
  openViewportChannel(options: {
    initialIntent: ViewportIntent;
    throttleMs: number;
    connectionId?: string;
  }): SqliteViewportChannelHandle<TRow>;
  close(): Promise<void>;
}

class SqliteViewportRpcClient extends ServiceMap.Service<
  SqliteViewportRpcClient,
  RpcClient.RpcClient<
    RpcGroup.Rpcs<typeof ViewportChannelRpcs>,
    RpcClientError
  >
>()("@sandbox/sqlite-store/SqliteViewportRpcClient") {
  static layer = Layer.effect(
    SqliteViewportRpcClient,
    RpcClient.make(ViewportChannelRpcs),
  );
}

function createConnectionId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `sqlite-viewport-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function createReadOnlySqliteWorkerClient<
  TRow extends SqliteRow = SqliteRow,
>(
  spawn: (id: number) => globalThis.Worker | globalThis.SharedWorker | MessagePort,
  options: {
    storeId: string;
  },
): Promise<ReadOnlySqliteWorkerClient<TRow>> {
  const runtime = ManagedRuntime.make(
    SqliteViewportRpcClient.layer.pipe(
      // Keep one lane free for unary control calls while the viewport stream stays open.
      Layer.provide(RpcClient.layerProtocolWorker({ size: 2 })),
      Layer.provide(BrowserWorker.layer(spawn)),
      Layer.merge(
        Layer.succeed(RpcServer.Protocol)({
          supportsAck: true,
        } as never),
      ),
    ),
  );

  const connectChannel = (rpcOptions: {
    connectionId: string;
    intent: ViewportIntent;
    throttleMs: number;
  }) =>
    SqliteViewportRpcClient.use((rpcClient) =>
      Effect.succeed(rpcClient.ConnectViewportChannel(rpcOptions)),
    ) as unknown as Effect.Effect<
      Stream.Stream<ViewportPatch<TRow>, RpcClientError>,
      RpcClientError | string,
      never
    >;

  const setViewportIntent = (rpcOptions: {
    connectionId: string;
    intent: ViewportIntent;
  }) =>
    SqliteViewportRpcClient.use((rpcClient) =>
      rpcClient.SetViewportIntent(rpcOptions),
    ) as unknown as Effect.Effect<
      SetViewportIntentSuccess,
      RpcClientError | string,
      never
    >;

  const closeViewportChannel = (rpcOptions: { connectionId: string }) =>
    SqliteViewportRpcClient.use((rpcClient) =>
      rpcClient.CloseViewportChannel(rpcOptions),
    ) as unknown as Effect.Effect<
      CloseViewportChannelSuccess,
      RpcClientError | string,
      never
    >;

  return {
    storeId: options.storeId,
    openViewportChannel(channelOptions) {
      const connectionId = channelOptions.connectionId ?? createConnectionId();

      return {
        connectionId,
        updates: Stream.unwrap(
          Effect.promise(() =>
            runtime.runPromise(
              connectChannel({
                connectionId,
                intent: channelOptions.initialIntent,
                throttleMs: channelOptions.throttleMs,
              }),
            )
          ),
        ) as Stream.Stream<ViewportPatch<TRow>, RpcClientError>,
        setIntent(intent) {
          return runtime.runPromise(
            setViewportIntent({
              connectionId,
              intent,
            }),
          );
        },
        close() {
          return runtime.runPromise(
            closeViewportChannel({
              connectionId,
            }),
          );
        },
      };
    },
    close() {
      return runtime.dispose();
    },
  };
}
