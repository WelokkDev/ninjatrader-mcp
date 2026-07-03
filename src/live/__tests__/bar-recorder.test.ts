import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LiveBarRecorder } from "../bar-recorder.js";
import type { BarCloseMessage } from "../../bridge/protocol.js";

function barClose(ts: number, over: { symbol?: string; timeframe?: string } = {}): BarCloseMessage {
  return {
    v: 1,
    type: "bar_close",
    symbol: over.symbol ?? "MNQ",
    timeframe: over.timeframe ?? "5m",
    candle: { timestamp: ts, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
  };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rec-"));
}

describe("LiveBarRecorder", () => {
  it("records a bar newest-first with computed lagSeconds (now in ms minus close ts)", () => {
    const rec = new LiveBarRecorder({ dir: tmp(), now: () => 1_700_000_300_000 });
    rec.record(barClose(1_700_000_000));
    const recent = rec.recent();
    expect(recent).toHaveLength(1);
    expect(recent[0].lagSeconds).toBe(300); // 1_700_000_300 - 1_700_000_000
    expect(recent[0].symbol).toBe("MNQ");
  });

  it("caps the ring at ringCapacity, keeping the most recent (newest first)", () => {
    const rec = new LiveBarRecorder({ dir: tmp(), ringCapacity: 3, now: () => 0 });
    for (let i = 1; i <= 5; i++) rec.record(barClose(i * 300));
    expect(rec.recent({ limit: 10 }).map((b) => b.timestamp)).toEqual([1500, 1200, 900]);
  });

  it("writes one JSONL line per bar to a dated file", () => {
    const dir = tmp();
    const rec = new LiveBarRecorder({ dir, now: () => 0 });
    rec.record(barClose(1_700_000_000));
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(dir, files[0]), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).timestamp).toBe(1_700_000_000);
  });

  it("counts duplicate close timestamps in status without dropping them", () => {
    const rec = new LiveBarRecorder({ dir: tmp(), now: () => 0 });
    rec.record(barClose(300));
    rec.record(barClose(300));
    const s = rec.subscriptions()[0];
    expect(s.count).toBe(2);
    expect(s.dupCount).toBe(1);
  });

  it("never throws into the receive path on a malformed message", () => {
    const rec = new LiveBarRecorder({ dir: tmp(), now: () => 0 });
    const bad = { v: 1, type: "bar_close", symbol: "MNQ", timeframe: "5m", candle: undefined } as unknown as BarCloseMessage;
    expect(() => rec.record(bad)).not.toThrow();
  });
});
