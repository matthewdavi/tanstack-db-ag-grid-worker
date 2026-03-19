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
}

type MaybeMany<T> = T | ReadonlyArray<T>;

type DirectWriteUpdate<T extends object> = Partial<T>;

export interface DirectWriteCollectionUtils<T extends object, TKey extends string | number> {
  writeBatch(callback: () => void): void;
  writeInsert(data: MaybeMany<T>): void;
  writeUpdate(data: MaybeMany<DirectWriteUpdate<T>>): void;
  writeUpsert(data: MaybeMany<T>): void;
  writeDelete(keys: MaybeMany<TKey>): void;
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
  DirectWriteCollectionUtils<T, TKey>
>;

export interface QueryWindowOptions {
  startRow?: number;
  endRow?: number;
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
  const offset = options?.startRow ?? 0;
  const limit = options?.endRow === undefined
    ? undefined
    : Math.max(0, options.endRow - offset);

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
    }),
  );
}

function bufferedLocalCollectionOptions<T extends object, TKey extends string | number>(config: {
  id: string;
  getKey: (row: T) => TKey;
  initialData?: ReadonlyArray<T>;
}): CollectionConfig<T, TKey, never, DirectWriteCollectionUtils<T, TKey>> {
  const baseOptions = localOnlyCollectionOptions<T, TKey>({
    id: config.id,
    getKey: config.getKey,
    initialData: [],
  });
  let metrics: BufferedCollectionMetrics = {
    lastCommitDurationMs: null,
    lastCommitChangeCount: 0,
    totalCommitCount: 0,
  };
  type DirectWriteOperation =
    | {
        type: "insert" | "upsert";
        value: T;
      }
    | {
        type: "update";
        value: DirectWriteUpdate<T>;
      }
    | {
        type: "delete";
        key: TKey;
      };
  let pendingOperations: Array<DirectWriteOperation> = [];
  let batchDepth = 0;
  let syncState:
    | {
        collection: Collection<T, TKey>;
        begin: Parameters<SyncConfig<T, TKey>["sync"]>[0]["begin"];
        write: Parameters<SyncConfig<T, TKey>["sync"]>[0]["write"];
        commit: Parameters<SyncConfig<T, TKey>["sync"]>[0]["commit"];
        markReady: Parameters<SyncConfig<T, TKey>["sync"]>[0]["markReady"];
      }
    | null = null;

  const asArray = <TItem>(data: MaybeMany<TItem>) =>
    Array.isArray(data) ? data : [data];

  const getCurrentValue = (
    shadow: Map<TKey, T | undefined>,
    key: TKey,
  ) => {
    if (shadow.has(key)) {
      return shadow.get(key);
    }

    return syncState?.collection.get(key);
  };

  const materializeOperations = (
    operations: ReadonlyArray<DirectWriteOperation>,
  ): Array<ChangeMessageOrDeleteKeyMessage<T, TKey>> => {
    const shadow = new Map<TKey, T | undefined>();
    const changes: Array<ChangeMessageOrDeleteKeyMessage<T, TKey>> = [];

    for (const operation of operations) {
      switch (operation.type) {
        case "insert": {
          const key = config.getKey(operation.value);
          shadow.set(key, operation.value);
          changes.push({
            type: "insert",
            value: operation.value,
          });
          break;
        }
        case "update": {
          const key = config.getKey(operation.value as T);
          const current = getCurrentValue(shadow, key);
          if (current === undefined) {
            break;
          }

          const nextValue = {
            ...current,
            ...operation.value,
          } as T;
          shadow.set(key, nextValue);
          changes.push({
            type: "update",
            value: nextValue,
          });
          break;
        }
        case "upsert": {
          const key = config.getKey(operation.value);
          const current = getCurrentValue(shadow, key);
          const nextValue = current === undefined
            ? operation.value
            : ({
                ...current,
                ...operation.value,
              } as T);

          shadow.set(key, nextValue);
          changes.push({
            type: current === undefined ? "insert" : "update",
            value: nextValue,
          });
          break;
        }
        case "delete": {
          if (getCurrentValue(shadow, operation.key) === undefined) {
            break;
          }

          shadow.set(operation.key, undefined);
          changes.push({
            type: "delete",
            key: operation.key,
          });
          break;
        }
      }
    }

    return changes;
  };

  const commitChanges = (changes: ReadonlyArray<ChangeMessageOrDeleteKeyMessage<T, TKey>>) => {
    if (syncState === null || changes.length === 0) {
      return;
    }

    const startedAt = nowMs();
    syncState.begin({ immediate: true });
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

  const flushPendingOperations = () => {
    if (syncState === null || pendingOperations.length === 0) {
      return;
    }

    const operations = pendingOperations;
    pendingOperations = [];
    commitChanges(materializeOperations(operations));
  };

  return {
    ...baseOptions,
    utils: {
      ...baseOptions.utils,
      writeBatch(callback) {
        const savepoint = pendingOperations.length;
        batchDepth += 1;

        try {
          callback();
        } catch (error) {
          pendingOperations.length = savepoint;
          batchDepth -= 1;
          throw error;
        }

        batchDepth -= 1;
        if (batchDepth === 0) {
          flushPendingOperations();
        }
      },
      writeInsert(data) {
        pendingOperations.push(
          ...asArray(data).map((value) => ({
            type: "insert" as const,
            value,
          })),
        );
        if (batchDepth === 0) {
          flushPendingOperations();
        }
      },
      writeUpdate(data) {
        pendingOperations.push(
          ...asArray(data).map((value) => ({
            type: "update" as const,
            value,
          })),
        );
        if (batchDepth === 0) {
          flushPendingOperations();
        }
      },
      writeUpsert(data) {
        pendingOperations.push(
          ...asArray(data).map((value) => ({
            type: "upsert" as const,
            value,
          })),
        );
        if (batchDepth === 0) {
          flushPendingOperations();
        }
      },
      writeDelete(keys) {
        pendingOperations.push(
          ...asArray(keys).map((key) => ({
            type: "delete" as const,
            key,
          })),
        );
        if (batchDepth === 0) {
          flushPendingOperations();
        }
      },
      getMetrics() {
        return metrics;
      },
    },
    sync: {
      sync({ collection, begin, write, commit, markReady }) {
        syncState = {
          collection,
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

        flushPendingOperations();
        markReady();

        return () => {
          pendingOperations = [];
          batchDepth = 0;
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

function toRowCountQueryState(queryState: GridQueryState): GridQueryState {
  return {
    predicate: queryState.predicate,
    sorts: [],
  };
}

export function createRowCountCollection(
  rowsCollection: Collection<RowRecord, string>,
  queryState: GridQueryState,
) {
  return createQueryCollection(rowsCollection, toRowCountQueryState(queryState));
}

export function collectWindowRows<T extends object>(
  collection: {
    values(): IterableIterator<T>;
  },
  range: {
    startRow: number;
    endRow: number;
  },
) {
  const rows: Array<T> = [];
  let index = 0;

  for (const row of collection.values()) {
    if (index >= range.endRow) {
      break;
    }

    if (index >= range.startRow) {
      rows.push(row);
    }

    index += 1;
  }

  return rows;
}

export async function executeGridQuery(
  rowsCollection: Collection<RowRecord, string>,
  queryState: GridQueryState,
  options?: {
    startRow?: number;
    endRow?: number;
  },
) {
  const rowCountCollection = createRowCountCollection(rowsCollection, queryState);
  const queryCollection = createQueryCollection(rowsCollection, queryState);

  await Promise.all([
    rowCountCollection.preload(),
    queryCollection.preload(),
  ]);

  return {
    rowCount: rowCountCollection.size,
    rows: asRowRecords(
      collectWindowRows(queryCollection, {
        startRow: options?.startRow ?? 0,
        endRow: options?.endRow ?? rowCountCollection.size,
      }),
    ),
  };
}
