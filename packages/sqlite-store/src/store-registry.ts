import sqlite3InitModule, {
  type BindingSpec,
  type Database as SqliteDatabase,
  type Sqlite3Static as SqliteModule,
} from "@sqlite.org/sqlite-wasm";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as FiberApi from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Runtime from "effect/Runtime";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import type { GridQueryState } from "@sandbox/ag-grid-translator";

import { createDemoRowFactory, generateDemoRows } from "./demo-data";
import type { RowRecord } from "./row-schema";
import { planViewportQuery } from "./sql-planner";
import type {
  ApplyTransactionSuccess,
  CloseViewportSessionSuccess,
  DisposeStoreSuccess,
  LoadStoreSuccess,
  OpenViewportSessionRequest,
  ReplaceViewportSessionRequest,
  ReplaceViewportSessionSuccess,
  StoreDefinition,
  StoreMetrics,
  StoreSource,
  StoreTransaction,
  StressState,
  ViewportPatch,
} from "./worker-contract";

type SqliteDatabaseFactory = (
  storeId: string,
  sqlite3: SqliteModule,
) => SqliteDatabase | Promise<SqliteDatabase>;

const DEFAULT_STRESS_TICK_MS = 100;
const DEFAULT_WRITE_REFRESH_THROTTLE_MS = 100;

interface StoreEntry {
  readonly storeId: string;
  readonly rowKey: string;
  readonly db: SqliteDatabase;
  readonly makeStressRow: () => RowRecord;
  rowCount: number;
  rowsPerSecond: number;
  metrics: StoreMetrics;
  stressFiber: Fiber.RuntimeFiber<void, unknown> | null;
}

interface ViewportRequest {
  startRow: number;
  endRow: number;
  query: GridQueryState;
}

interface ViewportSession {
  readonly sessionId: string;
  readonly storeId: string;
  readonly queue: Queue.Queue<ViewportPatch>;
  request: ViewportRequest;
  runId: number;
  inFlightCount: number;
  closed: boolean;
  dirty: boolean;
  throttledRefreshFiber: Fiber.RuntimeFiber<void, unknown> | null;
}

let sqliteModulePromise: Promise<SqliteModule> | null = null;

function mapError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function getSqliteModule() {
  sqliteModulePromise ??= sqlite3InitModule();
  return sqliteModulePromise;
}

function asViewportRequest(
  request: Pick<OpenViewportSessionRequest, "startRow" | "endRow" | "query">,
): ViewportRequest {
  return {
    startRow: request.startRow,
    endRow: request.endRow,
    query: request.query,
  };
}

function createPlaceholders(count: number) {
  return Array.from({ length: count }, () => "?").join(", ");
}

