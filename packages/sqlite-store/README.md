# `@sandbox/sqlite-store`

`@sandbox/sqlite-store` is the query engine.

it takes ag grid viewport requests, turns them into sqlite sql, runs that inside a worker, and pushes the current visible window back to the grid.

the important boundary is:

- your worker creates and owns sqlite
- your app code does writes however it wants
- this package serves ag grid queries against that sqlite dependency
- writes do not leak into the public api

## what it does

- translates ag grid filter/sort state into `GridQueryState`
- plans `count(*)` + visible window sql
- keeps one worker-owned current viewport channel per grid
- reruns the current viewport query when the worker invalidates it
- throttles invalidation reruns in the worker with `throttleMs`

it is intentionally not:

- a generic sqlite client
- a generic live-query framework
- a browser-side write api

## public api

- `defineAgGridSqliteEngine(...)`
- `engine.makeWorkerService(...)`
- `engine.connect(...)`
- browser client: `open(options?)` and `close()`

## define the engine

```ts
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { defineAgGridSqliteEngine } from "@sandbox/sqlite-store";

const marketRowsTable = sqliteTable("market_rows", {
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

## worker side

the worker provides sqlite. this package depends on that effect service and serves viewport queries on top of it.

```ts
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as SqliteClient from "@effect/sql-sqlite-wasm/SqliteClient";

const sqlRuntime = ManagedRuntime.make(SqliteClient.layerMemory({}));

const workerService = await sqlRuntime.runPromise(
  marketGrid.makeWorkerService({
    storeId: "market",
  }),
);

Effect.runFork(
  Effect.gen(function* () {
    yield* workerService.serve;
  }),
);
```

worker service surface:

- `serve`
- `invalidate`
- `close`

if your worker writes to sqlite, your worker should call `invalidate` after those writes.

## browser side

```ts
const market = await marketGrid.connect(
  () => new Worker(new URL("./sqlite.worker.ts", import.meta.url), { type: "module" }),
  { storeId: "market" },
);

const datasource = market.open({
  throttleMs: 100,
  onSnapshot(snapshot) {
    console.log(snapshot.rowCount);
  },
  onViewportDiagnostics(diagnostics) {
    console.log(diagnostics);
  },
});
```

browser client surface:

- `open(options?)`
- `close()`

`open()` returns the `IViewportDatasource` you hand to ag grid.

## ag grid usage

```tsx
<AgGridReact<Row>
  rowModelType="viewport"
  viewportDatasource={market.open({ throttleMs: 100 })}
  getRowId={(params) => String(params.data.id)}
/>
```

the browser side stays thin:

- open one worker channel
- send the latest viewport intent immediately
- let the worker own throttling and invalidation reruns
- close the channel on destroy

there is no browser-side debounce or browser-side write api.

## invalidation model

the worker owns the current viewport intent.

when the app writes to sqlite, the app publishes invalidation by calling `workerService.invalidate`.

the worker then reruns:

- `count(*)`
- the current visible window query

that rerun is throttled in the worker with `throttleMs`, so continuous writes do not spam the grid.

## design constraints

- ag grid viewport row model is the target
- sqlite is created in the worker, not in the browser
- the package depends on sqlite as an effect service
- writes are app-local and outside the package boundary
- every patch is a full visible window plus row count
- no incremental diff protocol
