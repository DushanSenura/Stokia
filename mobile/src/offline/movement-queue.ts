import { createMovementQueue } from "@/lib/offline/movement-queue";
import { openDriver } from "./db";
import { createSqliteMovementStore } from "./sqlite-store";

/** The phone's queue of movements entered offline: the SHARED rules (movement-queue) over SQLite. */
export const movementQueue = createMovementQueue(createSqliteMovementStore(openDriver));
