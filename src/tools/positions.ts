import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getBridgeStatus } from "../bridge/index.js";
import { getLiveFeedRuntime, type LiveFeedRuntime } from "../live/runtime.js";
import {
  looksLikeSimAccount,
  maePoints,
  mfePoints,
  type PositionAccountState,
  type TrackedOrder,
  type TrackedPosition,
} from "../live/positions.js";
import { errorResult, jsonResult, type ToolResult } from "./result.js";

const NOT_STARTED =
  "live feed runtime not started — startRuntime() has not run in this process";

const SELL_SIDE = new Set(["Sell", "SellShort"]);
const BUY_SIDE = new Set(["Buy", "BuyToCover"]);

export interface RiskLeg {
  orderId: string;
  name: string;
  orderType: string;
  price: number;
  remainingQuantity: number;
  pointsFromEntry: number | null;
}

export interface RiskAssessment {
  stops: RiskLeg[];
  targets: RiskLeg[];
  stopCoverage: "full" | "partial" | "none";
  coveredQuantity: number;
  /** Worst-case loss if every covering stop fills, in dollars (covered qty only). */
  riskDollars: number | null;
  riskPointsPerContract: number | null;
  targetCoverage: "full" | "partial" | "none";
  rewardDollars: number | null;
  rewardRiskRatio: number | null;
}

/**
 * Match protective stops (*Stop* types, exit side) and targets (Limit/MIT)
 * from the account's working orders and derive dollar risk. Over-covered
 * positions allocate furthest-first — assume the worst legs fill.
 */
export function assessRisk(
  position: {
    instrument: string;
    direction: "long" | "short";
    quantity: number;
    averagePrice: number | null;
    pointValue: number | null;
  },
  orders: TrackedOrder[],
): RiskAssessment {
  const exitSide = position.direction === "long" ? SELL_SIDE : BUY_SIDE;
  const avg = position.averagePrice;

  const stops: RiskLeg[] = [];
  const targets: RiskLeg[] = [];
  for (const o of orders) {
    if (o.instrument !== position.instrument) continue;
    if (!exitSide.has(o.action)) continue;
    const remaining = o.quantity - o.filled;
    if (remaining <= 0) continue;
    const isStop = o.orderType.includes("Stop");
    const isTargetType = o.orderType === "Limit" || o.orderType === "MIT";
    if (!isStop && !isTargetType) continue;
    const price = isStop
      ? typeof o.stopPrice === "number"
        ? o.stopPrice
        : null
      : typeof o.limitPrice === "number"
        ? o.limitPrice
        : null;
    if (price === null) continue;
    const leg: RiskLeg = {
      orderId: o.orderId,
      name: o.name,
      orderType: o.orderType,
      price,
      remainingQuantity: remaining,
      pointsFromEntry: avg !== null ? Math.abs(avg - price) : null,
    };
    if (isStop) stops.push(leg);
    else targets.push(leg);
  }

  const allocate = (
    legs: RiskLeg[],
  ): { covered: number; dollars: number | null } => {
    if (legs.length === 0 || position.quantity <= 0) return { covered: 0, dollars: null };
    // Furthest from entry first — assume the worst legs are the ones that fill.
    const sorted = [...legs].sort(
      (a, b) => (b.pointsFromEntry ?? 0) - (a.pointsFromEntry ?? 0),
    );
    let remainingQty = position.quantity;
    let covered = 0;
    let dollars: number | null = 0;
    for (const leg of sorted) {
      if (remainingQty === 0) break;
      const take = Math.min(leg.remainingQuantity, remainingQty);
      covered += take;
      remainingQty -= take;
      if (leg.pointsFromEntry === null || position.pointValue === null) {
        dollars = null; // price known but entry/pointValue missing — no $ math
      } else if (dollars !== null) {
        dollars += take * leg.pointsFromEntry * position.pointValue;
      }
    }
    return { covered, dollars };
  };

  const stopAlloc = allocate(stops);
  const targetAlloc = allocate(targets);
  const coverage = (covered: number): "full" | "partial" | "none" =>
    covered >= position.quantity ? "full" : covered > 0 ? "partial" : "none";

  const riskDollars = stopAlloc.covered > 0 ? stopAlloc.dollars : null;
  const rewardDollars = targetAlloc.covered > 0 ? targetAlloc.dollars : null;
  return {
    stops,
    targets,
    stopCoverage: coverage(stopAlloc.covered),
    coveredQuantity: stopAlloc.covered,
    riskDollars,
    riskPointsPerContract:
      riskDollars !== null && position.pointValue !== null && stopAlloc.covered > 0
        ? riskDollars / position.pointValue / stopAlloc.covered
        : null,
    targetCoverage: coverage(targetAlloc.covered),
    rewardDollars,
    rewardRiskRatio:
      riskDollars !== null && riskDollars > 0 && rewardDollars !== null
        ? rewardDollars / riskDollars
        : null,
  };
}

