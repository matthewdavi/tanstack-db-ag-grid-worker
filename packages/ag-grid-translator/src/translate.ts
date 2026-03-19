import { Match, Schema } from "effect";

import type {
  GridComparisonPredicate,
  GridPredicate,
  GridPredicateGroup,
  GridQueryState,
} from "./query-state";
import { GridQueryStateSchema } from "./query-state";
import {
  AdvancedFilterModelSchema,
  GridColumnFilterStateSchema,
  GridSortStateSchema,
  type AdvancedFilterModel,
  type CombinedDateFilter,
  type CombinedNumberFilter,
  type CombinedTextFilter,
  type ColumnFilterState,
  type DateFilterCondition,
  type GridColumnFilterState,
  type GridSortState,
  type NumberFilterCondition,
  type SetFilterCondition,
  type TextFilterCondition,
} from "./schemas";

export const decodeColumnFilterState = Schema.decodeUnknownSync(
  GridColumnFilterStateSchema,
);

export const decodeAdvancedFilterState = Schema.decodeUnknownSync(
  AdvancedFilterModelSchema,
);

export const decodeGridSortState = Schema.decodeUnknownSync(GridSortStateSchema);

export const decodeGridQueryState = Schema.decodeUnknownSync(GridQueryStateSchema);

export function isAdvancedFilterModel(
  value: unknown,
): value is AdvancedFilterModel {
  if (value === null || value === undefined || typeof value !== "object") {
    return false;
  }

  return "colId" in value || ("filterType" in value && value.filterType === "join");
}

const SIMPLE_OPERATOR_MAP: Record<string, GridComparisonPredicate["operator"]> = {
  equals: "eq",
  notEqual: "neq",
  lessThan: "lt",
  lessThanOrEqual: "lte",
  greaterThan: "gt",
  greaterThanOrEqual: "gte",
  inRange: "inRange",
  contains: "contains",
  notContains: "notContains",
  startsWith: "startsWith",
  endsWith: "endsWith",
  blank: "blank",
  notBlank: "notBlank",
  true: "true",
  false: "false",
};

function compactPredicate(
  predicate: GridPredicate | null,
): GridPredicate | null {
  if (predicate === null || predicate.kind === "comparison") {
    return predicate;
  }

  const predicates = predicate.predicates
    .map(compactPredicate)
    .filter((value): value is GridPredicate => value !== null);

  if (predicates.length === 0) {
    return null;
  }

  if (predicates.length === 1) {
    return predicates[0];
  }

  return {
    ...predicate,
    predicates,
  };
}

function makeComparison(
  field: string,
  filterType: string,
  operator: GridComparisonPredicate["operator"],
  options: {
    value?: string | number | boolean | null;
    valueTo?: string | number | boolean | null;
    values?: ReadonlyArray<string | null>;
  } = {},
): GridComparisonPredicate {
  return {
    kind: "comparison",
    field,
    filterType,
    operator,
    value: options.value,
    valueTo: options.valueTo,
    values: options.values,
  };
}

function makeGroup(
  operator: GridPredicateGroup["operator"],
  predicates: ReadonlyArray<GridPredicate>,
): GridPredicateGroup {
  return {
    kind: "group",
    operator,
    predicates,
  };
}

function translateConditionGroup(
  field: string,
  operator: "AND" | "OR",
  conditions: ReadonlyArray<ColumnFilterState>,
): GridPredicate | null {
  return compactPredicate(
    makeGroup(
      operator === "OR" ? "or" : "and",
      conditions
        .map((condition) => translateColumnCondition(field, condition))
        .filter((value): value is GridPredicate => value !== null),
    ),
  );
}

function translateSimpleCondition(
  field: string,
  model: TextFilterCondition | NumberFilterCondition | DateFilterCondition,
): GridComparisonPredicate {
  const operator = SIMPLE_OPERATOR_MAP[model.type ?? "equals"];
  const filterType = model.filterType ?? "text";

  if ("dateFrom" in model || "dateTo" in model) {
    return makeComparison(field, filterType, operator, {
      value: model.dateFrom ?? undefined,
      valueTo: model.dateTo ?? undefined,
    });
  }

  return makeComparison(field, filterType, operator, {
    value: "filter" in model ? model.filter ?? undefined : undefined,
    valueTo: "filterTo" in model ? model.filterTo ?? undefined : undefined,
  });
}

