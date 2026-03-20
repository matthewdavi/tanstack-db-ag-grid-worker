import * as Effect from "effect/Effect";

import {
  INITIAL_DEMO_ROW_COUNT,
  SQLITE_STORE_ID,
} from "./demo-constants";
import {
  createMarketRowFactory,
  generateMarketRows,
  marketGrid,
} from "./market-sqlite-store";

const runtime = marketGrid.createWorkerRuntime({
  storeId: SQLITE_STORE_ID,
});

type DemoWorkerMessage =
  | { type: "sqlite-demo-push-update" }
  | { type: "sqlite-demo-set-stress-rate"; rowsPerSecond: number };

type DemoControlPortInitMessage = {
  type: "sqlite-demo-init-port";
};

const makeLiveRow = createMarketRowFactory(7, INITIAL_DEMO_ROW_COUNT, {
  realtimeTimestamps: true,
});

function isDemoWorkerMessage(value: unknown): value is DemoWorkerMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.type === "sqlite-demo-push-update") {
    return true;
  }

  return candidate.type === "sqlite-demo-set-stress-rate" &&
    typeof candidate.rowsPerSecond === "number";
}

const bootPromise = runtime.replaceAll(generateMarketRows(INITIAL_DEMO_ROW_COUNT, 7));
let demoPort: MessagePort | null = null;

function handleDemoMessage(message: DemoWorkerMessage) {
  if (message.type === "sqlite-demo-push-update") {
    Effect.runFork(
      Effect.promise(async () => {
        await bootPromise;
        return runtime.upsert([makeLiveRow()]);
      }),
    );
    return;
  }

  Effect.runFork(
    Effect.promise(async () => {
      await bootPromise;
      return runtime.setStressRate(message.rowsPerSecond);
    }),
  );
}

function isDemoControlPortInitMessage(value: unknown): value is DemoControlPortInitMessage {
  return typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).type === "sqlite-demo-init-port";
}

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!isDemoControlPortInitMessage(event.data) || event.ports.length === 0) {
    return;
  }

  demoPort?.close();
  demoPort = event.ports[0] ?? null;
  if (demoPort === null) {
    return;
  }

  demoPort.onmessage = (messageEvent: MessageEvent<unknown>) => {
    if (!isDemoWorkerMessage(messageEvent.data)) {
      return;
    }

    handleDemoMessage(messageEvent.data);
  };
  demoPort.start?.();
});

Effect.runFork(
  Effect.gen(function* () {
    yield* Effect.promise(() => bootPromise);
    yield* runtime.launchBrowserWorker();
  }),
);
