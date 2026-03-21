import { useSelector } from "@xstate/store-react";
import { ModuleRegistry as AgGridModuleRegistry } from "ag-grid-community";
import {
  AllEnterpriseModule,
  LicenseManager,
} from "ag-grid-enterprise";

import type { WorkerClient } from "@sandbox/worker-store";

import type { DemoSqliteClient } from "./browser-clients";
import { getDemoAppController } from "./app-store";
import { INITIAL_DEMO_ROW_COUNT, STORE_ID } from "./demo-constants";
import { LoadingGridCard } from "./grids/shared/panel";
import { SqliteViewportGrid } from "./grids/sqlite-viewport/grid";
import { TanstackViewportGrid } from "./grids/tanstack-viewport/grid";

const licenseKey = import.meta.env.VITE_AG_GRID_LICENSE_KEY;
if (typeof licenseKey === "string" && licenseKey.length > 0) {
  LicenseManager.setLicenseKey(licenseKey);
}

AgGridModuleRegistry.registerModules([AllEnterpriseModule]);

export interface AppProps {
  client?: WorkerClient;
  sqliteClient?: DemoSqliteClient;
}

const heroCardClass =
  "rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-6 shadow-sm ring-1 ring-white/[0.04] backdrop-blur-md sm:p-8";

const metricsShellClass =
  "grid gap-px overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-800/50 shadow-sm ring-1 ring-white/[0.04]";

const metricCellClass =
  "bg-zinc-900/70 px-5 py-4 transition-colors hover:bg-zinc-900/90";

const errorBannerClass =
  "mb-4 rounded-lg border border-red-500/25 bg-red-950/40 px-4 py-3 text-sm font-medium text-red-200 ring-1 ring-red-500/10";

export function App(props: AppProps) {
  const controller = getDemoAppController({
    client: props.client,
    sqliteClient: props.sqliteClient,
  });
  const tanstackClient = useSelector(
    controller.store,
    (snapshot) => snapshot.context.tanstackClient,
  );
  const sqliteClient = useSelector(
    controller.store,
    (snapshot) => snapshot.context.sqliteClient,
  );
  const tanstackReady = useSelector(
    controller.store,
    (snapshot) => snapshot.context.tanstackReady,
  );
  const tanstackError = useSelector(
    controller.store,
    (snapshot) => snapshot.context.tanstackError,
  );
  const sqliteError = useSelector(
    controller.store,
    (snapshot) => snapshot.context.sqliteError,
  );
  const bootstrapError = useSelector(
    controller.store,
    (snapshot) => snapshot.context.bootstrapError,
  );
  const collection = tanstackClient?.collection(STORE_ID) ?? null;

  return (
    <main
      className={"relative mx-auto w-full max-w-[1280px] px-4 py-10 pb-16 sm:px-6"}
      ref={controller.attachHost}
    >
      <section
        className={
          "mb-8 grid grid-cols-1 gap-5 lg:grid-cols-[1.35fr_1fr] lg:items-stretch"
        }
      >
        <div className={heroCardClass}>
          <p
            className={
              "mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500"
            }
          >
            {"Worker query engines · AG Grid Enterprise"}
          </p>
          <h1
            className={
              "m-0 mb-3 text-3xl font-semibold tracking-tight text-zinc-50 sm:text-4xl"
            }
          >
            {"Two viewport grids, two engines, one comparison."}
          </h1>
          <p className={"m-0 max-w-[52ch] text-sm leading-relaxed text-zinc-400"}>
            {
              "Filters and sorting decode once, then run in the TanStack worker or SQLite Wasm—both on the viewport model."
            }
          </p>
        </div>
        <dl className={metricsShellClass}>
          <div className={metricCellClass}>
            <dt
              className={
                "m-0 mb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500"
              }
            >
              {"Transport"}
            </dt>
            <dd className={"m-0 text-sm font-medium text-zinc-100"}>
              {"Effect serialized worker"}
            </dd>
          </div>
          <div className={metricCellClass}>
            <dt
              className={
                "m-0 mb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500"
              }
            >
              {"Compilers"}
            </dt>
            <dd className={"m-0 text-sm font-medium text-zinc-100"}>
              {"AG Grid → TanStack DB · AG Grid → SQL"}
            </dd>
          </div>
          <div className={metricCellClass}>
            <dt
              className={
                "m-0 mb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500"
              }
            >
              {"Dataset"}
            </dt>
            <dd className={"m-0 text-sm font-medium tabular-nums text-zinc-100"}>
              {`${INITIAL_DEMO_ROW_COUNT.toLocaleString()} synthetic rows`}
            </dd>
          </div>
        </dl>
      </section>

      {tanstackError ? <p className={errorBannerClass}>{tanstackError}</p> : null}
      {sqliteError ? <p className={errorBannerClass}>{sqliteError}</p> : null}
      {bootstrapError ? <p className={errorBannerClass}>{bootstrapError}</p> : null}
      <section className={"flex flex-col gap-5"}>
        {sqliteClient !== null ? (
          <SqliteViewportGrid client={sqliteClient} />
        ) : (
          <LoadingGridCard
            title={"SQLite SQL Viewport"}
            body={
              "The grid asks the SQLite worker for count plus window rows, and write-driven refreshes are coalesced before patching the UI."
            }
            status={"Viewport / SQLite Wasm"}
            message={
              "Starting the SQLite worker store in the background. TanStack panels stay interactive while it catches up."
            }
          />
        )}
        {tanstackReady && collection !== null ? (
          <TanstackViewportGrid collection={collection} />
        ) : (
          <LoadingGridCard
            title={"Viewport Push"}
            body={
              "The grid only owns the visible slice. The TanStack worker keeps the live query hot and streams patches back through the viewport datasource."
            }
            status={"Viewport / TanStack push"}
            message={"Waiting for the TanStack viewport store to finish booting."}
          />
        )}
      </section>
    </main>
  );
}
