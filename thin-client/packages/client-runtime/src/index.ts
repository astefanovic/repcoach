// Task 3a: vendored client-runtime (connection supervisor, rpc) adapted from
// t3code's `packages/client-runtime/src/{connection,rpc}`.
export * as Connection from "./connection/index.ts";
export * as Rpc from "./rpc/index.ts";
// Task 4 (issue #18, G1): the log outbox.
export * as Outbox from "./outbox/index.ts";
// Task 5 (issue #19, G3): prescription prefetch + durable cache.
export * as Prescription from "./prescription/index.ts";
// Task 6 (issue #20): the logging grid's pure presentation/interaction logic.
export * as Logging from "./logging/index.ts";
// Task 7 (issue #21): the rest timer's pure state/tick logic (fully local).
export * as Timer from "./timer/index.ts";
// #71: Plan authoring — set runs, run formatting, and the operation seam
// (apply / validate / invert) both Store layers and the editor share.
export * as Plan from "./plan/index.ts";
// #74: the Intake takeover's pure logic — activity phrasing, the citation
// lifecycle, the revision ledger, the sweep's scoped disclosure. The rung-1
// suite runs `environment: "node"` with no DOM, so a decision left in
// JSX is one no test can reach — every decision the takeover makes lives here.
export * as Intake from "./intake/index.ts";
// #117: the consistency heatmap's bucket thresholds and week-column layout.
export * as Stats from "./stats/index.ts";
// kg / lb display units — presentation only; every
// stored load stays kg.
export * as Units from "./units/index.ts";
// Strong / Hevy CSV import — parsed and exercise-matched on the device,
// written by `data.importWorkouts`.
export * as WorkoutImport from "./workoutImport/index.ts";
