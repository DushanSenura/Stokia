import { createMovementQueue } from "@/lib/offline/movement-queue";
import { createLocalStorageMovementStore } from "./web-store";

/** Browser test build only: the same shared rules over localStorage. */
export const movementQueue = createMovementQueue(createLocalStorageMovementStore(localStorage));
