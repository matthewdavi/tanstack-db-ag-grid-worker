import {
  and,
  type ChangeMessageOrDeleteKeyMessage,
  type CollectionConfig,
  type SyncConfig,
  createCollection,
  createLiveQueryCollection,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  isUndefined,
  like,
  localOnlyCollectionOptions,
  lt,
  lte,
  not,
  or,
  type Collection,
} from "@tanstack/db";
import type {
  GridComparisonPredicate,
  GridPredicate,
  GridQueryState,
  GridSort,
} from "@sandbox/ag-grid-translator";

export type RowRecord = Record<string, unknown> & { id: string };

export interface RowCollectionOptions {
  id: string;
  getKey?: (row: RowRecord) => string;
  rows?: ReadonlyArray<RowRecord>;
  commitDebounceMs?: number;
}

export interface BufferedCollectionUtils<T extends object, TKey extends string | number> {
  writeChanges(
    changes: ReadonlyArray<ChangeMessageOrDeleteKeyMessage<T, TKey>>,
    options?: {
      immediate?: boolean;
    },
  ): void;
  flushChanges(): void;
  getMetrics(): BufferedCollectionMetrics;
}

export interface BufferedCollectionMetrics {
  lastCommitDurationMs: number | null;
  lastCommitChangeCount: number;
  totalCommitCount: number;
}

export type BufferedCollection<T extends object, TKey extends string | number> = Collection<
  T,
  TKey,
  BufferedCollectionUtils<T, TKey>
>;

interface QueryWindowOptions {
  offset?: number;
  limit?: number;
}

function getFieldRef(row: Record<string, unknown>, field: string) {
  return Reflect.get(row, field);
}

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function asRowRecords(rows: ReadonlyArray<object>) {
  return rows as unknown as ReadonlyArray<RowRecord>;
}

