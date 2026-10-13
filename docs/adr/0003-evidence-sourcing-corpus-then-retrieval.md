# Evidence sourcing: minimal seed floor, retrieval-as-norm, corpus grows by promotion

Every coaching Decision is grounded in **Citations** that the user can check. The **Evidence base** is a small curated **floor** of foundational, settled principles — the trusted spine for the very first Plan — and the agent does **most** of its sourcing via live web retrieval as decisions become tailored. Each Citation carries a visible trust level — `corpus-verified` or `retrieved-unverified` — and a retrieved source stays `retrieved-unverified` until a human promotes it into the corpus. The corpus therefore **grows organically from real deliberations** rather than being hand-curated up front. The app discloses upfront that the user should check sources.

> **Amends the original decision.** This ADR previously specified a *corpus-first* model (~15–25 hand-authored principles as the primary tier, retrieval secondary). We deliberately shifted the centre of gravity to **corpus-as-floor, retrieval-as-norm**: a tiny seed plus organic growth via promotion. Rationale below.
>
> **Second amendment (2026-07-25), after authoring the seed.** Writing the corpus surfaced three things this ADR had wrong or under-specified, all now folded into §1–§2: the "~4–6" size and the list of likely admits were gestures, not bounds, and were being read as both; test (a) is broader than *authoring*; and one of the illustrative admits ("minimal frequency") does not survive the evidence. Also settles the source bar — a seat must carry the whole claim, and paywalled full text is fine when the abstract carries it.

## Decision

### 1. Minimal seed floor
A principle earns a seat in the seed only if it passes **both** tests:
- **(a) load-bearing on the coach's first decisions** — the agent cannot author a coherent beginner hypertrophy Plan *or* correctly read the first Check-ins and Logged Sessions without it; and
- **(b) settled-enough-to-need-no-retrieval** — no serious practitioner disagreement, no "it depends".

This is the *intersection*, not the union. It excludes anything "it depends": specific volume landmarks (MEV/MAV/MRV numbers), periodization models, deload timing, exercise selection, myo-reps / lengthened partials, full-vs-partial ROM — all of which are **retrieval-time** concerns.

**The floor has no target size.** It is whatever passes both tests — currently **seven** entries ([the seed](../evidence/evidence-base-seed.md)). An earlier revision of this ADR said "~4–6" and offered an illustrative list of likely admits; both were gestures at smallness that were then mistaken for a bound and for a search. Neither is normative: authoring the seed is a *sweep* of the candidate space against the two tests, and the resulting count is an output. Smallness is still the intent — §5 full-injects the corpus, so growth has a real cost — but the tests decide, not the number.

**On test (a).** It reads *the coach's first decisions*, not narrowly *authoring*. A claim that governs how the coach interprets a signal the app collects from day one — soreness in a Check-in, a prescribed-vs-actual delta — is as load-bearing as one that shapes the Plan document, because the coach acts on it just as early. The sharpest case for seating such a claim is a **retrieval blind spot**: retrieval covers questions the agent knows it has, but a confidently-held wrong prior generates no search query, so nothing else in the architecture catches it. That is why "soreness is not a measure of the training stimulus" is seated.

**Superseded example.** This ADR previously cited "weekly volume must be distributed across some minimal frequency" as a likely admit. That does not survive the evidence: with weekly set volume equated, frequency has little independent effect on hypertrophy. The seed seats the defensible version — frequency is the *vehicle* for distributing the weekly volume target, which is what licenses the agent to lay out a split around the user's availability. Recorded here because the superseded phrasing kept regenerating in downstream work.

### 2. Uniform entry shape (seed and promoted alike)
- **`claim`** — the principle as a single citable sentence (this *is* the one-liner).
- **`source`** — a real, checkable reference. For seed entries a **review / meta-analysis / authoritative reference** is not just acceptable but *preferred* — it is the honest source-type for consensus claims, and still checkable. (Do not force a single primary trial onto a textbook-consensus claim.)
  - **The seat must carry the whole claim.** Every clause of the `claim` sentence must be supported by the cited source. A source that carries only part of it is recorded as **corroboration**, with the clause it covers named, and a source that carries all of it takes the seat. A near-miss here is not cosmetic — it is exactly what the Adversarial sweep exists to strip, and a seed entry the sweep would strip is worse than no entry.
  - **Paywalled full text is acceptable, provided the openly readable part carries the claim.** Seed claims are broad, settled principles; the abstract or conclusion is where such a claim lives, and that is the level at which a Deliberation will use it. Requiring open full text would cost most review-tier sources for no gain in checkability. Prefer an open-access source when one of equal quality exists, but do not downgrade the claim or the source tier to get one.
- **`applicability`** — when the claim holds / when to override.
- **`trust`** — `corpus-verified` for anything in the base (seed or promoted); `retrieved-unverified` only ever lives on un-promoted live-retrieval citations.

