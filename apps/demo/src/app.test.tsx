// @vitest-environment jsdom

import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-quartz.css";
import "ag-grid-enterprise";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as Stream from "effect/Stream";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import type {
  ViewportPatch,
  WorkerClient,
  WorkerCollectionHandle,
} from "@sandbox/worker-store";

import { App } from "./app";

const sampleRows = [
  {
    id: "1",
    symbol: "ADAI",
    company: "Ada Insights Holdings",
    sector: "Technology",
    venue: "NASDAQ",
    price: 184.32,
    volume: 125000,
    updatedAt: "2026-03-08T14:49:00.000Z",
  },
  {
    id: "2",
    symbol: "GRAC",
    company: "Grace Systems Group",
    sector: "Financials",
    venue: "NYSE",
    price: 92.14,
    volume: 98000,
    updatedAt: "2026-03-08T14:48:30.000Z",
  },
];

const sampleMetrics = {
  lastCommitDurationMs: 1.75,
  lastCommitChangeCount: sampleRows.length,
  totalCommitCount: 1,
};

class ResizeObserverStub {
  observe() {}

  unobserve() {}

  disconnect() {}
}

beforeAll(() => {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: ResizeObserverStub,
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return 1280;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return 720;
    },
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

function makeClient(): WorkerClient {
  const collection: WorkerCollectionHandle = {
    storeId: "olympic-athletes",
    applyTransaction: vi.fn().mockResolvedValue({
      storeId: "olympic-athletes",
      rowCount: sampleRows.length,
      metrics: sampleMetrics,
    }),
    getRows: vi.fn().mockResolvedValue({
      storeId: "olympic-athletes",
      startRow: 0,
      endRow: sampleRows.length,
      rowCount: sampleRows.length,
      metrics: sampleMetrics,
      rows: sampleRows,
    }),
    openViewportSession: vi.fn().mockImplementation(() => ({
      sessionId: "viewport-session",
      updates: Stream.fromIterable<ViewportPatch>([{
        storeId: "olympic-athletes",
        startRow: 0,
        endRow: sampleRows.length,
        rowCount: sampleRows.length,
        metrics: sampleMetrics,
        rows: sampleRows,
      }]),
      replace: vi.fn().mockResolvedValue({
        sessionId: "viewport-session",
        replaced: true,
      }),
      close: vi.fn().mockResolvedValue({
        sessionId: "viewport-session",
        closed: true,
      }),
    })),
    setStressRate: vi.fn().mockResolvedValue({
      storeId: "olympic-athletes",
      rowsPerSecond: 0,
      running: false,
      rowCount: sampleRows.length,
      metrics: sampleMetrics,
    }),
    dispose: vi.fn().mockResolvedValue({
      storeId: "olympic-athletes",
      disposed: true,
    }),
  };

  return {
    loadStore: vi.fn().mockResolvedValue({
      storeId: "olympic-athletes",
      rowCount: sampleRows.length,
      metrics: sampleMetrics,
    }),
    collection: vi.fn().mockReturnValue(collection),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("demo app", () => {
  it("mounts both worker-backed grid modes and renders sample row data", async () => {
    const client = makeClient();
    render(<App client={client} />);

    await screen.findByText("Server-Side Pull");
    await screen.findByText("Viewport Push");

    await screen.findAllByText("Ada Insights Holdings");

    await waitFor(() => {
      expect(client.collection).toHaveBeenCalledWith("olympic-athletes");
      expect(client.loadStore).toHaveBeenCalled();
    });

    await screen.findAllByText("Worker rows");
    await screen.findAllByText("2");
    await screen.findAllByText("Last commit");
    await screen.findAllByText("1.75 ms / 2 rows");
    await screen.findByText("Requested range");
    await screen.findByText("Fulfilled range");
    await screen.findByText("Patch latency");
  });

  it("lets the viewport demo retune worker-side stress throughput", async () => {
    const client = makeClient();
    render(<App client={client} />);

    const slider = await screen.findByRole("slider", { name: "Rows per second" });
    fireEvent.change(slider, {
      target: {
        value: "120",
      },
    });

    await waitFor(() => {
      expect(client.collection("olympic-athletes").setStressRate).toHaveBeenLastCalledWith(120);
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop stress stream" }));

    await waitFor(() => {
      expect(client.collection("olympic-athletes").setStressRate).toHaveBeenLastCalledWith(0);
    });
  });
});
