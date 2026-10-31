import type { CommandId, EntryId, LoggedSessionId } from "@repcoach/contracts";

import type { NewQueuedAddEntryNote, NewQueuedEditEntryNote } from "../outbox/model.ts";

/**
 * "Add a note" (issue #130) — builds the outbox command for the per-Entry
 * sheet's one non-Set item. Mirrors `grid.ts`'s `buildConfirmCommand`: the
 * `commandId` is minted here, once, so a queued note replays idempotently
 * (migration `018`) no matter how many times the outbox retries it after a
 * reconnect.
 */
export function buildAddEntryNoteCommand(args: {
  readonly makeCommandId: () => CommandId;
  readonly loggedSessionId: LoggedSessionId;
  readonly entryId: EntryId;
  readonly text: string;
  readonly recordedAt?: string;
}): NewQueuedAddEntryNote {
  return {
    kind: "addEntryNote",
    commandId: args.makeCommandId(),
    loggedSessionId: args.loggedSessionId,
    entryId: args.entryId,
    text: args.text,
    recordedAt: args.recordedAt ?? new Date().toISOString(),
  };
}

/**
 * "Edit note" (UAT) — the same sheet item once the Entry already has a note.
 * `noteId` is the EXISTING note's id (its original `commandId`, migration
 * `018`); the `commandId` minted here is this command's own outbox identity,
 * and is never a row id. Replay-safe without any server-side dedupe: the
 * command carries the whole resulting text, so applying it twice lands the
 * row in the same state.
 */
export function buildEditEntryNoteCommand(args: {
  readonly makeCommandId: () => CommandId;
  readonly loggedSessionId: LoggedSessionId;
  readonly entryId: EntryId;
  readonly noteId: string;
  readonly text: string;
}): NewQueuedEditEntryNote {
  return {
    kind: "editEntryNote",
    commandId: args.makeCommandId(),
    loggedSessionId: args.loggedSessionId,
    entryId: args.entryId,
    noteId: args.noteId,
    text: args.text,
  };
}
