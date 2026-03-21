import type { ReactNode } from "react";

import type { ViewportStateDiagnostics } from "./types";

interface GridCardProps {
  title: string;
  body: string;
  status: string;
  children: ReactNode;
}

const cardClass =
  "overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-900/35 shadow-sm ring-1 ring-white/[0.04] backdrop-blur-md";

const headerClass =
  "grid grid-cols-1 gap-4 border-b border-zinc-800/60 p-5 pb-4 md:grid-cols-[minmax(0,1fr)_minmax(18rem,26rem)] md:items-end";

const eyebrowClass =
  "mb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500";

const titleClass = "m-0 text-lg font-semibold tracking-tight text-zinc-50";

const bodyClass = "m-0 max-w-[62ch] text-sm leading-relaxed text-zinc-400";

export function GridCard(props: GridCardProps) {
  return (
    <section className={cardClass}>
      <header className={headerClass}>
        <div>
          <p className={eyebrowClass}>{props.status}</p>
          <h2 className={titleClass}>{props.title}</h2>
        </div>
        <p className={bodyClass}>{props.body}</p>
      </header>
      {props.children}
    </section>
  );
}

interface LoadingGridCardProps extends Omit<GridCardProps, "children"> {
  message: string;
}

export function LoadingGridCard(props: LoadingGridCardProps) {
  return (
    <GridCard
      title={props.title}
      body={props.body}
      status={props.status}
    >
      <div
        className={
          "grid min-h-64 place-content-center gap-1 px-5 py-8 text-sm text-zinc-500"
        }
      >
        <p className={"m-0 max-w-[54ch]"}>{props.message}</p>
      </div>
    </GridCard>
  );
}

export function formatViewportRange(
  range: {
    startRow: number;
    endRow: number;
  } | null,
) {
  if (range === null) {
    return "Awaiting patch";
  }

  return `${range.startRow}-${Math.max(range.endRow - 1, range.startRow)}`;
}

interface ViewportDiagnosticsRowProps {
  diagnostics: ViewportStateDiagnostics;
}

export function ViewportDiagnosticsRow(props: ViewportDiagnosticsRowProps) {
  const { diagnostics } = props;

  return (
    <div
      className={
        "flex flex-wrap gap-x-5 gap-y-2 border-b border-zinc-800/50 px-5 py-3 font-mono text-xs text-zinc-500 max-md:flex-col"
      }
    >
      <span>
        Requested range{" "}
        <strong className={"font-semibold text-zinc-200"}>
          {formatViewportRange(diagnostics.requestedRange)}
        </strong>
      </span>
      <span>
        Fulfilled range{" "}
        <strong className={"font-semibold text-zinc-200"}>
          {formatViewportRange(diagnostics.fulfilledRange)}
        </strong>
      </span>
      <span>
        Patch latency{" "}
        <strong className={"font-semibold text-zinc-200"}>
          {diagnostics.lastPatchLatencyMs === null
            ? "Awaiting patch"
            : `${diagnostics.lastPatchLatencyMs.toFixed(2)} ms`}
        </strong>
      </span>
      <span>
        Ignored patches{" "}
        <strong className={"font-semibold text-zinc-200"}>
          {diagnostics.ignoredPatchCount}
        </strong>
      </span>
    </div>
  );
}
