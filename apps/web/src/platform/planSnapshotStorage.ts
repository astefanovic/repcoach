import * as Schema from "effect/Schema";

import { PlanSnapshot } from "@repcoach/contracts";

import { kvGet, kvPut, PLAN_STORE } from "./indexedDb.ts";

/**
 * Durable single-slot storage for the last Plan snapshot (#72 user story 2).
 *
 * Deliberately *not* an Effect-shaped `Storage` seam like the outbox's and
 * the prescription cache's. Those two are consumed by runtime services that
 * own a persistence discipline (persist-before-reflect, exactly-once); this
 * is a read-through display cache with one writer and one reader, both in
 * the React layer, and giving it a service seam would be machinery around a
 * `get` and a `put`.
 *
 * The snapshot is decoded on the way out rather than trusted. A row written
 * by an older client whose `PlanSnapshot` shape has since moved must read as
 * "no cached Plan" — which sends the app to the server — rather than as a
 * Plan with holes in it that the editor then writes edits against.
 */
const CURRENT_SLOT = "current";

const decodePlanSnapshot = Schema.decodeUnknownSync(PlanSnapshot);
const encodePlanSnapshot = Schema.encodeUnknownSync(PlanSnapshot);

export async function loadCachedPlan(): Promise<PlanSnapshot | undefined> {
  try {
    const raw = await kvGet(PLAN_STORE, CURRENT_SLOT);
    return raw === undefined ? undefined : decodePlanSnapshot(raw);
  } catch (cause) {
    console.warn("[plan-cache] ignored unreadable persisted Plan", cause);
    return undefined;
  }
}

export async function saveCachedPlan(plan: PlanSnapshot): Promise<void> {
  try {
    await kvPut(PLAN_STORE, CURRENT_SLOT, encodePlanSnapshot(plan));
  } catch (cause) {
    // A failed cache write costs the *next* offline launch its Plan; it must
    // not cost this one its render, so it is reported and swallowed.
    console.warn("[plan-cache] could not persist the Plan snapshot", cause);
  }
}
