import { useSelector } from "@xstate/store-react";
import { ModuleRegistry as AgGridModuleRegistry } from "ag-grid-community";
import {
  AllEnterpriseModule,
  LicenseManager,
} from "ag-grid-enterprise";

import type { DemoSqliteClient } from "./browser-clients";
import { getDemoAppController } from "./app-store";
import { LoadingGridCard } from "./grids/shared/panel";
import { SqliteViewportGrid } from "./grids/sqlite-viewport/grid";

const licenseKey = import.meta.env.VITE_AG_GRID_LICENSE_KEY;
if (typeof licenseKey === "string" && licenseKey.length > 0) {
  LicenseManager.setLicenseKey(licenseKey);
}

AgGridModuleRegistry.registerModules([AllEnterpriseModule]);

export interface AppProps {
  sqliteClient?: DemoSqliteClient;
}

const heroCardClass =
  "rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-6 shadow-sm ring-1 ring-white/[0.04] backdrop-blur-md sm:p-8";

const errorBannerClass =
  "mb-4 rounded-lg border border-red-500/25 bg-red-950/40 px-4 py-3 text-sm font-medium text-red-200 ring-1 ring-red-500/10";

export function App(props: AppProps) {
  const controller = getDemoAppController({
    sqliteClient: props.sqliteClient,
  });
  const sqliteClient = useSelector(
    controller.store,
    (snapshot) => snapshot.context.sqliteClient,
  );
  const sqliteError = useSelector(
    controller.store,
    (snapshot) => snapshot.context.sqliteError,
  );

  return (
    <main
      className={"relative mx-auto w-full max-w-[1280px] px-4 py-10 pb-16 sm:px-6"}
      ref={controller.attachHost}
    >
      <section className={"mb-8"}>
        <div className={heroCardClass}>
          <p
            className={
              "mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500"
            }
          >
          </p>
          <h1
            className={
              "m-0 mb-3 text-3xl font-semibold tracking-tight text-zinc-50 sm:text-4xl"
            }
          >
            {"this is the fastest grid you've ever seen in your life"}
          </h1>
          <p className={"m-0 max-w-[52ch] text-sm leading-relaxed text-zinc-400"}>
            {
              "25k rows/sec in the worker, main thread stays smooth. you have to be a fool to bet against sqlite"
            }
          </p>
        </div>
      </section>

      {sqliteError ? <p className={errorBannerClass}>{sqliteError}</p> : null}
      <section className={"flex flex-col gap-5"}>
        {sqliteClient !== null ? (
          <SqliteViewportGrid client={sqliteClient} />
        ) : (
          <LoadingGridCard
            title={"SQLite SQL Viewport"}
            body={
              "sqlite woker waking up. gonna be quick dont worry"
            }
            status={"loading lol"}
            message={
              "one sec"
            }
          />
        )}
      </section>
    </main>
  );
}
