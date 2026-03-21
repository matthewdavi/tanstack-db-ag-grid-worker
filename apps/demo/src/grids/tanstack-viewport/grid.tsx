import { useSelector } from "@xstate/store-react";
import { AgGridReact } from "ag-grid-react";

import type { WorkerCollectionHandle } from "@sandbox/worker-store";

import type { MarketRow } from "../../market-sqlite-store";
import { GridCard, ViewportDiagnosticsRow } from "../shared/panel";
import { createRowCountStatusBar } from "../shared/status-bar";
import {
  viewportGhostButtonClass,
  viewportGridChromeClass,
  viewportPrimaryButtonClass,
  viewportStressControlClass,
} from "../shared/viewport-toolbar-classes";
import { getTanstackViewportGridModel } from "./props";

interface TanstackViewportGridProps {
  collection: WorkerCollectionHandle;
}

export function TanstackViewportGrid(props: TanstackViewportGridProps) {
  const { controller, gridProps } = getTanstackViewportGridModel(props.collection);
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
      title={"Viewport Push"}
      body={
        "The grid only owns the visible slice. The TanStack worker keeps the live query hot and streams patches back through the viewport datasource."
      }
      status={"Viewport / TanStack push"}
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
          statusBar={createRowCountStatusBar("TanStack rows", rowCount, metrics)}
        />
      </div>
    </GridCard>
  );
}
