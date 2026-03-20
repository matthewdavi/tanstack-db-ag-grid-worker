import { Faker, en } from "@faker-js/faker";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { defineAgGridSqliteEngine } from "@sandbox/sqlite-store";

const SECTORS = [
  "Technology",
  "Financials",
  "Energy",
  "Healthcare",
  "Industrials",
] as const;
const VENUES = ["NASDAQ", "NYSE", "CBOE", "IEX"] as const;

export const marketRowsTable = sqliteTable("demo_rows", {
  id: text("id").primaryKey(),
  active: integer("active", { mode: "boolean" }).notNull(),
  symbol: text("symbol").notNull(),
  company: text("company").notNull(),
  sector: text("sector").notNull(),
  venue: text("venue").notNull(),
  price: real("price").notNull(),
  volume: integer("volume").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type MarketRow = typeof marketRowsTable.$inferSelect;

interface DemoRowFactoryOptions {
  realtimeTimestamps?: boolean;
}

function createFaker(seed: number) {
  const faker = new Faker({
    locale: [en],
  });
  faker.seed(seed);
  return faker;
}

export function createMarketRowFactory(
  seed = 1,
  startIndex = 0,
  options: DemoRowFactoryOptions = {},
) {
  const faker = createFaker(seed);
  let index = startIndex;

  return (): MarketRow => {
    const nextIndex = index;
    index += 1;

    const sector = faker.helpers.arrayElement(SECTORS);
    const venue = faker.helpers.arrayElement(VENUES);
    const company = faker.company.name();
    const symbol = faker.string.alpha({
      casing: "upper",
      length: { min: 3, max: 4 },
    });
    const createdAt = options.realtimeTimestamps
      ? new Date()
      : faker.date.between({
          from: "2021-01-01T00:00:00.000Z",
          to: "2025-03-01T23:59:59.999Z",
        });
    const updatedAt = options.realtimeTimestamps
      ? new Date()
      : faker.date.between({
          from: createdAt,
          to: new Date(createdAt.getTime() + 1000 * 60 * 60 * 24 * 180),
        });
    const price = faker.number.float({
      min: 10,
      max: 1000,
      fractionDigits: 2,
    });

    return {
      id: `row-${nextIndex + 1}`,
      active: faker.datatype.boolean({ probability: 0.65 }),
      symbol,
      company,
      sector,
      venue,
      price,
      volume: faker.number.int({ min: 10_000, max: 5_000_000 }),
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    };
  };
}

export function generateMarketRows(rowCount: number, seed = 1): ReadonlyArray<MarketRow> {
  const makeRow = createMarketRowFactory(seed);
  return Array.from({ length: rowCount }, () => makeRow());
}

export const marketGrid = defineAgGridSqliteEngine({
  table: marketRowsTable,
  rowKey: "id",
  rowFactory: {
    generateRows: generateMarketRows,
    createStressRowFactory: createMarketRowFactory,
  },
});
