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

import {
  CloseViewportChannel,
  ConnectViewportChannel,
  createSqliteViewportDatasource,
  SetViewportIntent,
  type AgGridSqliteClient,
  type CloseViewportChannelSuccess,
  type GridStoreAdapterOptions,
  type SetViewportIntentSuccess,
  type ViewportIntent,
  type ViewportPatch,
} from "@sandbox/sqlite-store";

import { SQLITE_STORE_ID } from "./demo-constants";
import { PushLiveUpdate, SetStressRate } from "./demo-control-rpc";
import { type MarketRow } from "./market-sqlite-store";

export interface DemoSqliteClient extends AgGridSqliteClient<MarketRow> {
  pushLiveUpdate(): void;
  setStressRate(rowsPerSecond: number): void;
}

const DemoWorkerRpcs = RpcGroup.make(
  ConnectViewportChannel,
  SetViewportIntent,
  CloseViewportChannel,
  PushLiveUpdate,
  SetStressRate,
);

class DemoWorkerRpcClient extends ServiceMap.Service<
  DemoWorkerRpcClient,
  RpcClient.RpcClient<
    RpcGroup.Rpcs<typeof DemoWorkerRpcs>,
    RpcClientError
  >
>()("@apps/demo/DemoWorkerRpcClient") {
  static readonly layer = Layer.effect(
    DemoWorkerRpcClient,
    RpcClient.make(DemoWorkerRpcs),
  );
}

function createConnectionId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `sqlite-demo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function makeBrowserSqliteWorkerClient(): Promise<DemoSqliteClient> {
  const worker = new Worker(new URL("./sqlite.worker.ts", import.meta.url), {
    type: "module",
  });
  const spawn = () => worker;
  const runtime = ManagedRuntime.make(
    DemoWorkerRpcClient.layer.pipe(
      Layer.provide(RpcClient.layerProtocolWorker({ size: 3 })),
      Layer.provide(BrowserWorker.layer(spawn)),
      Layer.merge(
        Layer.succeed(RpcServer.Protocol)({
          supportsAck: true,
        } as never),
      ),
    ),
  );

  const connectViewportChannel = (options: {
    connectionId: string;
    intent: ViewportIntent;
    throttleMs: number;
  }) =>
    DemoWorkerRpcClient.use((rpcClient) =>
      Effect.succeed(rpcClient.ConnectViewportChannel(options)),
    ) as unknown as Effect.Effect<
      Stream.Stream<ViewportPatch<MarketRow>, RpcClientError>,
      RpcClientError | string,
      never
    >;

  const setViewportIntent = (options: {
    connectionId: string;
    intent: ViewportIntent;
  }) =>
    DemoWorkerRpcClient.use((rpcClient) =>
      rpcClient.SetViewportIntent(options),
    ) as unknown as Effect.Effect<
      SetViewportIntentSuccess,
      RpcClientError | string,
      never
    >;

  const closeViewportChannel = (options: { connectionId: string }) =>
    DemoWorkerRpcClient.use((rpcClient) =>
      rpcClient.CloseViewportChannel(options),
    ) as unknown as Effect.Effect<
      CloseViewportChannelSuccess,
      RpcClientError | string,
      never
    >;

  const pushLiveUpdate = DemoWorkerRpcClient.use((rpcClient) =>
    rpcClient.PushLiveUpdate({}).pipe(Effect.asVoid),
  ) as unknown as Effect.Effect<void, RpcClientError | string, never>;

  const setStressRate = (rowsPerSecond: number) =>
    DemoWorkerRpcClient.use((rpcClient) =>
      rpcClient.SetStressRate({ rowsPerSecond }).pipe(Effect.asVoid),
    ) as unknown as Effect.Effect<void, RpcClientError | string, never>;

  return {
    storeId: SQLITE_STORE_ID,
    open(options: GridStoreAdapterOptions = {}) {
      return createSqliteViewportDatasource(
        {
          storeId: SQLITE_STORE_ID,
          openViewportChannel(channelOptions) {
            const connectionId = channelOptions.connectionId ?? createConnectionId();

            return {
              connectionId,
              updates: Stream.unwrap(
                Effect.promise(() =>
                  runtime.runPromise(
                    connectViewportChannel({
                      connectionId,
                      intent: channelOptions.initialIntent,
                      throttleMs: channelOptions.throttleMs,
                    }),
                  )
                ),
              ),
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
        },
        options,
      );
    },
    pushLiveUpdate() {
      void runtime.runPromise(pushLiveUpdate);
    },
    setStressRate(rowsPerSecond: number) {
      void runtime.runPromise(setStressRate(rowsPerSecond));
    },
    async close() {
      await runtime.dispose();
      worker.terminate();
    },
  };
}