function escapeLike(value: string) {
  return value.replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function blankExpression(fieldRef: unknown) {
  return or(isUndefined(fieldRef), isNull(fieldRef), eq(fieldRef, ""));
}

function comparisonExpression(
  row: Record<string, unknown>,
  predicate: GridComparisonPredicate,
) {
  const fieldRef = getFieldRef(row, predicate.field);

  switch (predicate.operator) {
    case "eq":
      return eq(fieldRef, predicate.value ?? null);
    case "neq":
      return not(eq(fieldRef, predicate.value ?? null));
    case "lt":
      return lt(fieldRef, predicate.value ?? null);
    case "lte":
      return lte(fieldRef, predicate.value ?? null);
    case "gt":
      return gt(fieldRef, predicate.value ?? null);
    case "gte":
      return gte(fieldRef, predicate.value ?? null);
    case "inRange":
      return and(
        gte(fieldRef, predicate.value ?? null),
        lte(fieldRef, predicate.valueTo ?? null),
      );
    case "contains":
      return ilike(fieldRef as string, `%${escapeLike(String(predicate.value ?? ""))}%`);
    case "notContains":
      return not(
        ilike(fieldRef as string, `%${escapeLike(String(predicate.value ?? ""))}%`),
      );
    case "startsWith":
      return ilike(fieldRef as string, `${escapeLike(String(predicate.value ?? ""))}%`);
    case "endsWith":
      return ilike(fieldRef as string, `%${escapeLike(String(predicate.value ?? ""))}`);
    case "blank":
      return blankExpression(fieldRef);
    case "notBlank":
      return not(blankExpression(fieldRef));
    case "set":
      return inArray(fieldRef, [...(predicate.values ?? [])]);
    case "true":
      return eq(fieldRef, true);
    case "false":
      return eq(fieldRef, false);
    default:
      return like(fieldRef as string, String(predicate.value ?? ""));
  }
}

function predicateExpression(
  row: Record<string, unknown>,
  predicate: GridPredicate,
): unknown {
  if (predicate.kind === "comparison") {
    return comparisonExpression(row, predicate);
  }

  const children: ReadonlyArray<unknown> = predicate.predicates.map((entry) =>
    predicateExpression(row, entry),
  );

  if (children.length === 0) {
    return eq(1, 1);
  }

  if (children.length === 1) {
    return children[0];
  }

  const tuple = children as [unknown, unknown, ...unknown[]];
  return predicate.operator === "or" ? or(...tuple) : and(...tuple);
}

function applySorts(
  builder: any,
  sorts: ReadonlyArray<GridSort>,
) {
  return sorts.reduce(
    (current, sort) =>
      current.orderBy(
        ({ rows }: { rows: RowRecord }) =>
          getFieldRef(rows as Record<string, unknown>, sort.field),
        sort.direction,
      ),
    builder,
  );
}

function applyWindow(
  builder: any,
  rowsCollection: Collection<RowRecord, string>,
  queryState: GridQueryState,
  options?: QueryWindowOptions,
) {
  const offset = options?.offset ?? 0;
  const limit = options?.limit;

  if (offset <= 0 && limit === undefined) {
    return builder;
  }

  const hasExplicitSorts = queryState.sorts.length > 0;
  const orderedBuilder = hasExplicitSorts
    ? builder
    : builder.orderBy(({ rows }: { rows: RowRecord }) => rows.id);

  let windowedBuilder = orderedBuilder;

  if (offset > 0) {
    windowedBuilder = windowedBuilder.offset(offset);
  }

  if (limit !== undefined) {
    windowedBuilder = windowedBuilder.limit(limit);
  }

  return windowedBuilder;
}

export function createRowCollection(options: RowCollectionOptions) {
  return createCollection(
    bufferedLocalCollectionOptions<RowRecord, string>({
      id: options.id,
      getKey: options.getKey ?? ((row) => row.id),
      initialData: [...(options.rows ?? [])],
      commitDebounceMs: options.commitDebounceMs,
    }),
  );
}

function bufferedLocalCollectionOptions<T extends object, TKey extends string | number>(config: {
  id: string;
  getKey: (row: T) => TKey;
  initialData?: ReadonlyArray<T>;
  commitDebounceMs?: number;
}): CollectionConfig<T, TKey, never, BufferedCollectionUtils<T, TKey>> {
  const baseOptions = localOnlyCollectionOptions<T, TKey>({
    id: config.id,
    getKey: config.getKey,
    initialData: [],
  });
  const commitDebounceMs = config.commitDebounceMs ?? 100;
  let pendingChanges: Array<ChangeMessageOrDeleteKeyMessage<T, TKey>> = [];
  let flushHandle: ReturnType<typeof setTimeout> | null = null;
  let metrics: BufferedCollectionMetrics = {
    lastCommitDurationMs: null,
    lastCommitChangeCount: 0,
    totalCommitCount: 0,
  };
  let syncState:
    | {
        begin: Parameters<SyncConfig<T, TKey>["sync"]>[0]["begin"];
        write: Parameters<SyncConfig<T, TKey>["sync"]>[0]["write"];
        commit: Parameters<SyncConfig<T, TKey>["sync"]>[0]["commit"];
        markReady: Parameters<SyncConfig<T, TKey>["sync"]>[0]["markReady"];
      }
    | null = null;

  const flushPendingChanges = () => {
    if (flushHandle !== null) {
      clearTimeout(flushHandle);
      flushHandle = null;
    }

    if (syncState === null || pendingChanges.length === 0) {
      return;
    }

    const changes = pendingChanges;
    pendingChanges = [];
    const startedAt = nowMs();
    syncState.begin();
    for (const change of changes) {
      syncState.write(change);
    }
    syncState.commit();
    metrics = {
      lastCommitDurationMs: nowMs() - startedAt,
      lastCommitChangeCount: changes.length,
      totalCommitCount: metrics.totalCommitCount + 1,
    };
  };

  const scheduleFlush = () => {
    if (flushHandle !== null) {
      return;
    }

    if (commitDebounceMs <= 0) {
      flushPendingChanges();
      return;
    }

    flushHandle = setTimeout(() => {
      flushHandle = null;
      flushPendingChanges();
    }, commitDebounceMs);
  };

  return {
    ...baseOptions,
    utils: {
      ...baseOptions.utils,
      writeChanges(changes, options) {
        pendingChanges.push(...changes);
        if (options?.immediate) {
          flushPendingChanges();
          return;
        }
        scheduleFlush();
      },
      flushChanges() {
        flushPendingChanges();
      },
      getMetrics() {
        return metrics;
      },
    },
    sync: {
      sync({ begin, write, commit, markReady }) {
        syncState = {
          begin,
          write,
          commit,
          markReady,
        };

        if (config.initialData && config.initialData.length > 0) {
          const startedAt = nowMs();
          begin();
          for (const row of config.initialData) {
            write({
              type: "insert",
              value: row,
            });
          }
          commit();
          metrics = {
            lastCommitDurationMs: nowMs() - startedAt,
            lastCommitChangeCount: config.initialData.length,
            totalCommitCount: metrics.totalCommitCount + 1,
          };
        }

        flushPendingChanges();
        markReady();

        return () => {
          if (flushHandle !== null) {
            clearTimeout(flushHandle);
            flushHandle = null;
          }
          pendingChanges = [];
          syncState = null;
        };
      },
    },
  };
}

export function createQueryCollection(
  rowsCollection: Collection<RowRecord, string>,
  queryState: GridQueryState,
  options?: QueryWindowOptions,
) {
  return createLiveQueryCollection((q) => {
    let builder = q.from({ rows: rowsCollection });

    if (queryState.predicate) {
      builder = builder.where(({ rows }) =>
        predicateExpression(rows as Record<string, unknown>, queryState.predicate!),
      );
    }

    if (queryState.sorts.length > 0) {
      builder = applySorts(builder as never, queryState.sorts) as never;
    }

    return applyWindow(builder, rowsCollection, queryState, options);
  });
}

export async function executeGridQuery(
  rowsCollection: Collection<RowRecord, string>,
  queryState: GridQueryState,
  options?: {
    offset?: number;
    limit?: number;
  },
) {
  const rowCountCollection = createQueryCollection(rowsCollection, queryState);
  const windowCollection = createQueryCollection(rowsCollection, queryState, options);

  await Promise.all([
    rowCountCollection.preload(),
    windowCollection.preload(),
  ]);

  return {
    rowCount: rowCountCollection.size,
    rows: asRowRecords(windowCollection.toArray),
  };
}
