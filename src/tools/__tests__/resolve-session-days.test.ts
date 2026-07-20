import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../../db/schema.js";
import { createResolveSessionDaysHandler } from "../resolve-session-days.js";
import { expectedBarCount } from "../../core/cache/validator.js";

const unix = (y: number, mo1: number, d: number, h: number, mi = 0): number =>
  Math.floor(Date.UTC(y, mo1 - 1, d, h, mi, 0) / 1000);

// Wed 2026-07-08 15:00 ET (EDT, UTC-4) — mid-session of the Wednesday
// session (Tue 18:00 → Wed 17:00 ET).
const WED_1500_ET = unix(2026, 7, 8, 19);
// Wed 2026-07-08 19:30 ET — the Thursday-labeled session is already open.
const WED_1930_ET = unix(2026, 7, 8, 23, 30);

function harness(nowUnix: number) {
  return createResolveSessionDaysHandler({ now: () => nowUnix });
}

async function resolve(nowUnix: number, args: Record<string, unknown>) {
  const handler = harness(nowUnix);
  const res = await handler({ symbol: "NQ", ...args } as never);
  return res.content[0].text;
}

async function resolveJson(nowUnix: number, args: Record<string, unknown>) {
  return JSON.parse(await resolve(nowUnix, args));
}

describe("resolve_session_days relative anchors", () => {
  it("today (mid-session) resolves to the in-progress session-day", async () => {
    const out = await resolveJson(WED_1500_ET, { relative: "today" });
    expect(out.today).toMatchObject({ label: "2026-07-08", weekday: "Wed" });
    expect(out.sessionDays).toHaveLength(1);
    expect(out.sessionDays[0]).toMatchObject({
      label: "2026-07-08",
      weekday: "Wed",
      etSpan: "Tue 18:00 → Wed 17:00 ET",
      startUnix: unix(2026, 7, 7, 22),
      endUnix: unix(2026, 7, 8, 21),
      inProgress: true,
    });
    expect(out.holidaysModeled).toBe(false);
  });

  it("today after the 18:00 ET open resolves to the NEXT close-label (the open session)", async () => {
    const out = await resolveJson(WED_1930_ET, { relative: "today" });
    expect(out.sessionDays.map((d: { label: string }) => d.label)).toEqual(["2026-07-09"]);
    expect(out.sessionDays[0].etSpan).toBe("Wed 18:00 → Thu 17:00 ET");
  });

  it("yesterday resolves to the prior session-day", async () => {
    const out = await resolveJson(WED_1500_ET, { relative: "yesterday" });
    expect(out.sessionDays.map((d: { label: string }) => d.label)).toEqual(["2026-07-07"]);
  });

  it("last-n-sessions walks back across the set, newest last", async () => {
    const out = await resolveJson(WED_1500_ET, { relative: "last-n-sessions", n: 3 });
    expect(out.sessionDays.map((d: { label: string }) => d.label)).toEqual([
      "2026-07-06",
      "2026-07-07",
      "2026-07-08",
    ]);
  });

  it("this-week lists only session-days that have started", async () => {
    const out = await resolveJson(WED_1500_ET, { relative: "this-week" });
    expect(out.sessionDays.map((d: { label: string }) => d.label)).toEqual([
      "2026-07-06",
      "2026-07-07",
      "2026-07-08",
    ]);
  });

  it("last-week lists Mon–Fri of the prior week with a matching barCountEstimate", async () => {
    const out = await resolveJson(WED_1500_ET, { relative: "last-week" });
    expect(out.sessionDays.map((d: { label: string }) => d.label)).toEqual([
      "2026-06-29",
      "2026-06-30",
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
    ]);
    // 23h CME ETH session-days: 5520/276/92/46/23/12/6 bars per day.
    expect(out.barCountEstimate).toEqual({
      "15s": 27600,
      "5m": 1380,
      "15m": 460,
      "30m": 230,
      "1h": 115,
      "2h": 60,
      "4h": 30,
    });
    const sum5m = out.sessionDays.reduce(
      (acc: number, d: { label: string; startUnix: number; endUnix: number }) =>
        acc + expectedBarCount(d, "5m"),
      0,
    );
    expect(out.barCountEstimate["5m"]).toBe(sum5m);
  });
});

