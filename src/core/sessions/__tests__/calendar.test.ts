import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../../../db/schema.js";
import {
  EMPTY_CALENDAR,
  loadCalendar,
  recordObservedClose,
  upsertFromSync,
} from "../calendar.js";

const TPL = "cme_us_index_futures_eth";

function memDb() {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

describe("loadCalendar + bootstrap", () => {
  it("seeds the 2026 CME bootstrap on first load and returns entries keyed by date", () => {
    const db = memDb();
    const cal = loadCalendar(db, TPL);
    expect(cal.get("2026-02-16")).toMatchObject({
      kind: "modified",
      closeTime: "13:00",
      source: "bootstrap",
    });
    expect(cal.get("2026-04-03")).toMatchObject({ kind: "modified", closeTime: "09:15" });
    expect(cal.get("2026-12-25")).toMatchObject({ kind: "closed" });
    // Date-certain but time-unverified: declared with no closeTime.
    expect(cal.get("2026-01-19")).toMatchObject({ kind: "modified" });
    expect(cal.get("2026-01-19")!.closeTime).toBeUndefined();
  });

  it("reads always-fresh: a direct table update is visible on the next load", () => {
    const db = memDb();
    loadCalendar(db, TPL);
    db.prepare(
      `UPDATE session_calendar SET close_time = '11:11' WHERE template = ? AND date = '2026-01-19'`,
    ).run(TPL);
    expect(loadCalendar(db, TPL).get("2026-01-19")!.closeTime).toBe("11:11");
  });

  it("re-seeding never clobbers existing rows", () => {
    const db = memDb();
    loadCalendar(db, TPL);
    db.prepare(
      `UPDATE session_calendar SET close_time = '11:11', source = 'nt8-observed' WHERE template = ? AND date = '2026-01-19'`,
    ).run(TPL);
    const cal = loadCalendar(db, TPL); // triggers another bootstrap pass
    expect(cal.get("2026-01-19")).toMatchObject({ closeTime: "11:11", source: "nt8-observed" });
  });

  it("returns an empty map for templates with no calendar rows", () => {
    const db = memDb();
    expect(loadCalendar(db, "nyse_rth").size).toBe(0);
    expect(EMPTY_CALENDAR.size).toBe(0);
  });
});

describe("recordObservedClose", () => {
  it("records onto a declared, untimed, non-manual row and stamps the source", () => {
    const db = memDb();
    loadCalendar(db, TPL);
    expect(recordObservedClose(db, TPL, "2026-01-19", "13:00")).toBe(true);
    const cal = loadCalendar(db, TPL);
    expect(cal.get("2026-01-19")).toMatchObject({
      closeTime: "13:00",
      source: "nt8-observed",
      kind: "modified",
    });
  });

  it("refuses undeclared dates", () => {
    const db = memDb();
    loadCalendar(db, TPL);
    expect(recordObservedClose(db, TPL, "2026-03-11", "13:00")).toBe(false);
  });

  it("refuses closed days", () => {
    const db = memDb();
    loadCalendar(db, TPL);
    expect(recordObservedClose(db, TPL, "2026-12-25", "13:00")).toBe(false);
  });

  it("refuses rows that already carry a time", () => {
    const db = memDb();
    loadCalendar(db, TPL);
    expect(recordObservedClose(db, TPL, "2026-02-16", "12:00")).toBe(false);
    expect(loadCalendar(db, TPL).get("2026-02-16")!.closeTime).toBe("13:00");
  });

  it("refuses manual rows", () => {
    const db = memDb();
    db.prepare(
      `INSERT INTO session_calendar (template, date, kind, source) VALUES (?, '2026-08-14', 'modified', 'manual')`,
    ).run(TPL);
    expect(recordObservedClose(db, TPL, "2026-08-14", "13:00")).toBe(false);
    expect(loadCalendar(db, TPL).get("2026-08-14")!.source).toBe("manual");
  });
});

describe("upsertFromSync", () => {
  it("inserts new rows as source nt8", () => {
    const db = memDb();
    upsertFromSync(db, TPL, { date: "2027-07-05", kind: "closed", description: "July 4th observed" });
    expect(loadCalendar(db, TPL).get("2027-07-05")).toMatchObject({
      kind: "closed",
      source: "nt8",
      description: "July 4th observed",
    });
  });

  it("updates kind/description on existing rows but preserves times and source", () => {
    const db = memDb();
    loadCalendar(db, TPL);
    recordObservedClose(db, TPL, "2026-01-19", "13:00");
    upsertFromSync(db, TPL, { date: "2026-01-19", kind: "modified", description: "MLK Day (synced)" });
    const e = loadCalendar(db, TPL).get("2026-01-19")!;
    expect(e.closeTime).toBe("13:00");
    expect(e.source).toBe("nt8-observed"); // observation provenance survives sync
    expect(e.description).toBe("MLK Day (synced)");
  });

  it("never touches manual rows", () => {
    const db = memDb();
    db.prepare(
      `INSERT INTO session_calendar (template, date, kind, close_time, source, description)
       VALUES (?, '2026-08-14', 'modified', '12:30', 'manual', 'operator override')`,
    ).run(TPL);
    upsertFromSync(db, TPL, { date: "2026-08-14", kind: "closed", description: "sync says closed" });
    expect(loadCalendar(db, TPL).get("2026-08-14")).toMatchObject({
      kind: "modified",
      closeTime: "12:30",
      source: "manual",
      description: "operator override",
    });
  });
});
