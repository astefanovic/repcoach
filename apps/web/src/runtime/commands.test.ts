import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { localDateStamp } from "./commands.ts";

/** The export's filename is dated by the device's calendar, not by UTC. */
describe("localDateStamp", () => {
  const originalTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "Australia/Sydney";
  });
  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it("dates an export taken just after local midnight by the local day", () => {
    // 2026-10-14T15:30Z is 02:30 on the 15th in Sydney (AEDT, UTC+11).
    expect(localDateStamp(new Date("2026-10-14T15:30:00.000Z"))).toBe("2026-10-15");
  });
});
