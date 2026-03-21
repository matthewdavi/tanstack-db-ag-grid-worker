import { readFile } from "node:fs/promises";

import { afterAll, beforeAll } from "vitest";

export function installFileFetchShim() {
  let originalFetch: typeof globalThis.fetch | null = null;

  beforeAll(() => {
    originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

      if (url.startsWith("file://")) {
        const body = await readFile(new URL(url));
        return new Response(body, {
          status: 200,
        });
      }

      return originalFetch!(input as never, init);
    };
  });

  afterAll(() => {
    if (originalFetch !== null) {
      globalThis.fetch = originalFetch;
      originalFetch = null;
    }
  });
}
