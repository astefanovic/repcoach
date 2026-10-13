# Evidence base — the working seed

**Status: WORKING SEED — vetted and live.** All seven entries are `corpus-verified`. Sources were vetted and accepted by the owner on **2026-07-25**; this document is the corpus itself, not a proposal for one. The coach may cite these entries verbatim, at `corpus-verified` trust.

This is the minimal seed **floor** the coach cites into — not the primary evidence tier. Everything more specific is sourced by live web retrieval at Deliberation time and stays `retrieved-unverified` until promoted ([ADR 0003](../adr/0003-evidence-sourcing-corpus-then-retrieval.md) §3–§4).

**The §4 human promotion gate does not apply to this document.** That gate governs *runtime* growth — retrieved sources encountered mid-deliberation being promoted into the corpus — where the risk is laundering an unvetted web source as corpus-verified. The seed was authored offline against the inclusion test with every source fetched and read, and vetted before seating; it enters the corpus directly. Changes to a seated entry are ordinary edits to this file under review, not promotions.

**To change a seated entry**, edit here and in the JSON twin together, and say in the commit which clause moved and what evidence moved it. The bar in ADR 0003 §2 — a seat must carry the whole claim — applies to every edit, not just the original authoring.

Machine-readable twin: [`evidence-base-seed.json`](evidence-base-seed.json). The two must be kept in sync; the JSON is what the store **actually loads** — `thin-client/packages/persistence/src/evidenceSeed.ts` reads it directly (issue #87), so an edit there reaches every fresh database's roster with no code change, and this prose twin is the reviewed record of why each entry reads as it does.

## Inclusion test

An entry earns a seat only by passing **both** (the intersection, not the union):

- **(a) load-bearing on the coach's first decisions** — the agent cannot author a coherent beginner hypertrophy Plan *or* correctly read the first Check-ins and Logged Sessions without it.
- **(b) settled-enough-to-need-no-retrieval** — no serious practitioner disagreement, no "it depends".

Seven entries clear the bar. Each `claim` is a single sentence the coach can cite verbatim.

E1–E5 come from ADR 0003 §1's illustrative "likely admits" list; **E6 and E7 come from a subsequent deliberate sweep of the candidate space** (§1's list was never the product of a search). Seven is not an overshoot of a bound — §1 no longer states a target size, precisely because authoring this seed showed the old "~4–6" being read as one. The floor is whatever passes both tests. Everything the sweep rejected is in *Deliberately excluded* below, with the test it fails.

---

## E1 — Progressive overload

| field | value |
| --- | --- |
| **claim** | Continued muscular adaptation requires the training stimulus to be increased progressively over time; repeating an unchanged workload indefinitely stops producing gains. |
| **source** | American College of Sports Medicine. *Progression Models in Resistance Training for Healthy Adults* (position stand). Med Sci Sports Exerc. 2009;41(3):687–708. <https://pubmed.ncbi.nlm.nih.gov/19204579/> |
| **applicability** | Holds for every trainee and every Plan model — it is the reason a Plan needs Progression rules at all. It says *that* the stimulus must rise, **not** *how*: load, reps, sets, and proximity-to-failure are all valid progression currencies, and which to advance (and how fast) is a retrieval-time / Plan-model question. Override the *rate*, never the principle: during illness, deload, injury or a deliberate maintenance phase, holding or reducing the stimulus is correct. |
| **trust** | `corpus-verified` |

**Why it passes:** (a) without it there is no Progression rule and the first Plan is a static list. (b) the single least contested statement in the field; carried by an authoritative position stand, which is the honest source type here.

**Source note:** review/position-stand tier, as ADR 0003 §2 prefers. Abstract openly fetchable on PubMed. The stand is from 2009 — its *specific* prescriptions (e.g. "2–10% load increase") are dated and deliberately **not** part of the claim; only the progression principle is seated.

---

## E2 — Hypertrophy across a broad rep range

| field | value |
| --- | --- |
| **claim** | Similar muscle hypertrophy can be achieved across a broad spectrum of loads and repetition ranges — roughly 5 to 30 reps per set (loads ≳30% of 1RM) — provided sets are taken to a high level of effort. |
| **source** | Schoenfeld BJ, Grgic J, Van Every DW, Plotkin DL. *Loading Recommendations for Muscle Strength, Hypertrophy, and Local Endurance: A Re-Examination of the Repetition Continuum.* Sports (Basel). 2021;9(2):32. <https://pmc.ncbi.nlm.nih.gov/articles/PMC7927075/> |
| **applicability** | Applies to hypertrophy as the goal, and only under the effort proviso in **E3** — the light-load half of the range collapses if sets stop well short of fatigue. It does **not** transfer to maximal strength, which remains load-specific (heavy work is required). Practical override: moderate loads are usually the default anyway (less discomfort at the light end, less joint stress and fatigue cost at the heavy end); exercise-specific ceilings and injury history can narrow the usable band. |
| **trust** | `corpus-verified` |

