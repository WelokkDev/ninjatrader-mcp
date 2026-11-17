import { fmtSecs, fmtTs } from "../nt8-lake/checks.js";
import { formatExchangeTime } from "../core/time.js";
import { EngineUnavailableError } from "../nt8-lake/engine.js";
import {
  defaultContext,
  gold,
  ingest,
  openSource,
  probe,
  recheck,
  select,
  show,
  status,
  ungold,
  verify,
  type LakeContext,
} from "../nt8-lake/ops.js";
import type { DayState } from "../nt8-lake/labels.js";
import { RefusedError } from "../nt8-lake/source.js";

const USAGE = `usage: npm run nt8-lake -- <command>
  ingest <source> <folder> [--json]  source: addon, nt8-export
  probe <source> <folder> [--json]   each whole stream through the writer; stores nothing
  status [--contract C] [--from D] [--to D]
  show <contract> <session>
  verify [--contract C] [--session D]
  recheck [--contract C] [--session D]
  gold <contract> <session> --note "..." [--waive a,b]
  ungold <contract> <session>
  select <contract> <session> <take>`;

// With --json, stdout carries exactly one JSON line: the report, {"refused"} or {"failed"}.
const JSON_FLAG = "--json";
const json = process.argv.includes(JSON_FLAG);

function parseArgs(argv: string[]): { pos: string[]; flags: Record<string, string> } {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === JSON_FLAG) continue;
    if (a.startsWith("--")) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new RefusedError(`${a} needs a value`);
      flags[a.slice(2)] = v;
      i++;
    } else pos.push(a);
  }
  return { pos, flags };
}

const num = (v: number | string) => Number(v).toLocaleString("en-US");

function need(pos: string[], count: number): void {
  if (pos.length < count) throw new RefusedError(USAGE);
}

function printDay(label: string, st: DayState): void {
  console.log(`${label}: take ${st.selected} of ${st.takes.length}, ${st.tier ?? "not stored"}`);
  for (const r of st.results) console.log(`  ${r.status.padEnd(12)} ${r.id.padEnd(26)} ${r.detail}`);
  if (st.day.gold) console.log(`  gold on take ${st.day.gold.take} at ${st.day.gold.at}: ${st.day.gold.note}; waived ${st.day.gold.waived.join(", ") || "none"}`);
}