### 3. Retrieval guardrails
Because the seed is tiny, **retrieval carries most citations** — so retrieval quality *is* the product's credibility. It is therefore constrained:
- **Scientific sources only, with a real stable URL** — PubMed / meta-analyses / systematic reviews as the primary tier, reputable evidence-based practitioners as a lower sub-tier. Not open-web blogs/forums.
- **No source → no fabricated citation.** If no checkable source is found, the agent either falls back to a seed principle (and says so) or surfaces the recommendation flagged **"reasoning only, uncited"**. A fabricated reference is never acceptable.
- Everything retrieval produces is `retrieved-unverified` until promoted.

### 4. Promotion (human-gated, never automatic) — a *runtime* gate

**Scope.** This section governs how the corpus **grows at runtime**: a source the agent met mid-deliberation being written into the corpus. The risk it exists to stop is laundering an unvetted web source as `corpus-verified`.

It does **not** govern the [seed](../evidence/evidence-base-seed.md). The seed is authored offline against the §1 inclusion test with every source fetched and read, and vetted before seating — the human judgement the gate exists to force has already happened, in the open, under review. Seed entries enter the corpus directly at `corpus-verified`, and later edits to a seated entry are ordinary reviewed changes to that file, not promotions. Applying the promotion queue to the seed would be ceremony over a decision already made deliberately.
- **Candidate trigger:** a `retrieved-unverified` source cited in an **accepted Proposal** becomes a promotion candidate (the owner accepting the Proposal is the signal its evidence held up). Reuse across deliberations may raise rank but is not required.
- **Gate:** candidates collect in a **batch review queue**; the owner reviews `claim + source + applicability` and approves → the entry is written into the corpus as `corpus-verified`. Until approved it stays `retrieved-unverified` even if cited repeatedly.
- **No auto-promotion, ever** — never launder a retrieved source as corpus-verified.

### 5. Storage and prompt
- **Server-side corpus.** The Evidence base and the promotion queue live where Deliberation runs (the home server, [ADR 0005](0005-deliberation-on-agent-sdk-subscription.md)). The phone never replicates the corpus.
- **Citations are value-snapshots on Decisions.** When a Decision is generated, its citations (`claim` + `source` URL + `trust` **as of that decision**) are denormalized onto the Decision and synced to the phone — so cited reasoning is readable offline, and the Decision log stays **historically honest** (a Decision keeps the trust level it had at decision time even after the source is later promoted). Mirrors the immutability pattern in [ADR 0008](0008-plan-changes-carry-origin-and-status.md).
- **Full-inject, no cap (for now).** The whole corpus is injected into every deliberation as a compact **roster of `claim` lines** (+ short `source`/`applicability`), so the agent always sees the full spine of settled principles it can cite into. At review-tier density this stays tiny for a long time (dozens of entries fit a modest budget). **Corpus→prompt selection at scale is deferred to the Deliberation branch** (open-questions §2) and only activates if the corpus ever outgrows the budget.

## Considered Options
- **Corpus-first (the prior decision).** Superseded: 15–25 hand-authored entries is a near-term chore that front-loads guesses about what matters, and the coach's value is precisely that it researches specifics itself. Kept the *floor* idea, dropped the *primary-tier* weight.
- **Trust model knowledge, cite post-hoc.** Rejected: LLMs fabricate plausible-looking references; a fake citation is worse than none and actively deceptive.
- **Pure live-retrieval, no floor at all.** Rejected: the first Plan needs *some* trusted ground, and an unconstrained web search stakes credibility on whatever a mid-decision search returns. The minimal seed + the §3 scientific-source guardrail together neutralise this — the guardrail is what makes the small-seed bet safe.
- **Auto-promote frequently-cited retrieved sources.** Rejected: launders unverified evidence as corpus-verified without human vetting.

## Consequences
- The seed is a small near-term deliverable; the agent may draft it for the owner's review. **Delivered and live:** [`docs/evidence/evidence-base-seed.md`](../evidence/evidence-base-seed.md) (+ JSON twin) is the **working seed** — seven entries, sources vetted and accepted 2026-07-25, all `corpus-verified`.
- Because seed sources may be paywalled beyond the abstract (§2), the Adversarial sweep's "fetch and read every cited source" check is satisfied at **abstract level** for corpus-verified citations. This is a deliberate asymmetry with `retrieved-unverified` citations, where the sweep's scrutiny is the whole point: seed entries have already passed human vetting, retrieved ones have not.
- Most early citations the user sees are `retrieved-unverified` — this is expected and honestly labelled; the corpus matures as accepted Proposals feed the promotion queue.
- The layered explanation must never launder a retrieved-unverified source as corpus-verified — trust level is always shown and is frozen onto each Decision at decision time.
