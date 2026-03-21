import type { StatusBar } from "ag-grid-community";

interface WorkerRowCountStatusPanelProps {
  label: string;
  rowCount: number;
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
    </span>
  );
}

export function createRowCountStatusBar(
  label: string,
  rowCount: number,
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
        },
      },
    ],
  };
}
