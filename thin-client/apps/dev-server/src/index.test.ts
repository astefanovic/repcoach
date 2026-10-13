import { describe, expect, it } from "vitest";

// Rung 1 smoke test for Task 0: proves the Vitest wiring (config, workspace
// resolution, test runner script) is green end-to-end. Real dev-server tests
// land in Task 2.
describe("thin-client workspace", () => {
  it("runs vitest", () => {
    expect(1 + 1).toBe(2);
  });
});
