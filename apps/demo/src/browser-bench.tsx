import { useEffect, useState } from "react";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

const TOTAL_COLUMNS = 70;
const PAYLOAD_COLUMN_COUNT = TOTAL_COLUMNS - 1;
const INTEGER_COLUMN_COUNT = 23;
const REAL_COLUMN_COUNT = 23;
const TEXT_COLUMN_COUNT = PAYLOAD_COLUMN_COUNT - INTEGER_COLUMN_COUNT - REAL_COLUMN_COUNT;
const DEFAULT_ROW_COUNT = 100_000;
const DEFAULT_BATCH_SIZE = 100;

interface BenchResult {
  rowCount: number;
  batchSize: number;
  elapsedMs: number;
  rowsPerSecond: number;
}

function parsePositiveInt(value: string | null, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function makeColumnDefinitions() {
  const definitions = ["id integer primary key"];

  for (let index = 0; index < INTEGER_COLUMN_COUNT; index += 1) {
    definitions.push(`i_${String(index + 1).padStart(2, "0")} integer not null`);
  }

  for (let index = 0; index < REAL_COLUMN_COUNT; index += 1) {
    definitions.push(`r_${String(index + 1).padStart(2, "0")} real not null`);
  }

  for (let index = 0; index < TEXT_COLUMN_COUNT; index += 1) {
    definitions.push(`t_${String(index + 1).padStart(2, "0")} text not null`);
  }

  return definitions;
}

function makeInsertColumns() {
  return [
    "id",
    ...Array.from({ length: INTEGER_COLUMN_COUNT }, (_, index) => `i_${String(index + 1).padStart(2, "0")}`),
    ...Array.from({ length: REAL_COLUMN_COUNT }, (_, index) => `r_${String(index + 1).padStart(2, "0")}`),
    ...Array.from({ length: TEXT_COLUMN_COUNT }, (_, index) => `t_${String(index + 1).padStart(2, "0")}`),
  ];
}

function makeRow(rowIndex: number) {
  const row: Array<number | string> = [rowIndex + 1];

  for (let index = 0; index < INTEGER_COLUMN_COUNT; index += 1) {
    row.push((rowIndex + 1) * (index + 3));
  }

  for (let index = 0; index < REAL_COLUMN_COUNT; index += 1) {
    row.push(Number(((rowIndex + 1) * 1.618 + index * 0.125).toFixed(6)));
  }

  for (let index = 0; index < TEXT_COLUMN_COUNT; index += 1) {
    row.push(`row-${rowIndex + 1}-text-${index + 1}`);
  }

  return row;
}

function makeRows(rowCount: number) {
  return Array.from({ length: rowCount }, (_, index) => makeRow(index));
}

function chunk<T>(values: ReadonlyArray<T>, size: number) {
  const result: Array<ReadonlyArray<T>> = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function makeInsertSql(batchRowCount: number) {
  const columns = makeInsertColumns();
  const placeholdersPerRow = `(${columns.map(() => "?").join(", ")})`;
  const valuesSql = Array.from({ length: batchRowCount }, () => placeholdersPerRow).join(", ");

  return `
    insert into bench_rows (${columns.join(", ")})
    values ${valuesSql}
  `;
}

async function runBrowserBench(rowCount: number, batchSize: number): Promise<BenchResult> {
  const rows = makeRows(rowCount);
  const rowChunks = chunk(rows, batchSize);
  const sqlite3 = await sqlite3InitModule();
  const db = new sqlite3.oo1.DB("/bench-browser.sqlite3", "ct");

  try {
    db.exec("drop table if exists bench_rows");
    db.exec(`create table bench_rows (${makeColumnDefinitions().join(", ")})`);

    const startedAt = performance.now();

    db.exec("begin");
    try {
      for (const rowsInChunk of rowChunks) {
        db.exec({
          sql: makeInsertSql(rowsInChunk.length),
          bind: rowsInChunk.flat(),
        });
      }

      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }

    const elapsedMs = performance.now() - startedAt;
    const [countRow] = db.exec({
      sql: "select count(*) as count from bench_rows",
      rowMode: "object",
      returnValue: "resultRows",
    }) as Array<{ count: number | string }>;

    return {
      rowCount: Number(countRow?.count ?? 0),
      batchSize,
      elapsedMs,
      rowsPerSecond: rowCount / (elapsedMs / 1000),
    };
  } finally {
    db.close();
  }
}

export function BrowserBenchPage() {
  const searchParams = new URLSearchParams(window.location.search);
  const rowCount = parsePositiveInt(searchParams.get("rows"), DEFAULT_ROW_COUNT);
  const batchSize = parsePositiveInt(searchParams.get("batch"), DEFAULT_BATCH_SIZE);
  const [result, setResult] = useState<BenchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        setRunning(true);
        setError(null);
        setResult(null);
        const nextResult = await runBrowserBench(rowCount, batchSize);
        if (!cancelled) {
          setResult(nextResult);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "browser bench failed");
        }
      } finally {
        if (!cancelled) {
          setRunning(false);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [batchSize, rowCount]);

  return (
    <main className={"mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 px-6 py-10 text-zinc-100"}>
      <section className={"rounded-xl border border-zinc-800 bg-zinc-950/70 p-6 shadow-sm"}>
        <p className={"mb-2 text-xs uppercase tracking-[0.2em] text-zinc-500"}>{"browser bench"}</p>
        <h1 className={"m-0 text-3xl font-semibold tracking-tight"}>
          {"sqlite wasm insert benchmark"}
        </h1>
        <p className={"mt-3 max-w-2xl text-sm leading-relaxed text-zinc-400"}>
          {
            "real browser run. 70 total columns, one transaction, multi-row insert batches. tweak with ?rows=100000&batch=100."
          }
        </p>
      </section>

      <section className={"grid gap-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 shadow-sm"}>
        <div className={"grid gap-2 text-sm text-zinc-300 sm:grid-cols-2"}>
          <span>{`rows: ${rowCount.toLocaleString()}`}</span>
          <span>{`batch size: ${batchSize.toLocaleString()}`}</span>
          <span>{`columns: ${TOTAL_COLUMNS} total`}</span>
          <span>{"mix: 1 id, 23 integer, 23 real, 23 text"}</span>
        </div>

        {running ? (
          <p className={"m-0 text-sm text-zinc-400"}>{"running benchmark..."}</p>
        ) : null}

        {error !== null ? (
          <p className={"m-0 rounded-lg border border-red-500/30 bg-red-950/40 px-4 py-3 text-sm text-red-200"}>
            {error}
          </p>
        ) : null}

        {result !== null ? (
          <div className={"grid gap-3 rounded-lg border border-zinc-800 bg-zinc-950/70 p-5 font-mono text-sm text-zinc-200"}>
            <div>{`inserted rows: ${result.rowCount.toLocaleString()}`}</div>
            <div>{`elapsed ms: ${result.elapsedMs.toFixed(2)}`}</div>
            <div>{`rows/sec: ${Math.round(result.rowsPerSecond).toLocaleString()}`}</div>
          </div>
        ) : null}
      </section>
    </main>
  );
}
