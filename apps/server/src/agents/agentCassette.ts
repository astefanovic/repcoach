import * as fs from "node:fs";
import * as path from "node:path";

import * as Effect from "effect/Effect";

import { ZERO_TOKEN_USAGE, type TokenUsage } from "@repcoach/contracts";

import { DeliberationRunKilledError, type AgentSdkSessionResult } from "./agentSdkSession.ts";
import { agentPromptFingerprint } from "./agentPromptFingerprint.ts";
import {
  isAgentSessionStage,
  type AgentSdkTransport,
  type AgentSessionStage,
} from "./agentTransport.ts";

/**
 * Record and replay for the four real agent sessions (issue #95).
 *
 * A cassette is one session's transcript: what was sent, what the model sent
 * back verbatim, and what it cost. Replaying one puts the recorded text through
 * the **real adapter** — the same `extractJsonPayload` → `dropNullValues` →
 * `defaultEmptyDecisionLists` → Schema decode path production runs — so a
 * change to the output contract that breaks real decoding fails here, in a
 * deterministic, quota-free rung, instead of surviving until a human opens the
 * app on a phone.
 *
 * What replay does NOT prove: that the model would still say this. Only a live
 * run proves that, which is why the live mode exists alongside rather than
 * instead (`agentMode.ts`), and why the fingerprint in each cassette exists to
 * say "the question changed since this answer was recorded".
 */

export interface AgentCassetteToolCall {
  readonly tool: string;
  readonly subject?: string;
}

/**
 * One turn. A one-shot session (deliberator, either sweep) has exactly one; a
 * held-open Intake session has one per exchange turn, the first being the cold
 * draft.
 */
export interface AgentCassetteTurn {
  /**
   * The prompt this reply answered, stored in full.
   *
   * It is never matched against — matching a live prompt byte-for-byte would
   * make every cassette single-use, since the prompt carries the run's own data
   * — but it is the artifact a refresh is judged against by hand, and the only
   * record of what the model was actually asked.
   */
  readonly prompt: string;
  /** Tool activity the session reported, replayed so the activity line has something real to narrate. */
  readonly toolCalls?: ReadonlyArray<AgentCassetteToolCall>;
  /** The model's final message, verbatim — fence, stray null and all. */
  readonly reply: string;
  readonly usage: TokenUsage;
  readonly costUsd: number;
}

export interface AgentCassette {
  readonly stage: AgentSessionStage;
  readonly recordedAt: string;
  /** `agentPromptFingerprint(stage)` at record time — the staleness signal. */
  readonly promptFingerprint: string;
  /** Where this came from: a live run, or a hand-seeded reproduction of one. Prose, for a reader. */
  readonly provenance: string;
  readonly model?: string;
  readonly turns: ReadonlyArray<AgentCassetteTurn>;
}

export class AgentCassetteError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "AgentCassetteError";
  }
}

/* ------------------------------------------------------------------- io --- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readUsage = (value: unknown): TokenUsage => {
  if (!isRecord(value)) return ZERO_TOKEN_USAGE;
  const read = (key: string): number => (typeof value[key] === "number" ? (value[key] as number) : 0);
  return {
    input: read("input"),
    output: read("output"),
    cacheRead: read("cacheRead"),
    cacheCreation: read("cacheCreation"),
  };
};

/**
 * Parses one cassette, refusing anything it cannot fully understand.
 *
 * Deliberately strict: a cassette is a test fixture standing in for a real
 * model, and one that silently loses its `toolCalls` or defaults a missing
 * `reply` to `""` would fail somewhere else entirely, as a decode error against
 * an empty string — the least legible failure available.
 */
export const parseCassette = (raw: unknown, source: string): AgentCassette => {
  if (!isRecord(raw)) throw new AgentCassetteError(`${source}: not a JSON object`);
  const stage = raw["stage"];
  if (typeof stage !== "string" || !isAgentSessionStage(stage)) {
    throw new AgentCassetteError(`${source}: "stage" must be one of the four agent stages, got ${String(stage)}`);
  }
  const turnsRaw = raw["turns"];
  if (!Array.isArray(turnsRaw) || turnsRaw.length === 0) {
    throw new AgentCassetteError(`${source}: "turns" must be a non-empty array`);
  }
  const turns = turnsRaw.map((turn, index): AgentCassetteTurn => {
    if (!isRecord(turn)) throw new AgentCassetteError(`${source}: turn ${index} is not an object`);
    if (typeof turn["reply"] !== "string") {
      throw new AgentCassetteError(`${source}: turn ${index} has no "reply" string`);
    }
    const toolCalls = turn["toolCalls"];
    return {
      prompt: typeof turn["prompt"] === "string" ? turn["prompt"] : "",
      reply: turn["reply"],
      usage: readUsage(turn["usage"]),
      costUsd: typeof turn["costUsd"] === "number" ? turn["costUsd"] : 0,
      ...(Array.isArray(toolCalls)
        ? {
            toolCalls: toolCalls.filter(isRecord).map((call) => ({
              tool: String(call["tool"] ?? "tool"),
              ...(typeof call["subject"] === "string" ? { subject: call["subject"] } : {}),
            })),
          }
        : {}),
    };
  });
  return {
    stage,
    recordedAt: typeof raw["recordedAt"] === "string" ? raw["recordedAt"] : "unknown",
    promptFingerprint: typeof raw["promptFingerprint"] === "string" ? raw["promptFingerprint"] : "unknown",
    provenance: typeof raw["provenance"] === "string" ? raw["provenance"] : "unknown",
    ...(typeof raw["model"] === "string" ? { model: raw["model"] } : {}),
    turns,
  };
};