export interface PositionsToolsDeps {
  runtime: () => LiveFeedRuntime | null;
  bridgeStatus: () => ReturnType<typeof getBridgeStatus>;
  nowUnix?: () => number;
}

const defaultDeps: PositionsToolsDeps = {
  runtime: getLiveFeedRuntime,
  bridgeStatus: getBridgeStatus,
};

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function buildPositionView(
  runtime: LiveFeedRuntime,
  account: PositionAccountState,
  pos: TrackedPosition,
  now: number,
): Record<string, unknown> {
  const direction: "long" | "short" = pos.marketPosition === "Short" ? "short" : "long";
  const avg = typeof pos.averagePrice === "number" ? pos.averagePrice : null;
  const pointValue = typeof pos.pointValue === "number" ? pos.pointValue : null;

  const mark = runtime.positions.lastPriceFor(pos.symbol);
  const dirSign = direction === "long" ? 1 : -1;
  let unrealized: Record<string, unknown> | null = null;
  if (mark && avg !== null) {
    const points = dirSign * (mark.price - avg);
    unrealized = {
      points: round(points, 4),
      perContractDollars: pointValue !== null ? round(points * pointValue) : null,
      dollars: pointValue !== null ? round(points * pos.quantity * pointValue) : null,
    };
  }

  const risk = assessRisk(
    { instrument: pos.instrument, direction, quantity: pos.quantity, averagePrice: avg, pointValue },
    [...account.orders.values()],
  );

  let rMultiple: number | null = null;
  if (
    unrealized &&
    risk.riskDollars !== null &&
    risk.riskDollars > 0 &&
    typeof unrealized.dollars === "number"
  ) {
    rMultiple = round(unrealized.dollars / risk.riskDollars, 2);
  }

  const trade = runtime.positions.tradeFor(account.name, pos.instrument);
  let liveTrade: Record<string, unknown> | null = null;
  if (trade) {
    const mae = maePoints(trade.direction, avg, trade.maxAdversePrice);
    const mfe = mfePoints(trade.direction, avg, trade.maxFavorablePrice);
    liveTrade = {
      openedAt: trade.openedAt,
      ageSeconds: trade.openedAt !== null ? Math.max(0, now - trade.openedAt) : null,
      // Feed attached mid-trade: entry time/fills before that are unknown.
      preExisting: trade.openedAt === null,
      peakQuantity: trade.peakQuantity,
      fillCount: trade.fills.length,
      recentFills: trade.fills.slice(-10),
      maePoints: mae !== null ? round(mae, 4) : null,
      mfePoints: mfe !== null ? round(mfe, 4) : null,
      maeDollars: mae !== null && pointValue !== null ? round(mae * pointValue * pos.quantity) : null,
      mfeDollars: mfe !== null && pointValue !== null ? round(mfe * pointValue * pos.quantity) : null,
    };
  }

  return {
    symbol: pos.symbol,
    instrument: pos.instrument,
    direction,
    quantity: pos.quantity,
    averagePrice: avg,
    pointValue,
    tickSize: pos.tickSize ?? null,
    updatedAt: pos.updatedAt,
    price: mark
      ? {
          value: mark.price,
          source: mark.source,
          asOf: mark.asOf,
          ageSeconds: Math.max(0, now - mark.asOf),
        }
      : null,
    unrealized,
    // NT8's own unrealized number from the last snapshot, when it had one.
    ntUnrealizedPnl: typeof pos.unrealizedPnl === "number" ? pos.unrealizedPnl : null,
    risk: {
      stopCoverage: risk.stopCoverage,
      coveredQuantity: risk.coveredQuantity,
      riskDollars: risk.riskDollars !== null ? round(risk.riskDollars) : null,
      riskPointsPerContract:
        risk.riskPointsPerContract !== null ? round(risk.riskPointsPerContract, 4) : null,
      rMultiple,
      targetCoverage: risk.targetCoverage,
      rewardDollars: risk.rewardDollars !== null ? round(risk.rewardDollars) : null,
      rewardRiskRatio:
        risk.rewardRiskRatio !== null ? round(risk.rewardRiskRatio, 2) : null,
      stops: risk.stops,
      targets: risk.targets,
    },
    liveTrade,
  };
}

function buildAccountsView(
  runtime: LiveFeedRuntime,
  now: number,
): Array<Record<string, unknown>> {
  return runtime.positions.accountsView().map((account) => ({
    name: account.name,
    // Name heuristic — NT8 has no sim/live API; raw fields let the reader judge.
    isSim: looksLikeSimAccount(account.name),
    connection: account.connection,
    connectionStatus: account.connectionStatus,
    denomination: account.denomination,
    realizedPnl: account.realizedPnl,
    cashValue: account.cashValue,
    netLiquidation: account.netLiquidation,
    positions: [...account.positions.values()].map((p) =>
      buildPositionView(runtime, account, p, now),
    ),
    workingOrders: [...account.orders.values()],
  }));
}

