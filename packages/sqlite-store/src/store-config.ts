import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";

export type SqliteRow = Record<string, unknown>;

type InferTableRow<TTable> = TTable extends { $inferSelect: infer TRow }
  ? Extract<TRow, SqliteRow>
  : SqliteRow;

type RowKeyOf<TRow extends SqliteRow> = Extract<keyof TRow, string>;

export interface SqliteRowFactoryHooks<TRow extends SqliteRow> {
  generateRows?(rowCount: number, seed?: number | null): ReadonlyArray<TRow>;
}

export interface SqliteStoreColumn<Field extends string = string> {
  readonly field: Field;
  readonly columnName: string;
  readonly columnSql: string;
  readonly sqlType: string;
  readonly dataType: string;
  readonly notNull: boolean;
  readonly primary: boolean;
}

export interface SqliteStoreDefinition<
  TTable extends object = object,
  TRow extends SqliteRow = InferTableRow<TTable>,
> {
  readonly table: TTable;
  readonly tableName: string;
  readonly rowKey: RowKeyOf<TRow>;
  readonly rowKeyColumn: SqliteStoreColumn<RowKeyOf<TRow>>;
  readonly columns: Readonly<Record<RowKeyOf<TRow>, SqliteStoreColumn<RowKeyOf<TRow>>>>;
  readonly columnOrder: ReadonlyArray<RowKeyOf<TRow>>;
  readonly selectListSql: string;
  readonly createTableSql: string;
  readonly upsertSql: string;
  readonly rowFactory?: SqliteRowFactoryHooks<TRow>;
  encodeRow(row: TRow): Array<unknown>;
  decodeRow(row: Record<string, unknown>): TRow;
  deleteSql(idCount: number): string;
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replaceAll(`"`, `""`)}"`;
}

function normalizeDataType(dataType: string) {
  switch (dataType) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
      return dataType;
    default:
      return "unknown";
  }
}

function encodeValue(column: SqliteStoreColumn, value: unknown) {
  if (column.dataType === "boolean") {
    return value ? 1 : 0;
  }

  return value;
}

function decodeValue(column: SqliteStoreColumn, value: unknown) {
  if (value === null || value === undefined) {
    return value;
  }

  switch (column.dataType) {
    case "boolean":
      return Boolean(value);
    case "bigint":
      return typeof value === "bigint" ? value : BigInt(String(value));
    default:
      return value;
  }
}

export function defineSqliteStore<TTable extends object>(
  options: {
    table: TTable;
    rowKey: RowKeyOf<InferTableRow<TTable>>;
    rowFactory?: SqliteRowFactoryHooks<InferTableRow<TTable>>;
  },
): SqliteStoreDefinition<TTable, InferTableRow<TTable>> {
  const tableName = getTableConfig(options.table as never).name;
  const rawColumns = getTableColumns(options.table as never) as Record<string, {
    name: string;
    dataType: string;
    notNull: boolean;
    primary: boolean;
    getSQLType(): string;
  }>;

  type TableRow = InferTableRow<TTable>;
  type TableKey = RowKeyOf<TableRow>;

  const columnEntries = Object.entries(rawColumns).map(([field, column]) => [
    field,
    {
      field,
      columnName: column.name,
      columnSql: quoteIdentifier(column.name),
      sqlType: column.getSQLType(),
      dataType: normalizeDataType(column.dataType),
      notNull: column.notNull,
      primary: column.primary,
    },
  ]) as Array<[TableKey, SqliteStoreColumn<TableKey>]>;

  const columns = Object.fromEntries(columnEntries) as Record<TableKey, SqliteStoreColumn<TableKey>>;
  const columnOrder = columnEntries.map(([field]) => field);
  const rowKeyColumn = columns[options.rowKey];

  if (!rowKeyColumn) {
    throw new Error(`Unknown row key: ${String(options.rowKey)}`);
  }

  const tableSql = quoteIdentifier(tableName);
  const insertColumnsSql = columnOrder.map((field) => columns[field].columnSql).join(", ");
  const upsertAssignmentsSql = columnOrder
    .filter((field) => field !== options.rowKey)
    .map((field) => `${columns[field].columnSql} = excluded.${columns[field].columnSql}`)
    .join(", ");

  return {
    table: options.table,
    tableName,
    rowKey: options.rowKey,
    rowKeyColumn,
    columns,
    columnOrder,
    rowFactory: options.rowFactory,
    selectListSql: columnOrder
      .map((field) => {
        const column = columns[field];
        return column.columnName === field
          ? column.columnSql
          : `${column.columnSql} as ${quoteIdentifier(field)}`;
      })
      .join(", "),
    createTableSql: [
      `create table ${tableSql} (`,
      columnOrder.map((field) => {
        const column = columns[field];
        const parts = [column.columnSql, column.sqlType];
        if (column.primary) {
          parts.push("primary key");
        }
        if (column.notNull) {
          parts.push("not null");
        }
        return `  ${parts.join(" ")}`;
      }).join(",\n"),
      ");",
    ].join("\n"),
    upsertSql: [
      `insert into ${tableSql} (${insertColumnsSql})`,
      `values (${columnOrder.map(() => "?").join(", ")})`,
      upsertAssignmentsSql.length > 0
        ? `on conflict (${rowKeyColumn.columnSql}) do update set ${upsertAssignmentsSql}`
        : `on conflict (${rowKeyColumn.columnSql}) do nothing`,
    ].join(" "),
    encodeRow(row) {
      return columnOrder.map((field) => encodeValue(columns[field], row[field]));
    },
    decodeRow(row) {
      return Object.fromEntries(
        columnOrder.map((field) => [field, decodeValue(columns[field], row[field])]),
      ) as InferTableRow<TTable>;
    },
    deleteSql(idCount) {
      const placeholders = Array.from({ length: idCount }, () => "?").join(", ");
      return `delete from ${tableSql} where ${rowKeyColumn.columnSql} in (${placeholders})`;
    },
  };
}
