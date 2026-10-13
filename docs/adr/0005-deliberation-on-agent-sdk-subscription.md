# Deliberation runs on the Claude Agent SDK under a Pro/Max subscription

Deliberation (ADR [0002](0002-deliberation-pipeline-not-live-chat.md)) is an ahead-of-time agentic process — analyze the Log, gather evidence/research, decide. That maps directly onto the **Claude Agent SDK** (the programmatic Claude Code), which can authenticate via **Pro/Max subscription OAuth** rather than a metered API key. For the personal/dogfooding phase we run Deliberation on the Agent SDK under the owner's subscription, so coaching consumes subscription quota instead of per-token API spend.

## Considered Options

- **Anthropic Messages API on an API key.** The supported path for building apps, clean server auth — but every Deliberation costs tokens. Cheap in absolute terms at personal volume, but it is a bill, and the bare Messages API is a worse fit for an agent that researches and decides with tools.
- **Agent SDK on subscription OAuth (chosen).** No per-token cost; native agent+tools fit for Deliberation (including web retrieval for the D-tier evidence in ADR [0003](0003-evidence-sourcing-corpus-then-retrieval.md)).

## Consequences / risks (accepted for personal use)

- **Limits, not unlimited** — Deliberation spends against Pro/Max rolling + weekly rate limits, shared with the owner's other Claude Code use.
- **Intended-use grey area** — subscription auth targets interactive developer use; driving it from an automated backend is acceptable for genuine personal use but is not the blessed path for a product. Revisit (switch to the Messages API) if RepCoach ever goes beyond personal.
- **OAuth plumbing** — short-lived token refreshed via the Claude Code login; the Deliberation runner runs under that logged-in profile, not a static key.
- Keep the "run a Deliberation" call site thin so the Messages API remains a drop-in fallback if limits bite.
- **Runner location:** the owner's always-on Windows home server hosts the backend — it is the sync target for the native client's Log replica and runs the Agent SDK under the owner's OAuth. Being always-on makes coaching genuinely proactive: Session reviews fire on post-session sync and Cycle reviews run on schedule without the owner initiating anything.

## Why not run Deliberation on-device (in the native app)

The native client ([0004](0004-native-android-local-first.md)) raised the option of dropping the server and deliberating on the phone. Rejected for the personal phase, because on-device Deliberation buys nothing while single-user:

- **No Agent SDK on Android** (it's Node) — on-device would mean a hand-rolled Messages-API loop, recovering tools only via server-side tools, whose availability/billing under subscription OAuth is unverified.
- **Weak background proactivity** — Android Doze / WorkManager can't reliably run multi-minute background deliberations, gutting the proactive-coach premise (ADR 0002). The always-on server runs them trivially.
- **No present payoff** — the only thing on-device per-user Deliberation unlocks is *each user riding their own subscription*, which has no supported mechanism today.

The thin seam means Deliberation can move on-device **if and when Anthropic officially supports third-party OAuth reuse** — the sole trigger that would make a multi-user, per-subscription RepCoach viable.
