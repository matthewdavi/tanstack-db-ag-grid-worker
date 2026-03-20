import * as Data from "effect/Data";

import type { GridQueryState } from "@sandbox/ag-grid-translator";

export interface ViewportRequest {
  startRow: number;
  endRow: number;
  query: GridQueryState;
}

export interface ViewportBindingHandle {
  readonly queryKey: string;
}

export type ViewportSessionState<
  ReplaceReply = unknown,
  Binding extends ViewportBindingHandle = ViewportBindingHandle,
> =
  | {
      readonly _tag: "Booting";
      readonly request: ViewportRequest;
      readonly queryKey: string;
      readonly pendingReplaceReplies: ReadonlyArray<ReplaceReply>;
    }
  | {
      readonly _tag: "Live";
      readonly request: ViewportRequest;
      readonly queryKey: string;
      readonly binding: Binding;
    }
  | {
      readonly _tag: "Recomputing";
      readonly request: ViewportRequest;
      readonly queryKey: string;
      readonly previous: Extract<ViewportSessionState<ReplaceReply, Binding>, { readonly _tag: "Live" }>;
      readonly pendingReplaceReplies: ReadonlyArray<ReplaceReply>;
    }
  | {
      readonly _tag: "Closed";
    };

export type ViewportSessionEvent<
  ReplaceReply = unknown,
  CloseReply = unknown,
  Binding extends ViewportBindingHandle = ViewportBindingHandle,
> =
  | {
      readonly _tag: "Replace";
      readonly request: ViewportRequest;
      readonly reply: ReplaceReply;
    }
  | {
      readonly _tag: "BindingReady";
      readonly request: ViewportRequest;
      readonly queryKey: string;
      readonly binding: Binding;
    }
  | {
      readonly _tag: "BindingFailed";
      readonly queryKey: string;
      readonly error: string;
    }
  | {
      readonly _tag: "SourceChanged";
      readonly queryKey: string;
      readonly triggeredAtMs: number | null;
    }
  | {
      readonly _tag: "Close";
      readonly reply: CloseReply;
    };

export type ViewportSessionCommand<
  ReplaceReply = unknown,
  CloseReply = unknown,
  Binding extends ViewportBindingHandle = ViewportBindingHandle,
> =
  | {
      readonly _tag: "BuildBinding";
      readonly request: ViewportRequest;
    }
  | {
      readonly _tag: "Publish";
      readonly binding: Binding;
      readonly request: ViewportRequest;
      readonly triggeredAtMs: number | null;
    }
  | {
      readonly _tag: "CloseBinding";
      readonly binding: Binding;
    }
  | {
      readonly _tag: "ResolveReplace";
      readonly reply: ReplaceReply;
    }
  | {
      readonly _tag: "ResolveReplaceMany";
      readonly replies: ReadonlyArray<ReplaceReply>;
    }
  | {
      readonly _tag: "RejectReplace";
      readonly reply: ReplaceReply;
      readonly error: string;
    }
  | {
      readonly _tag: "RejectReplaceMany";
      readonly replies: ReadonlyArray<ReplaceReply>;
      readonly error: string;
    }
  | {
      readonly _tag: "ResolveClose";
      readonly reply: CloseReply;
    };

export interface ViewportSessionTransitionResult<
  ReplaceReply = unknown,
  CloseReply = unknown,
  Binding extends ViewportBindingHandle = ViewportBindingHandle,
> {
  readonly state: ViewportSessionState<ReplaceReply, Binding>;
  readonly commands: ReadonlyArray<ViewportSessionCommand<ReplaceReply, CloseReply, Binding>>;
}

const ViewportState = Data.taggedEnum<ViewportSessionState<any, any>>();
const ViewportEvent = Data.taggedEnum<ViewportSessionEvent<any, any, any>>();
const ViewportCommand = Data.taggedEnum<ViewportSessionCommand<any, any, any>>();

const SESSION_CLOSED_ERROR = "Viewport session closed";

export function toViewportQueryKey(query: GridQueryState) {
  return JSON.stringify(query);
}

export function makeBootingViewportState<ReplaceReply = unknown>(
  request: ViewportRequest,
): ViewportSessionState<ReplaceReply> {
  return ViewportState.Booting({
    request,
    queryKey: toViewportQueryKey(request.query),
    pendingReplaceReplies: [],
  }) as ViewportSessionState<ReplaceReply>;
}

export function makeBuildBindingCommand<
  ReplaceReply = unknown,
  CloseReply = unknown,
  Binding extends ViewportBindingHandle = ViewportBindingHandle,
>(
  request: ViewportRequest,
): ViewportSessionCommand<ReplaceReply, CloseReply, Binding> {
  return ViewportCommand.BuildBinding({ request }) as ViewportSessionCommand<
    ReplaceReply,
    CloseReply,
    Binding
  >;
}

