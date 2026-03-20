import * as Effect from "effect/Effect";

import { launchSqliteBrowserWorker } from "@sandbox/sqlite-store";

Effect.runFork(launchSqliteBrowserWorker());
