import { Schema } from "effect";

export type SimpleFilterType =
  | "empty"
  | "equals"
  | "notEqual"
  | "lessThan"
  | "lessThanOrEqual"
  | "greaterThan"
  | "greaterThanOrEqual"
  | "inRange"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "blank"
  | "notBlank"
  | "today"
  | "yesterday"
  | "tomorrow"
  | "thisWeek"
  | "lastWeek"
  | "nextWeek"
  | "thisMonth"
  | "lastMonth"
  | "nextMonth"
  | "thisQuarter"
  | "lastQuarter"
  | "nextQuarter"
  | "thisYear"
  | "lastYear"
  | "nextYear"
  | "yearToDate"
  | "last7Days"
  | "last30Days"
  | "last90Days"
  | "last6Months"
  | "last12Months"
  | "last24Months";

export type JoinOperator = "AND" | "OR";

export interface TextFilterCondition {
  filterType?: "text" | null;
  type?: SimpleFilterType | null;
  filter?: string | null;
  filterTo?: string | null;
}

export interface NumberFilterCondition {
  filterType?: "number" | null;
  type?: SimpleFilterType | null;
  filter?: number | null;
  filterTo?: number | null;
}

export interface DateFilterCondition {
  filterType?: "date" | null;
  type?: SimpleFilterType | null;
  dateFrom?: string | null;
  dateTo?: string | null;
}

export interface SetFilterCondition {
  filterType?: "set" | null;
  values: ReadonlyArray<string | null>;
}

export interface MultiFilterCondition {
  filterType?: "multi" | null;
  filterModels: ReadonlyArray<ColumnFilterState | null> | null;
}

export interface CombinedTextFilter {
  filterType?: "text" | null;
  operator: JoinOperator;
  conditions: ReadonlyArray<TextFilterCondition>;
}

export interface CombinedNumberFilter {
  filterType?: "number" | null;
  operator: JoinOperator;
  conditions: ReadonlyArray<NumberFilterCondition>;
}

export interface CombinedDateFilter {
  filterType?: "date" | null;
  operator: JoinOperator;
  conditions: ReadonlyArray<DateFilterCondition>;
}

export type ColumnFilterState =
  | TextFilterCondition
  | NumberFilterCondition
  | DateFilterCondition
  | SetFilterCondition
  | MultiFilterCondition
  | CombinedTextFilter
  | CombinedNumberFilter
  | CombinedDateFilter;

export type GridColumnFilterState = Record<string, ColumnFilterState>;

export type ScalarAdvancedFilterType =
  | "equals"
  | "notEqual"
  | "lessThan"
  | "lessThanOrEqual"
  | "greaterThan"
  | "greaterThanOrEqual"
  | "blank"
  | "notBlank";

export interface JoinAdvancedFilterModel {
  filterType: "join";
  type: JoinOperator;
  conditions: ReadonlyArray<AdvancedFilterModel>;
}

export interface TextAdvancedFilterModel {
  filterType: "text";
  colId: string;
  type:
    | "equals"
    | "notEqual"
    | "contains"
    | "notContains"
    | "startsWith"
    | "endsWith"
    | "blank"
    | "notBlank";
  filter?: string | null;
}

export interface NumberAdvancedFilterModel {
  filterType: "number";
  colId: string;
  type: ScalarAdvancedFilterType;
  filter?: number | null;
}

export interface DateLikeAdvancedFilterModel {
  filterType: "date" | "dateString" | "dateTime" | "dateTimeString" | "bigint";
  colId: string;
  type: ScalarAdvancedFilterType;
  filter?: string | null;
}

export interface BooleanAdvancedFilterModel {
  filterType: "boolean";
  colId: string;
  type: "true" | "false";
}

export interface ObjectAdvancedFilterModel {
  filterType: "object";
  colId: string;
  type:
    | "equals"
    | "notEqual"
    | "contains"
    | "notContains"
    | "startsWith"
    | "endsWith"
    | "blank"
    | "notBlank";
  filter?: string | null;
}

export type AdvancedFilterModel =
  | JoinAdvancedFilterModel
  | TextAdvancedFilterModel
  | NumberAdvancedFilterModel
  | DateLikeAdvancedFilterModel
  | BooleanAdvancedFilterModel
  | ObjectAdvancedFilterModel;

export interface GridSortItem {
  colId: string;
  sort: "asc" | "desc";
  type?: string;
}

export type GridSortState = ReadonlyArray<GridSortItem>;

export const GridColumnFilterStateSchema =
  Schema.Unknown as unknown as Schema.Schema<GridColumnFilterState>;

export const AdvancedFilterModelSchema =
  Schema.Unknown as unknown as Schema.Schema<AdvancedFilterModel>;

export const GridSortStateSchema =
  Schema.Unknown as unknown as Schema.Schema<GridSortState>;
