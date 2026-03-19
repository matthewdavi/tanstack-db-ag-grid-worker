import * as Effect from "effect/Effect";

import { launchBrowserWorker } from "@sandbox/worker-store";

Effect.runFork(launchBrowserWorker());
