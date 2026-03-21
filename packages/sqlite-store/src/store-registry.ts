import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as ServiceMap from "effect/ServiceMap";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { SqliteRow, SqliteStoreDefinition } from "./store-config";
import { planViewportQuery } from "./sql-planner";
import type {
  CloseViewportChannelSuccess,
  SetViewportIntentSuccess,
  ViewportIntent,
  ViewportPatch,
} from "./worker-contract";

const DEFAULT_THROTTLE_MS = 100;

interface ChannelState {
  readonly intentRef: SubscriptionRef.SubscriptionRef<ViewportIntent>;
  readonly throttleMs: number;
}

export interface SqliteViewportChannelService<
  TRow extends SqliteRow = SqliteRow,
> {
  readonly storeId: string;
  readonly connect: (
    connectionId: string,
    initialIntent: ViewportIntent,
    options?: {
      throttleMs?: number;
    },
  ) => Stream.Stream<ViewportPatch<TRow>, string>;
  readonly setIntent: (
    connectionId: string,
    intent: ViewportIntent,
  ) => Effect.Effect<SetViewportIntentSuccess, string>;
  readonly close: (
    connectionId: string,
  ) => Effect.Effect<CloseViewportChannelSuccess, string>;
  readonly invalidate: Effect.Effect<void>;
  readonly closeAll: Effect.Effect<void>;
}

export const SqliteViewportChannelService =
  ServiceMap.Service<SqliteViewportChannelService>(
    "@sandbox/sqlite-store/SqliteViewportChannelService",
  );

