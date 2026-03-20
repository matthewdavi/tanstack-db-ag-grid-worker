import { performance } from "node:perf_hooks";

import { PGlite } from "@electric-sql/pglite";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { generateDemoRows } from "../src/demo-data";
import { createRowCollection, executeGridQuery } from "../src/query-runtime";
import type { GridQueryState } from "@sandbox/ag-grid-translator";

type Row = ReturnType<typeof generateDemoRows>[number];
type Sqlite3Module = Awaited<ReturnType<typeof sqlite3InitModule>>;
type SqliteDatabase = Sqlite3Module["oo1"]["DB"];

interface Sample {
  label: string;
  elapsedMs: number;
}

function measure(label: string, task: () => void): Sample {
  const startedAt = performance.now();
  task();
  return {
    label,
    elapsedMs: performance.now() - startedAt,
  };
}

async function measureAsync(label: string, task: () => Promise<void>): Promise<Sample> {
  const startedAt = performance.now();
  await task();
  return {
    label,
    elapsedMs: performance.now() - startedAt,
  };
}

function summarize(samples: ReadonlyArray<Sample>) {
  const elapsed = samples.map((sample) => sample.elapsedMs).sort((a, b) => a - b);
  const total = elapsed.reduce((sum, value) => sum + value, 0);
  return {
    minMs: elapsed[0] ?? 0,
    maxMs: elapsed[elapsed.length - 1] ?? 0,
    avgMs: total / Math.max(elapsed.length, 1),
    medianMs: elapsed[Math.floor(elapsed.length / 2)] ?? 0,
  };
}

function cloneRows(rows: ReadonlyArray<Row>) {
  return rows.slice();
}

function byPriceAsc(left: Row, right: Row) {
  return Number(left.price) - Number(right.price);
}

function byCompanyAsc(left: Row, right: Row) {
  return String(left.company).localeCompare(String(right.company));
}

function bySymbolAsc(left: Row, right: Row) {
  return String(left.symbol).localeCompare(String(right.symbol));
}

interface PgliteCase {
  readonly countSql: string;
  readonly countParams?: ReadonlyArray<unknown>;
  readonly rowsSql: string;
  readonly rowsParams?: ReadonlyArray<unknown>;
}

