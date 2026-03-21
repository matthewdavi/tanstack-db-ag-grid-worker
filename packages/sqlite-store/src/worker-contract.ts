import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import {
  GridQueryStateSchema,
  type GridQueryState,
} from "@sandbox/ag-grid-translator";

import type { SqliteRow } from "./store-config";

export interface ViewportIntent {
  storeId: string;
  startRow: number;
  endRow: number;
  query: GridQueryState;
}

export interface ViewportPatch<TRow extends SqliteRow = SqliteRow> {
  storeId: string;
  startRow: number;
  endRow: number;
  rowCount: number;
  latencyMs: number;
  rows: ReadonlyArray<TRow>;
}

export interface SetViewportIntentSuccess {
  connectionId: string;
  updated: boolean;
}

export interface CloseViewportChannelSuccess {
  connectionId: string;
  closed: boolean;
}

export const ViewportIntentSchema = Schema.Struct({
  storeId: Schema.String,
  startRow: Schema.Number,
  endRow: Schema.Number,
  query: GridQueryStateSchema,
}) as unknown as Schema.Schema<ViewportIntent>;

export const ViewportPatchSchema = Schema.Struct({
  storeId: Schema.String,
  startRow: Schema.Number,
  endRow: Schema.Number,
  rowCount: Schema.Number,
  latencyMs: Schema.Number,
  rows: Schema.Array(Schema.Unknown),
}) as unknown as Schema.Schema<ViewportPatch>;

const SetViewportIntentSuccessSchema = Schema.Struct({
  connectionId: Schema.String,
  updated: Schema.Boolean,
}) as Schema.Schema<SetViewportIntentSuccess>;

const CloseViewportChannelSuccessSchema = Schema.Struct({
  connectionId: Schema.String,
  closed: Schema.Boolean,
}) as Schema.Schema<CloseViewportChannelSuccess>;

export class ConnectViewportChannel extends Rpc.make("ConnectViewportChannel", {
  payload: {
    connectionId: Schema.String,
    intent: ViewportIntentSchema,
    throttleMs: Schema.Number,
  },
  success: ViewportPatchSchema,
  error: Schema.String,
  stream: true,
}) {}

export class SetViewportIntent extends Rpc.make("SetViewportIntent", {
  payload: {
    connectionId: Schema.String,
    intent: ViewportIntentSchema,
  },
  success: SetViewportIntentSuccessSchema,
  error: Schema.String,
}) {}

export class CloseViewportChannel extends Rpc.make("CloseViewportChannel", {
  payload: {
    connectionId: Schema.String,
  },
  success: CloseViewportChannelSuccessSchema,
  error: Schema.String,
}) {}

export const ViewportChannelRpcs = RpcGroup.make(
  ConnectViewportChannel,
  SetViewportIntent,
  CloseViewportChannel,
);
