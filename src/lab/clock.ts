// A tiny injectable clock so the lab (ETA, spans, timestamps) is deterministic
// under test and never reaches for a global directly.

export interface Clock {
  now(): number; // epoch millis
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** A clock you can drive by hand in tests. */
export function manualClock(start = 0): Clock & { set(ms: number): void; advance(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    set: (ms: number) => {
      t = ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}
