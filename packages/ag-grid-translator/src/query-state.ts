import { Schema } from "effect";

export type GridScalar = string | number | boolean | null;

export type ComparisonOperator =
  | "eq"
  | "neq"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "inRange"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "blank"
  | "notBlank"
  | "set"
  | "true"
  | "false";

export interface GridComparisonPredicate {
  kind: "comparison";
  field: string;
  filterType: string;
  operator: ComparisonOperator;
  value?: GridScalar;
  valueTo?: GridScalar;
  values?: ReadonlyArray<string | null>;
}

export interface GridPredicateGroup {
  kind: "group";
  operator: "and" | "or";
  predicates: ReadonlyArray<GridPredicate>;
}

export type GridPredicate = GridComparisonPredicate | GridPredicateGroup;

export interface GridSort {
  field: string;
  direction: "asc" | "desc";
}

export interface GridQueryState {
  predicate: GridPredicate | null;
  sorts: ReadonlyArray<GridSort>;
}

export const GridScalarSchema = Schema.Union(
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Null,
) as Schema.Schema<GridScalar>;

export const ComparisonOperatorSchema = Schema.Literal(
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "inRange",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "blank",
  "notBlank",
  "set",
  "true",
  "false",
) as Schema.Schema<ComparisonOperator>;

export const GridComparisonPredicateSchema =
  Schema.Struct({
    kind: Schema.Literal("comparison"),
    field: Schema.String,
    filterType: Schema.String,
    operator: ComparisonOperatorSchema,
    value: Schema.optionalWith(GridScalarSchema, { nullable: true }),
    valueTo: Schema.optionalWith(GridScalarSchema, { nullable: true }),
    values: Schema.optionalWith(Schema.Array(Schema.NullOr(Schema.String)), {
      nullable: true,
    }),
  }) as Schema.Schema<GridComparisonPredicate>;

export const GridPredicateSchema: Schema.Schema<GridPredicate> = Schema.suspend(
  (): Schema.Schema<GridPredicate> =>
    Schema.Union(
      GridComparisonPredicateSchema,
      Schema.Struct({
        kind: Schema.Literal("group"),
        operator: Schema.Literal("and", "or"),
        predicates: Schema.Array(GridPredicateSchema),
      }) as unknown as Schema.Schema<GridPredicateGroup>,
    ) as Schema.Schema<GridPredicate>,
);

export const GridSortSchema = Schema.Struct({
  field: Schema.String,
  direction: Schema.Literal("asc", "desc"),
}) as Schema.Schema<GridSort>;

export const GridQueryStateSchema = Schema.Struct({
  predicate: Schema.NullOr(GridPredicateSchema),
  sorts: Schema.Array(GridSortSchema),
}) as unknown as Schema.Schema<GridQueryState>;
