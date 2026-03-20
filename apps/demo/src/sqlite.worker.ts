import * as Effect from "effect/Effect";

import { launchSqliteBrowserWorker } from "@sandbox/sqlite-store";
import { marketSqliteStore } from "./market-sqlite-store";

Effect.runFork(launchSqliteBrowserWorker(marketSqliteStore));
