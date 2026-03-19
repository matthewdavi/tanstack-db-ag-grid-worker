import { Schema } from "effect";

import { GridQueryStateSchema } from "@sandbox/ag-grid-translator";

import type { GridQueryState } from "@sandbox/ag-grid-translator";
import type { RowRecord } from "./query-runtime";

const RowRecordSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
}) as unknown as Schema.Schema<RowRecord>;

const StoreMetricsSchema = Schema.Struct({
  lastCommitDurationMs: Schema.NullOr(Schema.Number),
  lastCommitChangeCount: Schema.Number,
  totalCommitCount: Schema.Number,
}) as Schema.Schema<StoreMetrics>;

export const StoreDefinitionSchema = Schema.Struct({
  storeId: Schema.String,
  rowKey: Schema.String,
}) as Schema.Schema<StoreDefinition>;

export const StoreSourceSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("rows"),
    rows: Schema.Array(RowRecordSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal("generator"),
    rowCount: Schema.Number,
    seed: Schema.optionalWith(Schema.Number, { nullable: true }),
  }),
) as Schema.Schema<StoreSource>;

export const OpenViewportSessionRequestSchema = Schema.Struct({
  sessionId: Schema.String,
  storeId: Schema.String,
  startRow: Schema.Number,
  endRow: Schema.Number,
  query: GridQueryStateSchema,
}) as Schema.Schema<OpenViewportSessionRequest>;

export const ReplaceViewportSessionRequestSchema = Schema.Struct({
  sessionId: Schema.String,
  startRow: Schema.Number,
  endRow: Schema.Number,
  query: GridQueryStateSchema,
}) as Schema.Schema<ReplaceViewportSessionRequest>;

export const CloseViewportSessionRequestSchema = Schema.Struct({
  sessionId: Schema.String,
}) as Schema.Schema<CloseViewportSessionRequest>;

export const SsrmRequestSchema = Schema.Struct({
  storeId: Schema.String,
  startRow: Schema.Number,
  endRow: Schema.Number,
  query: GridQueryStateSchema,
}) as Schema.Schema<SsrmRequest>;

export const ViewportPatchSchema = Schema.Struct({
  storeId: Schema.String,
  startRow: Schema.Number,
  endRow: Schema.Number,
  rowCount: Schema.Number,
  metrics: StoreMetricsSchema,
  rows: Schema.Array(RowRecordSchema),
}) as Schema.Schema<ViewportPatch>;

export const SsrmBlockResponseSchema = Schema.Struct({
  storeId: Schema.String,
  startRow: Schema.Number,
  endRow: Schema.Number,
  rowCount: Schema.Number,
  metrics: StoreMetricsSchema,
  rows: Schema.Array(RowRecordSchema),
}) as Schema.Schema<SsrmBlockResponse>;

const LoadStoreSuccessSchema = Schema.Struct({
  storeId: Schema.String,
  rowCount: Schema.Number,
  metrics: StoreMetricsSchema,
}) as Schema.Schema<LoadStoreSuccess>;

const ApplyTransactionSuccessSchema = Schema.Struct({
  storeId: Schema.String,
  rowCount: Schema.Number,
  metrics: StoreMetricsSchema,
}) as Schema.Schema<ApplyTransactionSuccess>;

const DisposeStoreSuccessSchema = Schema.Struct({
  storeId: Schema.String,
  disposed: Schema.Boolean,
}) as Schema.Schema<DisposeStoreSuccess>;

const ReplaceViewportSessionSuccessSchema = Schema.Struct({
  sessionId: Schema.String,
  replaced: Schema.Boolean,
}) as Schema.Schema<ReplaceViewportSessionSuccess>;

const CloseViewportSessionSuccessSchema = Schema.Struct({
  sessionId: Schema.String,
  closed: Schema.Boolean,
}) as Schema.Schema<CloseViewportSessionSuccess>;

const StressStateSchema = Schema.Struct({
  storeId: Schema.String,
  rowsPerSecond: Schema.Number,
  running: Schema.Boolean,
  rowCount: Schema.Number,
  metrics: StoreMetricsSchema,
}) as Schema.Schema<StressState>;

const TransactionSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("upsert"),
    rows: Schema.Array(RowRecordSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal("delete"),
    ids: Schema.Array(Schema.String),
  }),
) as Schema.Schema<StoreTransaction>;

export class LoadStore extends Schema.TaggedRequest<LoadStore>("LoadStore")(
  "LoadStore",
  {
    failure: Schema.String,
    success: LoadStoreSuccessSchema,
    payload: {
      definition: StoreDefinitionSchema,
      source: StoreSourceSchema,
    },
  },
) {}

