import { createAtom, createStore } from "@xstate/store";

import type { WorkerClient } from "@sandbox/worker-store";

import {
  INITIAL_DEMO_ROW_COUNT,
  ROW_KEY,
  STORE_ID,
} from "./demo-constants";
import {
  makeBrowserSqliteWorkerClient,
  makeBrowserWorkerClient,
  type DemoSqliteClient,
} from "./browser-clients";

type AppLifecycle = "idle" | "running" | "closed";

interface DemoAppContext {
  lifecycle: AppLifecycle;
  tanstackClient: WorkerClient | null;
  sqliteClient: DemoSqliteClient | null;
  tanstackReady: boolean;
  tanstackError: string | null;
  sqliteError: string | null;
  bootstrapError: string | null;
}

interface DemoAppControllerOptions {
  client?: WorkerClient;
  sqliteClient?: DemoSqliteClient;
}

const createInitialContext = (): DemoAppContext => ({
  lifecycle: "idle",
  tanstackClient: null,
  sqliteClient: null,
  tanstackReady: false,
  tanstackError: null,
  sqliteError: null,
  bootstrapError: null,
});

function toErrorMessage(
  cause: unknown,
  fallback: string,
) {
  return cause instanceof Error ? cause.message : fallback;
}

export function createDemoAppController(
  options: DemoAppControllerOptions = {},
) {
  let ownedTanstackClient: WorkerClient | null = null;
  let ownedSqliteClient: DemoSqliteClient | null = null;

  const applyLifecycle = (
    context: DemoAppContext,
    lifecycle: AppLifecycle,
  ): DemoAppContext => ({
    ...context,
    lifecycle,
  });

  const buildStore = () => createStore({
    context: createInitialContext(),
    on: {
      hostAttached: (context, _event, enqueue) => {
        if (context.lifecycle !== "idle") {
          return context;
        }

        enqueue.effect(() => {
          void bootstrapTanstack();
          void bootstrapSqlite();
        });

        return applyLifecycle(context, "running");
      },
      tanstackClientReady: (context, event: { client: WorkerClient }) => ({
        ...context,
        tanstackClient: event.client,
        tanstackError: null,
        bootstrapError: null,
      }),
      sqliteClientReady: (context, event: { client: DemoSqliteClient }) => ({
        ...context,
        sqliteClient: event.client,
        sqliteError: null,
      }),
      tanstackBootstrapped: (context) => ({
        ...context,
        tanstackReady: true,
        bootstrapError: null,
      }),
      tanstackClientFailed: (context, event: { message: string }) => ({
        ...context,
        tanstackError: event.message,
        tanstackClient: null,
        tanstackReady: false,
      }),
      sqliteClientFailed: (context, event: { message: string }) => ({
        ...context,
        sqliteError: event.message,
        sqliteClient: null,
      }),
      tanstackBootstrapFailed: (context, event: { message: string }) => ({
        ...context,
        bootstrapError: event.message,
        tanstackReady: false,
      }),
      closed: (context, _event, enqueue) => {
        if (context.lifecycle === "closed") {
          return context;
        }

        enqueue.effect(() => {
          void closeOwnedClients();
        });

        return applyLifecycle(context, "closed");
      },
    },
  });

  let store: ReturnType<typeof buildStore>;

  const getLifecycle = () => store.getSnapshot().context.lifecycle;
  const isClosed = () => getLifecycle() === "closed";

  const bootstrapTanstack = async () => {
    try {
      const client = options.client ?? await makeBrowserWorkerClient();
      if (isClosed()) {
        await client.close();
        return;
      }

      if (!options.client) {
        ownedTanstackClient = client;
      }

      store.trigger.tanstackClientReady({ client });
      await client.loadStore(
        {
          storeId: STORE_ID,
          rowKey: ROW_KEY,
        },
        {
          kind: "generator",
          rowCount: INITIAL_DEMO_ROW_COUNT,
          seed: 7,
        },
      );

      if (isClosed()) {
        return;
      }

      store.trigger.tanstackBootstrapped();
    } catch (cause) {
      if (isClosed()) {
        return;
      }

      const message = toErrorMessage(cause, "Failed to start worker client");
      if (options.client === undefined && ownedTanstackClient !== null) {
        await ownedTanstackClient.close();
        ownedTanstackClient = null;
      }

      if (store.getSnapshot().context.tanstackClient === null) {
        store.trigger.tanstackClientFailed({ message });
        return;
      }

      store.trigger.tanstackBootstrapFailed({ message });
    }
  };

  const bootstrapSqlite = async () => {
    try {
      const client = options.sqliteClient ?? await makeBrowserSqliteWorkerClient();
      if (isClosed()) {
        await client.close();
        return;
      }

      if (!options.sqliteClient) {
        ownedSqliteClient = client;
      }

      store.trigger.sqliteClientReady({ client });
    } catch (cause) {
      if (isClosed()) {
        return;
      }

      store.trigger.sqliteClientFailed({
        message: toErrorMessage(cause, "Failed to start SQLite worker client"),
      });
    }
  };

  const closeOwnedClients = async () => {
    const pendingClosures: Array<Promise<unknown>> = [];
    if (ownedTanstackClient !== null) {
      pendingClosures.push(ownedTanstackClient.close());
      ownedTanstackClient = null;
    }
    if (ownedSqliteClient !== null) {
      pendingClosures.push(ownedSqliteClient.close());
      ownedSqliteClient = null;
    }
    await Promise.allSettled(pendingClosures);
  };

  store = buildStore();

  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", () => {
      store.trigger.closed();
    }, { once: true });
  }

  return {
    store,
    attachHost(node: HTMLElement | null) {
      if (node !== null) {
        store.trigger.hostAttached();
      }
    },
  };
}

const browserAppControllerAtom = createAtom<ReturnType<typeof createDemoAppController> | null>(null);
const configuredAppControllerAtom = createAtom<ReturnType<typeof createDemoAppController> | null>(null);

export function getDemoAppController(options: DemoAppControllerOptions = {}) {
  if (options.client || options.sqliteClient) {
    const configuredController = configuredAppControllerAtom.get();
    if (configuredController === null) {
      const controller = createDemoAppController(options);
      configuredAppControllerAtom.set(controller);
      return controller;
    }

    return configuredController;
  }

  const browserController = browserAppControllerAtom.get();
  if (browserController === null) {
    const controller = createDemoAppController();
    browserAppControllerAtom.set(controller);
    return controller;
  }

  return browserController;
}