**Why it passes:** (a) the agent cannot pick set/rep schemes for a first Plan without knowing the admissible band. (b) the equivalence-across-loads finding is settled; what stays contested is only *where within* the band to sit for a given exercise — a retrieval-time question.

**Source note:** open-access review, full text fetchable (PMC).

---

## E3 — Proximity to failure is the stimulus driver

| field | value |
| --- | --- |
| **claim** | Hypertrophy increases as sets are taken closer to muscular failure, but training to momentary failure itself is not required for growth. |
| **source** | Refalo MC, Helms ER, Trexler ET, Hamilton DL, Fyfe JJ. *Influence of Resistance Training Proximity-to-Failure on Skeletal Muscle Hypertrophy: A Systematic Review with Meta-analysis.* Sports Med. 2023;53(3):649–665. <https://pmc.ncbi.nlm.nih.gov/articles/PMC9935748/> |
| **applicability** | Governs how the coach sets and reads effort targets (RIR/RPE) on prescribed sets, and is the proviso that makes **E2**'s broad range valid. The second clause is load-sensitive: the further from failure a set stops, the more it depends on load being sufficient, so lighter sets need to be taken nearer failure than heavy ones. Override toward *lower* proximity (more reps in reserve) when fatigue cost matters more than per-set stimulus — high-volume phases, technically demanding or heavy compound lifts, poor recovery, injury risk. The *specific* RIR target for a given lift, week, or phase is retrieval-time, not seed. |
| **trust** | `corpus-verified` |

**Why it passes:** (a) without it the agent cannot prescribe effort, and rep ranges alone under-specify the stimulus. (b) both clauses are meta-analytically supported and mutually reinforcing; the disagreement in the field is over *how many* RIR, not over the direction of the relationship.

**Source note:** the seated source is **open access, full text fetchable** (PMC) — chosen over the alternative on the fetchability principle in open question 3, since the Adversarial sweep verifies claim-support, not URL resolution. Refalo carries the "failure is not required" clause directly and reports the non-linear proximity relationship. Corroborating source for the "closer to failure = more growth" clause, and the on-point dose-response meta-regression, is Robinson ZP, Pelland JC, Remmert JF, et al. *Exploring the Dose–Response Relationship Between Estimated Resistance Training Proximity to Failure, Strength Gain, and Muscle Hypertrophy: A Series of Meta-Regressions.* Sports Med. 2024;54(9):2209–2231. <https://pubmed.ncbi.nlm.nih.gov/38970765/> — abstract-only (Springer gates full text), which is why it is corroboration rather than the seat.

---

## E4 — Weekly volume drives growth, with diminishing returns

| field | value |
| --- | --- |
| **claim** | Muscle hypertrophy scales with the number of hard sets performed per muscle group per week, in a positive dose-response relationship that flattens as volume rises. |
| **source** | Pelland JC, Remmert JF, Robinson ZP, Hinson SR, Zourdos MC. *The Resistance Training Dose Response: Meta-Regressions Exploring the Effects of Weekly Volume and Frequency on Muscle Hypertrophy and Strength Gains.* Sports Med. 2026 Feb. <https://pubmed.ncbi.nlm.nih.gov/41343037/> · doi:10.1007/s40279-025-02344-w |
| **applicability** | Weekly sets **per muscle group** is the unit the coach budgets a Plan in — this is what makes weekly volume, not session volume, the planning currency. Deliberately excludes any specific number: MEV/MAV/MRV landmarks and "the right" weekly set count are contested and are retrieval-time (ADR 0003 §1). The relationship is bounded by recovery — more sets stop paying once fatigue, soreness, or performance decay accumulate, which is what the Check-in and Log signals are for. Override during deloads, low-recovery periods, and maintenance phases, where less volume is the correct prescription. |
| **trust** | `corpus-verified` |

**Why it passes:** (a) the agent must allocate *some* volume per muscle to author a Plan, and must know which direction to move it when progress stalls. (b) the direction and the existence of diminishing returns are agreed; only the numbers are contested, and the numbers are excluded from the claim.

