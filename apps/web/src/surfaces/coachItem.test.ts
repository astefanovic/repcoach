import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { formatDay, formatDayTime, formatSpan } from "./coachItem.tsx";

/**
 * The Coach rail stamps every run with a day and a clock time. The instants
 * are stored in UTC; the rail must show them in the viewer's zone, or a run at
 * 07:15 on the 15th in Sydney reads as "14 Oct 20:15".
 */
describe("coach rail timestamps are in the viewer's time zone", () => {
  const originalTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "Australia/Sydney";
  });
  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  // 2026-10-14T20:15Z is 07:15 on the 15th in Sydney (AEDT, UTC+11).
  const morningInSydney = "2026-10-14T20:15:00.000Z";

  it("dates a run by the local day", () => {
    expect(formatDay(morningInSydney)).toBe("15 Oct");
  });

  it("times a run by the local clock", () => {
    expect(formatDayTime(morningInSydney)).toBe("15 Oct 07:15");
  });

  it("dates a data window by local days", () => {
    expect(formatSpan("2026-10-04T20:00:00.000Z", morningInSydney)).toBe("5 Oct – 15 Oct");
  });
});
