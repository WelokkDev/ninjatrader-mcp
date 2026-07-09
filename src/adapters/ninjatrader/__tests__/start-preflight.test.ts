import { describe, it, expect, vi } from "vitest";
import { NinjaTraderRunner } from "../runner.js";
import type { RunContext } from "../../../lab/runner/types.js";
import type { Tracer } from "../../../lab/obs/types.js";

function fakeCtx() {
  const tracer = {
    traceId: "t",
    startSpan: vi.fn(),
    event: vi.fn(),
    metric: vi.fn(),
  } as unknown as Tracer;
  const fail = vi.fn();
  const ctx = {
    experimentId: "exp-preflight-1",
    spec: { symbol: "NQ", startDay: "2026-05-04", endDay: "2026-05-05" },
    tracer,
    progress: vi.fn(),
    complete: vi.fn(),
    fail,
  } as unknown as RunContext;
  return { ctx, fail };
}

describe("NinjaTraderRunner data preflight", () => {
  it("fails the run before spawning when the preflight rejects", () => {
    const runner = new NinjaTraderRunner({
      repoRoot: "Z:/definitely/not/a/real/path",
      nodeBin: "no-such-binary-xyz",
      preflight: () => "3 session-day(s) incomplete at 5m: boom",
    });
    const { ctx, fail } = fakeCtx();
    const handle = runner.start(ctx);
    expect(handle.experimentId).toBe("exp-preflight-1");
    expect(handle.pid).toBeUndefined();
    expect(fail).toHaveBeenCalledTimes(1);
    expect(fail.mock.calls[0][0]).toMatch(/data preflight failed/);
    expect(fail.mock.calls[0][0]).toMatch(/boom/);
  });
});