**Source note:** the seat was moved to Pelland 2026 because the *diminishing-returns* half of the claim is not carried by the older meta-analysis: Schoenfeld 2017 concludes a **graded** dose-response and reports no plateau. Pelland 2026 is the largest analysis to date (67 studies, 2,058 participants) and carries both halves. The earlier canonical meta-analysis remains corroboration for the positive-direction clause: Schoenfeld BJ, Ogborn D, Krieger JW. *Dose-response relationship between weekly resistance training volume and increases in muscle mass.* J Sports Sci. 2017;35(11):1073–1082. <https://pubmed.ncbi.nlm.nih.gov/27433992/>. Both are abstract-only.

---

## E5 — Frequency is the vehicle for distributing volume

| field | value |
| --- | --- |
| **claim** | When weekly set volume is equated, training frequency has little independent effect on hypertrophy, so frequency should be chosen as the means of distributing the weekly volume target rather than as a stimulus in its own right. |
| **source** | Pelland JC, Remmert JF, Robinson ZP, Hinson SR, Zourdos MC. *The Resistance Training Dose Response: Meta-Regressions Exploring the Effects of Weekly Volume and Frequency on Muscle Hypertrophy and Strength Gains.* Sports Med. 2026 Feb. <https://pubmed.ncbi.nlm.nih.gov/41343037/> · doi:10.1007/s40279-025-02344-w |
| **applicability** | This is what licenses the agent to lay out a split: it may distribute a muscle's weekly sets across whatever session structure fits the user's availability, without owing the user a frequency-specific justification. It cuts both ways — high weekly volumes *must* be spread across more sessions to remain executable, so frequency is constrained from below by per-session fatigue rather than by an adaptation requirement. Note the asymmetry: the same analysis finds higher frequency **does** favour strength gains, so this claim is scoped to hypertrophy. Override when the user's schedule, recovery, or exercise selection makes a distribution impractical. |
| **trust** | `corpus-verified` |

**Why it passes:** (a) the agent cannot produce an ordered list of Prescribed Sessions without a rule for splitting weekly volume across days. (b) the finding is not disputed in current work; what disagreement exists is *historical* — see the superseded position below — and it resolved in one direction as the evidence base grew.

**Source note:** most recent source in the seed (Feb 2026); PubMed record fetchable, Springer full text gated. The entry most likely to be revised by newer work — revisit it first when the corpus is next reviewed.

