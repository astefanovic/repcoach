## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on `astefanovic/repcoach`; external PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo — one `CONTEXT.md` (glossary) + `docs/adr/` (decisions) at the repo root. See `docs/agents/domain.md`.

### Design docs

- `docs/design/open-questions.md` — the design backlog: un-grilled branches, each framed to cold-start a new `/grill-with-docs` session. Check here before starting design work; tick items as they're resolved into CONTEXT/ADRs.
- `docs/design/ui-surfaces.md` — pre-design stubs of the screens the architecture implies; the starting frame for a design session.
- `docs/design/uat-watchlist.md` — decisions made **knowingly, without evidence**, to be judged by daily-driving the app. The mirror of `open-questions.md`: that file is "not yet decided", this one is "decided, but on a guess".

**When to prompt for a watchlist entry.** During design work — a grilling session, an ADR, a spec — if a branch is resolved by taking the **expensive or permissive option and accepting a named risk**, or the honest answer is *"we won't know until it's used"*, **say so and offer to add an entry**. Don't add one silently, and don't add one for every trade-off: the bar is a decision where real use could plausibly overturn it. Typical shapes:

- a cost/latency/quota risk accepted at personal scale ("watch it rather than cap it now")
- a cap, limit or guard deliberately *not* imposed as premature
- machinery whose value depends on a usage pattern nobody has observed yet
- a simpler concept rejected on reasoning alone, where use might vindicate it

Follow the file's own entry shape (question → watch for → two fallbacks → optional bigger question), and cross-reference the entry from the resolving ADR's *Consequences*.

### Testing & UAT

Three rungs, each gating the next: unit/integration (`/tdd`, Vitest in
`thin-client/`) → e2e acceptance (Playwright specs in `thin-client/e2e/flows/`,
written by an **adversarial author agent forbidden to read
`thin-client/apps/web/src/**`**, run headless against Chromium) → human UAT by
opening the served URL on the phone browser over Tailscale. See
`docs/agents/testing.md`.

- `pnpm --filter @repcoach/e2e test` (from `thin-client/`) — boots the dev-server
  and the web client itself and runs the full Playwright suite (final piece of
  automated verification).
- `REPCOACH_AGENT_MODE=replay` turns the **`@agents` specs** onto the real agent
  adapters instead of the canned layers (#95), replayed from recorded
  transcripts — deterministic and quota-free. It is what an agent uses in place
  of `live`, and it is always paired with `--grep '@agents'`: replay moves the
  dev-server to port 4011, and the canned flows inline 4010, so a full suite run
  under replay red-lines ~80 specs on `ECONNREFUSED` before asserting anything.
  The full suite is a canned run — leave the variable unset. Clear ports
  4010/4011/5173/5174 between full runs, since `reuseExistingServer` will
  otherwise adopt a dirty in-memory server. See the testing doc's *Running the
  suite locally* and *Agent-backed rung 2*.
- **`live` mode and the production server are the owner's to start, never an
  agent's** — both spend subscription quota. Refused in code and blocked by a
  PreToolUse hook; if a run needs them, ask rather than route around it.
- `scripts/Start-RepcoachServer.ps1` — serves the built web client for final UAT;
  the phone just opens the tailnet URL in its browser. Run only after e2e is
  green.

Human UAT also carries `docs/design/uat-watchlist.md` — the design decisions daily-driving is meant to settle. The rungs prove the app does what it was built to do; the watchlist asks whether it was worth building that way.
