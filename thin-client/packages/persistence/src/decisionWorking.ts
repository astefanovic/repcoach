import type {
  Citation,
  DecisionMeasurement,
  DecisionWorking,
  DeliberationDataWindow,
} from "@repcoach/contracts";

import type { DecisionRecord } from "./store.ts";

/**
 * `DecisionRecord` → `DecisionWorking` (#79): the read model behind
 * `decisions.get`, and the one place the `decision` row's JSON columns are
 * decoded.
 *
 * It lives at the store boundary rather than in the RPC handler for two
 * reasons. Both `Store` layers produce the same `DecisionRecord`, so one
 * mapper keeps them from drifting; and the decode is the part with a rule
 * worth testing — **absent stays absent**. A `null` column means the run
 * emitted nothing there, and this must never soften that into `[]` or `""`,
 * because the surface's whole contract is that a block it renders is a block
 * the coach actually filled in (see `DecisionDraft`'s note in
 * `@repcoach/contracts`).
 *
 * The JSON columns are parsed unvalidated. They were written by this same
 * package from already-decoded contract values, so a schema round-trip here
 * would only re-prove what the write path enforced — and a decode failure on
 * read would take down a card whose summary and rationale are perfectly
 * readable.
 */
export const toDecisionWorking = (record: DecisionRecord): DecisionWorking => ({
  id: record.id as never,
  kind: record.kind as never,
  status: record.status as never,
  summary: record.summary,
  rationale: record.rationale,
  createdAt: record.createdAt,
  citations:
    record.citationsJson === null
      ? []
      : (JSON.parse(record.citationsJson) as ReadonlyArray<Citation>),
  ...(record.dataWindowJson === null
    ? {}
    : { dataWindow: JSON.parse(record.dataWindowJson) as DeliberationDataWindow }),
  ...(record.measurementsJson === null
    ? {}
    : {
        measurements: JSON.parse(record.measurementsJson) as ReadonlyArray<DecisionMeasurement>,
      }),
  ...(record.rule === null ? {} : { rule: record.rule }),
  ...(record.uncertainty === null ? {} : { uncertainty: record.uncertainty }),
});