async function loadRowsIntoPglite(
  db: PGlite,
  rows: ReadonlyArray<Row>,
  chunkSize = 500,
) {
  await db.exec(`
    create table demo_rows (
      id text primary key,
      active boolean not null,
      symbol text not null,
      company text not null,
      sector text not null,
      venue text not null,
      price double precision not null,
      volume integer not null,
      created_at text not null,
      updated_at text not null
    );
  `);

  await db.transaction(async (tx) => {
    for (let offset = 0; offset < rows.length; offset += chunkSize) {
      const chunk = rows.slice(offset, offset + chunkSize);
      const values: Array<unknown> = [];
      const placeholders = chunk.map((row, index) => {
        const base = index * 10;
        values.push(
          row.id,
          row.active,
          row.symbol,
          row.company,
          row.sector,
          row.venue,
          row.price,
          row.volume,
          row.createdAt,
          row.updatedAt,
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`;
      });

      await tx.query(
        `
          insert into demo_rows (
            id,
            active,
            symbol,
            company,
            sector,
            venue,
            price,
            volume,
            created_at,
            updated_at
          ) values ${placeholders.join(", ")}
        `,
        values,
      );
    }
  });

  await db.exec(`
    analyze demo_rows;
  `);
}

async function runPgliteCase(
  db: PGlite,
  sqlCase: PgliteCase,
) {
  const countResult = await db.query<{ count: string }>(
    sqlCase.countSql,
    sqlCase.countParams ? [...sqlCase.countParams] : [],
  );
  const rowsResult = await db.query(
    sqlCase.rowsSql,
    sqlCase.rowsParams ? [...sqlCase.rowsParams] : [],
  );

  return {
    rowCount: Number(countResult.rows[0]?.count ?? 0),
    rowWindowSize: rowsResult.rows.length,
  };
}

function loadRowsIntoSqliteWasm(
  sqlite3: Sqlite3Module,
  db: SqliteDatabase,
  rows: ReadonlyArray<Row>,
) {
  db.exec(`
    create table demo_rows (
      id text primary key,
      active integer not null,
      symbol text not null,
      company text not null,
      sector text not null,
      venue text not null,
      price real not null,
      volume integer not null,
      created_at text not null,
      updated_at text not null
    );
  `);

  db.exec("begin");
  try {
    const statement = db.prepare(`
      insert into demo_rows (
        id,
        active,
        symbol,
        company,
        sector,
        venue,
        price,
        volume,
        created_at,
        updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      for (const row of rows) {
        statement.bind([
          row.id,
          row.active ? 1 : 0,
          row.symbol,
          row.company,
          row.sector,
          row.venue,
          row.price,
          row.volume,
          row.createdAt,
          row.updatedAt,
        ]);
        statement.step();
        statement.reset();
      }
    } finally {
      statement.finalize();
    }

    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }

  db.exec("analyze demo_rows");
  void sqlite3;
}

function runSqliteWasmCase(
  db: SqliteDatabase,
  sqlCase: PgliteCase,
) {
  const countRows = db.exec({
    sql: sqlCase.countSql,
    bind: sqlCase.countParams ? [...sqlCase.countParams] : undefined,
    rowMode: "object",
    returnValue: "resultRows",
  }) as Array<{ count: number | string }>;
  const rows = db.exec({
    sql: sqlCase.rowsSql,
    bind: sqlCase.rowsParams ? [...sqlCase.rowsParams] : undefined,
    rowMode: "object",
    returnValue: "resultRows",
  }) as Array<Record<string, unknown>>;

  return {
    rowCount: Number(countRows[0]?.count ?? 0),
    rowWindowSize: rows.length,
  };
}

async function runBench() {
  const rowCount = Number(process.env.BENCH_ROW_COUNT ?? 200_000);
  const iterations = Number(process.env.BENCH_ITERATIONS ?? 3);
  const viewportWindow = {
    startRow: 0,
    endRow: 100,
  };

  const generationStartedAt = performance.now();
  const rows = generateDemoRows(rowCount, 1);
  const generationElapsedMs = performance.now() - generationStartedAt;
  const collectionInitStartedAt = performance.now();
  const rowsCollection = createRowCollection({
    id: "bench-sort-rows",
    rows,
  });
  const collectionInitElapsedMs = performance.now() - collectionInitStartedAt;
  const pgliteInitStartedAt = performance.now();
  const pglite = new PGlite("memory://bench-sort");
  await pglite.waitReady;
  const pgliteReadyElapsedMs = performance.now() - pgliteInitStartedAt;
  const pgliteLoadStartedAt = performance.now();
  await loadRowsIntoPglite(pglite, rows);
  const pgliteLoadElapsedMs = performance.now() - pgliteLoadStartedAt;
  const sqliteInitStartedAt = performance.now();
  const sqlite3 = await sqlite3InitModule();
  const sqlite = new sqlite3.oo1.DB("/bench.sqlite3", "c");
  const sqliteReadyElapsedMs = performance.now() - sqliteInitStartedAt;
  const sqliteLoadStartedAt = performance.now();
  loadRowsIntoSqliteWasm(sqlite3, sqlite, rows);
  const sqliteLoadElapsedMs = performance.now() - sqliteLoadStartedAt;

  const cases: Array<{
    label: string;
    query: GridQueryState;
    runJs: () => void;
    runPglite: () => Promise<void>;
    runSqlite: () => void;
  }> = [
    {
      label: "sort price asc",
      query: {
        predicate: undefined,
        sorts: [{ field: "price", direction: "asc" }],
      },
      runJs: () => {
        const orderedRows = cloneRows(rows).sort(byPriceAsc);
        orderedRows.length;
        orderedRows.slice(viewportWindow.startRow, viewportWindow.endRow);
      },
      runPglite: async () => {
        await runPgliteCase(pglite, {
          countSql: "select count(*)::text as count from demo_rows",
          rowsSql: `
            select id, symbol, company, sector, venue, price
            from demo_rows
            order by price asc
            limit $1 offset $2
          `,
          rowsParams: [viewportWindow.endRow - viewportWindow.startRow, viewportWindow.startRow],
        });
      },
      runSqlite: () => {
        runSqliteWasmCase(sqlite, {
          countSql: "select count(*) as count from demo_rows",
          rowsSql: `
            select id, symbol, company, sector, venue, price
            from demo_rows
            order by price asc
            limit ? offset ?
          `,
          rowsParams: [viewportWindow.endRow - viewportWindow.startRow, viewportWindow.startRow],
        });
      },
    },
    {
      label: "sort company asc",
      query: {
        predicate: undefined,
        sorts: [{ field: "company", direction: "asc" }],
      },
      runJs: () => {
        const orderedRows = cloneRows(rows).sort(byCompanyAsc);
        orderedRows.length;
        orderedRows.slice(viewportWindow.startRow, viewportWindow.endRow);
      },
      runPglite: async () => {
        await runPgliteCase(pglite, {
          countSql: "select count(*)::text as count from demo_rows",
          rowsSql: `
            select id, symbol, company, sector, venue, price
            from demo_rows
            order by company asc
            limit $1 offset $2
          `,
          rowsParams: [viewportWindow.endRow - viewportWindow.startRow, viewportWindow.startRow],
        });
      },
      runSqlite: () => {
        runSqliteWasmCase(sqlite, {
          countSql: "select count(*) as count from demo_rows",
          rowsSql: `
            select id, symbol, company, sector, venue, price
            from demo_rows
            order by company asc
            limit ? offset ?
          `,
          rowsParams: [viewportWindow.endRow - viewportWindow.startRow, viewportWindow.startRow],
        });
      },
    },
    {
      label: "filter sector=Technology then sort price desc",
      query: {
        predicate: {
          kind: "comparison",
          field: "sector",
          operator: "eq",
          value: "Technology",
        },
        sorts: [{ field: "price", direction: "desc" }],
      },
      runJs: () => {
        const filteredRows = rows
          .filter((row) => row.sector === "Technology")
          .sort((left, right) => byPriceAsc(right, left));
        filteredRows.length;
        filteredRows.slice(viewportWindow.startRow, viewportWindow.endRow);
      },
      runPglite: async () => {
        await runPgliteCase(pglite, {
          countSql: "select count(*)::text as count from demo_rows where sector = $1",
          countParams: ["Technology"],
          rowsSql: `
            select id, symbol, company, sector, venue, price
            from demo_rows
            where sector = $1
            order by price desc
            limit $2 offset $3
          `,
          rowsParams: ["Technology", viewportWindow.endRow - viewportWindow.startRow, viewportWindow.startRow],
        });
      },
      runSqlite: () => {
        runSqliteWasmCase(sqlite, {
          countSql: "select count(*) as count from demo_rows where sector = ?",
          countParams: ["Technology"],
          rowsSql: `
            select id, symbol, company, sector, venue, price
            from demo_rows
            where sector = ?
            order by price desc
            limit ? offset ?
          `,
          rowsParams: ["Technology", viewportWindow.endRow - viewportWindow.startRow, viewportWindow.startRow],
        });
      },
    },
    {
      label: "filter symbol startsWith=A then sort symbol asc",
      query: {
        predicate: {
          kind: "comparison",
          field: "symbol",
          operator: "startsWith",
          value: "A",
        },
        sorts: [{ field: "symbol", direction: "asc" }],
      },
      runJs: () => {
        const filteredRows = rows
          .filter((row) => String(row.symbol).startsWith("A"))
          .sort(bySymbolAsc);
        filteredRows.length;
        filteredRows.slice(viewportWindow.startRow, viewportWindow.endRow);
      },
      runPglite: async () => {
        await runPgliteCase(pglite, {
          countSql: "select count(*)::text as count from demo_rows where symbol like $1",
          countParams: ["A%"],
          rowsSql: `
            select id, symbol, company, sector, venue, price
            from demo_rows
            where symbol like $1
            order by symbol asc
            limit $2 offset $3
          `,
          rowsParams: ["A%", viewportWindow.endRow - viewportWindow.startRow, viewportWindow.startRow],
        });
      },
      runSqlite: () => {
        runSqliteWasmCase(sqlite, {
          countSql: "select count(*) as count from demo_rows where symbol like ?",
          countParams: ["A%"],
          rowsSql: `
            select id, symbol, company, sector, venue, price
            from demo_rows
            where symbol like ?
            order by symbol asc
            limit ? offset ?
          `,
          rowsParams: ["A%", viewportWindow.endRow - viewportWindow.startRow, viewportWindow.startRow],
        });
      },
    },
  ];

  for (const benchCase of cases) {
    benchCase.runJs();
    await executeGridQuery(rowsCollection, benchCase.query, viewportWindow);
    await benchCase.runPglite();
    benchCase.runSqlite();
  }

  console.log(`Generated ${rowCount.toLocaleString()} rows in ${generationElapsedMs.toFixed(2)} ms`);
  console.log(`Created TanStack base collection in ${collectionInitElapsedMs.toFixed(2)} ms`);
  console.log(`PGlite ready in ${pgliteReadyElapsedMs.toFixed(2)} ms`);
  console.log(`Loaded PGlite rows without indexes in ${pgliteLoadElapsedMs.toFixed(2)} ms`);
  console.log(`SQLite Wasm ready in ${sqliteReadyElapsedMs.toFixed(2)} ms`);
  console.log(`Loaded SQLite Wasm rows without indexes in ${sqliteLoadElapsedMs.toFixed(2)} ms`);
  console.log(`Viewport window: ${viewportWindow.startRow}-${viewportWindow.endRow}`);
  console.log(`Iterations per case: ${iterations}`);

  try {
    for (const benchCase of cases) {
    const jsSamples: Array<Sample> = [];
    const tanstackSamples: Array<Sample> = [];
    const pgliteSamples: Array<Sample> = [];
    const sqliteSamples: Array<Sample> = [];

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      jsSamples.push(measure(benchCase.label, benchCase.runJs));
      tanstackSamples.push(
        await measureAsync(benchCase.label, async () => {
          await executeGridQuery(rowsCollection, benchCase.query, viewportWindow);
        }),
      );
      pgliteSamples.push(
        await measureAsync(benchCase.label, async () => {
          await benchCase.runPglite();
        }),
      );
      sqliteSamples.push(measure(benchCase.label, benchCase.runSqlite));
    }

      const jsSummary = summarize(jsSamples);
      const tanstackSummary = summarize(tanstackSamples);
      const pgliteSummary = summarize(pgliteSamples);
      const sqliteSummary = summarize(sqliteSamples);
      console.log(
        [
          `${benchCase.label} | plain-js`,
          `min=${jsSummary.minMs.toFixed(2)}ms`,
          `median=${jsSummary.medianMs.toFixed(2)}ms`,
          `avg=${jsSummary.avgMs.toFixed(2)}ms`,
          `max=${jsSummary.maxMs.toFixed(2)}ms`,
        ].join(" | "),
      );
      console.log(
        [
          `${benchCase.label} | tanstack-db executeGridQuery`,
          `min=${tanstackSummary.minMs.toFixed(2)}ms`,
          `median=${tanstackSummary.medianMs.toFixed(2)}ms`,
          `avg=${tanstackSummary.avgMs.toFixed(2)}ms`,
          `max=${tanstackSummary.maxMs.toFixed(2)}ms`,
        ].join(" | "),
      );
      console.log(
        [
          `${benchCase.label} | pglite raw sql`,
          `min=${pgliteSummary.minMs.toFixed(2)}ms`,
          `median=${pgliteSummary.medianMs.toFixed(2)}ms`,
          `avg=${pgliteSummary.avgMs.toFixed(2)}ms`,
          `max=${pgliteSummary.maxMs.toFixed(2)}ms`,
        ].join(" | "),
      );
      console.log(
        [
          `${benchCase.label} | sqlite-wasm raw sql`,
          `min=${sqliteSummary.minMs.toFixed(2)}ms`,
          `median=${sqliteSummary.medianMs.toFixed(2)}ms`,
          `avg=${sqliteSummary.avgMs.toFixed(2)}ms`,
          `max=${sqliteSummary.maxMs.toFixed(2)}ms`,
        ].join(" | "),
      );
    }
  } finally {
    await pglite.close();
    sqlite.close();
  }
}

await runBench();
