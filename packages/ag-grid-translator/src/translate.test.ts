import { describe, expect, it } from "vitest";

import {
  decodeAdvancedFilterState,
  decodeAgGridFilterModel,
  decodeColumnFilterState,
  decodeGridSortState,
  isAdvancedFilterModel,
  translateAgGridQuery,
  translateAdvancedFilter,
  translateColumnFilters,
  translateGridModels,
} from "./translate";

describe("ag-grid model translation", () => {
  it("decodes simple column filters and translates them into a normalized predicate tree", () => {
    const filterModel = decodeColumnFilterState({
      athlete: {
        filterType: "text",
        type: "contains",
        filter: "michael",
      },
      age: {
        filterType: "number",
        operator: "AND",
        conditions: [
          { filterType: "number", type: "greaterThan", filter: 20 },
          { filterType: "number", type: "lessThanOrEqual", filter: 40 },
        ],
      },
      country: {
        filterType: "set",
        values: ["USA", "Canada"],
      },
    });

    expect(translateColumnFilters(filterModel)).toEqual({
      kind: "group",
      operator: "and",
      predicates: [
        {
          kind: "comparison",
          field: "athlete",
          filterType: "text",
          operator: "contains",
          value: "michael",
          valueTo: undefined,
          values: undefined,
        },
        {
          kind: "group",
          operator: "and",
          predicates: [
            {
              kind: "comparison",
              field: "age",
              filterType: "number",
              operator: "gt",
              value: 20,
              valueTo: undefined,
              values: undefined,
            },
            {
              kind: "comparison",
              field: "age",
              filterType: "number",
              operator: "lte",
              value: 40,
              valueTo: undefined,
              values: undefined,
            },
          ],
        },
        {
          kind: "comparison",
          field: "country",
          filterType: "set",
          operator: "set",
          value: undefined,
          valueTo: undefined,
          values: ["USA", "Canada"],
        },
      ],
    });
  });

  it("translates multi filters into an AND group across child filters", () => {
    const filterModel = decodeColumnFilterState({
      year: {
        filterType: "multi",
        filterModels: [
          {
            filterType: "number",
            type: "greaterThanOrEqual",
            filter: 2008,
          },
          {
            filterType: "set",
            values: ["2008", "2012"],
          },
        ],
      },
    });

    expect(translateColumnFilters(filterModel)).toEqual({
      kind: "group",
      operator: "and",
      predicates: [
        {
          kind: "comparison",
          field: "year",
          filterType: "number",
          operator: "gte",
          value: 2008,
          valueTo: undefined,
          values: undefined,
        },
        {
          kind: "comparison",
          field: "year",
          filterType: "set",
          operator: "set",
          value: undefined,
          valueTo: undefined,
          values: ["2008", "2012"],
        },
      ],
    });
  });

  it("translates advanced filters with nested boolean joins", () => {
    const filterModel = decodeAdvancedFilterState({
      filterType: "join",
      type: "OR",
      conditions: [
        {
          filterType: "text",
          colId: "athlete",
          type: "startsWith",
          filter: "A",
        },
        {
          filterType: "join",
          type: "AND",
          conditions: [
            {
              filterType: "number",
              colId: "gold",
              type: "greaterThan",
              filter: 1,
            },
            {
              filterType: "boolean",
              colId: "active",
              type: "true",
            },
          ],
        },
      ],
    });

    expect(translateAdvancedFilter(filterModel)).toEqual({
      kind: "group",
      operator: "or",
      predicates: [
        {
          kind: "comparison",
          field: "athlete",
          filterType: "text",
          operator: "startsWith",
          value: "A",
          valueTo: undefined,
          values: undefined,
        },
        {
          kind: "group",
          operator: "and",
          predicates: [
            {
              kind: "comparison",
              field: "gold",
              filterType: "number",
              operator: "gt",
              value: 1,
              valueTo: undefined,
              values: undefined,
            },
            {
              kind: "comparison",
              field: "active",
              filterType: "boolean",
              operator: "true",
              value: null,
              valueTo: undefined,
              values: undefined,
            },
          ],
        },
      ],
    });
  });

  it("translates multi-column sorting and wraps the full query state", () => {
    const sortModel = decodeGridSortState([
      { colId: "country", sort: "asc" },
      { colId: "year", sort: "desc" },
    ]);

    expect(
      translateGridModels({
        filterModel: {
          sport: {
            filterType: "text",
            type: "equals",
            filter: "Swimming",
          },
        },
        sortModel,
      }),
    ).toEqual({
      predicate: {
        kind: "comparison",
        field: "sport",
        filterType: "text",
        operator: "eq",
        value: "Swimming",
        valueTo: undefined,
        values: undefined,
      },
      sorts: [
        { field: "country", direction: "asc" },
        { field: "year", direction: "desc" },
      ],
    });
  });

  it("detects and translates advanced scalar filters from raw ag-grid request payloads", () => {
    const filterModel = {
      filterType: "text",
      colId: "athlete",
      type: "equals",
      filter: "Alicia",
    };

    expect(isAdvancedFilterModel(filterModel)).toBe(true);
    expect(decodeAgGridFilterModel(filterModel)).toEqual(
      decodeAdvancedFilterState(filterModel),
    );
    expect(
      translateAgGridQuery({
        filterModel,
        sortModel: [{ colId: "year", sort: "desc" }],
      }),
    ).toEqual({
      predicate: {
        kind: "comparison",
        field: "athlete",
        filterType: "text",
        operator: "eq",
        value: "Alicia",
        valueTo: undefined,
        values: undefined,
      },
      sorts: [{ field: "year", direction: "desc" }],
    });
  });
});
