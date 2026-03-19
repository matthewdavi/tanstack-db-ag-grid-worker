# TanStack AG Grid Monorepo

This repository is organized as a Bun workspace managed by Turbo.

## Workspace Layout

- `apps/demo`: the Vite demo app.
- `packages/ag-grid-translator`: AG Grid model translation helpers.
- `packages/worker-store`: worker-backed store runtime and adapters.
- `packages/msgpackr-extract`: local override for `msgpackr-extract`.

## Commands

- `bun run dev`: start the demo app through Turbo.
- `bun run build`: run workspace builds.
- `bun run typecheck`: run package-aware TypeScript checks.
- `bun run test`: run tests across the workspace.
- `bun run check`: run build, typecheck, and test in one pass.

## Notes

- Workspace packages are consumed by package name, not by hand-written source aliases.
- TypeScript checks run source-first in each package without an extra declaration-build layer.
- Shared tooling lives at the repo root; package scripts use normal binary resolution instead of direct `.bin` paths.
