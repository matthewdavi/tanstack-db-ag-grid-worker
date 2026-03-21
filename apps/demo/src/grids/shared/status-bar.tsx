import type { StatusBar } from "ag-grid-community";

import type { WorkerMetrics } from "./types";

interface WorkerRowCountStatusPanelProps {
  label: string;
  rowCount: number;
  commitSummary: string;
}

export function formatCommitSummary(metrics: WorkerMetrics) {
  if (metrics.lastCommitDurationMs === null) {
    return "Awaiting worker commit";
  }

  return `${metrics.lastCommitDurationMs.toFixed(2)} ms / ${metrics.lastCommitChangeCount.toLocaleString()} rows`;
}

export function WorkerRowCountStatusPanel(props: WorkerRowCountStatusPanelProps) {
  return (
    <span
      className={
        "inline-flex items-center gap-2 font-sans text-[13px] text-zinc-300"
      }
    >
      <span className={"font-medium text-zinc-500"}>{props.label}</span>
      <strong className={"font-semibold text-zinc-100"}>
        {props.rowCount.toLocaleString()}
      </strong>
      <span className={"font-medium text-zinc-500"}>Last commit</span>
      <strong className={"font-semibold tabular-nums text-zinc-100"}>
        {props.commitSummary}
      </strong>
    </span>
  );
}

export function createRowCountStatusBar(
  label: string,
  rowCount: number,
  metrics: WorkerMetrics,
): StatusBar {
  return {
    statusPanels: [
      {
        key: "worker-row-count",
        align: "left",
        statusPanel: WorkerRowCountStatusPanel,
        statusPanelParams: {
          label,
          rowCount,
          commitSummary: formatCommitSummary(metrics),
        },
      },
    ],
  };
}
