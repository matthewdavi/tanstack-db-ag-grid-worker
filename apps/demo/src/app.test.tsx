// @vitest-environment jsdom

import "ag-grid-enterprise";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";

import type { AgGridSqliteClient } from "@sandbox/sqlite-store";

import { App } from "./app";
import type { MarketRow } from "./market-sqlite-store";

const sampleRows: ReadonlyArray<MarketRow> = [
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

function makeSqliteClient(): AgGridSqliteClient<MarketRow> & {
  pushLiveUpdate(): void;
  setStressRate(rowsPerSecond: number): void;
} {
  return {
    storeId: "sqlite-olympic-athletes",
    open: vi.fn().mockImplementation((options?: {
      onSnapshot?: (snapshot: {
        startRow: number;
        endRow: number;
        rowCount: number;
      }) => void;
      onViewportDiagnostics?: (diagnostics: {
        requestedRange: { startRow: number; endRow: number };
        fulfilledRange: { startRow: number; endRow: number } | null;
        isLoading: boolean;
        lastPatchLatencyMs: number | null;
        patchCount: number;
      }) => void;
    }) => ({
      init(params: {
        setRowCount(rowCount: number): void;
        setRowData(rows: Record<number, MarketRow>): void;
      }) {
        options?.onSnapshot?.({
          startRow: 0,
          endRow: sampleRows.length,
          rowCount: sampleRows.length,
        });
        options?.onViewportDiagnostics?.({
          requestedRange: { startRow: 0, endRow: 50 },
          fulfilledRange: { startRow: 0, endRow: sampleRows.length },
          isLoading: false,
          lastPatchLatencyMs: 8.5,
          patchCount: 1,
        });
        params.setRowCount(sampleRows.length);
        params.setRowData(
          Object.fromEntries(sampleRows.map((row, index) => [index, row])),
        );
      },
      setViewportRange: vi.fn(),
      destroy: vi.fn(),
    })),
    pushLiveUpdate: vi.fn(),
    setStressRate: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("demo app", () => {
  it("mounts the sqlite viewport grid and wires the demo panel", async () => {
    const sqliteClient = makeSqliteClient();
    render(<App sqliteClient={sqliteClient} />);

    const sqliteHeading = await screen.findByRole("heading", { name: "SQLite SQL Viewport" });
    const sqlitePanel = sqliteHeading.closest("section");

    expect(sqlitePanel).not.toBeNull();

    await screen.findAllByText("Ada Insights Holdings");

    await waitFor(() => {
      expect(sqliteClient.open).toHaveBeenCalled();
    });

    await screen.findAllByText(/rows$/);
    await screen.findAllByText("2");
    await screen.findAllByText("Requested range");
    await screen.findAllByText("Fulfilled range");
    await screen.findAllByText("Patch latency");
  });

  it("renders the sqlite viewport stress controls", async () => {
    const sqliteClient = makeSqliteClient();
    render(<App sqliteClient={sqliteClient} />);

    const sqliteHeading = (await screen.findAllByRole("heading", { name: "SQLite SQL Viewport" }))[0];
    const sqlitePanel = sqliteHeading.closest("section");

    expect(sqlitePanel).not.toBeNull();
    await within(sqlitePanel as HTMLElement).findByRole("slider", {
      name: "Rows per second",
    });
    expect(
      within(sqlitePanel as HTMLElement).getByRole("button", { name: "Push live update" }),
    );
    expect(
      within(sqlitePanel as HTMLElement).getByRole("button", { name: "Stop stress stream" }),
    );
  });
});
