# Coaching is an ahead-of-time Deliberation pipeline, not a live chatbot

Coaching Decisions are produced by **Deliberation** ahead of time — the agent analyzes the Log and derived analytics, gathers evidence, forms an opinion, and records a cited Decision (modeled on the grill→ADR flow) — and *then* surfaces it. The chat is only an interface to interrogate or amend an already-made Decision; it is never where a Decision originates. Decisions are written to an append-only, auditable, queryable **Decision log** that records what changed, the rationale, the citations, and the data window, enabling layered explanation (quick cited summary on top, deeper evidence beneath) and stall detection over the *prescription*.

## Considered Options

- **Live LLM-in-a-chatbox coach** (reason on the fly when the user asks). Rejected: produces unauditable, non-reproducible advice and reads as "a chatbot guessing," which is the core trust failure the product must avoid. It also can't detect trends over what was *prescribed*, only over what was *logged*.

## Consequences

- Two review cadences feed Deliberation: a restrained **Session review** after every Session (mostly emits Observations, escalates to a Proposal only on a confirmed trend or acute finding) and a heavier **Cycle review** at Plan-model-defined boundaries; an on-demand pass is always available.
- An **Observation** is the durable "watching this" state that prevents twitchy plan changes.
- A Decision is immutable once recorded; amendments are new Decisions, preserving the audit trail.