/**
 * Every cassette in a directory, in filename order.
 *
 * Filename order IS replay order within a stage, which is why the recorder
 * writes zero-padded ordinals: `intake-session-01.json` before
 * `intake-session-02.json`, and `intake-session-10.json` after both.
 */
export const readCassetteDirectory = (dir: string): ReadonlyArray<AgentCassette> => {
  if (!fs.existsSync(dir)) {
    throw new AgentCassetteError(
      `no cassette directory at ${dir} — record one first (see docs/agents/testing.md, "agent-backed rung 2")`,
    );
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const full = path.join(dir, name);
      return parseCassette(JSON.parse(fs.readFileSync(full, "utf8")), name);
    });
};

/* --------------------------------------------------------------- replay --- */

export interface ReplayTransportOptions {
  readonly cassettes: ReadonlyArray<AgentCassette>;
  /**
   * Replay a cassette whose recorded fingerprint no longer matches the prompt
   * scaffold. Off by default — the mismatch is the whole staleness signal — and
   * meant for the window where a prompt is deliberately being changed and the
   * fixtures have not been re-recorded yet.
   */
  readonly allowStaleFingerprint?: boolean;
}

export interface ReplayTransport {
  readonly transport: AgentSdkTransport;
  /**
   * Rewinds every per-stage cursor. Folded into `POST /__test__/reset`, so the
   * second flow in a spec file gets the same cassettes the first one did rather
   * than running off the end of them.
   */
  readonly reset: () => void;
}

const killed = (detail: string) =>
  Effect.fail(new DeliberationRunKilledError({ reason: "could-not-start", detail }));

const toResult = (turn: AgentCassetteTurn): AgentSdkSessionResult => ({
  text: turn.reply,
  usage: turn.usage,
  costUsd: turn.costUsd,
});

/**
 * A transport that answers from recorded transcripts instead of the network.
 *
 * Cassettes are handed out per stage, in order, and running past the end is a
 * loud failure rather than a wrap-around: "this flow ran three deliberator
 * sessions and only two were recorded" is a real finding about the flow or the
 * fixtures, and quietly re-serving cassette 1 would bury it.
 */
export const makeReplayTransport = (options: ReplayTransportOptions): ReplayTransport => {
  const byStage = new Map<AgentSessionStage, Array<AgentCassette>>();
  for (const cassette of options.cassettes) {
    const existing = byStage.get(cassette.stage);
    if (existing === undefined) byStage.set(cassette.stage, [cassette]);
    else existing.push(cassette);
  }
  const cursors = new Map<AgentSessionStage, number>();

  const take = (stage: AgentSessionStage): AgentCassette | string => {
    const available = byStage.get(stage) ?? [];
    const cursor = cursors.get(stage) ?? 0;
    if (available.length === 0) {
      return `no recorded cassette for the "${stage}" session — this flow reached an agent the fixtures do not cover`;
    }
    const cassette = available[cursor];
    if (cassette === undefined) {
      return `the "${stage}" session ran ${cursor + 1} time(s) but only ${available.length} cassette(s) were recorded`;
    }
    cursors.set(stage, cursor + 1);
    const expected = agentPromptFingerprint(stage);
    if (cassette.promptFingerprint !== expected && options.allowStaleFingerprint !== true) {
      return (
        `the "${stage}" cassette is stale: recorded against prompt ${cassette.promptFingerprint}, ` +
        `this build sends ${expected}. The recorded reply answers a question the code no longer asks. ` +
        `Re-record it (docs/agents/testing.md → "refreshing the cassettes"), or set ` +
        `REPCOACH_AGENT_ALLOW_STALE_CASSETTES=1 to replay it anyway.`
      );
    }
    return cassette;
  };

  const transport: AgentSdkTransport = {
    run: ({ stage }) =>
      Effect.suspend(() => {
        const taken = take(stage);
        if (typeof taken === "string") return killed(taken);
        const turn = taken.turns[0];
        return turn === undefined ? killed(`the "${stage}" cassette has no turns`) : Effect.succeed(toResult(turn));
      }),

    openHeld: ({ stage, onToolCall }) =>
      Effect.suspend(() => {
        const taken = take(stage);
        if (typeof taken === "string") return killed(taken);
        const cassette = taken;
        const first = cassette.turns[0];
        if (first === undefined) return killed(`the "${stage}" cassette has no turns`);

        let index = 0;
        let closed = false;
        const emit = (turn: AgentCassetteTurn): void => {
          for (const call of turn.toolCalls ?? []) onToolCall(call);
        };
        emit(first);

        return Effect.succeed({
          first: toResult(first),
          session: {
            send: () =>
              Effect.suspend(() => {
                if (closed) return killed(`the replayed "${stage}" session was already closed`);
                index += 1;
                const turn = cassette.turns[index];
                if (turn === undefined) {
                  return killed(
                    `the replayed "${stage}" session was sent turn ${index + 1} but only ` +
                      `${cassette.turns.length} turn(s) were recorded — drive one fewer turn, or re-record with more`,
                  );
                }
                emit(turn);
                return Effect.succeed(toResult(turn));
              }),
            close: Effect.sync(() => {
              closed = true;
            }),
          },
        });
      }),
  };

  return {
    transport,
    reset: () => {
      cursors.clear();
    },
  };
};

