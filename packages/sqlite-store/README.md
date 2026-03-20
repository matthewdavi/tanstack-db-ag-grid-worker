# `@sandbox/sqlite-store`

`@sandbox/sqlite-store` is an AG Grid-first SQLite Wasm worker engine.

It is built for the viewport row model:

- define one Drizzle SQLite table
- infer the row type once from that table
- run count + window SQL inside a worker
- keep the main thread read-only
- coalesce write-driven refreshes in the worker

This package is intentionally not a generic database client and not a live-query engine.

## API

The public API is deliberately small:

- `defineAgGridSqliteEngine(...)`
- `engine.createWorkerRuntime(...)`
- `engine.connect(...)`

The main thread should only connect and hand the returned datasource to AG Grid.

## Define An Engine

```ts
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { defineAgGridSqliteEngine } from "@sandbox/sqlite-store";

export const marketRowsTable = sqliteTable("market_rows", {
  id: text("id").primaryKey(),
  active: integer("active", { mode: "boolean" }).notNull(),
  symbol: text("symbol").notNull(),
  company: text("company").notNull(),
  price: real("price").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type MarketRow = typeof marketRowsTable.$inferSelect;

export const marketGrid = defineAgGridSqliteEngine({
  table: marketRowsTable,
  rowKey: "id",
});
```

That single Drizzle table drives:

- the row type
- table name
- SQL column mapping
- create-table DDL
- upsert SQL
- delete-by-key SQL
- fallback sort key

## Worker Runtime

Writes and ingestion live in the worker runtime, not in the browser API.

```ts
import * as Effect from "effect/Effect";
import { marketGrid } from "./market-sqlite-store";

const runtime = marketGrid.createWorkerRuntime({
  storeId: "market",
});

Effect.runFork(
  Effect.gen(function* () {
    yield* Effect.promise(() => runtime.replaceAll(seedRows));
    yield* runtime.launchBrowserWorker();
  }),
);
```

Worker runtime methods:

- `replaceAll(rows)`
- `upsert(rows)`
- `delete(ids)`
- `setStressRate(rowsPerSecond)` for demo-style worker-owned write churn
- `launchBrowserWorker()`

The worker runtime owns:

- SQLite DB creation
- table bootstrap
- row writes
- viewport session refresh scheduling

## Main Thread

The browser side is read-only.

```ts
const market = await marketGrid.connect(
  () => new Worker(new URL("./sqlite.worker.ts", import.meta.url), { type: "module" }),
  { storeId: "market" },
);

const datasource = market.viewportDatasource({
  onSnapshot(snapshot) {
    console.log(snapshot.rowCount, snapshot.metrics);
  },
  onViewportDiagnostics(diagnostics) {
    console.log(diagnostics);
  },
});
```

Main-thread surface:

- `viewportDatasource(options?)`
- `close()`

It does not expose:

- `loadStore`
- `applyTransaction`
- `collection(...)`
- `openViewportSession(...)`

Those are internal worker concerns.

## AG Grid Usage

```ts
<AgGridReact<Row>
  rowModelType="viewport"
  viewportDatasource={market.viewportDatasource()}
  getRowId={(params) => String(params.data.id)}
/>
```

The datasource behavior is simple:

- initial open runs `count + rows`
- sort changes rerun immediately
- filter changes rerun immediately
- floating-filter typing can debounce
- write churn triggers one coalesced rerun per throttle window
- every patch is a full visible window plus row count

There is no incremental diff protocol.

## Worker-Owned Demo Controls

If an app wants demo-only write controls such as stress sliders or “push live update”, keep that bridge app-local.

For example:

- create the worker in app code
- call `engine.connect(() => worker, { storeId })`
- send app-specific `postMessage(...)` commands to the worker
- let the worker file call `runtime.upsert(...)` or `runtime.setStressRate(...)`

That keeps the package API read-only while still allowing app-local mutation demos.

## Query Model

`sqlite-store` expects `GridQueryState` from `@sandbox/ag-grid-translator`.

The worker planner translates that to SQLite SQL with positional `?` params:

- supported AG Grid filter operators
- nested `and` / `or`
- dynamic `ORDER BY`
- `LIMIT` / `OFFSET`
- stable fallback ordering via `rowKey`

Drizzle is used for schema and type inference, not for the runtime viewport query builder.

## Design Constraints

- AG Grid viewport row model is the primary use case
- main-thread API is read-only
- no live-query subscription graph
- no incremental patch engine
- no secondary indexes by default
- no persistence by default
- no `Effect/sql` adapter in v1

The package favors a small API and fast rerun queries over a more elaborate abstraction layer.
