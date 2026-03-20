# `@sandbox/sqlite-store`

`@sandbox/sqlite-store` is a small AG Grid viewport-store library built around:

- one Drizzle SQLite schema
- one in-memory SQLite Wasm database in a worker
- one straightforward RPC model

It is intentionally not a live-query engine. Query changes run immediately. Write-driven refreshes are coalesced and re-run as normal SQL.

## Goals

- define the row shape once with Drizzle
- import the inferred row type on the main thread
- keep the worker runtime simple
- avoid collection hydration, subscription graphs, and engine-specific patch logic
- work cleanly with AG Grid viewport row model

## Core Model

The worker owns a SQLite table and exposes a small set of operations:

- `loadStore`
- `applyTransaction`
- `openViewportSession`
- `replaceViewportSession`
- `closeViewportSession`
- `setStressRate`

Viewport requests are plain query RPCs:

- initial open runs `count + rows`
- range changes run `count + rows` immediately
- sort/filter changes run `count + rows` immediately
- write churn marks sessions dirty and coalesces refreshes to one full patch per throttle window

Every emitted viewport patch contains:

- requested `startRow` / `endRow`
- full visible window rows
- total row count
- worker commit metrics
- query latency

There is no incremental diff protocol in this package.

## Define A Store

Create one Drizzle SQLite table and pass it to `defineSqliteStore`.

```ts
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { defineSqliteStore } from "@sandbox/sqlite-store";

export const marketRowsTable = sqliteTable("market_rows", {
  id: text("id").primaryKey(),
  active: integer("active", { mode: "boolean" }).notNull(),
  symbol: text("symbol").notNull(),
  company: text("company").notNull(),
  price: real("price").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type MarketRow = typeof marketRowsTable.$inferSelect;

export const marketSqliteStore = defineSqliteStore({
  table: marketRowsTable,
  rowKey: "id",
});
```

`defineSqliteStore(...)` derives:

- table name
- SQL column names
- `SELECT` list with aliases
- `CREATE TABLE` DDL
- `UPSERT` SQL
- delete-by-key SQL
- row encoding/decoding for SQLite
- default sort fallback from `rowKey`

## Optional Worker-Side Row Factories

If you want worker-side bootstrap or demo stress writes, add row factory hooks:

```ts
export const marketSqliteStore = defineSqliteStore({
  table: marketRowsTable,
  rowKey: "id",
  rowFactory: {
    generateRows(rowCount, seed) {
      return generateMarketRows(rowCount, seed ?? 1);
    },
    createStressRowFactory(seed, startIndex, options) {
      return createMarketRowFactory(seed, startIndex, options);
    },
  },
});
```

If you do not provide these hooks:

- `loadStore({ kind: "generator" })` will fail
- `setStressRate(...)` will fail

For app code that already has real rows, use `kind: "rows"` and skip row factories entirely.

## Worker Setup

Launch the worker with the store definition:

```ts
import * as Effect from "effect/Effect";
import { launchSqliteBrowserWorker } from "@sandbox/sqlite-store";
import { marketSqliteStore } from "./market-sqlite-store";

Effect.runFork(launchSqliteBrowserWorker(marketSqliteStore));
```

You can also create a registry or handler layer directly:

- `new StoreRegistry(marketSqliteStore, options?)`
- `createSqliteWorkerHandlers(marketSqliteStore, registry?)`
- `makeSqliteWorkerLayer(marketSqliteStore, registry?)`

## Main Thread Client

On the main thread, create the worker client and parameterize it with the inferred row type:

```ts
import { createSqliteWorkerClient } from "@sandbox/sqlite-store";
import type { MarketRow } from "./market-sqlite-store";

const client = await createSqliteWorkerClient<MarketRow>(
  () => new Worker(new URL("./sqlite.worker.ts", import.meta.url), { type: "module" }),
);
```

Load a store:

```ts
await client.loadStore(
  { storeId: "market" },
  { kind: "rows", rows },
);
```

Or, if your store definition includes `rowFactory.generateRows(...)`:

```ts
await client.loadStore(
  { storeId: "market" },
  { kind: "generator", rowCount: 100_000, seed: 7 },
);
```

Then get a collection handle:

```ts
const collection = client.collection("market");
```

## AG Grid Viewport Datasource

Use `createSqliteViewportDatasource(...)` with the collection handle:

```ts
import { createSqliteViewportDatasource } from "@sandbox/sqlite-store";

const datasource = createSqliteViewportDatasource(collection, {
  storeId: "market",
  onSnapshot(snapshot) {
    console.log(snapshot.rowCount, snapshot.metrics);
  },
  onViewportDiagnostics(diagnostics) {
    console.log(diagnostics);
  },
});
```

The datasource keeps the AG Grid integration simple:

- immediate refresh for normal query changes
- optional debounce for floating-filter typing
- loading overlay only for actual query refresh
- no invalid range calls during startup

## Query Translation

`sqlite-store` expects a `GridQueryState` from `@sandbox/ag-grid-translator`.

The SQL planner:

- validates fields against the Drizzle table columns
- maps AG Grid field ids to SQL column names
- translates supported predicates to SQLite SQL with positional `?` params
- uses the configured `rowKey` as the stable fallback sort

This means you do not maintain a second handwritten column map for normal table fields.

## What Is Generic And What Is Not

Generic:

- table name
- column names
- selected row type
- default row key
- worker-side row encoding/decoding
- SQL planner field lookup

Not generic:

- AG Grid still needs field names that match your selected row shape
- runtime row payloads across the worker boundary are treated as opaque row objects
- dynamic query translation is still plain SQL, not Drizzle query-builder chaining

That tradeoff is deliberate. The Drizzle table is the source of truth for schema and types, and the SQL planner stays small and direct.

## Why Raw SQL Instead Of Drizzle Queries

Drizzle is used here for:

- schema definition
- inferred row types
- runtime table metadata

The viewport query path still uses raw SQL because AG Grid filter and sort state is highly dynamic. Building `WHERE`, `ORDER BY`, `LIMIT`, and `OFFSET` directly is simpler and more predictable than trying to express the same runtime shape through a higher-level query builder.

## Design Constraints

- no live-query subscription model
- no incremental patch graph
- no secondary indexes by default
- no persistence by default
- no `Effect/sql` adapter in v1

The package favors simple worker ownership and fast rerun queries over a more elaborate database abstraction.
