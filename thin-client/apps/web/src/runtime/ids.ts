import type { BlockId, CommandId, EntryId, ExerciseId, SessionId, SetId } from "@repcoach/contracts";

/**
 * Client-minted ids (#72).
 *
 * Two contracts already insist the client mints its own: the outbox's
 * `commandId` is the exactly-once key the server dedupes on (ADR 0006), and
 * every structural Plan operation carries the id of whatever it creates (#71)
 * so a replayed edit cannot duplicate a Session. Both mean a retry must
 * replay the *same* id — which is why these are called at the moment of the
 * user's action and then held, never regenerated on a re-render.
 *
 * `crypto.randomUUID` needs a secure context, which the app has over
 * localhost and over the tailnet's HTTPS origin but not over a plain-HTTP
 * LAN address. The fallback is not cryptographically strong and does not
 * need to be — these ids are scoped to one user's own data and only have to
 * not collide.
 */
function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const makeCommandId = (): CommandId => `cmd-${uuid()}` as CommandId;
export const makeSessionId = (): SessionId => `session-${uuid()}` as SessionId;
export const makeBlockId = (): BlockId => `block-${uuid()}` as BlockId;
export const makeEntryId = (): EntryId => `entry-${uuid()}` as EntryId;
export const makeSetId = (): SetId => `set-${uuid()}` as SetId;
/**
 * A User-authored exercise's id (#102). Client-minted for the same reason the
 * rest are, and with more riding on it: creating an exercise is not a Plan
 * operation (ADR 0016) and so does not travel through the outbox, leaving
 * this id as the only guard against a retry minting a second exercise.
 */
export const makeExerciseId = (): ExerciseId => `exercise-${uuid()}` as ExerciseId;
