import { readFileSync } from "node:fs";

import * as Schema from "effect/Schema";

import type { EvidenceClaim } from "@repcoach/contracts";

/**
 * Loads the **vetted** Evidence-base seed corpus (issue #87) — the seven
 * entries in `docs/evidence/evidence-base-seed.json`, sources fetched, read
 * against their claim and accepted by the owner 2026-07-25 under ADR 0003
 * §1/§2.
 *
 * **The JSON document is the single source of truth.** The entries are read
 * from it at load time rather than retyped here, because the reviewed artifact
 * is the document: a TypeScript transcription is a second copy that drifts
 * silently the moment a claim is sharpened or a source reseated (E4 and E5
 * were both reseated during vetting). Nothing in this module knows any of the
 * corpus content; it knows only the document's *shape* and how to flatten a
 * structured source into the one-line `EvidenceClaim.source` string the
 * contract carries.
 *
 * Seed entries enter the corpus directly at `corpus-verified` — ADR 0003 §4's
 * human promotion gate governs RUNTIME growth (a source retrieved and promoted
 * mid-deliberation), and explicitly does not apply to entries authored offline
 * against the inclusion test. The document says so itself, and the decode below
 * requires it: an entry arriving at any other trust level is a defect, not a
 * value to pass through.
 *
 * Node-only, deliberately: both `Store` layers live server-side (the web client
 * reaches them over RPC), so a synchronous read of a repo file is the simplest
 * thing that works and keeps `seedEvidenceRoster()` synchronous for the two
 * call sites that flatten it into a fresh database.
 */

const SourceRef = Schema.Struct({
  citation: Schema.String,
  url: Schema.optional(Schema.String),
  doi: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
});

const CorroboratingRef = Schema.Struct({
  ...SourceRef.fields,
  carries: Schema.optional(Schema.String),
});

const SupersededRef = Schema.Struct({
  ...SourceRef.fields,
  warning: Schema.String,
});

const SeatedSource = Schema.Struct({
  ...SourceRef.fields,
  tier: Schema.String,
  open_access: Schema.optional(Schema.String),
  corroborating: Schema.optional(CorroboratingRef),
  superseded_prior_position: Schema.optional(SupersededRef),
});

const SeedEntry = Schema.Struct({
  id: Schema.String,
  topic: Schema.String,
  claim: Schema.String,
  source: SeatedSource,
  applicability: Schema.String,
  /**
   * Not `Schema.String`: the document is only allowed to seat entries at the
   * one trust level the contract's `EvidenceClaimTrust` admits. A future
   * document that tries to seat something weaker fails the decode loudly
   * instead of silently widening the roster's trust badge.
   */
  trust: Schema.Literal("corpus-verified"),
});

const SeedDocument = Schema.Struct({
  version: Schema.String,
  entries: Schema.Array(SeedEntry),
});

const decodeSeedDocument = Schema.decodeUnknownSync(SeedDocument);

/**
 * `packages/persistence/src` → repo root. Resolved from `import.meta.url` (not
 * `process.cwd()`) so the roster loads identically under `tsx`, Vitest, and
 * whichever directory the server was started from.
 */
const SEED_DOCUMENT_URL = new URL("../../../../docs/evidence/evidence-base-seed.json", import.meta.url);

type SeedEntry = typeof SeedEntry.Type;
type SeatedSource = typeof SeatedSource.Type;

const renderReference = (ref: {
  readonly citation: string;
  readonly url?: string | undefined;
  readonly doi?: string | undefined;
}): string => [ref.citation, ref.url, ref.doi === undefined ? undefined : `doi:${ref.doi}`]
  .filter((part): part is string => part !== undefined && part.length > 0)
  .join(" ");

/**
 * Flattens a structured source into the single `source` line the coach sees.
 *
 * Everything the vetting recorded travels: the tier and open-access status
 * (so the agent can weigh an abstract-only meta-analysis against a full-text
 * review), the corroborating reference and the specific clause it carries, and
 * — load-bearing — the superseded prior position with its DO-NOT-CITE warning.
 * That last one exists so the coach does not rediscover a contradicting paper
 * mid-deliberation and treat it as a finding; dropping it in the flattening
 * would throw away the most useful thing the vetting produced.
 */
const renderSource = (source: SeatedSource): string => {
  const qualifiers = [source.tier, source.open_access].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  const parts = [`${renderReference(source)} [${qualifiers.join(", ")}]`];

  if (source.note !== undefined) parts.push(`Note: ${source.note}`);

  const corroborating = source.corroborating;
  if (corroborating !== undefined) {
    const carries = corroborating.carries === undefined ? "" : ` (carries: ${corroborating.carries})`;
    const note = corroborating.note === undefined ? "" : ` (${corroborating.note})`;
    parts.push(`Corroborating: ${renderReference(corroborating)}${note}${carries}`);
  }

  const superseded = source.superseded_prior_position;
  if (superseded !== undefined) {
    parts.push(`Superseded prior position — ${renderReference(superseded)} — ${superseded.warning}`);
  }

  return parts.join(" | ");
};

/**
 * Row id for a seated entry. Namespaced rather than raw `E1` so a roster row is
 * self-describing in the database, and derived from the document's own id so an
 * entry keeps its identity across a re-seed.
 */
export const evidenceSeedRowId = (entryId: string): string => `evidence-seed-${entryId}`;

const toEvidenceClaim = (entry: SeedEntry): EvidenceClaim & { readonly id: string } => ({
  id: evidenceSeedRowId(entry.id),
  claim: entry.claim,
  source: renderSource(entry.source),
  applicability: entry.applicability,
  trust: entry.trust,
});

let cached: ReadonlyArray<EvidenceClaim & { readonly id: string }> | undefined;

/**
 * The vetted roster, decoded once per process. Memoized because both `Store`
 * layers and migration 010 ask for it, and re-reading the document per call
 * would let a mid-process edit produce two different rosters in one run.
 */
export const loadVettedEvidenceSeed = (): ReadonlyArray<EvidenceClaim & { readonly id: string }> => {
  if (cached !== undefined) return cached;
  const document = decodeSeedDocument(JSON.parse(readFileSync(SEED_DOCUMENT_URL, "utf8")));
  cached = document.entries.map(toEvidenceClaim);
  return cached;
};
