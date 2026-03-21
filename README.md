# ag grid sqlite worker demo

this repo is a demo of running sqlite wasm inside a worker and letting ag grid talk to it through the viewport row model.

the whole point is that the ui thread stays thin while filtering, sorting, row counts, and viewport queries happen off-thread. that setup is really fast. inserts are basically all in the ~1ms range in the worker, even while the grid keeps rendering just the visible slice instead of having a public meltdown.

## what this repo is

- `apps/demo`: the vite demo app showing the sqlite worker setup.
- `packages/sqlite-store`: the actual ag grid + sqlite worker package.
- `packages/ag-grid-translator`: the ag grid filter/sort translation layer that normalizes query state before sqlite turns it into sql.

## what the demo is proving

- sqlite in a worker is a clean way to keep main-thread work light.
- ag grid's viewport row model is a good fit when the worker owns querying.
- write churn can stay cheap because the worker coalesces refreshes and only sends back the current window plus row count.
- you do not need a giant generic client architecture to make this work.

## commands

- `bun run dev`: start the demo through turbo.
- `bun run build`: run workspace builds.
- `bun run typecheck`: run typescript checks across the workspace.
- `bun run test`: run tests across the workspace.
- `bun run check`: run build, typecheck, and test together.

## note

this repo is centered on one story now: use sqlite in a worker, keep the browser side read-only and thin, and let ag grid render the viewport without dragging the whole app into the mud.