function quoteTableName<TRow extends SqliteRow>(
  store: SqliteStoreDefinition<object, TRow>,
) {
  return `"${store.tableName.replaceAll(`"`, `""`)}"`;
}

function normalizeViewportIntent(intent: ViewportIntent): ViewportIntent {
  return {
    storeId: intent.storeId,
    startRow: intent.startRow,
    endRow: intent.endRow,
    query: intent.query,
  };
}

function sameViewportIntent(left: ViewportIntent, right: ViewportIntent) {
  return left.storeId === right.storeId &&
    left.startRow === right.startRow &&
    left.endRow === right.endRow &&
    JSON.stringify(left.query) === JSON.stringify(right.query);
}

export function makeSqliteViewportChannelService<
  TRow extends SqliteRow = SqliteRow,
>(
  store: SqliteStoreDefinition<object, TRow>,
  options: {
    storeId: string;
  },
): Effect.Effect<SqliteViewportChannelService<TRow>, never, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const invalidations = yield* PubSub.sliding<void>(1);
    const channelsRef = yield* SynchronizedRef.make(new Map<string, ChannelState>());

    const runCurrentViewportSql = (intent: ViewportIntent) =>
      Effect.gen(function* () {
        const startedAtMs = yield* Clock.currentTimeMillis;
        const plan = planViewportQuery(store, intent.query, {
          startRow: intent.startRow,
          endRow: intent.endRow,
        });
        const countRows = yield* sql.unsafe<{ count: number }>(
          plan.countSql,
          plan.countParams,
        );
        const rows = yield* sql.unsafe<Record<string, unknown>>(
          plan.rowsSql,
          plan.rowsParams,
        );
        const finishedAtMs = yield* Clock.currentTimeMillis;

        return {
          storeId: intent.storeId,
          startRow: intent.startRow,
          endRow: intent.endRow,
          rowCount: Number(countRows[0]?.count ?? 0),
          latencyMs: Math.max(0, finishedAtMs - startedAtMs),
          rows: rows.map((row) => store.decodeRow(row)),
        } satisfies ViewportPatch<TRow>;
      }).pipe(
        Effect.mapError((error) =>
          error instanceof Error ? error.message : "Failed to run viewport SQL"
        ),
      );

    const getChannel = Effect.fn("SqliteViewportChannelService.getChannel")(
      function* (connectionId: string) {
        const channels = yield* SynchronizedRef.get(channelsRef);
        const channel = channels.get(connectionId);
        if (!channel) {
          return yield* Effect.fail(`Viewport channel not found: ${connectionId}`);
        }
        return channel;
      },
    );

    const close = Effect.fn("SqliteViewportChannelService.close")(
      function* (connectionId: string) {
        const channel = yield* SynchronizedRef.modify(channelsRef, (channels) => {
          const next = new Map(channels);
          const current = next.get(connectionId) ?? null;
          next.delete(connectionId);
          return [current, next] as const;
        });

        if (channel === null) {
          return {
            connectionId,
            closed: true,
          } satisfies CloseViewportChannelSuccess;
        }

        return {
          connectionId,
          closed: true,
        } satisfies CloseViewportChannelSuccess;
      },
    );

    const connect = (
      connectionId: string,
      initialIntent: ViewportIntent,
      channelOptions?: {
        throttleMs?: number;
      },
    ): Stream.Stream<ViewportPatch<TRow>, string> =>
      Stream.unwrap(
        Effect.acquireRelease(
          Effect.gen(function* () {
            if (initialIntent.storeId !== options.storeId) {
              return yield* Effect.fail(
                `Unknown store: ${initialIntent.storeId}. Expected ${options.storeId}`,
              );
            }

            const intentRef = yield* SubscriptionRef.make(
              normalizeViewportIntent(initialIntent),
            );
            const channel: ChannelState = {
              intentRef,
              throttleMs: channelOptions?.throttleMs ?? DEFAULT_THROTTLE_MS,
            };

            yield* SynchronizedRef.modifyEffect(channelsRef, (channels) => {
              if (channels.has(connectionId)) {
                return Effect.fail(
                  `Viewport channel already exists: ${connectionId}`,
                );
              }

              const next = new Map(channels);
              next.set(connectionId, channel);
              return Effect.succeed([channel, next] as const);
            });

            return channel;
          }),
          () => close(connectionId).pipe(Effect.ignore),
        ).pipe(
          Effect.map((channel) =>
            SubscriptionRef.changes(channel.intentRef).pipe(
              Stream.changesWith(sameViewportIntent),
              Stream.switchMap((intent) =>
                Stream.make(intent).pipe(
                  Stream.concat(
                    Stream.fromPubSub(invalidations).pipe(
                      Stream.throttle({
                        cost: () => 1,
                        units: 1,
                        duration: Duration.millis(channel.throttleMs),
                        strategy: "enforce",
                      }),
                      Stream.map(() => intent),
                    ),
                  ),
                  Stream.mapEffect(runCurrentViewportSql),
                )
              ),
            )
          ),
        ),
      );

    const setIntent = Effect.fn("SqliteViewportChannelService.setIntent")(
      function* (connectionId: string, intent: ViewportIntent) {
        if (intent.storeId !== options.storeId) {
          return yield* Effect.fail(
            `Unknown store: ${intent.storeId}. Expected ${options.storeId}`,
          );
        }

        const channel = yield* getChannel(connectionId);
        yield* SubscriptionRef.set(channel.intentRef, normalizeViewportIntent(intent));

        return {
          connectionId,
          updated: true,
        } satisfies SetViewportIntentSuccess;
      },
    );

    const invalidate = PubSub.publish(invalidations, undefined).pipe(Effect.asVoid);

    const closeAll = Effect.gen(function* () {
      const channels = yield* SynchronizedRef.get(channelsRef);
      for (const connectionId of Array.from(channels.keys())) {
        yield* close(connectionId).pipe(Effect.ignore);
      }
      yield* PubSub.shutdown(invalidations);
    });

    return SqliteViewportChannelService.of({
      storeId: options.storeId,
      connect,
      setIntent,
      close,
      invalidate,
      closeAll,
    }) as SqliteViewportChannelService<TRow>;
  });
}

export function layerSqliteViewportChannelService<
  TRow extends SqliteRow = SqliteRow,
>(
  store: SqliteStoreDefinition<object, TRow>,
  options: {
    storeId: string;
  },
) {
  return Layer.effect(
    SqliteViewportChannelService,
    makeSqliteViewportChannelService(store, options) as Effect.Effect<
      SqliteViewportChannelService,
      never,
      SqlClient.SqlClient
    >,
  );
}

export function seedSqliteStore<TRow extends SqliteRow = SqliteRow>(
  store: SqliteStoreDefinition<object, TRow>,
  rows: ReadonlyArray<TRow>,
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tableName = quoteTableName(store);
    yield* sql.unsafe(`drop table if exists ${tableName}`);
    yield* sql.unsafe(store.createTableSql);

    for (const row of rows) {
      yield* sql.unsafe(store.upsertSql, store.encodeRow(row));
    }
  });
}