export function createGetPositionsHandler(deps: PositionsToolsDeps) {
  return async (_args: Record<string, never>): Promise<ToolResult> => {
    const runtime = deps.runtime();
    if (!runtime) return errorResult(NOT_STARTED, { ok: false });
    const now = deps.nowUnix ? deps.nowUnix() : Math.floor(Date.now() / 1000);
    const bridge = deps.bridgeStatus();

    let source: "live" | "last-known" = "last-known";
    let pullError: string | null = null;
    if (bridge.connected) {
      const pull = await runtime.positions.pull();
      if (pull.ok) source = "live";
      else pullError = pull.error ?? "pull failed";
    } else {
      pullError = "NinjaTrader bridge not connected";
    }
    // Status is read after the pull so its counters reflect this call.
    const feed = runtime.positions.status();

    const accounts = buildAccountsView(runtime, now);
    const openPositions = accounts.reduce(
      (n, a) => n + (a.positions as unknown[]).length,
      0,
    );
    return jsonResult({
      ok: true,
      source,
      asOf: now,
      ...(source === "last-known"
        ? {
            stale: true,
            warning:
              `${pullError} — data below is the LAST KNOWN state` +
              (feed.lastSyncAt || feed.lastEventAt
                ? ` (last update ${Math.max(feed.lastSyncAt ?? 0, feed.lastEventAt ?? 0)})`
                : " (never updated this session)") +
              ". Do NOT assume flat.",
          }
        : {}),
      openPositions,
      accounts,
      recentClosedTrades: runtime.positions.recentClosedTrades(),
      feed,
      bridge,
    });
  };
}

export function createSubscribeLivePositionsHandler(deps: PositionsToolsDeps) {
  return async (_args: Record<string, never>): Promise<ToolResult> => {
    const runtime = deps.runtime();
    if (!runtime) return errorResult(NOT_STARTED, { ok: false });
    const res = await runtime.positions.subscribe();
    const view = { ok: res.ok, accounts: res.accounts, alreadyActive: res.alreadyActive };
    return res.ok
      ? jsonResult(view)
      : errorResult(res.error ?? "subscribe_live_positions failed", view);
  };
}

export function createUnsubscribeLivePositionsHandler(deps: PositionsToolsDeps) {
  return async (_args: Record<string, never>): Promise<ToolResult> => {
    const runtime = deps.runtime();
    if (!runtime) return errorResult(NOT_STARTED, { ok: false });
    const res = await runtime.positions.unsubscribe();
    if (!res.ok) {
      return errorResult(res.error ?? "unsubscribe_live_positions failed", {
        ok: false,
        removed: res.removed,
      });
    }
    // An error string on ok:true means the NT8-side release is unconfirmed —
    // desired OFF is durable and re-enforced on reconnect, so only a warning.
    return jsonResult({
      ok: true,
      removed: res.removed,
      ...(res.error ? { warning: res.error } : {}),
    });
  };
}

export function registerGetPositions(server: McpServer): void {
  server.tool(
    "get_positions",
    "Snapshot of every NinjaTrader account's open positions and working orders with risk math: unrealized P&L from the freshest known price (source and age reported), stop/target matching with dollar risk, R-multiple, and live-trade context (age, fills, MAE/MFE) when the position feed is on. Fresh bridge round-trip whenever NT8 is connected; when disconnected returns last-known state marked stale — treat as UNKNOWN, never as flat. Accounts carry an isSim name-heuristic flag; sim and live are never merged. Read-only.",
    {},
    createGetPositionsHandler(defaultDeps),
  );
}

export function registerSubscribeLivePositions(server: McpServer): void {
  server.tool(
    "subscribe_live_positions",
    "Turn ON account-wide live position tracking: the NT8 AddOn streams position/order/execution events for ALL accounts (sparse events, not a P&L ticker), self-healing via full snapshots on subscribe/reconnect. Enables live-trade context in get_positions (entry time, fills, MAE/MFE — granularity follows active live bar feeds) and closed-trade summaries. Persists across restarts and replays on every NT8 reconnect. Events also broadcast on ws://127.0.0.1:9472/feed (send {type:'subscribe_positions'}); health in live_feed_status under 'positions'. Read-only.",
    {},
    createSubscribeLivePositionsHandler(defaultDeps),
  );
}

export function registerUnsubscribeLivePositions(server: McpServer): void {
  server.tool(
    "unsubscribe_live_positions",
    "Turn OFF the live position feed (get_positions keeps working via on-demand snapshots; MAE/MFE context stops accumulating). removed:false with an error means the NT8-side stop is unconfirmed — OFF is persisted and re-enforced on the next NT8 reconnect.",
    {},
    createUnsubscribeLivePositionsHandler(defaultDeps),
  );
}
