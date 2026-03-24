import { useSelector } from "@xstate/store-react";
import { AgGridReact } from "ag-grid-react";

import type { DemoSqliteClient } from "../../browser-clients";
import type { MarketRow } from "../../market-sqlite-store";
import { GridCard, ViewportDiagnosticsRow } from "../shared/panel";
import { createRowCountStatusBar } from "../shared/status-bar";
import {
  viewportGhostButtonClass,
  viewportGridChromeClass,
  viewportPrimaryButtonClass,
  viewportStressControlClass,
} from "../shared/viewport-toolbar-classes";
import { getSqliteViewportGridModel } from "./props";

interface SqliteViewportGridProps {
  client: DemoSqliteClient;
}

export function SqliteViewportGrid(props: SqliteViewportGridProps) {
  const { controller, gridProps } = getSqliteViewportGridModel(props.client);
  const rowCount = useSelector(controller.store, (snapshot) => snapshot.context.rowCount);
  const diagnostics = useSelector(
    controller.store,
    (snapshot) => snapshot.context.diagnostics,
  );
  const rowsPerSecond = useSelector(
    controller.store,
    (snapshot) => snapshot.context.rowsPerSecond,
  );

  return (
    <GridCard
      title={"SQLite SQL Viewport"}
      body={
        "ridiculously fast. sql + viewport live in the worker. ui thread doesn't worry about filtering or sorting. it thinks it's rendering like 50 rows but there are no fewer than 100,000 in there."
      }
      status={"fast / sqlite"}
    >
      <div className={"flex flex-wrap items-center gap-2 px-5 pb-4 pt-1"}>
        <button
          className={viewportPrimaryButtonClass}
          onClick={controller.onPushLiveUpdate}
          type={"button"}
        >
          {"Push live update"}
        </button>
        <label className={viewportStressControlClass}>
          <span className={"text-zinc-400"}>{"Rows per second"}</span>
          <input
            aria-label={"Rows per second"}
            max={25000}
            min={0}
            onInput={(event) => {
              controller.onStressRateInput(event.currentTarget.value);
            }}
            step={10}
            type={"range"}
            value={rowsPerSecond}
            className={"w-full accent-indigo-500"}
          />
          <strong className={"tabular-nums text-zinc-200"}>{rowsPerSecond}</strong>
        </label>
        <button
          className={viewportGhostButtonClass}
          onClick={controller.onStopStressStream}
          type={"button"}
        >
          {"Stop stress stream"}
        </button>
      </div>
      <ViewportDiagnosticsRow diagnostics={diagnostics} />
      <div className={viewportGridChromeClass}>
        <AgGridReact<MarketRow>
          {...gridProps}
          statusBar={createRowCountStatusBar("SQLite rows", rowCount)}
        />
      </div>
    </GridCard>
  );
}
