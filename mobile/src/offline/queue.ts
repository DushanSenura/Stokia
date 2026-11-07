import * as Crypto from "expo-crypto";
import { createQueue } from "@/lib/offline/queue-engine";
import { openDriver } from "./db";
import { createSqliteQueueStore } from "./sqlite-store";

/** The phone's offline queue: the SHARED rules (queue-engine) over SQLite. */
export const queue = createQueue(createSqliteQueueStore(openDriver), { newKey: () => Crypto.randomUUID() });