/* ------------------------------------------------------------ recording --- */

export interface RecordingTransportOptions {
  readonly inner: AgentSdkTransport;
  readonly dir: string;
  readonly provenance?: string;
}

const writeCassette = (dir: string, ordinal: number, cassette: AgentCassette): void => {
  fs.mkdirSync(dir, { recursive: true });
  const name = `${cassette.stage}-${String(ordinal).padStart(2, "0")}.json`;
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(cassette, null, 2)}\n`, "utf8");
};

/**
 * Wraps a real transport and writes every session it runs to disk as a
 * cassette. This is how fixtures are refreshed: point the **production** server
 * at a recording directory, drive a real Intake or a real Session review, and
 * the transcripts land beside each other, ready to be reviewed and committed.
 *
 * Each turn is flushed as it completes rather than buffered until the session
 * ends — a held-open Intake that dies on turn four is precisely the transcript
 * worth having, and buffering would throw it away.
 */
export const makeRecordingTransport = (options: RecordingTransportOptions): AgentSdkTransport => {
  const counts = new Map<AgentSessionStage, number>();
  const nextOrdinal = (stage: AgentSessionStage): number => {
    const next = (counts.get(stage) ?? 0) + 1;
    counts.set(stage, next);
    return next;
  };

  const start = (stage: AgentSessionStage, model: string | undefined): { ordinal: number; cassette: AgentCassette } => ({
    ordinal: nextOrdinal(stage),
    cassette: {
      stage,
      recordedAt: new Date().toISOString(),
      promptFingerprint: agentPromptFingerprint(stage),
      provenance: options.provenance ?? "recorded from a live Agent SDK session",
      ...(model === undefined ? {} : { model }),
      turns: [],
    },
  });

  return {
    run: (request) =>
      options.inner.run(request).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            const { ordinal, cassette } = start(request.stage, request.config.model);
            writeCassette(options.dir, ordinal, {
              ...cassette,
              turns: [
                {
                  prompt: request.prompt,
                  reply: result.text,
                  usage: result.usage,
                  costUsd: result.costUsd,
                },
              ],
            });
          }),
        ),
      ),

    openHeld: (request) =>
      Effect.suspend(() => {
        const { ordinal, cassette } = start(request.stage, request.config.model);
        const turns: Array<AgentCassetteTurn> = [];
        // Tool calls are collected per turn: the SDK reports them as they
        // happen, so whatever has arrived when a turn settles is that turn's.
        let pendingToolCalls: Array<AgentCassetteToolCall> = [];
        const onToolCall = (call: AgentCassetteToolCall): void => {
          pendingToolCalls.push(call);
          request.onToolCall(call);
        };
        const flush = (prompt: string, result: AgentSdkSessionResult): void => {
          turns.push({
            prompt,
            reply: result.text,
            usage: result.usage,
            costUsd: result.costUsd,
            ...(pendingToolCalls.length === 0 ? {} : { toolCalls: pendingToolCalls }),
          });
          pendingToolCalls = [];
          writeCassette(options.dir, ordinal, { ...cassette, turns });
        };

        return options.inner.openHeld({ ...request, onToolCall }).pipe(
          Effect.map((opened) => {
            flush(request.prompt, opened.first);
            return {
              first: opened.first,
              session: {
                send: (text: string) =>
                  opened.session.send(text).pipe(Effect.tap((result) => Effect.sync(() => flush(text, result)))),
                close: opened.session.close,
              },
            };
          }),
        );
      }),
  };
};
