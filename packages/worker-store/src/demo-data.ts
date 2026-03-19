import { Faker, en } from "@faker-js/faker";

import type { RowRecord } from "./query-runtime";

const SECTORS = [
  "Technology",
  "Financials",
  "Energy",
  "Healthcare",
  "Industrials",
] as const;
const VENUES = ["NASDAQ", "NYSE", "CBOE", "IEX"] as const;

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

export function createDemoRowFactory(
  seed = 1,
  startIndex = 0,
  options: DemoRowFactoryOptions = {},
) {
  const faker = createFaker(seed);
  let index = startIndex;

  return (): RowRecord => {
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

export function generateDemoRows(rowCount: number, seed = 1): ReadonlyArray<RowRecord> {
  const makeRow = createDemoRowFactory(seed);
  return Array.from({ length: rowCount }, () => makeRow());
}
