// Lists finished Logged Sessions the coach has not reviewed (issue #132).
//
// READ-ONLY. Opens the live DB with `readonly: true` and runs SELECTs only, so
// it is safe to run against a server that is up. It never starts an agent, so it
// spends no subscription quota.
//
// Why this exists: the bug it verifies was invisible for ten days. Three
// sessions were finished and never reviewed, and nothing in the app said so —
// the failed-run state lived in memory and died with the process. This is the
// lever that answers "has the coach actually kept up?" without booting anything.
//
// Usage (portable Node 22, which has node:sqlite):
//   node scripts/Get-UnreviewedSessions.mjs
//   node scripts/Get-UnreviewedSessions.mjs --db /path/to/repcoach.sqlite
//
// Exit code is 0 when nothing is owed, 1 when something is — so it can gate a
// check rather than only being read by a human.

import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

// `node:sqlite` is loaded via createRequire for the same reason the app does it.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

const argv = process.argv.slice(2);
const dbFlagIndex = argv.indexOf("--db");
const dbPath =
  dbFlagIndex !== -1 && argv[dbFlagIndex + 1] !== undefined
    ? argv[dbFlagIndex + 1]
    : path.join(os.homedir(), ".repcoach", "repcoach.sqlite");

let db;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
} catch (cause) {
  console.error(`Could not open ${dbPath} read-only: ${cause.message}`);
  process.exit(2);
}

// `review_status` only exists once migration 017 has run. Report that plainly
// rather than crashing with a SQL error — an un-migrated DB is a real state
// (the server has not been restarted since the fix landed), and it means every
// finished session is still unreviewed.
const columns = db.prepare(`PRAGMA table_info(logged_session)`).all();
const migrated = columns.some((column) => column.name === "review_status");

if (!migrated) {
  const finished = db
    .prepare(`SELECT COUNT(*) AS n FROM logged_session WHERE status = 'finished'`)
    .get();
  console.log(`DB:        ${dbPath}`);
  console.log(`Migration: 017 has NOT run — restart the server to apply it.`);
  console.log(
    `Until it does, all ${finished.n} finished session(s) are unreviewed; the migration backfills them to pending.`,
  );
  db.close();
  process.exit(finished.n > 0 ? 1 : 0);
}

const rows = db
  .prepare(
    `SELECT s.id,
            s.started_at,
            s.finished_at,
            s.review_status,
            (SELECT COUNT(DISTINCT a.set_id) FROM logged_set_actual a WHERE a.logged_session_id = s.id) AS sets
     FROM logged_session s
     WHERE s.status = 'finished' AND s.review_status = 'pending'
     ORDER BY s.finished_at IS NOT NULL, s.finished_at ASC`,
  )
  .all();

const reviewed = db
  .prepare(`SELECT COUNT(*) AS n FROM logged_session WHERE status = 'finished' AND review_status = 'reviewed'`)
  .get();

// The run ledger is the independent check: a session marked `reviewed` should
// have left cost rows behind. Reported alongside so "the marker says reviewed"
// can be sanity-checked against "a run actually happened".
const ledger = db
  .prepare(
    `SELECT COUNT(DISTINCT run_id) AS runs FROM deliberation_run_ledger WHERE cadence = 'session-review'`,
  )
  .get();

console.log(`DB:                    ${dbPath}`);
console.log(`Reviewed sessions:     ${reviewed.n}`);
console.log(`Session-review runs:   ${ledger.runs} (distinct run_id on the ledger)`);
console.log(`Awaiting review:       ${rows.length}`);

if (rows.length > 0) {
  console.log("");
  console.log("  finished_at               sets  logged_session_id");
  console.log("  ------------------------  ----  ------------------------------------");
  for (const row of rows) {
    const finishedAt = (row.finished_at ?? "(none recorded)").padEnd(24);
    const sets = String(row.sets).padStart(4);
    console.log(`  ${finishedAt}  ${sets}  ${row.id}`);
  }
  console.log("");
  console.log("These are picked up by the Session-review drain: immediately on the next");
  console.log("server start, and every 15 minutes thereafter while any remain.");
}

db.close();
process.exit(rows.length > 0 ? 1 : 0);
