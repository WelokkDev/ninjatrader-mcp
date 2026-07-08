import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import type { WebSocket } from "ws";
import { initializeSchema } from "../../db/schema.js";
import { createCandlesResponseHandler } from "../ingest.js";
import { ConnectionManager } from "../connection.js";
import type { CandlesResponseMessage } from "../protocol.js";

const unix = (y: number, mo1: number, d: number, h: number): number =>
  Math.floor(Date.UTC(y, mo1 - 1, d, h, 0, 0) / 1000);

// NQ session-day 2026-05-01 (Fri): Apr 30 18:00 EDT → May 1 17:00 EDT.
const DAY_START = unix(2026, 4, 30, 22);

function memDb() {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

function candlesAt(stamps: number[]) {
  return stamps.map((timestamp) => ({
    timestamp,
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: 10,
  }));
}

function countRows(db: Database.Database, timeframe: string): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS c FROM candles WHERE symbol = 'NQ' AND timeframe = ?`)
      .get(timeframe) as { c: number }
  ).c;
}

describe("candles_response heal handler", () => {
  it("ingests a candles_response message into the cache", () => {
    const db = memDb();
    const handler = createCandlesResponseHandler(db);
    const msg: CandlesResponseMessage = {
      v: 1,
      id: "req-1",
      type: "candles_response",
      symbol: "NQ",
      timeframe: "5m",
      candles: candlesAt([DAY_START + 300, DAY_START + 600]),
    };
    handler(msg);
    expect(countRows(db, "5m")).toBe(2);
  });

  it("runs the full ingest path — 15m responses cascade into derived TFs", () => {
    const db = memDb();
    const handler = createCandlesResponseHandler(db);
    handler({
      v: 1,
      id: "req-2",
      type: "candles_response",
      symbol: "NQ",
      timeframe: "15m",
      candles: candlesAt([DAY_START + 900, DAY_START + 1800]),
    });
    expect(countRows(db, "15m")).toBe(2);
    expect(countRows(db, "30m")).toBeGreaterThanOrEqual(1);
  });

  it("never throws — a bad message is logged and dropped", () => {
    const db = memDb();
    const handler = createCandlesResponseHandler(db);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      handler({
        v: 1,
        id: "req-3",
        type: "candles_response",
        symbol: "NQ",
        timeframe: "30m", // not a raw TF — ingestCandles throws internally
        candles: candlesAt([DAY_START + 1800]),
      }),
    ).not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("late candles_response through the connection layer", () => {
  function fakeSocket() {
    const listeners = new Map<string, (...args: never[]) => void>();
    const sent: string[] = [];
    const socket = {
      on(event: string, cb: (...args: never[]) => void) {
        listeners.set(event, cb);
      },
      send(data: string) {
        sent.push(data);
      },
      close() {
        // handleClose is driven manually in the test teardown
      },
    } as unknown as WebSocket;
    return { socket, listeners, sent };
  }

  it("a response arriving after the request timed out still heals the cache", async () => {
    const db = memDb();
    const cm = new ConnectionManager();
    const { socket, listeners, sent } = fakeSocket();
    cm.attach(socket);
    cm.onMessage("candles_response", createCandlesResponseHandler(db));

    const pending = cm.request(
      "request_candles",
      { symbol: "NQ", timeframe: "5m", from: DAY_START, to: DAY_START + 900 },
      10,
    );
    await expect(pending).rejects.toThrow(/heal on the next query/);
    await expect(pending).rejects.toThrow(/downloading history/);

    // NT8 finishes late and sends the correlated response anyway.
    const envelope = JSON.parse(sent[0]) as { id: string };
    const late = JSON.stringify({
      v: 1,
      id: envelope.id,
      type: "candles_response",
      symbol: "NQ",
      timeframe: "5m",
      candles: candlesAt([DAY_START + 300, DAY_START + 600, DAY_START + 900]),
    });
    listeners.get("message")!(late as never);

    expect(countRows(db, "5m")).toBe(3);

    // Teardown: close the connection so the heartbeat watchdog is cleared.
    listeners.get("close")!(1000 as never, Buffer.from("") as never);
  });
});
