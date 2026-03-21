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

// The translator package only needs lightweight serialization schemas for RPC payloads.
// Runtime validation happens in the explicit decode helpers in translate.ts.
export const GridScalarSchema =
  Schema.Unknown as unknown as Schema.Schema<GridScalar>;

export const ComparisonOperatorSchema =
  Schema.Unknown as unknown as Schema.Schema<ComparisonOperator>;

export const GridComparisonPredicateSchema =
  Schema.Unknown as unknown as Schema.Schema<GridComparisonPredicate>;

export const GridPredicateSchema =
  Schema.Unknown as unknown as Schema.Schema<GridPredicate>;

export const GridSortSchema =
  Schema.Unknown as unknown as Schema.Schema<GridSort>;

export const GridQueryStateSchema =
  Schema.Unknown as unknown as Schema.Schema<GridQueryState>;
