// @vitest-environment jsdom

import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-quartz.css";
import "ag-grid-enterprise";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as Stream from "effect/Stream";
import { render, screen, waitFor, within } from "@testing-library/react";

import type {
  ViewportPatch,
  WorkerClient,
  WorkerCollectionHandle,
} from "@sandbox/worker-store";
import type {
  SqliteWorkerClient,
  ViewportPatch as SqliteViewportPatch,
} from "@sandbox/sqlite-store";

import { App } from "./app";

const sampleRows = [
  {
    id: "1",
    active: true,
    symbol: "ADAI",
    company: "Ada Insights Holdings",
    sector: "Technology",
    venue: "NASDAQ",
    price: 184.32,
    volume: 125000,
    createdAt: "2026-03-08T14:40:00.000Z",
    updatedAt: "2026-03-08T14:49:00.000Z",
  },
  {
    id: "2",
    active: true,
    symbol: "GRAC",
    company: "Grace Systems Group",
    sector: "Financials",
    venue: "NYSE",
    price: 92.14,
    volume: 98000,
    createdAt: "2026-03-08T14:39:30.000Z",
    updatedAt: "2026-03-08T14:48:30.000Z",
  },
];

const sampleMetrics = {
  lastCommitDurationMs: 1.75,
  lastCommitChangeCount: sampleRows.length,
  totalCommitCount: 1,
};
const originalConsoleError = console.error.bind(console);
const originalConsoleWarn = console.warn.bind(console);

function isAgGridLicenseMessage(value: unknown) {
  return typeof value === "string" && (
    value.includes("****************************************************************") ||
    value.includes("AG Grid Enterprise") ||
    value.includes("License Key Not Found") ||
    value.includes("trial license key") ||
    value.includes("watermark")
  );
}

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
  vi.spyOn(console, "error").mockImplementation((...args) => {
    const [firstArg] = args;
    if (isAgGridLicenseMessage(firstArg)) {
      return;
    }

    originalConsoleError(...args);
  });
  vi.spyOn(console, "warn").mockImplementation((...args) => {
    const [firstArg] = args;
    if (isAgGridLicenseMessage(firstArg)) {
      return;
    }

    originalConsoleWarn(...args);
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
        latencyMs: 12.5,
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

function makeSqliteClient(): SqliteWorkerClient {
  const updates = Stream.fromIterable<SqliteViewportPatch>([{
    storeId: "sqlite-olympic-athletes",
    startRow: 0,
    endRow: sampleRows.length,
    rowCount: sampleRows.length,
    latencyMs: 8.5,
    metrics: sampleMetrics,
    rows: sampleRows,
  }]);

  return {
    loadStore: vi.fn().mockResolvedValue({
      storeId: "sqlite-olympic-athletes",
      rowCount: sampleRows.length,
      metrics: sampleMetrics,
    }),
    collection: vi.fn().mockReturnValue({
      storeId: "sqlite-olympic-athletes",
      applyTransaction: vi.fn().mockResolvedValue({
        storeId: "sqlite-olympic-athletes",
        rowCount: sampleRows.length,
        metrics: sampleMetrics,
      }),
      openViewportSession: vi.fn().mockImplementation(() => ({
        sessionId: "sqlite-viewport-session",
        updates,
        replace: vi.fn().mockResolvedValue({
          sessionId: "sqlite-viewport-session",
          replaced: true,
        }),
        close: vi.fn().mockResolvedValue({
          sessionId: "sqlite-viewport-session",
          closed: true,
        }),
      })),
      setStressRate: vi.fn().mockResolvedValue({
        storeId: "sqlite-olympic-athletes",
        rowsPerSecond: 0,
        running: false,
        rowCount: sampleRows.length,
        metrics: sampleMetrics,
      }),
      dispose: vi.fn().mockResolvedValue({
        storeId: "sqlite-olympic-athletes",
        disposed: true,
      }),
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makePendingSqliteClient(): SqliteWorkerClient {
  return {
    loadStore: vi.fn().mockImplementation(() => new Promise(() => undefined)),
    collection: vi.fn().mockReturnValue({
      storeId: "sqlite-olympic-athletes",
      applyTransaction: vi.fn(),
      openViewportSession: vi.fn(),
      setStressRate: vi.fn(),
      dispose: vi.fn(),
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("demo app", () => {
  it("mounts both worker-backed grid modes and wires the demo panels", async () => {
    const client = makeClient();
    const sqliteClient = makeSqliteClient();
    render(<App client={client} sqliteClient={sqliteClient} />);

    await screen.findByText("Server-Side Pull");
    const viewportHeading = await screen.findByRole("heading", { name: "Viewport Push" });
    const sqliteHeading = await screen.findByRole("heading", { name: "SQLite SQL Viewport" });
    const viewportPanel = viewportHeading.closest("section");
    const sqlitePanel = sqliteHeading.closest("section");

    expect(viewportPanel).not.toBeNull();
    expect(sqlitePanel).not.toBeNull();

    await screen.findAllByText("Ada Insights Holdings");

    await waitFor(() => {
      expect(client.collection).toHaveBeenCalledWith("olympic-athletes");
      expect(client.loadStore).toHaveBeenCalled();
      expect(sqliteClient.collection).toHaveBeenCalledWith("sqlite-olympic-athletes");
      expect(sqliteClient.loadStore).toHaveBeenCalled();
    });

    await screen.findAllByText(/rows$/);
    await screen.findAllByText("2");
    await screen.findAllByText("Last commit");
    await screen.findAllByText("1.75 ms / 2 rows");
    await screen.findAllByText("Requested range");
    await screen.findAllByText("Fulfilled range");
    await screen.findAllByText("Patch latency");
  });

  it("renders the viewport stress controls", async () => {
    const client = makeClient();
    const sqliteClient = makeSqliteClient();
    render(<App client={client} sqliteClient={sqliteClient} />);

    const viewportHeading = (await screen.findAllByRole("heading", { name: "Viewport Push" }))[0];
    const viewportPanel = viewportHeading.closest("section");

    expect(viewportPanel).not.toBeNull();
    await within(viewportPanel as HTMLElement).findByRole("slider", {
      name: "Rows per second",
    });
    expect(
      within(viewportPanel as HTMLElement).getByRole("button", { name: "Stop stress stream" }),
    );
  });

  it("does not block TanStack panels while the SQLite store is still booting", async () => {
    const client = makeClient();
    const sqliteClient = makePendingSqliteClient();

    render(<App client={client} sqliteClient={sqliteClient} />);

    expect((await screen.findAllByText("Server-Side Pull")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Viewport Push")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("SQLite SQL Viewport")).length).toBeGreaterThan(0);
    await screen.findAllByText("Ada Insights Holdings");

    expect(
      screen.getByText(
        "Starting the SQLite worker store in the background. TanStack panels stay interactive while it catches up.",
      ),
    ).not.toBeNull();
  });
});
