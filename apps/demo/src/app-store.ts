import { createAtom, createStore } from "@xstate/store";
import {
  makeBrowserSqliteWorkerClient,
  type DemoSqliteClient,
} from "./browser-clients";

type AppLifecycle = "idle" | "running" | "closed";

interface DemoAppContext {
  lifecycle: AppLifecycle;
  sqliteClient: DemoSqliteClient | null;
  sqliteError: string | null;
}

interface DemoAppControllerOptions {
  sqliteClient?: DemoSqliteClient;
}

const createInitialContext = (): DemoAppContext => ({
  lifecycle: "idle",
  sqliteClient: null,
  sqliteError: null,
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
          void bootstrapSqlite();
        });

        return applyLifecycle(context, "running");
      },
      sqliteClientReady: (context, event: { client: DemoSqliteClient }) => ({
        ...context,
        sqliteClient: event.client,
        sqliteError: null,
      }),
      sqliteClientFailed: (context, event: { message: string }) => ({
        ...context,
        sqliteError: event.message,
        sqliteClient: null,
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
  if (options.sqliteClient) {
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