export function transitionViewportSession<
  ReplaceReply = unknown,
  CloseReply = unknown,
  Binding extends ViewportBindingHandle = ViewportBindingHandle,
>(
  state: ViewportSessionState<ReplaceReply, Binding>,
  event: ViewportSessionEvent<ReplaceReply, CloseReply, Binding>,
): ViewportSessionTransitionResult<ReplaceReply, CloseReply, Binding> {
  return ViewportState.$match(state, {
    Booting: (currentState) =>
      ViewportEvent.$match(event, {
        Replace: ({ request, reply }) => {
          const queryKey = toViewportQueryKey(request.query);
          const nextState = ViewportState.Booting({
            request,
            queryKey,
            pendingReplaceReplies: [...currentState.pendingReplaceReplies, reply],
          }) as ViewportSessionState<ReplaceReply, Binding>;

          return {
            state: nextState,
            commands: queryKey === currentState.queryKey
              ? []
              : [makeBuildBindingCommand<ReplaceReply, CloseReply, Binding>(request)],
          };
        },
        BindingReady: ({ queryKey, binding }) => {
          if (queryKey !== currentState.queryKey) {
            return {
              state,
              commands: [
                ViewportCommand.CloseBinding({ binding }) as ViewportSessionCommand<
                  ReplaceReply,
                  CloseReply,
                  Binding
                >,
              ],
            };
          }

          return {
            state: ViewportState.Live({
              request: currentState.request,
              queryKey,
              binding,
            }) as ViewportSessionState<ReplaceReply, Binding>,
            commands: [
              ViewportCommand.Publish({
                binding,
                request: currentState.request,
                triggeredAtMs: null,
              }) as ViewportSessionCommand<ReplaceReply, CloseReply, Binding>,
              ViewportCommand.ResolveReplaceMany({
                replies: currentState.pendingReplaceReplies,
              }) as ViewportSessionCommand<ReplaceReply, CloseReply, Binding>,
            ],
          };
        },
        BindingFailed: ({ queryKey, error }) => {
          if (queryKey !== currentState.queryKey) {
            return { state, commands: [] };
          }

          return {
            state: ViewportState.Closed() as ViewportSessionState<ReplaceReply, Binding>,
            commands: [
              ViewportCommand.RejectReplaceMany({
                replies: currentState.pendingReplaceReplies,
                error,
              }) as ViewportSessionCommand<ReplaceReply, CloseReply, Binding>,
            ],
          };
        },
        SourceChanged: () => ({ state, commands: [] }),
        Close: ({ reply }) => ({
          state: ViewportState.Closed() as ViewportSessionState<ReplaceReply, Binding>,
          commands: [
            ViewportCommand.RejectReplaceMany({
              replies: currentState.pendingReplaceReplies,
              error: SESSION_CLOSED_ERROR,
            }) as ViewportSessionCommand<ReplaceReply, CloseReply, Binding>,
            ViewportCommand.ResolveClose({ reply }) as ViewportSessionCommand<
              ReplaceReply,
              CloseReply,
              Binding
            >,
          ],
        }),
      }),
    Live: (currentState) =>
      ViewportEvent.$match(event, {
        Replace: ({ request, reply }) => {
          const queryKey = toViewportQueryKey(request.query);

          if (queryKey === currentState.queryKey) {
            return {
              state: ViewportState.Live({
                request,
                queryKey,
                binding: currentState.binding,
              }) as ViewportSessionState<ReplaceReply, Binding>,
              commands: [
                ViewportCommand.Publish({
                  binding: currentState.binding,
                  request,
                  triggeredAtMs: null,
                }) as ViewportSessionCommand<ReplaceReply, CloseReply, Binding>,
                ViewportCommand.ResolveReplace({ reply }) as ViewportSessionCommand<
                  ReplaceReply,
                  CloseReply,
                  Binding
                >,
              ],
            };
          }

          return {
            state: ViewportState.Recomputing({
              request,
              queryKey,
              previous: currentState,
              pendingReplaceReplies: [reply],
            }) as ViewportSessionState<ReplaceReply, Binding>,
            commands: [makeBuildBindingCommand<ReplaceReply, CloseReply, Binding>(request)],
          };
        },
        BindingReady: ({ binding }) => ({
          state,
          commands: [
            ViewportCommand.CloseBinding({ binding }) as ViewportSessionCommand<
              ReplaceReply,
              CloseReply,
              Binding
            >,
          ],
        }),
        BindingFailed: () => ({ state, commands: [] }),
        SourceChanged: ({ queryKey, triggeredAtMs }) =>
          queryKey !== currentState.queryKey
            ? { state, commands: [] }
            : {
                state,
                commands: [
                  ViewportCommand.Publish({
                    binding: currentState.binding,
                    request: currentState.request,
                    triggeredAtMs,
                  }) as ViewportSessionCommand<ReplaceReply, CloseReply, Binding>,
                ],
              },
        Close: ({ reply }) => ({
          state: ViewportState.Closed() as ViewportSessionState<ReplaceReply, Binding>,
          commands: [
            ViewportCommand.CloseBinding({
              binding: currentState.binding,
            }) as ViewportSessionCommand<ReplaceReply, CloseReply, Binding>,
            ViewportCommand.ResolveClose({ reply }) as ViewportSessionCommand<
              ReplaceReply,
              CloseReply,
              Binding
            >,
          ],
        }),
      }),
    Recomputing: (currentState) =>
      ViewportEvent.$match(event, {
        Replace: ({ request, reply }) => {
          const queryKey = toViewportQueryKey(request.query);
          const nextState = ViewportState.Recomputing({
            request,
            queryKey,
            previous: currentState.previous,
            pendingReplaceReplies: [...currentState.pendingReplaceReplies, reply],
          }) as ViewportSessionState<ReplaceReply, Binding>;

          return {
            state: nextState,
            commands: queryKey === currentState.queryKey
              ? []
              : [makeBuildBindingCommand<ReplaceReply, CloseReply, Binding>(request)],
          };
        },
        BindingReady: ({ queryKey, binding }) => {
          if (queryKey !== currentState.queryKey) {
            return {
              state,
              commands: [
                ViewportCommand.CloseBinding({ binding }) as ViewportSessionCommand<
                  ReplaceReply,
                  CloseReply,
                  Binding
                >,
              ],
            };
          }

          return {
            state: ViewportState.Live({
              request: currentState.request,
              queryKey,
              binding,
            }) as ViewportSessionState<ReplaceReply, Binding>,
            commands: [
              ViewportCommand.CloseBinding({
                binding: currentState.previous.binding,
              }) as ViewportSessionCommand<ReplaceReply, CloseReply, Binding>,
              ViewportCommand.Publish({
                binding,
                request: currentState.request,
                triggeredAtMs: null,
              }) as ViewportSessionCommand<ReplaceReply, CloseReply, Binding>,
              ViewportCommand.ResolveReplaceMany({
                replies: currentState.pendingReplaceReplies,
              }) as ViewportSessionCommand<ReplaceReply, CloseReply, Binding>,
            ],
          };
        },
        BindingFailed: ({ queryKey, error }) =>
          queryKey !== currentState.queryKey
            ? { state, commands: [] }
            : {
                state: currentState.previous as ViewportSessionState<ReplaceReply, Binding>,
                commands: [
                  ViewportCommand.RejectReplaceMany({
                    replies: currentState.pendingReplaceReplies,
                    error,
                  }) as ViewportSessionCommand<ReplaceReply, CloseReply, Binding>,
                ],
              },
        SourceChanged: () => ({ state, commands: [] }),
        Close: ({ reply }) => ({
          state: ViewportState.Closed() as ViewportSessionState<ReplaceReply, Binding>,
          commands: [
            ViewportCommand.CloseBinding({
              binding: currentState.previous.binding,
            }) as ViewportSessionCommand<ReplaceReply, CloseReply, Binding>,
            ViewportCommand.RejectReplaceMany({
              replies: currentState.pendingReplaceReplies,
              error: SESSION_CLOSED_ERROR,
            }) as ViewportSessionCommand<ReplaceReply, CloseReply, Binding>,
            ViewportCommand.ResolveClose({ reply }) as ViewportSessionCommand<
              ReplaceReply,
              CloseReply,
              Binding
            >,
          ],
        }),
      }),
    Closed: () =>
      ViewportEvent.$match(event, {
        Replace: ({ reply }) => ({
          state,
          commands: [
            ViewportCommand.RejectReplace({
              reply,
              error: SESSION_CLOSED_ERROR,
            }) as ViewportSessionCommand<ReplaceReply, CloseReply, Binding>,
          ],
        }),
        BindingReady: ({ binding }) => ({
          state,
          commands: [
            ViewportCommand.CloseBinding({ binding }) as ViewportSessionCommand<
              ReplaceReply,
              CloseReply,
              Binding
            >,
          ],
        }),
        BindingFailed: () => ({ state, commands: [] }),
        SourceChanged: () => ({ state, commands: [] }),
        Close: ({ reply }) => ({
          state,
          commands: [
            ViewportCommand.ResolveClose({ reply }) as ViewportSessionCommand<
              ReplaceReply,
              CloseReply,
              Binding
            >,
          ],
        }),
      }),
  });
}
