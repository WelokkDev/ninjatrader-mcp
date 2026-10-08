import { describe, it, expect } from "vitest";
import { bucketIndexOf, bucketPeriodEnd } from "../buckets.js";

describe("bucket arithmetic", () => {
  it("puts a close-stamp exactly on a boundary in the bucket it ends", () => {
    const start = 1_000_000;
    const period = 1800;
    expect(bucketIndexOf(start + 1, start, period)).toBe(0);
    expect(bucketIndexOf(start + period, start, period)).toBe(0);
    expect(bucketIndexOf(start + period + 1, start, period)).toBe(1);
    expect(bucketIndexOf(start + 2 * period, start, period)).toBe(1);
  });

  it("ends a bucket on its grid close, clamped to the session end", () => {
    const start = 1_000_000;
    const end = start + 82_800; // 23h session
    expect(bucketPeriodEnd(start, end, 0, 1800)).toBe(start + 1800);
    expect(bucketPeriodEnd(start, end, 45, 1800)).toBe(end); // last full 30m ends at the close
    // The sixth 4h bucket would grid-end an hour past the session.
    expect(bucketPeriodEnd(start, end, 5, 14_400)).toBe(end);
  });
});
