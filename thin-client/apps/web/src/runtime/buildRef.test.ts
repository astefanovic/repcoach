import { describe, expect, it } from "vitest";

import { isClientOutOfDate, UNKNOWN_BUILD_REF } from "./buildRef.ts";

/**
 * Rung 1 for the drift check (issue #111).
 *
 * The bug it exists for: the served bundle was two days older than the server,
 * `TokenUsage` had been widened in between, and every Intake died at the
 * client's decode of a reply the server had already drafted and been billed
 * for. The socket was open the whole time. Nothing anywhere compared the two
 * halves, so nothing could say so.
 *
 * These pin the *judgement*, which is mostly about when to keep quiet — a
 * check that fires without evidence is one people learn to click past, and
 * this one only gets to be believed if it is silent whenever it cannot be
 * sure.
 */
describe("isClientOutOfDate", () => {
  const A = "0039760aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const B = "99f50d3bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  it("reports drift when the two commits differ — the #111 case", () => {
    expect(isClientOutOfDate(A, B)).toBe(true);
  });

  it("stays quiet when both sides are the same commit", () => {
    expect(isClientOutOfDate(A, A)).toBe(false);
  });

  it("stays quiet before the server has answered, so no page flashes red on load", () => {
    expect(isClientOutOfDate(A, undefined)).toBe(false);
  });

  it("stays quiet when the client was built outside a git checkout", () => {
    expect(isClientOutOfDate(UNKNOWN_BUILD_REF, B)).toBe(false);
  });

  it("stays quiet when the server cannot name its own commit", () => {
    expect(isClientOutOfDate(A, UNKNOWN_BUILD_REF)).toBe(false);
  });

  it("stays quiet when neither side knows, rather than comparing two unknowns as equal", () => {
    expect(isClientOutOfDate(UNKNOWN_BUILD_REF, UNKNOWN_BUILD_REF)).toBe(false);
  });
});
