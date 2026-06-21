import { randomUUID } from "node:crypto";

export function newExperimentId(): string {
  return `exp_${randomUUID()}`;
}

export function newTraceId(): string {
  return `tr_${randomUUID()}`;
}

let spanSeq = 0;
export function newSpanId(): string {
  spanSeq = (spanSeq + 1) >>> 0;
  return `sp_${spanSeq.toString(36)}_${randomUUID().slice(0, 8)}`;
}
