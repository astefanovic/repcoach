import { describe, expect, it } from "vitest";

import { statusStripState } from "./statusStrip.ts";

/**
 * Rung 1 for the status strip (#50). These assert the #42 *semantics* rather
 * than the wording — the tone rules are settled decisions, the strings are a
 * choice this ticket made (see `statusStrip.ts`), so pinning the exact text
 * here would freeze the weaker of the two.
 */
describe("statusStripState", () => {
  it("is neutral and idle when connected with nothing pending", () => {
    const state = statusStripState({ notConnectedToHome: false, pendingCount: 0 });
    expect(state.tone).toBe("neutral");
  });

  it("stays neutral while draining a backlog, because that resolves itself", () => {
    const state = statusStripState({ notConnectedToHome: false, pendingCount: 3 });
    expect(state.tone).toBe("neutral");
    expect(state.text).toContain("3 pending");
  });

  it("raises caution when not connected to home", () => {
    const state = statusStripState({ notConnectedToHome: true, pendingCount: 0 });
    expect(state.tone).toBe("caution");
  });

  it("names the pending count while offline, so the user can trust the capture", () => {
    const state = statusStripState({ notConnectedToHome: true, pendingCount: 3 });
    expect(state.tone).toBe("caution");
    expect(state.text).toContain("3 pending");
  });

  /**
   * #42's never-red rule, as amended by #111. The rule was never really "the
   * strip may not go red" — it was "an *expected* state may not go red", and
   * offline mid-gym is the expected state it was written for. That half is
   * unchanged and is what this pins: no combination of connection and backlog
   * escalates past caution.
   */
  it("keeps every expected state at caution or below — offline is not a failure", () => {
    for (const notConnectedToHome of [true, false]) {
      for (const pendingCount of [0, 1, 3, 99]) {
        const state = statusStripState({ notConnectedToHome, pendingCount });
        expect(["neutral", "caution"]).toContain(state.tone);
      }
    }
  });

  /**
   * Issue #111: the drift that made every Intake fail. Red, above everything,
   * and it names the reload — because that is the only move the user has, and
   * on a phone it is the one they would not think of.
   */
  describe("an out-of-date client (#111)", () => {
    it("goes red, which no expected state ever does", () => {
      const state = statusStripState({
        notConnectedToHome: false,
        pendingCount: 0,
        clientOutOfDate: true,
      });
      expect(state.tone).toBe("error");
    });

    it("tells the user to reload rather than naming the diagnosis", () => {
      const { text } = statusStripState({
        notConnectedToHome: false,
        pendingCount: 0,
        clientOutOfDate: true,
      });
      expect(text).toContain("reload");
    });

    /**
     * It outranks offline deliberately. Offline says "your work is safe, carry
     * on"; a stale bundle means carrying on is exactly what the user must not
     * do, since a cold draft bills an agent run before being discarded.
     */
    it("outranks every other state, including offline and a live run", () => {
      const state = statusStripState({
        notConnectedToHome: true,
        pendingCount: 4,
        clientOutOfDate: true,
        revisionRunning: true,
        deliberationStatus: "running",
      });
      expect(state.tone).toBe("error");
      expect(state.text).toContain("reload");
    });

    it("stays quiet when the client is current", () => {
      const state = statusStripState({
        notConnectedToHome: false,
        pendingCount: 0,
        clientOutOfDate: false,
      });
      expect(state.tone).toBe("neutral");
    });
  });

  /**
   * #80: the strip must not call queued work "sets" any more — the outbox now
   * carries Plan edits too, and a Plan edit counted as a set is a false
   * statement made in the one place the user goes to trust the capture.
   */
  it("counts pending work without claiming what kind of work it is", () => {
    for (const pendingCount of [1, 2, 7]) {
      for (const notConnectedToHome of [true, false]) {
        const { text } = statusStripState({ notConnectedToHome, pendingCount });
        expect(text).toContain(`${pendingCount} pending`);
        expect(text).not.toContain("set");
      }
    }
  });

  /**
   * Issue #66 slice 3: the Revision run's "coach running" state and its
   * transient green flash on landing — the two states #50 left unwired.
   */
  describe("Revision run states (#66)", () => {
    it("picks up coach running while a Revision run is in flight", () => {
      const state = statusStripState({
        notConnectedToHome: false,
        pendingCount: 0,
        revisionRunning: true,
      });
      expect(state.tone).toBe("neutral");
      expect(state.text).toContain("coach running");
    });

    it("flashes green when the run lands", () => {
      const state = statusStripState({
        notConnectedToHome: false,
        pendingCount: 0,
        revisionJustLanded: true,
      });
      expect(state.tone).toBe("flash");
    });

    it("prefers the landing flash over the running state once the run is done", () => {
      const state = statusStripState({
        notConnectedToHome: false,
        pendingCount: 0,
        revisionRunning: true,
        revisionJustLanded: true,
      });
      expect(state.tone).toBe("flash");
    });

    it("never lets a Revision run override the offline caution — #42 caps the strip there", () => {
      const state = statusStripState({
        notConnectedToHome: true,
        pendingCount: 0,
        revisionRunning: true,
        revisionJustLanded: true,
      });
      expect(state.tone).toBe("caution");
    });

    it("defaults to the ordinary idle/syncing states when the fields are omitted", () => {
      const state = statusStripState({ notConnectedToHome: false, pendingCount: 0 });
      expect(state.tone).toBe("neutral");
      expect(state.text).toBe("synced · idle");
    });
  });

  /**
   * Issue #78: the Deliberation run — the scheduled/session-review kind — is
   * the run `apps/expo`'s retired `DeliberationStateIndicator` was the only
   * surface for. Same #42 semantics as the Revision states above; the extra
   * obligation is ADR 0011 §8's: a deferred run must be **said out loud**, so
   * the queued state names its backlog rather than looking idle.
   */
  describe("Deliberation run states (#78)", () => {
    it("picks up coach running while a Deliberation run is in flight", () => {
      const state = statusStripState({
        notConnectedToHome: false,
        pendingCount: 0,
        deliberationStatus: "running",
      });
      expect(state.tone).toBe("neutral");
      expect(state.text).toContain("coach running");
    });

    it("says the deferral queue out loud rather than looking idle", () => {
      const state = statusStripState({
        notConnectedToHome: false,
        pendingCount: 0,
        deliberationStatus: "queued",
        deliberationQueuedCount: 2,
      });
      expect(state.tone).toBe("neutral");
      expect(state.text).toContain("queued");
      expect(state.text).toContain("2");
    });

    it("keeps naming the backlog while a run is in flight, not just while queued", () => {
      const state = statusStripState({
        notConnectedToHome: false,
        pendingCount: 0,
        deliberationStatus: "running",
        deliberationQueuedCount: 3,
      });
      expect(state.text).toContain("3 runs");
    });

    it("agrees with itself about singular and plural queued runs", () => {
      const one = statusStripState({
        notConnectedToHome: false,
        pendingCount: 0,
        deliberationStatus: "queued",
        deliberationQueuedCount: 1,
      });
      expect(one.text).toContain("1 run ");
      const two = statusStripState({
        notConnectedToHome: false,
        pendingCount: 0,
        deliberationStatus: "queued",
        deliberationQueuedCount: 2,
      });
      expect(two.text).toContain("2 runs");
    });

    it("flashes green when a Deliberation run lands", () => {
      const state = statusStripState({
        notConnectedToHome: false,
        pendingCount: 0,
        deliberationJustLanded: true,
      });
      expect(state.tone).toBe("flash");
    });

    it("prefers the landing flash over the running state once the run is done", () => {
      const state = statusStripState({
        notConnectedToHome: false,
        pendingCount: 0,
        deliberationStatus: "running",
        deliberationJustLanded: true,
      });
      expect(state.tone).toBe("flash");
    });

    it("never lets a Deliberation run override the offline caution", () => {
      const state = statusStripState({
        notConnectedToHome: true,
        pendingCount: 0,
        deliberationStatus: "queued",
        deliberationQueuedCount: 3,
        deliberationJustLanded: true,
      });
      expect(state.tone).toBe("caution");
    });

    it("stays out of the way when the runner is idle", () => {
      const state = statusStripState({
        notConnectedToHome: false,
        pendingCount: 0,
        deliberationStatus: "idle",
        deliberationQueuedCount: 0,
      });
      expect(state.text).toBe("synced · idle");
    });

    /**
     * The Revision run is the one the user is standing there waiting on
     * (ADR 0013 §5); a scheduled Deliberation is ambient. When both are live
     * the strip's single line belongs to the foreground one.
     */
    it("yields to a Revision run, which the user is actively waiting on", () => {
      const state = statusStripState({
        notConnectedToHome: false,
        pendingCount: 0,
        revisionRunning: true,
        deliberationStatus: "running",
      });
      expect(state.text).toContain("revising");
    });

    it("does not let an ambient landing steal the line from a Revision in flight", () => {
      const state = statusStripState({
        notConnectedToHome: false,
        pendingCount: 0,
        revisionRunning: true,
        deliberationJustLanded: true,
      });
      expect(state.text).toContain("revising");
    });

    it("still yields to a Revision landing, which the user asked for", () => {
      const state = statusStripState({
        notConnectedToHome: false,
        pendingCount: 0,
        revisionJustLanded: true,
        deliberationJustLanded: true,
      });
      expect(state.text).toContain("revision");
    });

    /**
     * A run that is idle, running or queued is the system working, and none of
     * them may escalate — the whole value of red is that it is rare. `failed`
     * is excluded because #111 moved it there on purpose (see below).
     */
    it("keeps every healthy Deliberation state at caution or below", () => {
      for (const deliberationStatus of ["idle", "running", "queued"] as const) {
        for (const notConnectedToHome of [true, false]) {
          const state = statusStripState({
            notConnectedToHome,
            pendingCount: 0,
            deliberationStatus,
            deliberationQueuedCount: 2,
          });
          expect(["neutral", "caution"]).toContain(state.tone);
        }
      }
    });

    /**
     * Issue #90: a killed run, an unparseable output, or a session that
     * could not start ends in a "failed" run state rather than vanishing.
     *
     * **Red since #111**, where it was caution. The reason for the change is
     * the difference between the two yellows it used to share a colour with: a
     * backlog drains itself and being offline ends when you walk into signal,
     * but a coach run that died stays dead until someone looks at the server.
     */
    describe("a failed Deliberation run (#90)", () => {
      it("goes red — a dead run does not resolve itself the way offline does", () => {
        const state = statusStripState({
          notConnectedToHome: false,
          pendingCount: 0,
          deliberationStatus: "failed",
        });
        expect(state.tone).toBe("error");
        expect(state.text).toContain("coach failed");
      });

      it("names the failure reason when one is given", () => {
        const state = statusStripState({
          notConnectedToHome: false,
          pendingCount: 0,
          deliberationStatus: "failed",
          deliberationFailureReason: "hit the 40-turn cap",
        });
        expect(state.text).toContain("hit the 40-turn cap");
      });

      it("still says something honest when no reason was given", () => {
        const state = statusStripState({
          notConnectedToHome: false,
          pendingCount: 0,
          deliberationStatus: "failed",
        });
        expect(state.text).toBe("coach failed");
      });

      it("never lets a failed Deliberation run override the offline caution's own text", () => {
        const state = statusStripState({
          notConnectedToHome: true,
          pendingCount: 2,
          deliberationStatus: "failed",
          deliberationFailureReason: "hit the 40-turn cap",
        });
        expect(state.tone).toBe("caution");
        expect(state.text).toContain("offline");
      });

      it("yields to a Revision run in flight, same as every other Deliberation state", () => {
        const state = statusStripState({
          notConnectedToHome: false,
          pendingCount: 0,
          revisionRunning: true,
          deliberationStatus: "failed",
        });
        expect(state.text).toContain("revising");
      });
    });
  });
});