function normalizeRow(row: Record<string, unknown>): RowRecord {
  return {
    id: String(row.id),
    active: Boolean(row.active),
    symbol: String(row.symbol),
    company: String(row.company),
    sector: String(row.sector),
    venue: String(row.venue),
    price: Number(row.price),
    volume: Number(row.volume),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function loadRows(
  db: SqliteDatabase,
  rows: ReadonlyArray<RowRecord>,
) {
  db.exec(`
    create table "demo_rows" (
      "id" text primary key,
      "active" integer not null,
      "symbol" text not null,
      "company" text not null,
      "sector" text not null,
      "venue" text not null,
      "price" real not null,
      "volume" integer not null,
      "created_at" text not null,
      "updated_at" text not null
    );
  `);

  db.exec("begin");
  try {
    const statement = db.prepare(`
      insert into "demo_rows" (
        "id",
        "active",
        "symbol",
        "company",
        "sector",
        "venue",
        "price",
        "volume",
        "created_at",
        "updated_at"
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

  db.exec(`analyze "demo_rows"`);
}

function readRowCount(db: SqliteDatabase) {
  return Number(db.selectValue(`select count(*) from "demo_rows"`) ?? 0);
}

function selectValue(
  db: SqliteDatabase,
  sql: string,
  params: ReadonlyArray<unknown>,
) {
  return params.length === 0
    ? db.selectValue(sql)
    : db.selectValue(sql, [...params] as BindingSpec);
}

function selectObjects(
  db: SqliteDatabase,
  sql: string,
  params: ReadonlyArray<unknown>,
) {
  return params.length === 0
    ? db.selectObjects(sql)
    : db.selectObjects(sql, [...params] as BindingSpec);
}

export class StoreRegistry {
  private readonly stores = new Map<string, StoreEntry>();
  private readonly viewportSessions = new Map<string, ViewportSession>();
  private readonly writeRefreshThrottleMs: number;
  private readonly runtime: Runtime.Runtime<never>;
  private readonly createDatabase: SqliteDatabaseFactory;

  constructor(options?: {
    writeRefreshThrottleMs?: number;
    runtime?: Runtime.Runtime<never>;
    createDatabase?: SqliteDatabaseFactory;
  }) {
    this.writeRefreshThrottleMs = options?.writeRefreshThrottleMs ?? DEFAULT_WRITE_REFRESH_THROTTLE_MS;
    this.runtime = options?.runtime ?? Runtime.defaultRuntime;
    this.createDatabase = options?.createDatabase ?? ((storeId, sqlite3) =>
      new sqlite3.oo1.DB(":memory:", "c") as SqliteDatabase);
  }

  async loadStore(
    definition: StoreDefinition,
    source: StoreSource,
  ): Promise<LoadStoreSuccess> {
    if (this.stores.has(definition.storeId)) {
      throw new Error(`Store already exists: ${definition.storeId}`);
    }

    const rows = source.kind === "rows"
      ? [...source.rows]
      : generateDemoRows(source.rowCount, source.seed ?? 1);

    const sqlite3 = await getSqliteModule();
    const db = await this.createDatabase(definition.storeId, sqlite3);
    loadRows(db, rows);

    const entry: StoreEntry = {
      storeId: definition.storeId,
      rowKey: definition.rowKey,
      db,
      makeStressRow: createDemoRowFactory(
        (source.kind === "generator" ? source.seed ?? 1 : rows.length) + rows.length,
        rows.length,
        { realtimeTimestamps: true },
      ),
      rowCount: rows.length,
      rowsPerSecond: 0,
      metrics: {
        lastCommitDurationMs: null,
        lastCommitChangeCount: 0,
        totalCommitCount: 0,
      },
      stressFiber: null,
    };
    this.stores.set(definition.storeId, entry);

    return {
      storeId: definition.storeId,
      rowCount: entry.rowCount,
      metrics: entry.metrics,
    };
  }

  openViewportSession(request: OpenViewportSessionRequest) {
    const self = this;
    return Stream.unwrapScoped(
      Effect.acquireRelease(
        Effect.tryPromise({
          try: () => self.makeViewportSession(request),
          catch: (error) => mapError(error, "Failed to open viewport session"),
        }),
        (session) =>
          Effect.promise(() => self.closeViewportSession(session.sessionId)).pipe(Effect.ignore),
      ).pipe(Effect.map((session) => Stream.fromQueue(session.queue))),
    );
  }

  replaceViewportSession(
    request: ReplaceViewportSessionRequest,
  ): Effect.Effect<ReplaceViewportSessionSuccess, string> {
    return Effect.tryPromise({
      try: async () => {
        const session = this.requireViewportSession(request.sessionId);
        session.request = asViewportRequest(request);
        await this.runViewportQuery(session, null);
        return {
          sessionId: request.sessionId,
          replaced: true,
        };
      },
      catch: (error) => mapError(error, "Failed to replace viewport session"),
    });
  }

  closeViewportSession(sessionId: string): Promise<CloseViewportSessionSuccess> {
    return (async () => {
      const session = this.viewportSessions.get(sessionId);
      if (!session) {
        return {
          sessionId,
          closed: true,
        };
      }

      session.closed = true;
      if (session.throttledRefreshFiber !== null) {
        await this.runPromise(FiberApi.interrupt(session.throttledRefreshFiber));
        session.throttledRefreshFiber = null;
      }
      this.viewportSessions.delete(sessionId);
      await this.runPromise(Queue.shutdown(session.queue));

      return {
        sessionId,
        closed: true,
      };
    })();
  }

  async applyTransaction(
    storeId: string,
    transaction: StoreTransaction,
  ): Promise<ApplyTransactionSuccess> {
    const entry = this.requireStore(storeId);
    const startedAt = await this.currentTimeMs();

    if (transaction.kind === "upsert") {
      entry.db.exec("begin");
      try {
        const statement = entry.db.prepare(`
          insert into "demo_rows" (
            "id",
            "active",
            "symbol",
            "company",
            "sector",
            "venue",
            "price",
            "volume",
            "created_at",
            "updated_at"
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict ("id") do update set
            "active" = excluded."active",
            "symbol" = excluded."symbol",
            "company" = excluded."company",
            "sector" = excluded."sector",
            "venue" = excluded."venue",
            "price" = excluded."price",
            "volume" = excluded."volume",
            "created_at" = excluded."created_at",
            "updated_at" = excluded."updated_at"
        `);

        try {
          for (const row of transaction.rows) {
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

        entry.db.exec("commit");
      } catch (error) {
        entry.db.exec("rollback");
        throw error;
      }
    } else if (transaction.ids.length > 0) {
      entry.db.exec({
        sql: `delete from "demo_rows" where "id" in (${createPlaceholders(transaction.ids.length)})`,
        bind: [...transaction.ids],
      });
    }

    entry.rowCount = readRowCount(entry.db);
    const completedAt = await this.currentTimeMs();
    entry.metrics = {
      lastCommitDurationMs: completedAt - startedAt,
      lastCommitChangeCount:
        transaction.kind === "upsert" ? transaction.rows.length : transaction.ids.length,
      totalCommitCount: entry.metrics.totalCommitCount + 1,
    };
    await this.scheduleViewportRefreshes(storeId);

    return {
      storeId,
      rowCount: entry.rowCount,
      metrics: entry.metrics,
    };
  }

  setStressRate(storeId: string, rowsPerSecond: number): StressState {
    const entry = this.requireStore(storeId);
    entry.rowsPerSecond = rowsPerSecond;
    this.stopStress(entry);

    if (rowsPerSecond > 0) {
      entry.stressFiber = this.runFork(
        Stream.runForEach(
          Stream.repeatEffect(Effect.sync(() => this.makeStressBatch(entry))).pipe(
            Stream.schedule(
              Schedule.spaced(Duration.millis(this.getStressIntervalMs(rowsPerSecond))),
            ),
          ),
          (rows) =>
            Effect.promise(() =>
              this.applyTransaction(storeId, {
                kind: "upsert",
                rows,
              }),
            ).pipe(Effect.asVoid),
        ),
      );
    }

    return {
      storeId,
      rowsPerSecond,
      running: rowsPerSecond > 0,
      rowCount: entry.rowCount,
      metrics: entry.metrics,
    };
  }

  disposeStore(storeId: string): DisposeStoreSuccess {
    const entry = this.stores.get(storeId);
    if (!entry) {
      return {
        storeId,
        disposed: true,
      };
    }

    this.stopStress(entry);
    this.stores.delete(storeId);
    for (const [sessionId, session] of this.viewportSessions.entries()) {
      if (session.storeId === storeId) {
        void this.closeViewportSession(sessionId);
      }
    }
    entry.db.close();

    return {
      storeId,
      disposed: true,
    };
  }

  private makeStressBatch(entry: StoreEntry) {
    const batchSize = this.getStressBatchSize(entry.rowsPerSecond);
    return Array.from({ length: batchSize }, () => entry.makeStressRow());
  }

  private getStressBatchSize(rowsPerSecond: number) {
    return Math.max(1, Math.round((rowsPerSecond * DEFAULT_STRESS_TICK_MS) / 1000));
  }

  private getStressIntervalMs(rowsPerSecond: number) {
    const batchSize = this.getStressBatchSize(rowsPerSecond);
    return Math.max(16, Math.round((1000 * batchSize) / Math.max(rowsPerSecond, 1)));
  }

  private stopStress(entry: StoreEntry) {
    if (entry.stressFiber === null) {
      return;
    }
    const fiber = entry.stressFiber;
    entry.stressFiber = null;
    void this.runPromise(FiberApi.interrupt(fiber));
  }

  private async makeViewportSession(request: OpenViewportSessionRequest) {
    if (this.viewportSessions.has(request.sessionId)) {
      throw new Error(`Viewport session already exists: ${request.sessionId}`);
    }
    this.requireStore(request.storeId);

    const queue = await this.runPromise(Queue.unbounded<ViewportPatch>());
    const session: ViewportSession = {
      sessionId: request.sessionId,
      storeId: request.storeId,
      queue,
      request: asViewportRequest(request),
      runId: 0,
      inFlightCount: 0,
      closed: false,
      dirty: false,
      throttledRefreshFiber: null,
    };
    this.viewportSessions.set(session.sessionId, session);
    try {
      await this.runViewportQuery(session, null);
      return session;
    } catch (error) {
      this.viewportSessions.delete(session.sessionId);
      await this.runPromise(Queue.shutdown(queue));
      throw error;
    }
  }

  private async scheduleViewportRefreshes(storeId: string) {
    for (const session of this.viewportSessions.values()) {
      if (session.storeId !== storeId || session.closed) {
        continue;
      }
      session.dirty = true;
      this.scheduleViewportRefresh(session);
    }
  }

  private async flushViewportRefresh(session: ViewportSession) {
    if (session.closed) {
      return;
    }
    if (session.inFlightCount > 0) {
      this.scheduleViewportRefresh(session);
      return;
    }
    if (!session.dirty) {
      return;
    }

    session.dirty = false;
    const triggeredAtMs = await this.currentTimeMs();
    await this.runViewportQuery(session, triggeredAtMs);

    if (session.dirty) {
      this.scheduleViewportRefresh(session);
    }
  }

  private async runViewportQuery(session: ViewportSession, triggeredAtMs: number | null) {
    const entry = this.requireStore(session.storeId);
    const runId = ++session.runId;
    const request = session.request;
    session.inFlightCount += 1;

    try {
      const plan = planViewportQuery(request.query, request);
      const rowCount = Number(selectValue(entry.db, plan.countSql, plan.countParams) ?? 0);
      const rows = selectObjects(entry.db, plan.rowsSql, plan.rowsParams).map(normalizeRow);

      if (session.closed || runId !== session.runId || !session.queue.isActive()) {
        return;
      }

      const emittedAtMs = await this.currentTimeMs();
      await this.runPromise(
        Queue.offer(session.queue, {
          storeId: entry.storeId,
          startRow: request.startRow,
          endRow: request.endRow,
          rowCount,
          latencyMs: triggeredAtMs === null ? 0 : Math.max(0, emittedAtMs - triggeredAtMs),
          metrics: entry.metrics,
          rows,
        }),
      );
    } finally {
      session.inFlightCount -= 1;
    }
  }

  private requireStore(storeId: string) {
    const entry = this.stores.get(storeId);
    if (!entry) {
      throw new Error(`Unknown store: ${storeId}`);
    }
    return entry;
  }

  private requireViewportSession(sessionId: string) {
    const session = this.viewportSessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown viewport session: ${sessionId}`);
    }
    return session;
  }

  private scheduleViewportRefresh(session: ViewportSession) {
    if (session.closed || session.throttledRefreshFiber !== null) {
      return;
    }

    let fiber: Fiber.RuntimeFiber<void, unknown>;
    fiber = this.runFork(
      Effect.sleep(Duration.millis(this.writeRefreshThrottleMs)).pipe(
        Effect.andThen(Effect.promise(() => this.flushViewportRefresh(session))),
        Effect.ensuring(
          Effect.sync(() => {
            if (session.throttledRefreshFiber === fiber) {
              session.throttledRefreshFiber = null;
            }
          }),
        ),
      ),
    );
    session.throttledRefreshFiber = fiber;
  }

  private currentTimeMs() {
    return this.runPromise(Clock.currentTimeMillis);
  }

  private runFork<A, E>(effect: Effect.Effect<A, E, never>) {
    return Runtime.runFork(this.runtime)(effect);
  }

  private runPromise<A, E>(effect: Effect.Effect<A, E, never>) {
    return Runtime.runPromise(this.runtime)(effect);
  }
}
