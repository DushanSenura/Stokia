import { createQueue } from "@/lib/offline/queue-engine";
import { newIdempotencyKey } from "@/lib/offline/idempotency";
import { createLocalStorageQueueStore } from "./web-store";

/** Browser test build only: the same shared rules over localStorage. */
export const queue = createQueue(createLocalStorageQueueStore(localStorage), { newKey: newIdempotencyKey });
