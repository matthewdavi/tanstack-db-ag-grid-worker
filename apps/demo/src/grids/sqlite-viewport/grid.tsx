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
  const metrics = useSelector(controller.store, (snapshot) => snapshot.context.metrics);
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
        "The grid asks the SQLite worker for count plus window rows, and write-driven refreshes are coalesced before patching the UI."
      }
      status={"Viewport / SQLite Wasm"}
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
            max={2500}
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
          onClick={controller.onSortChanged}
          type={"button"}
        >
          {"Refresh query snapshot"}
        </button>
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
          statusBar={createRowCountStatusBar("SQLite rows", rowCount, metrics)}
        />
      </div>
    </GridCard>
  );
}
