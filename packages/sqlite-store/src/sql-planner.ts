import type { GridComparisonPredicate, GridPredicate, GridQueryState } from "@sandbox/ag-grid-translator";
import type { SqliteRow, SqliteStoreDefinition } from "./store-config";

export interface SqlPlan {
  readonly countSql: string;
  readonly countParams: ReadonlyArray<unknown>;
  readonly rowsSql: string;
  readonly rowsParams: ReadonlyArray<unknown>;
}

interface SqlBuilderState {
  params: Array<unknown>;
}

function getColumnSql<TRow extends SqliteRow>(
  store: SqliteStoreDefinition<object, TRow>,
  field: string,
) {
  const columnSql = store.columns[field as keyof typeof store.columns]?.columnSql;
  if (!columnSql) {
    throw new Error(`Unsupported field: ${field}`);
  }
  return columnSql;
}

function pushParam(state: SqlBuilderState, value: unknown) {
  state.params.push(value);
  return "?";
}

function escapeLike(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function blankSql<TRow extends SqliteRow>(
  store: SqliteStoreDefinition<object, TRow>,
  field: string,
) {
  const columnSql = getColumnSql(store, field);
  return `(${columnSql} is null or ${columnSql} = '')`;
}

function comparisonSql<TRow extends SqliteRow>(
  store: SqliteStoreDefinition<object, TRow>,
  predicate: GridComparisonPredicate,
  state: SqlBuilderState,
): string {
  const columnSql = getColumnSql(store, predicate.field);
  const textOperatorValue = String(predicate.value ?? "");
  const loweredColumnSql = `lower(${columnSql})`;

  switch (predicate.operator) {
    case "eq":
      if (predicate.value === null) {
        return `${columnSql} is null`;
      }
      return `${columnSql} = ${pushParam(state, predicate.value)}`;
    case "neq":
      if (predicate.value === null) {
        return `${columnSql} is not null`;
      }
      return `${columnSql} is distinct from ${pushParam(state, predicate.value)}`;
    case "lt":
      return `${columnSql} < ${pushParam(state, predicate.value ?? null)}`;
    case "lte":
      return `${columnSql} <= ${pushParam(state, predicate.value ?? null)}`;
    case "gt":
      return `${columnSql} > ${pushParam(state, predicate.value ?? null)}`;
    case "gte":
      return `${columnSql} >= ${pushParam(state, predicate.value ?? null)}`;
    case "inRange":
      return `(${columnSql} >= ${pushParam(state, predicate.value ?? null)} and ${columnSql} <= ${pushParam(state, predicate.valueTo ?? null)})`;
    case "contains":
      return `${loweredColumnSql} like ${pushParam(state, `%${escapeLike(textOperatorValue.toLowerCase())}%`)} escape '\\'`;
    case "notContains":
      return `not (${loweredColumnSql} like ${pushParam(state, `%${escapeLike(textOperatorValue.toLowerCase())}%`)} escape '\\')`;
    case "startsWith":
      return `${loweredColumnSql} like ${pushParam(state, `${escapeLike(textOperatorValue.toLowerCase())}%`)} escape '\\'`;
    case "endsWith":
      return `${loweredColumnSql} like ${pushParam(state, `%${escapeLike(textOperatorValue.toLowerCase())}`)} escape '\\'`;
    case "blank":
      return blankSql(store, predicate.field);
    case "notBlank":
      return `not ${blankSql(store, predicate.field)}`;
    case "set": {
      const values = predicate.values ?? [];
      if (values.length === 0) {
        return "1 = 0";
      }
      const placeholders = values.map((value) => pushParam(state, value));
      return `${columnSql} in (${placeholders.join(", ")})`;
    }
    case "true":
      return `${columnSql} = true`;
    case "false":
      return `${columnSql} = false`;
    default:
      throw new Error(`Unsupported operator: ${predicate.operator satisfies never}`);
  }
}

function predicateSql<TRow extends SqliteRow>(
  store: SqliteStoreDefinition<object, TRow>,
  predicate: GridPredicate | null,
  state: SqlBuilderState,
): string | null {
  if (predicate === null) {
    return null;
  }

  if (predicate.kind === "comparison") {
    return comparisonSql(store, predicate, state);
  }

  const children = predicate.predicates
    .map((entry) => predicateSql(store, entry, state))
    .filter((entry): entry is string => entry !== null);

  if (children.length === 0) {
    return null;
  }

  if (children.length === 1) {
    return children[0];
  }

  const joiner = predicate.operator === "or" ? " or " : " and ";
  return `(${children.join(joiner)})`;
}

function orderBySql<TRow extends SqliteRow>(
  store: SqliteStoreDefinition<object, TRow>,
  query: GridQueryState,
): string {
  if (query.sorts.length === 0) {
    return `order by ${store.rowKeyColumn.columnSql} asc`;
  }

  return `order by ${query.sorts.map((sort) => `${getColumnSql(store, sort.field)} ${sort.direction}`).join(", ")}`;
}

export function planViewportQuery<TRow extends SqliteRow>(
  store: SqliteStoreDefinition<object, TRow>,
  query: GridQueryState,
  range: {
    startRow: number;
    endRow: number;
  },
): SqlPlan {
  const countState: SqlBuilderState = { params: [] };
  const rowsState: SqlBuilderState = { params: [] };
  const whereCount = predicateSql(store, query.predicate, countState);
  const whereRows = predicateSql(store, query.predicate, rowsState);
  const whereClauseCount = whereCount ? ` where ${whereCount}` : "";
  const whereClauseRows = whereRows ? ` where ${whereRows}` : "";
  const limit = Math.max(0, range.endRow - range.startRow);
  const limitPlaceholder = pushParam(rowsState, limit);
  const offsetPlaceholder = pushParam(rowsState, Math.max(0, range.startRow));
  const tableSql = `"${store.tableName.replaceAll(`"`, `""`)}"`;

  return {
    countSql: `select count(*) as count from ${tableSql}${whereClauseCount}`,
    countParams: countState.params,
    rowsSql: [
      `select ${store.selectListSql}`,
      `from ${tableSql}${whereClauseRows}`,
      orderBySql(store, query),
      `limit ${limitPlaceholder} offset ${offsetPlaceholder}`,
    ].join(" "),
    rowsParams: rowsState.params,
  };
}
