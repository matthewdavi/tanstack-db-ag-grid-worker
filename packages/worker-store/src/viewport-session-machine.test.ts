import * as Effect from "effect/Effect";
import { effect, expect } from "@effect/vitest";
import { describe } from "vitest";

import {
  makeBootingViewportState,
  transitionViewportSession,
  type ViewportRequest,
} from "./viewport-session-machine";

const baseRequest: ViewportRequest = {
  startRow: 0,
  endRow: 50,
  query: {
    predicate: null,
    sorts: [{ field: "athlete", direction: "asc" }],
  },
};

describe("viewport session machine", () => {
  effect("enters Live when a booting binding becomes ready", () =>
    Effect.sync(() => {
      const binding = {
        queryKey: JSON.stringify(baseRequest.query),
      };

      const result = transitionViewportSession(
        makeBootingViewportState(baseRequest),
        {
          _tag: "BindingReady",
          request: baseRequest,
          queryKey: binding.queryKey,
          binding,
        },
      );

      expect(result.state._tag).toBe("Live");
      expect(result.commands.map((command) => command._tag)).toEqual([
        "Publish",
        "ResolveReplaceMany",
      ]);
    }),
  );

  effect("republishes immediately when a live session only changes range", () =>
    Effect.sync(() => {
      const reply = "replace-1";
      const binding = {
        queryKey: JSON.stringify(baseRequest.query),
      };
      const result = transitionViewportSession(
        {
          _tag: "Live",
          request: baseRequest,
          queryKey: binding.queryKey,
          binding,
        },
        {
          _tag: "Replace",
          request: {
            ...baseRequest,
            startRow: 50,
            endRow: 100,
          },
          reply,
        },
      );

      expect(result.state._tag).toBe("Live");
      expect(result.commands).toHaveLength(2);
      expect(result.commands[0]).toMatchObject({
        _tag: "Publish",
        request: {
          startRow: 50,
          endRow: 100,
        },
      });
      expect(result.commands[1]).toMatchObject({
        _tag: "ResolveReplace",
        reply,
      });
    }),
  );

  effect("rebuilds when a live session changes query identity", () =>
    Effect.sync(() => {
      const reply = "replace-2";
      const binding = {
        queryKey: JSON.stringify(baseRequest.query),
      };
      const nextRequest: ViewportRequest = {
        ...baseRequest,
        query: {
          predicate: {
            kind: "comparison",
            field: "country",
            filterType: "text",
            operator: "eq",
            value: "USA",
          },
          sorts: [{ field: "athlete", direction: "desc" }],
        },
      };

      const result = transitionViewportSession(
        {
          _tag: "Live",
          request: baseRequest,
          queryKey: binding.queryKey,
          binding,
        },
        {
          _tag: "Replace",
          request: nextRequest,
          reply,
        },
      );

      expect(result.state._tag).toBe("Recomputing");
      expect(result.commands).toEqual([
        {
          _tag: "BuildBinding",
          request: nextRequest,
        },
      ]);
    }),
  );

  effect("returns to Live when a recomputing binding becomes ready", () =>
    Effect.sync(() => {
      const previousBinding = {
        queryKey: JSON.stringify(baseRequest.query),
      };
      const nextRequest: ViewportRequest = {
        ...baseRequest,
        query: {
          predicate: {
            kind: "comparison",
            field: "country",
            filterType: "text",
            operator: "eq",
            value: "Canada",
          },
          sorts: [{ field: "athlete", direction: "desc" }],
        },
      };
      const nextBinding = {
        queryKey: JSON.stringify(nextRequest.query),
      };

      const result = transitionViewportSession(
        {
          _tag: "Recomputing",
          request: nextRequest,
          queryKey: nextBinding.queryKey,
          previous: {
            _tag: "Live",
            request: baseRequest,
            queryKey: previousBinding.queryKey,
            binding: previousBinding,
          },
          pendingReplaceReplies: ["replace-3"],
        },
        {
          _tag: "BindingReady",
          request: nextRequest,
          queryKey: nextBinding.queryKey,
          binding: nextBinding,
        },
      );

      expect(result.state._tag).toBe("Live");
      expect(result.commands.map((command) => command._tag)).toEqual([
        "CloseBinding",
        "Publish",
        "ResolveReplaceMany",
      ]);
    }),
  );

  effect("closes from any state and emits cleanup commands", () =>
    Effect.sync(() => {
      const binding = {
        queryKey: JSON.stringify(baseRequest.query),
      };

      const result = transitionViewportSession(
        {
          _tag: "Live",
          request: baseRequest,
          queryKey: binding.queryKey,
          binding,
        },
        {
          _tag: "Close",
          reply: "close-1",
        },
      );

      expect(result.state._tag).toBe("Closed");
      expect(result.commands.map((command) => command._tag)).toEqual([
        "CloseBinding",
        "ResolveClose",
      ]);
    }),
  );
});