describe("resolve_session_days explicit ranges", () => {
  it("flags weekend inputs with the nearest real session-days", async () => {
    const out = await resolveJson(WED_1500_ET, { start: "2026-07-04", end: "2026-07-06" });
    expect(out.sessionDays.map((d: { label: string }) => d.label)).toEqual(["2026-07-06"]);
    expect(out.flags).toHaveLength(1);
    expect(out.flags[0]).toMatchObject({
      input: "2026-07-04",
      nearest: { prev: "2026-07-03 (Fri)", next: "2026-07-06 (Mon)" },
    });
    expect(out.flags[0].reason).toMatch(/Sat/);
  });

  it("rejects impossible calendar dates via the round-trip guard", async () => {
    const text = await resolve(WED_1500_ET, { start: "2026-02-30", end: "2026-03-02" });
    expect(text).toMatch(/impossible/);
  });

  it("keeps ET wall-clock spans correct across the March DST boundary", async () => {
    const out = await resolveJson(WED_1500_ET, { start: "2026-03-06", end: "2026-03-09" });
    expect(out.sessionDays.map((d: { label: string }) => d.label)).toEqual([
      "2026-03-06",
      "2026-03-09",
    ]);
    const [fri, mon] = out.sessionDays;
    // Fri 2026-03-06 is EST (UTC-5): Thu 18:00 ET = 23:00 UTC.
    expect(fri).toMatchObject({
      weekday: "Fri",
      etSpan: "Thu 18:00 → Fri 17:00 ET",
      startUnix: unix(2026, 3, 5, 23),
      endUnix: unix(2026, 3, 6, 22),
    });
    // Mon 2026-03-09 is EDT (UTC-4, DST began Mar 8): Sun 18:00 ET = 22:00 UTC.
    expect(mon).toMatchObject({
      weekday: "Mon",
      etSpan: "Sun 18:00 → Mon 17:00 ET",
      startUnix: unix(2026, 3, 8, 22),
      endUnix: unix(2026, 3, 9, 21),
    });
  });

  it("rejects an inverted explicit range", async () => {
    const text = await resolve(WED_1500_ET, { start: "2026-07-08", end: "2026-07-06" });
    expect(text).toMatch(/not before|after/i);
  });
});

describe("resolve_session_days with a session calendar", () => {
  function dbHarness(nowUnix: number) {
    const db = new Database(":memory:");
    initializeSchema(db);
    return createResolveSessionDaysHandler({ now: () => nowUnix, db });
  }

  async function resolveDb(nowUnix: number, args: Record<string, unknown>) {
    const handler = dbHarness(nowUnix);
    const res = await handler({ symbol: "NQ", ...args } as never);
    return JSON.parse(res.content[0].text);
  }

  it("adjusts early-close geometry, spans, and bar counts (Presidents Day 13:00)", async () => {
    const out = await resolveDb(WED_1500_ET, { start: "2026-02-16", end: "2026-02-16" });
    expect(out.holidaysModeled).toBe(true);
    expect(out.sessionDays).toHaveLength(1);
    expect(out.sessionDays[0]).toMatchObject({
      label: "2026-02-16",
      etSpan: "Sun 18:00 → Mon 13:00 ET",
      endUnix: unix(2026, 2, 16, 18), // 13:00 EST
    });
    expect(out.barCountEstimate["5m"]).toBe(228);
    expect(out.barCountEstimate["15m"]).toBe(76);
  });

  it("excludes closed days from the day set and flags them as holidays", async () => {
    // Thu 2026-12-24 (early close, untimed) .. Mon 2026-12-28; Fri 12-25 closed.
    const out = await resolveDb(WED_1500_ET, { start: "2026-12-24", end: "2026-12-28" });
    expect(out.sessionDays.map((d: { label: string }) => d.label)).toEqual([
      "2026-12-24",
      "2026-12-28",
    ]);
    const holidayFlag = out.flags.find((f: { input: string }) => f.input === "2026-12-25");
    expect(holidayFlag).toBeDefined();
    expect(holidayFlag.reason).toMatch(/market holiday/i);
    expect(holidayFlag.reason).toMatch(/Christmas/);
  });

  it("snaps a closed endpoint with a holiday-specific flag", async () => {
    const out = await resolveDb(WED_1500_ET, { start: "2026-12-25", end: "2026-12-28" });
    expect(out.sessionDays.map((d: { label: string }) => d.label)).toEqual(["2026-12-28"]);
    const flag = out.flags.find((f: { input: string }) => f.input === "2026-12-25");
    expect(flag).toBeDefined();
    expect(flag.reason).toMatch(/market holiday/i);
  });

  it("keeps holidaysModeled false without a calendar-backed db", async () => {
    const out = await resolveJson(WED_1500_ET, { relative: "today" });
    expect(out.holidaysModeled).toBe(false);
  });
});

describe("resolve_session_days input validation", () => {
  it("requires exactly one of explicit range or relative", async () => {
    expect(await resolve(WED_1500_ET, {})).toMatch(/either/i);
    expect(
      await resolve(WED_1500_ET, { start: "2026-07-06", end: "2026-07-08", relative: "today" }),
    ).toMatch(/either/i);
    expect(await resolve(WED_1500_ET, { start: "2026-07-06" })).toMatch(/either|end/i);
  });

  it("requires n for last-n-sessions", async () => {
    expect(await resolve(WED_1500_ET, { relative: "last-n-sessions" })).toMatch(/n/);
  });

  it("rejects unsupported symbols", async () => {
    const handler = harness(WED_1500_ET);
    const res = await handler({ symbol: "ZZ", relative: "today" } as never);
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toMatch(/Unsupported symbol/);
  });
});