async function run(ctx: LakeContext, argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { pos, flags } = parseArgs(rest);
  switch (command) {
    case "ingest": {
      need(pos, 2);
      const r = await ingest(ctx, await openSource(pos[0], pos[1]));
      if (json) {
        console.log(JSON.stringify(r));
        return 0;
      }
      console.log(`${r.instrument} from ${r.source}: ${Object.entries(r.rows).map(([s, n]) => `${s} ${num(n!)}`).join(", ")} rows`);
      if (r.days.length === 0) console.log("nothing to store");
      for (const d of r.days) {
        const counts = Object.entries(d.rows).map(([s, n]) => `${s} ${num(n!)}`).join(", ");
        if (d.status === "stored") {
          console.log(`  ${d.session} stored as take ${d.take}: ${d.tier}${d.failing?.length ? `, failing ${d.failing.join(", ")}` : ""} (${counts})`);
        } else if (d.status === "already_held") {
          console.log(`  ${d.session} already held as take ${d.take} (${counts})`);
        } else {
          console.log(`  ${d.session} ${d.status}, not stored: ${d.reason} (${counts})`);
        }
      }
      console.log(`wall time ${(r.wallMs / 1000).toFixed(1)} s`);
      return 0;
    }
    case "probe": {
      need(pos, 2);
      const r = await probe(ctx, await openSource(pos[0], pos[1]));
      if (json) {
        console.log(JSON.stringify(r));
        return 0;
      }
      console.log(`${r.instrument} from ${r.source}, no session cut, nothing stored:`);
      for (const [s, p] of Object.entries(r.streams)) {
        console.log(`  ${s.padEnd(6)} ${num(p!.rows).padStart(12)} rows  ${num(p!.bytes).padStart(12)} bytes  ${p!.fingerprint}`);
      }
      console.log(`wall time ${(r.wallMs / 1000).toFixed(1)} s`);
      return 0;
    }
    case "status": {
      const lines = status(ctx, { contract: flags.contract, from: flags.from, to: flags.to });
      if (lines.length === 0) console.log("the lake is empty");
      for (const l of lines) {
        const what =
          l.state === "stored"
            ? `take ${l.take}${l.takes! > 1 ? ` of ${l.takes}` : ""} ${l.tier}${l.failing?.length ? `  failing ${l.failing.join(", ")}` : ""}`
            : l.state;
        console.log(`${l.contract}  ${l.session}  ${what}${l.note ? `  (${l.note})` : ""}`);
      }
      return 0;
    }
    case "show": {
      need(pos, 2);
      const sheet = show(ctx, pos[0], pos[1]);
      printDay(`${sheet.instrument} ${sheet.session}`, sheet.state);
      for (const t of sheet.takes) {
        console.log(`  take ${t.take}: ${t.source}, written ${t.writtenAt}`);
        for (const [s, w] of Object.entries(t.streams)) console.log(`    ${s.padEnd(6)} ${num(w!.rows).padStart(12)} rows  ${num(w!.bytes).padStart(12)} bytes  ${w!.fingerprint}`);
      }
      const checks = sheet.state.checks;
      if (!checks) return 0;
      const p = checks.facts.prints;
      console.log(`sides: at bid ${num(p.atBid.rows)} (${num(p.atBid.contracts)} contracts), at ask ${num(p.atAsk.rows)} (${num(p.atAsk.contracts)}), bid = ask ${num(p.bothSides)}, unsided ${num(p.unsided)}, delta ${p.delta}`);
      console.log(`1s bars: lake ${num(checks.facts.bars1s.lake)}, reference ${num(checks.facts.bars1s.reference)}`);
      for (const [s, f] of Object.entries(checks.facts.streams)) {
        console.log(`${s}: ${num(f!.rows)} rows, ${num(f!.contracts)} contracts, ${fmtTs(f!.firstTs)} to ${fmtTs(f!.lastTs)} ET; ${num(f!.inSessionRows)} in session`);
        if (f!.mostRowsOnOneTs) console.log(`  most rows on one timestamp: ${num(f!.mostRowsOnOneTs.rows)} at ${fmtTs(f!.mostRowsOnOneTs.ts)}`);
        console.log(`  longest gaps: ${f!.longestGaps.map((g) => `${fmtSecs(g.secs)}s from ${fmtTs(g.fromTs).slice(11)}`).join(", ") || "-"}`);
        console.log(`  rows per hour (ET): ${f!.rowsPerHour.map((h) => `${formatExchangeTime(h.hour).slice(11, 13)}h ${num(h.rows)}`).join(", ")}`);
      }
      return 0;
    }
    case "verify": {
      const r = await verify(ctx, { contract: flags.contract, session: flags.session });
      for (const t of r.takes) {
        console.log(`${t.contract}  ${t.session}  take ${t.take}  ${t.problems.length === 0 ? "ok" : "FAILED"}`);
        for (const p of t.problems) console.log(`  ${p}`);
      }
      for (const l of r.leftovers) console.log(`leftover temp directory: ${l}`);
      console.log(r.ok ? `verified ${r.takes.length} takes` : "verify FAILED");
      return r.ok ? 0 : 1;
    }
    case "recheck": {
      const lines = await recheck(ctx, { contract: flags.contract, session: flags.session });
      for (const l of lines) {
        const tier = l.tierAfter === null ? "not selected" : l.tierBefore === l.tierAfter ? l.tierAfter : `${l.tierBefore} -> ${l.tierAfter}`;
        console.log(`${l.contract}  ${l.session}  take ${l.take}  ${tier}${l.failing.length ? `  failing ${l.failing.join(", ")}` : ""}`);
      }
      return 0;
    }
    case "gold": {
      need(pos, 2);
      if (flags.note === undefined) throw new RefusedError(`gold needs --note\n${USAGE}`);
      const waive = flags.waive ? flags.waive.split(",").map((w) => w.trim()).filter(Boolean) : [];
      printDay(`${pos[0]} ${pos[1]}`, await gold(ctx, pos[0], pos[1], flags.note, waive));
      return 0;
    }
    case "ungold": {
      need(pos, 2);
      printDay(`${pos[0]} ${pos[1]}`, await ungold(ctx, pos[0], pos[1]));
      return 0;
    }
    case "select": {
      need(pos, 3);
      const take = Number(pos[2]);
      if (!Number.isInteger(take) || take < 1) throw new RefusedError(`bad take "${pos[2]}"`);
      printDay(`${pos[0]} ${pos[1]}`, await select(ctx, pos[0], pos[1], take));
      return 0;
    }
    default:
      console.log(USAGE);
      return command === undefined || command === "help" ? 0 : 2;
  }
}

const ctx = defaultContext();
try {
  process.exitCode = await run(ctx, process.argv.slice(2));
} catch (err) {
  if (err instanceof RefusedError || err instanceof EngineUnavailableError) {
    if (json) console.log(JSON.stringify(err instanceof RefusedError ? { refused: err.message } : { failed: err.message }));
    else console.error(`refused: ${err.message}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
} finally {
  ctx.close();
}
