# Agent cassettes (issue #95)

Recorded transcripts of the four real agent sessions, replayed through the
**real adapters** so the prompts, the decode boundary and the output contract
are exercised below human UAT. See `docs/agents/testing.md` → *Agent-backed
rung 2* for the ladder, the commands and how to refresh these.

One file per session. `stage` says which of the four agents it stands in for,
and files are handed out per stage in **filename order** — `deliberator-01.json`
before `deliberator-02.json`.

## Provenance, stated honestly

Every cassette carries a `provenance` line, and the ones committed here say
`hand-seeded`. They are not verbatim recordings: they are hand-written replies
in the shape the live sessions of issue #93 actually produced, **including the
deviations that commissioning recorded** —

- `"citationId": null` where the contract wants the key absent (deviation 1);
- `reasoning_only_points` and `surface` omitted entirely (deviation 2);
- a JSON object wrapped in a markdown fence, which the adapters strip
  defensively even though #93 never observed it live.

That is deliberate. The point of replay is to exercise the decode path against
the shapes a real model emits, and those three shapes are the ones that have
actually thrown completed work away. A cassette recorded from a run that
happened to be clean would prove less.

Refreshing them from a genuine live run replaces `provenance` with the
recorder's own line — that is the upgrade path, and it is what
`REPCOACH_AGENT_RECORD_DIR` exists for.

## `promptFingerprint`

A hash of the stage's static prompt scaffold at record time
(`agentPromptFingerprint.ts`). Replay refuses a cassette whose fingerprint no
longer matches the prompt this build sends, because the recorded reply then
answers a question the code has stopped asking. That refusal is the "fixtures
went stale" signal the ticket asked for; `REPCOACH_AGENT_ALLOW_STALE_CASSETTES=1`
overrides it while a prompt is deliberately mid-change.

`pnpm --filter @repcoach/dev-server cassettes:restamp` restamps them after a
prompt change that is known not to invalidate the replies — see
`docs/agents/testing.md`, which is explicit that this is the one tool in the
repo capable of causing the silent rot the fingerprint exists to prevent.