**Superseded prior position — do not cite as support.** Schoenfeld BJ, Ogborn D, Krieger JW. *Effects of Resistance Training Frequency on Measures of Muscle Hypertrophy: A Systematic Review and Meta-Analysis.* Sports Med. 2016;46(11):1689–1697 (<https://pubmed.ncbi.nlm.nih.gov/27102172/>) concluded that volume-equated **twice-weekly training is superior to once-weekly**, and recommended training each major muscle group at least twice a week. That is the older position and it **contradicts this entry**; it was miscatalogued as corroboration in an earlier revision and corrected during source vetting. It is recorded here because a widely-cited contradicting source is provenance the coach should not rediscover as a surprise: the shift came from a much larger dataset with continuous meta-regression rather than categorical comparisons, not from a reversal on the same evidence. Note the practical distance is small — an "at least twice weekly" heuristic is usually *compatible* with this entry, since distributing a realistic weekly volume across two or more sessions is what per-session fatigue dictates anyway.

---

The two entries below came from the sweep rather than the ADR's list, and both were seated by owner decision (2026-07-25). The sweep also surfaced a general principle worth stating, because it changes what the seed is *for*: **a seed entry earns its keep most where the agent would not think to retrieve.** Retrieval covers questions the agent knows it has. It does not cover a confidently-held wrong prior, because nothing triggers a search. E7 is the clearest instance, and is seated on that argument.

---

## E6 — Hypertrophy is local to the loaded muscle

| field | value |
| --- | --- |
| **claim** | Muscle growth occurs only in the muscles that the training actually loads, so a Plan must ensure every muscle the user wants to develop is loaded by some exercise in it. |
| **source** | Wackerhage H, Schoenfeld BJ, Hamilton DL, Lehti M, Hulmi JJ. *Stimuli and sensors that initiate skeletal muscle hypertrophy following resistance exercise.* J Appl Physiol. 2019;126(1):30–43. <https://pubmed.ncbi.nlm.nih.gov/30335577/> · doi:10.1152/japplphysiol.00685.2018 |
| **applicability** | This is the coverage rule behind exercise selection: it licenses the coach to check a Plan for un-loaded target muscles and to justify adding work for them. It says a target muscle must be **loaded** — deliberately *not* that it needs a dedicated isolation exercise, since whether indirect/synergist loading suffices is contested and retrieval-time (Pelland 2026 handles it with fractional direct/indirect set counting; earlier work found adding isolation work to compound training gave untrained lifters no extra growth). Says nothing about *which* exercise to pick — that stays retrieval-time. |
| **trust** | `corpus-verified` |

**Why it passes:** (a) it is the only entry grounding **exercise coverage**, a first-Plan authoring decision nothing else in the seed supports — and E4's per-muscle volume budget is close to meaningless without it, since E4 assumes "per muscle group" is the right unit but never says why. (b) locality is not seriously disputed; the entire unilateral within-subject research design in this literature presupposes it.

**Source note:** the cited review hedges between mechanical, damage-associated and metabolic-stress stimuli, and does **not** resolve the mechanism. That does not weaken the claim: every candidate stimulus it considers is *local to the loaded muscle*, so locality holds whichever wins. Abstract-only on PubMed. **If a stronger seat is wanted**, the honest alternative is an authoritative-reference-tier source for the specificity principle (ADR 0003 §2 explicitly blesses this for textbook-consensus claims) rather than a mechanistic review.

---

## E7 — Soreness is not a measure of the training stimulus

| field | value |
| --- | --- |
| **claim** | Muscle damage and the soreness that accompanies it are neither required for nor indicative of muscle growth, so soreness cannot be used to judge whether a session delivered an effective stimulus. |
| **source** | Damas F, Libardi CA, Ugrinowitsch C. *The development of skeletal muscle hypertrophy through resistance training: the role of muscle damage and muscle protein synthesis.* Eur J Appl Physiol. 2018;118(3):485–500. <https://pubmed.ncbi.nlm.nih.gov/29282529/> |
| **applicability** | Governs how the coach reads the **soreness field of a Check-in**: as a recovery and tolerance signal, never as evidence that a session worked or that a Plan is under-stimulating. Blocks both failure modes — escalating volume because the user reports no soreness, and reading soreness as confirmation the stimulus was right. It does **not** make soreness worthless input: persistent or severe soreness is still legitimate grounds for an Observation about recovery or a too-fast progression. |
| **trust** | `corpus-verified` |

**Why it passes (b):** settled and explicit — the review states damage "is not the process that mediates or potentiates RT-induced muscle hypertrophy," and that low-damage protocols produce similar hypertrophy. No serious practitioner disagreement.

**Why (a) passes — on the broader reading, seated by owner decision.** Read strictly, ADR 0003's test (a) is *authoring*-scoped, and you can author a coherent first Plan without this. Read as "load-bearing on the coach's first decisions", it passes clearly: Check-in collects soreness from day one and Deliberation reads it, so the coach acts on soreness before it has ever authored a second Plan. The deciding argument is the retrieval blind spot above: "soreness means it worked" is the single most widespread lay training belief, it is the kind of prior a model can hold confidently, and a confidently-held wrong prior generates no search query — nothing else in the architecture catches it. **This is the entry that makes the (a)-scope question in *Open questions* live; it should be settled in the ADR.**

**Source note:** peer-reviewed review, on-point, abstract-only on PubMed. Corroborating: Schoenfeld BJ, Contreras B. *Is Postexercise Muscle Soreness a Valid Indicator of Muscular Adaptations?* Strength Cond J. 2013;35(5):16–21. <https://journals.lww.com/nsca-scj/fulltext/2013/10000/is_postexercise_muscle_soreness_a_valid_indicator.2.aspx> · doi:10.1519/SSC.0b013e3182a61820 — titled directly at the claim, but practitioner-journal tier, so it is corroboration rather than the seat.

## Deliberately excluded

Each of these fails test (b) — real practitioner disagreement or a genuine "it depends" — and is therefore **retrieval-time**, per ADR 0003 §1:

- **Volume landmarks** (MEV / MAV / MRV numbers, "10–20 sets per muscle per week"). Direction is settled (E4); the numbers are not.
- **Specific RIR targets** ("stop at 2 RIR"). Direction is settled (E3); the number is not.
- **Periodization models** — linear, undulating, block. Choosing one is exactly the Plan-model decision the coach is supposed to deliberate, not a seeded fact.
- **Deload timing and necessity.**
- **Exercise selection and ordering**, free-weight vs machine, compound vs isolation.
- **Rest interval duration.**
- **Advanced techniques** — myo-reps, drop sets, lengthened partials, ROM manipulation.
- **Nutrition / energy state, incl. protein intake.** Fails (a), not (b): energy deficiency does measurably impair lean-mass gains, but a coherent beginner *training* Plan can be authored without it and RepCoach models no intake. Let it arrive via §4 promotion if a real deliberation ever needs it.
- **Rest interval duration.** Fails (a) *on the evidence*, which is the interesting part: the current Bayesian meta-analysis finds a small benefit above 60 s, no appreciable further difference beyond 90 s, and states that both short and long rests are viable **for untrained individuals** — i.e. the source itself says this is not load-bearing on a beginner Plan. ([Give it a rest, Front Sports Act Living 2024](https://pmc.ncbi.nlm.nih.gov/articles/PMC11349676/))
- **Individual variability / non-responders.** Fails (b) in its strong form. Observed between-person variation is large, but the literature is explicit that separating *true* inter-individual variability from measurement error and random variation remains unresolved — so "people respond differently" cannot be seated as settled at the strength a coaching claim would need. The coach's autoregulation is justified by the user's own data, which needs no seed entry.
- **Full range of motion.** Fails (b) — the full-vs-partial difference is small with confidence intervals crossing zero, and the lengthened-partials literature actively contests it. Live disagreement, therefore retrieval-time.
- **Exercise technique / form.** Fails (a) — an execution concern, not an input to authoring a Plan, and the Plan does not model form.
- **Untrained-beginner "anything works" effect.** Fails (a) sharply, and seating it would licence the agent to under-specify the first Plan — the exact opposite of what it is being asked to do well.
- **Detraining / consistency.** Fails (a) for authoring; the settled core is already implied by E1.
- **Sleep and recovery duration.** Fails (b) at the specificity a claim would need (how much, for whom); like soreness it is a Check-in-reading concern, but unlike C7 there is no widespread wrong prior for a seed entry to block.

## Vetting record — 2026-07-25

All seven seats and all corroborating references were fetched and read against their claim before seating. Verification was claim-support, not URL resolution: for each, the openly readable portion (abstract, conclusion, or full text) had to state the claim.

- **Every citation resolves** to the stated title, authors, journal and year. No fabricated or misattributed reference.
- **Every seat carries its whole claim**, per ADR 0003 §2.
- **Two defects were found and fixed during vetting**, both of the same class — a source catalogued as supporting something it does not say:
  - **E4** asserted diminishing returns while seated on Schoenfeld 2017, which reports a *graded* dose-response with no plateau. Reseated on Pelland 2026; Schoenfeld 2017 retained as corroboration scoped to the positive-direction clause.
  - **E5** listed Schoenfeld 2016 as corroboration when it in fact **contradicts** the entry — it concludes volume-equated twice-weekly beats once-weekly. Recatalogued as a *superseded prior position* with the reason the field moved.
- **Known limitation:** five of seven seats are abstract-only (E1, E4, E5, E6, E7). Accepted per ADR 0003 §2 — seed claims are broad settled principles, which is the level an abstract carries. E2 and E3 have open full text.
- **Revisit first:** E5, the newest and most likely to move; then E1, whose position stand is from 2009 (the progression principle is not in doubt, but a newer authoritative reference would be a better seat if one appears).

## Open questions for the owner

**None outstanding.** Kept as a decision record.

1. ~~**Vet the seven sources.**~~ **Done 2026-07-25** — see *Vetting record* above. All seven are `corpus-verified`; two source defects were caught and fixed in the process.
2. ~~**Amend ADR 0003 §1** (the superseded "minimal frequency" wording).~~ **Done 2026-07-25** — §1 now records the superseded example explicitly, so the phrasing stops regenerating downstream.
3. ~~**Fetchability bar.**~~ **Resolved 2026-07-25: abstract-only is acceptable.** Seed claims are broad settled principles, which is the level the abstract or conclusion carries and the level a Deliberation uses; a hard open-full-text bar would cost most review-tier sources for no gain in checkability. Recorded in ADR 0003 §2, with the sweep's consequence in *Consequences*. E3's swap to an open-access seat stands anyway — it was equal-quality, and §2 still prefers open access at equal quality.
4. ~~**Seat C6 and C7?**~~ — **Resolved 2026-07-25: both seated**, as E6 and E7. Roster is seven.
5. ~~**Does test (a) mean "authoring" or "the coach's first decisions"?**~~ **Resolved 2026-07-25: the broader reading**, now the definition in ADR 0003 §1, along with the retrieval-blind-spot argument that decides cases like E7.
6. ~~**Roster size vs "~4–6".**~~ **Resolved 2026-07-25** — ADR 0003 §1 no longer states a target size. The floor is whatever passes both tests; smallness remains the intent because §5 full-injects the corpus.
