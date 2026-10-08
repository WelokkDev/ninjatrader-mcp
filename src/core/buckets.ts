// Session-aligned bucket arithmetic on already-resolved session-day bounds.
// The one home for it: the aggregator and the frozen view must agree bar for
// bar, and the Python engine ports these two functions as ziq.core.buckets.

// Bucket index of a close-stamped bar within its session-day.
//
// The `- 1` is load-bearing. A close-stamp exactly on a bucket boundary (the
// 22:00 close of a CME ETH session's first 4h bucket) belongs to the bucket
// whose data window it ENDS, not the next one. Remove it and every boundary
// bar shifts one bucket late.
export function bucketIndexOf(
  timestamp: number,
  sessionDayStartUnix: number,
  periodSeconds: number,
): number {
  return Math.floor((timestamp - sessionDayStartUnix - 1) / periodSeconds);
}

// A bucket's period end: its grid close, clamped to the session-day end so a
// trailing stub bucket ends at the session close.
export function bucketPeriodEnd(
  sessionDayStartUnix: number,
  sessionDayEndUnix: number,
  bucketIndex: number,
  periodSeconds: number,
): number {
  return Math.min(sessionDayStartUnix + (bucketIndex + 1) * periodSeconds, sessionDayEndUnix);
}
