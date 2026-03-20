import { performance } from "node:perf_hooks";

import { PGlite } from "@electric-sql/pglite";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

import { generateDemoRows } from "../src/demo-data";

type Row = ReturnType<typeof generateDemoRows>[number];
type Sqlite3Module = Awaited<ReturnType<typeof sqlite3InitModule>>;
type SqliteDatabase = Sqlite3Module["oo1"]["DB"];

interface Sample {
  elapsedMs: number;
}

interface SqlCase {
  readonly label: string;
  readonly pglite: {
    readonly countSql: string;
    readonly countParams?: ReadonlyArray<unknown>;
    readonly rowsSql: string;
    readonly rowsParams?: ReadonlyArray<unknown>;
  };
  readonly sqlite: {
    readonly countSql: string;
    readonly countParams?: ReadonlyArray<unknown>;
    readonly rowsSql: string;
    readonly rowsParams?: ReadonlyArray<unknown>;
  };
}

async function measureAsync(task: () => Promise<void>): Promise<Sample> {
  const startedAt = performance.now();
  await task();
  return {
    elapsedMs: performance.now() - startedAt,
  };
}

function measure(task: () => void): Sample {
  const startedAt = performance.now();
  task();
  return {
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

  await db.exec("analyze demo_rows");
}

function loadRowsIntoSqliteWasm(
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
}

async function runPgliteCase(
  db: PGlite,
  sqlCase: SqlCase["pglite"],
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

function runSqliteCase(
  db: SqliteDatabase,
  sqlCase: SqlCase["sqlite"],
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
  const rowCount = Number(process.env.BENCH_ROW_COUNT ?? 100_000);
  const iterations = Number(process.env.BENCH_ITERATIONS ?? 3);
  const viewportSize = 100;

  const generationStartedAt = performance.now();
  const rows = generateDemoRows(rowCount, 1);
  const generationElapsedMs = performance.now() - generationStartedAt;

  const pgliteInitStartedAt = performance.now();
  const pglite = new PGlite("memory://bench-sql-engines");
  await pglite.waitReady;
  const pgliteReadyElapsedMs = performance.now() - pgliteInitStartedAt;
  const pgliteLoadStartedAt = performance.now();
  await loadRowsIntoPglite(pglite, rows);
  const pgliteLoadElapsedMs = performance.now() - pgliteLoadStartedAt;

  const sqliteInitStartedAt = performance.now();
  const sqlite3 = await sqlite3InitModule();
  const sqlite = new sqlite3.oo1.DB("/bench-sql-engines.sqlite3", "c");
  const sqliteReadyElapsedMs = performance.now() - sqliteInitStartedAt;
  const sqliteLoadStartedAt = performance.now();
  loadRowsIntoSqliteWasm(sqlite, rows);
  const sqliteLoadElapsedMs = performance.now() - sqliteLoadStartedAt;

  const cases: ReadonlyArray<SqlCase> = [
    {
      label: "sort price asc",
      pglite: {
        countSql: "select count(*)::text as count from demo_rows",
        rowsSql: `
          select id, symbol, company, sector, venue, price
          from demo_rows
          order by price asc
          limit $1 offset $2
        `,
        rowsParams: [viewportSize, 0],
      },
      sqlite: {
        countSql: "select count(*) as count from demo_rows",
        rowsSql: `
          select id, symbol, company, sector, venue, price
          from demo_rows
          order by price asc
          limit ? offset ?
        `,
        rowsParams: [viewportSize, 0],
      },
    },
    {
      label: "sort company asc",
      pglite: {
        countSql: "select count(*)::text as count from demo_rows",
        rowsSql: `
          select id, symbol, company, sector, venue, price
          from demo_rows
          order by company asc
          limit $1 offset $2
        `,
        rowsParams: [viewportSize, 0],
      },
      sqlite: {
        countSql: "select count(*) as count from demo_rows",
        rowsSql: `
          select id, symbol, company, sector, venue, price
          from demo_rows
          order by company asc
          limit ? offset ?
        `,
        rowsParams: [viewportSize, 0],
      },
    },
    {
      label: "filter sector=Technology then sort price desc",
      pglite: {
        countSql: "select count(*)::text as count from demo_rows where sector = $1",
        countParams: ["Technology"],
        rowsSql: `
          select id, symbol, company, sector, venue, price
          from demo_rows
          where sector = $1
          order by price desc
          limit $2 offset $3
        `,
        rowsParams: ["Technology", viewportSize, 0],
      },
      sqlite: {
        countSql: "select count(*) as count from demo_rows where sector = ?",
        countParams: ["Technology"],
        rowsSql: `
          select id, symbol, company, sector, venue, price
          from demo_rows
          where sector = ?
          order by price desc
          limit ? offset ?
        `,
        rowsParams: ["Technology", viewportSize, 0],
      },
    },
    {
      label: "filter symbol startsWith=A then sort symbol asc",
      pglite: {
        countSql: "select count(*)::text as count from demo_rows where symbol like $1",
        countParams: ["A%"],
        rowsSql: `
          select id, symbol, company, sector, venue, price
          from demo_rows
          where symbol like $1
          order by symbol asc
          limit $2 offset $3
        `,
        rowsParams: ["A%", viewportSize, 0],
      },
      sqlite: {
        countSql: "select count(*) as count from demo_rows where symbol like ?",
        countParams: ["A%"],
        rowsSql: `
          select id, symbol, company, sector, venue, price
          from demo_rows
          where symbol like ?
          order by symbol asc
          limit ? offset ?
        `,
        rowsParams: ["A%", viewportSize, 0],
      },
    },
  ];

  for (const benchCase of cases) {
    await runPgliteCase(pglite, benchCase.pglite);
    runSqliteCase(sqlite, benchCase.sqlite);
  }

  console.log(`Generated ${rowCount.toLocaleString()} rows in ${generationElapsedMs.toFixed(2)} ms`);
  console.log(`PGlite ready in ${pgliteReadyElapsedMs.toFixed(2)} ms`);
  console.log(`Loaded PGlite rows without indexes in ${pgliteLoadElapsedMs.toFixed(2)} ms`);
  console.log(`SQLite Wasm ready in ${sqliteReadyElapsedMs.toFixed(2)} ms`);
  console.log(`Loaded SQLite Wasm rows without indexes in ${sqliteLoadElapsedMs.toFixed(2)} ms`);
  console.log(`Viewport size: ${viewportSize}`);
  console.log(`Iterations per case: ${iterations}`);

  try {
    for (const benchCase of cases) {
      const pgliteSamples: Array<Sample> = [];
      const sqliteSamples: Array<Sample> = [];

      for (let iteration = 0; iteration < iterations; iteration += 1) {
        pgliteSamples.push(
          await measureAsync(async () => {
            await runPgliteCase(pglite, benchCase.pglite);
          }),
        );
        sqliteSamples.push(
          measure(() => {
            runSqliteCase(sqlite, benchCase.sqlite);
          }),
        );
      }

      const pgliteSummary = summarize(pgliteSamples);
      const sqliteSummary = summarize(sqliteSamples);

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