function translateColumnCondition(
  field: string,
  model: ColumnFilterState,
): GridPredicate | null {
  return Match.value(model).pipe(
    Match.withReturnType<GridPredicate | null>(),
    Match.when({ filterType: "set" }, (current: SetFilterCondition) =>
      makeComparison(field, "set", "set", {
        values: current.values,
      }),
    ),
    Match.when({ filterType: "multi" }, (current) =>
      makeGroup(
        "and",
        (current.filterModels ?? [])
          .map((entry) => (entry ? translateColumnCondition(field, entry) : null))
          .filter((value): value is GridPredicate => value !== null),
      ),
    ),
    Match.when(
      { filterType: "text", operator: "AND" },
      (current: CombinedTextFilter) =>
        translateConditionGroup(field, current.operator, current.conditions),
    ),
    Match.when(
      { filterType: "text", operator: "OR" },
      (current: CombinedTextFilter) =>
        translateConditionGroup(field, current.operator, current.conditions),
    ),
    Match.when(
      { filterType: "number", operator: "AND" },
      (current: CombinedNumberFilter) =>
        translateConditionGroup(field, current.operator, current.conditions),
    ),
    Match.when(
      { filterType: "number", operator: "OR" },
      (current: CombinedNumberFilter) =>
        translateConditionGroup(field, current.operator, current.conditions),
    ),
    Match.when(
      { filterType: "date", operator: "AND" },
      (current: CombinedDateFilter) =>
        translateConditionGroup(field, current.operator, current.conditions),
    ),
    Match.when(
      { filterType: "date", operator: "OR" },
      (current: CombinedDateFilter) =>
        translateConditionGroup(field, current.operator, current.conditions),
    ),
    Match.when({ filterType: "text" }, (current: TextFilterCondition) =>
      translateSimpleCondition(field, current),
    ),
    Match.when({ filterType: "number" }, (current: NumberFilterCondition) =>
      translateSimpleCondition(field, current),
    ),
    Match.when({ filterType: "date" }, (current: DateFilterCondition) =>
      translateSimpleCondition(field, current),
    ),
    Match.when({ operator: "AND" }, (current: CombinedTextFilter | CombinedNumberFilter | CombinedDateFilter) =>
      translateConditionGroup(field, current.operator, current.conditions),
    ),
    Match.when({ operator: "OR" }, (current: CombinedTextFilter | CombinedNumberFilter | CombinedDateFilter) =>
      translateConditionGroup(field, current.operator, current.conditions),
    ),
    Match.orElse((current) => translateSimpleCondition(field, current as TextFilterCondition)),
  );
}

export function translateColumnFilters(
  filterModel: GridColumnFilterState | null,
): GridPredicate | null {
  if (filterModel === null) {
    return null;
  }

  return compactPredicate(
    makeGroup(
      "and",
      Object.entries(filterModel)
        .map(([field, model]) => translateColumnCondition(field, model))
        .filter((value): value is GridPredicate => value !== null),
    ),
  );
}

function translateAdvancedFilterNode(
  model: AdvancedFilterModel,
): GridPredicate | null {
  return Match.value(model).pipe(
    Match.withReturnType<GridPredicate | null>(),
    Match.when({ filterType: "join" }, (current) =>
      compactPredicate(
        makeGroup(
          current.type === "OR" ? "or" : "and",
          current.conditions
            .map(translateAdvancedFilterNode)
            .filter((value): value is GridPredicate => value !== null),
        ),
      ),
    ),
    Match.orElse((current) =>
      makeComparison(current.colId, current.filterType, SIMPLE_OPERATOR_MAP[current.type], {
        value: "filter" in current ? current.filter ?? null : null,
      }),
    ),
  );
}

export function translateAdvancedFilter(
  filterModel: AdvancedFilterModel | null,
): GridPredicate | null {
  return filterModel ? translateAdvancedFilterNode(filterModel) : null;
}

export function translateSortModel(sortModel: GridSortState): GridQueryState["sorts"] {
  return sortModel.map((entry) => ({
    field: entry.colId,
    direction: entry.sort,
  }));
}

export function translateGridModels(input: {
  filterModel?: GridColumnFilterState | AdvancedFilterModel | null;
  sortModel?: GridSortState;
}): GridQueryState {
  const predicate =
    isAdvancedFilterModel(input.filterModel)
      ? translateAdvancedFilter(input.filterModel)
      : translateColumnFilters(
          (input.filterModel as GridColumnFilterState | null) ?? null,
        );

  return decodeGridQueryState({
    predicate,
    sorts: translateSortModel(input.sortModel ?? []),
  });
}

export function decodeAgGridFilterModel(
  filterModel: unknown,
): GridColumnFilterState | AdvancedFilterModel | null {
  if (filterModel === null || filterModel === undefined) {
    return null;
  }

  return isAdvancedFilterModel(filterModel)
    ? decodeAdvancedFilterState(filterModel)
    : decodeColumnFilterState(filterModel);
}

export function translateAgGridQuery(input: {
  filterModel?: unknown;
  sortModel?: unknown;
}): GridQueryState {
  return translateGridModels({
    filterModel: decodeAgGridFilterModel(input.filterModel),
    sortModel:
      input.sortModel === undefined ? [] : decodeGridSortState(input.sortModel),
  });
}
