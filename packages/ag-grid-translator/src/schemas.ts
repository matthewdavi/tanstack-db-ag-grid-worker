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

const NullableString = Schema.optionalWith(Schema.String, { nullable: true });
const NullableNumber = Schema.optionalWith(Schema.Number, { nullable: true });

const SimpleFilterTypeSchema = Schema.Literal(
  "empty",
  "equals",
  "notEqual",
  "lessThan",
  "lessThanOrEqual",
  "greaterThan",
  "greaterThanOrEqual",
  "inRange",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "blank",
  "notBlank",
  "today",
  "yesterday",
  "tomorrow",
  "thisWeek",
  "lastWeek",
  "nextWeek",
  "thisMonth",
  "lastMonth",
  "nextMonth",
  "thisQuarter",
  "lastQuarter",
  "nextQuarter",
  "thisYear",
  "lastYear",
  "nextYear",
  "yearToDate",
  "last7Days",
  "last30Days",
  "last90Days",
  "last6Months",
  "last12Months",
  "last24Months",
) as Schema.Schema<SimpleFilterType>;

const JoinOperatorSchema = Schema.Literal("AND", "OR") as Schema.Schema<JoinOperator>;

const TextFilterConditionSchema = Schema.Struct({
  filterType: Schema.Literal("text"),
  type: Schema.optionalWith(SimpleFilterTypeSchema, { nullable: true }),
  filter: NullableString,
  filterTo: NullableString,
}) as Schema.Schema<TextFilterCondition>;

const NumberFilterConditionSchema = Schema.Struct({
  filterType: Schema.Literal("number"),
  type: Schema.optionalWith(SimpleFilterTypeSchema, { nullable: true }),
  filter: NullableNumber,
  filterTo: NullableNumber,
}) as Schema.Schema<NumberFilterCondition>;

const DateFilterConditionSchema = Schema.Struct({
  filterType: Schema.Literal("date"),
  type: Schema.optionalWith(SimpleFilterTypeSchema, { nullable: true }),
  dateFrom: NullableString,
  dateTo: NullableString,
}) as Schema.Schema<DateFilterCondition>;

const SetFilterConditionSchema = Schema.Struct({
  filterType: Schema.Literal("set"),
  values: Schema.Array(Schema.NullOr(Schema.String)),
}) as unknown as Schema.Schema<SetFilterCondition>;

const CombinedTextFilterSchema = Schema.Struct({
  filterType: Schema.Literal("text"),
  operator: JoinOperatorSchema,
  conditions: Schema.Array(TextFilterConditionSchema),
}) as unknown as Schema.Schema<CombinedTextFilter>;

const CombinedNumberFilterSchema = Schema.Struct({
  filterType: Schema.Literal("number"),
  operator: JoinOperatorSchema,
  conditions: Schema.Array(NumberFilterConditionSchema),
}) as unknown as Schema.Schema<CombinedNumberFilter>;

const CombinedDateFilterSchema = Schema.Struct({
  filterType: Schema.Literal("date"),
  operator: JoinOperatorSchema,
  conditions: Schema.Array(DateFilterConditionSchema),
}) as unknown as Schema.Schema<CombinedDateFilter>;

export const ColumnFilterStateSchema: Schema.Schema<ColumnFilterState> =
  Schema.suspend(
    (): Schema.Schema<ColumnFilterState> =>
      Schema.Union(
        SetFilterConditionSchema,
        Schema.Struct({
          filterType: Schema.Literal("multi"),
          filterModels: Schema.NullOr(
            Schema.Array(Schema.NullOr(ColumnFilterStateSchema)),
          ),
        }) as Schema.Schema<MultiFilterCondition>,
        CombinedTextFilterSchema,
        CombinedNumberFilterSchema,
        CombinedDateFilterSchema,
        TextFilterConditionSchema,
        NumberFilterConditionSchema,
        DateFilterConditionSchema,
      ) as Schema.Schema<ColumnFilterState>,
  );

export const GridColumnFilterStateSchema = Schema.Record({
  key: Schema.String,
  value: ColumnFilterStateSchema,
}) as unknown as Schema.Schema<GridColumnFilterState>;

const AdvancedScalarTypeSchema = Schema.Literal(
  "equals",
  "notEqual",
  "lessThan",
  "lessThanOrEqual",
  "greaterThan",
  "greaterThanOrEqual",
  "blank",
  "notBlank",
) as Schema.Schema<ScalarAdvancedFilterType>;

const AdvancedTextFilterModelSchema = Schema.Struct({
  filterType: Schema.Literal("text"),
  colId: Schema.String,
  type: Schema.Literal(
    "equals",
    "notEqual",
    "contains",
    "notContains",
    "startsWith",
    "endsWith",
    "blank",
    "notBlank",
  ),
  filter: NullableString,
}) as Schema.Schema<TextAdvancedFilterModel>;

const AdvancedNumberFilterModelSchema = Schema.Struct({
  filterType: Schema.Literal("number"),
  colId: Schema.String,
  type: AdvancedScalarTypeSchema,
  filter: NullableNumber,
}) as Schema.Schema<NumberAdvancedFilterModel>;

const AdvancedDateLikeFilterModelSchema = (
  filterType: DateLikeAdvancedFilterModel["filterType"],
) =>
  Schema.Struct({
    filterType: Schema.Literal(filterType),
    colId: Schema.String,
    type: AdvancedScalarTypeSchema,
    filter: NullableString,
  }) as Schema.Schema<DateLikeAdvancedFilterModel>;

const AdvancedBooleanFilterModelSchema = Schema.Struct({
  filterType: Schema.Literal("boolean"),
  colId: Schema.String,
  type: Schema.Literal("true", "false"),
}) as Schema.Schema<BooleanAdvancedFilterModel>;

const AdvancedObjectFilterModelSchema = Schema.Struct({
  filterType: Schema.Literal("object"),
  colId: Schema.String,
  type: Schema.Literal(
    "equals",
    "notEqual",
    "contains",
    "notContains",
    "startsWith",
    "endsWith",
    "blank",
    "notBlank",
  ),
  filter: NullableString,
}) as Schema.Schema<ObjectAdvancedFilterModel>;

export const AdvancedFilterModelSchema: Schema.Schema<AdvancedFilterModel> =
  Schema.suspend(
    (): Schema.Schema<AdvancedFilterModel> =>
      Schema.Union(
        Schema.Struct({
          filterType: Schema.Literal("join"),
          type: JoinOperatorSchema,
          conditions: Schema.Array(AdvancedFilterModelSchema),
        }) as unknown as Schema.Schema<JoinAdvancedFilterModel>,
        AdvancedTextFilterModelSchema,
        AdvancedNumberFilterModelSchema,
        AdvancedDateLikeFilterModelSchema("date"),
        AdvancedDateLikeFilterModelSchema("dateString"),
        AdvancedDateLikeFilterModelSchema("dateTime"),
        AdvancedDateLikeFilterModelSchema("dateTimeString"),
        AdvancedDateLikeFilterModelSchema("bigint"),
        AdvancedBooleanFilterModelSchema,
        AdvancedObjectFilterModelSchema,
      ) as Schema.Schema<AdvancedFilterModel>,
  );

export const GridSortStateSchema = Schema.Array(
  Schema.Struct({
    colId: Schema.String,
    sort: Schema.Literal("asc", "desc"),
    type: Schema.optional(Schema.String),
  }),
) as unknown as Schema.Schema<GridSortState>;
