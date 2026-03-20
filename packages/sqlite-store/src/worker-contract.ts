import { Schema } from "effect";

import { GridQueryStateSchema } from "@sandbox/ag-grid-translator";

import type { GridQueryState } from "@sandbox/ag-grid-translator";
import type { SqliteRow } from "./store-config";

const RowPayloadSchema = Schema.Unknown;
const RowKeyValueSchema = Schema.Union(Schema.String, Schema.Number);

const StoreMetricsSchema = Schema.Struct({
  lastCommitDurationMs: Schema.NullOr(Schema.Number),
  lastCommitChangeCount: Schema.Number,
  totalCommitCount: Schema.Number,
}) as Schema.Schema<StoreMetrics>;

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

export const ViewportPatchSchema = Schema.Struct({
  storeId: Schema.String,
  startRow: Schema.Number,
  endRow: Schema.Number,
  rowCount: Schema.Number,
  latencyMs: Schema.Number,
  metrics: StoreMetricsSchema,
  rows: Schema.Array(RowPayloadSchema),
}) as Schema.Schema<ViewportPatch>;

const ReplaceViewportSessionSuccessSchema = Schema.Struct({
  sessionId: Schema.String,
  replaced: Schema.Boolean,
}) as Schema.Schema<ReplaceViewportSessionSuccess>;

const CloseViewportSessionSuccessSchema = Schema.Struct({
  sessionId: Schema.String,
  closed: Schema.Boolean,
}) as Schema.Schema<CloseViewportSessionSuccess>;

export class OpenViewportSession extends Schema.TaggedRequest<OpenViewportSession>("OpenViewportSession")("OpenViewportSession", {
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

export class ReplaceViewportSession extends Schema.TaggedRequest<ReplaceViewportSession>("ReplaceViewportSession")("ReplaceViewportSession", {
  failure: Schema.String,
  success: ReplaceViewportSessionSuccessSchema,
  payload: {
    sessionId: Schema.String,
    startRow: Schema.Number,
    endRow: Schema.Number,
    query: GridQueryStateSchema,
  },
}) {}

export class CloseViewportSession extends Schema.TaggedRequest<CloseViewportSession>("CloseViewportSession")("CloseViewportSession", {
  failure: Schema.String,
  success: CloseViewportSessionSuccessSchema,
  payload: {
    sessionId: Schema.String,
  },
}) {}

export const WorkerRequestSchema = Schema.Union(
  OpenViewportSession,
  ReplaceViewportSession,
  CloseViewportSession,
);

export type WorkerRequest = typeof WorkerRequestSchema.Type;

export interface StoreDefinition {
  storeId: string;
  rowKey?: string | null;
}

export type StoreSource<TRow extends SqliteRow = SqliteRow> =
  | {
      kind: "rows";
      rows: ReadonlyArray<TRow>;
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

export interface ViewportPatch<TRow extends SqliteRow = SqliteRow> {
  storeId: string;
  startRow: number;
  endRow: number;
  rowCount: number;
  latencyMs: number;
  metrics: StoreMetrics;
  rows: ReadonlyArray<TRow>;
}

export type StoreTransaction<TRow extends SqliteRow = SqliteRow> =
  | {
      kind: "upsert";
      rows: ReadonlyArray<TRow>;
    }
  | {
      kind: "delete";
      ids: ReadonlyArray<string | number>;
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