export class ApplyTransaction extends Schema.TaggedRequest<ApplyTransaction>(
  "ApplyTransaction",
)("ApplyTransaction", {
  failure: Schema.String,
  success: ApplyTransactionSuccessSchema,
  payload: {
    storeId: Schema.String,
    transaction: TransactionSchema,
  },
}) {}

export class GetRows extends Schema.TaggedRequest<GetRows>("GetRows")("GetRows", {
  failure: Schema.String,
  success: SsrmBlockResponseSchema,
  payload: {
    storeId: Schema.String,
    startRow: Schema.Number,
    endRow: Schema.Number,
    query: GridQueryStateSchema,
  },
}) {}

export class OpenViewportSession extends Schema.TaggedRequest<OpenViewportSession>(
  "OpenViewportSession",
)("OpenViewportSession", {
  failure: Schema.String,
  success: ViewportPatchSchema,
  payload: {
    sessionId: Schema.String,
    storeId: Schema.String,
    startRow: Schema.Number,
    endRow: Schema.Number,
    query: GridQueryStateSchema,
  },
}) {}

export class ReplaceViewportSession extends Schema.TaggedRequest<ReplaceViewportSession>(
  "ReplaceViewportSession",
)("ReplaceViewportSession", {
  failure: Schema.String,
  success: ReplaceViewportSessionSuccessSchema,
  payload: {
    sessionId: Schema.String,
    startRow: Schema.Number,
    endRow: Schema.Number,
    query: GridQueryStateSchema,
  },
}) {}

export class CloseViewportSession extends Schema.TaggedRequest<CloseViewportSession>(
  "CloseViewportSession",
)("CloseViewportSession", {
  failure: Schema.String,
  success: CloseViewportSessionSuccessSchema,
  payload: {
    sessionId: Schema.String,
  },
}) {}

export class DisposeStore extends Schema.TaggedRequest<DisposeStore>("DisposeStore")(
  "DisposeStore",
  {
    failure: Schema.String,
    success: DisposeStoreSuccessSchema,
    payload: {
      storeId: Schema.String,
    },
  },
) {}

export class SetStressRate extends Schema.TaggedRequest<SetStressRate>("SetStressRate")(
  "SetStressRate",
  {
    failure: Schema.String,
    success: StressStateSchema,
    payload: {
      storeId: Schema.String,
      rowsPerSecond: Schema.Number,
    },
  },
) {}

export const WorkerRequestSchema = Schema.Union(
  LoadStore,
  ApplyTransaction,
  GetRows,
  OpenViewportSession,
  ReplaceViewportSession,
  CloseViewportSession,
  DisposeStore,
  SetStressRate,
);

export type WorkerRequest = typeof WorkerRequestSchema.Type;

export interface StoreDefinition {
  storeId: string;
  rowKey: string;
}

export type StoreSource =
  | {
      kind: "rows";
      rows: ReadonlyArray<RowRecord>;
    }
  | {
      kind: "generator";
      rowCount: number;
      seed?: number | null;
    };

export interface OpenViewportSessionRequest {
  sessionId: string;
  storeId: string;
  startRow: number;
  endRow: number;
  query: GridQueryState;
}

export interface ReplaceViewportSessionRequest {
  sessionId: string;
  startRow: number;
  endRow: number;
  query: GridQueryState;
}

export interface CloseViewportSessionRequest {
  sessionId: string;
}

export interface SsrmRequest {
  storeId: string;
  startRow: number;
  endRow: number;
  query: GridQueryState;
}

export interface ViewportPatch {
  storeId: string;
  startRow: number;
  endRow: number;
  rowCount: number;
  metrics: StoreMetrics;
  rows: ReadonlyArray<RowRecord>;
}

export interface SsrmBlockResponse extends ViewportPatch {}

export type StoreTransaction =
  | {
      kind: "upsert";
      rows: ReadonlyArray<RowRecord>;
    }
  | {
      kind: "delete";
      ids: ReadonlyArray<string>;
    };

export interface LoadStoreSuccess {
  storeId: string;
  rowCount: number;
  metrics: StoreMetrics;
}

export interface ApplyTransactionSuccess {
  storeId: string;
  rowCount: number;
  metrics: StoreMetrics;
}

export interface DisposeStoreSuccess {
  storeId: string;
  disposed: boolean;
}

export interface ReplaceViewportSessionSuccess {
  sessionId: string;
  replaced: boolean;
}

export interface CloseViewportSessionSuccess {
  sessionId: string;
  closed: boolean;
}

export interface StressState {
  storeId: string;
  rowsPerSecond: number;
  running: boolean;
  rowCount: number;
  metrics: StoreMetrics;
}

export interface StoreMetrics {
  lastCommitDurationMs: number | null;
  lastCommitChangeCount: number;
  totalCommitCount: number;
}
