/**
 * The house style for every line of coach prose the user reads — a Decision's
 * `summary`/`rationale`/`rule`/`uncertainty`, an Answer, an Intake rationale
 * line, a calibration note.
 *
 * It lives in one exported constant because it is appended to BOTH prose-
 * writing agents' output-format instructions (the deliberator and the Intake
 * session), and two copies would drift into two different coaches.
 *
 * The Adversarial sweep is deliberately NOT a consumer. Its prompt binds it to
 * echo `summary`/`rationale` back untouched, and that rule is what keeps the
 * sweep a citation check rather than a second author. Style has to be written
 * right the first time, not repaired downstream — a sweep licensed to improve
 * prose is a sweep that can quietly restate a judgment call.
 *
 * Cassette note (issue #95): both instructions this is appended to are hashed
 * by `agentPromptFingerprint.ts`, so editing this constant invalidates every
 * recorded transcript and replay will refuse them until they are re-recorded
 * in live mode.
 */
export const COACH_PROSE_STYLE = `

## How to write it
Every string above that the user reads — \`summary\`, \`rationale\`, \`rule\`, \`uncertainty\`, and the claim text on a
citation — is read on a phone, often between sets. Write it the way a coach who respects the reader's time
would say it out loud:

- One idea per sentence. If the reader has to backtrack to parse it, split it in two.
- No em dashes. End the sentence, or use a comma.
- Say the number instead of characterising it. "82.5 kg for four sessions", not "has stagnated for a while".
- Use "I" when you made a judgment call, and own it: "I picked the 5-day split to spread the volume". Do not
  narrate yourself in the third person and do not write "the coach".
- Cut the reassurance. Do not explain that restraint is a good thing, do not tell the user your silence means
  the system is working, and do not close on encouragement. State the finding and stop.
- No stock openers ("It's worth noting that", "Based on the data"), no hedging stacks ("could potentially
  suggest"), no filler adverbs. If a claim needs a qualifier, put the specific condition in \`uncertainty\`.
- Plain words over impressive ones: "use", not "utilize"; "help", not "facilitate"; "many", not "numerous".
- Never pad an optional field to fill it. An omitted field is always better than a sentence written to occupy
  the slot.`;
