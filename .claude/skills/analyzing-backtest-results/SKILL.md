---
name: analyzing-backtest-results
description: Use when analyzing, interpreting, judging, or reporting a backtest or strategy-lab result in this NinjaTrader 8 futures project (MNQ/NQ, 5-minute RTH strategies) — e.g. deciding whether a result is promising, what a trade count / expectancy / Sharpe / profit factor / win rate / drawdown actually tells you, whether fills and transaction costs are realistic, why a strategy that backtests well may fail live, or what to do next with an experiment. Keywords: backtest, Strategy Analyzer, expectancy, R-multiple, slippage, fill resolution, overfitting, drawdown, position sizing.
---

# Analyzing Backtest Results

**A backtest is a filter that rejects fragile strategies and characterizes risk — it does not prove an edge.** Treat every headline number as an optimistic upper bound; live is worse, never equal. "Backtests great, live poor" is the default outcome, not bad luck.

## Check before concluding anything

1. **Trade count.** n<50 is not gate-bearing — a weak point estimate, not evidence. Need ~150 minimum, 200–300 across regimes (bull/chop/bear, high/low vol) to judge an edge.
2. **Costs modeled?** No commission/slippage/spread → the result is optimistic. Re-derive net before believing it.
3. **Fills realistic?** Exact stop/target fills are best-case (see NT8 fills).
4. **Selection effect?** Config sweeps and the lab's 3 exit modes (fixed/trailing/constrained) make a headline a best-of-N — discount it, confirm out-of-sample.
5. **Does the return hinge on 1–2 trades?** Remove the top trade and re-check. If the edge collapses, that's fragility, not edge.

## NT8 fill reality (re-verify against current docs if unsure)

- Historical backtests run strategy logic **on bar close**; fills are inferred from a **"virtual bar" OHLC path** (Open → whichever of High/Low is nearer the Open, then the other, then Close), not observed ticks.
- Default fill resolution fills **stops/targets at their exact price** with no intrabar path, slippage, or spread → **fills are optimistic.** Tick Replay does *not* fix this; High Order Fill Resolution improves pricing via a finer series (commonly Last-only, so slippage stays understated).
- NinjaTrader documents that **real-time results differ from backtest.**
- **Rule:** if the edge only survives exact fills, `target-first` tie-breaking, or zero costs, it is a mirage. Prefer `bothTouchedRule: "stop-first"`; check `ambiguousExitTrades`.

## Realistic costs — MNQ/NQ (as of 2026-07; re-verify the schedule if stale)

| | tick value | round-turn all-in (NinjaTrader) |
|---|---|---|
| MNQ | $0.50 ($2/pt) | ~$1.30–$1.90 |
| NQ | $5.00 ($20/pt) | ~$4.36–$5.76 |

Add **~1 tick/side slippage** (2+ around the open/news) plus ~1 tick spread. No reliable per-broker slippage data exists — ignore blog figures. Convert cost to R using each trade's dollar risk. **Costs bite hardest on tight-stop / high-frequency strategies** and can flip a thin edge negative.

## Metric reliability at low n

- **Expectancy (R/trade) is the primary metric.** SE = σ/√n; for high reward:risk σ≈1.5–2R, so distinguishing +0.2R from zero needs ~350–700 trades. **Gate = lower bound of the 95% CI on _post-cost_ expectancy > 0**, holding out-of-sample.
- **Sharpe, profit factor, win rate:** unstable below ~100 trades (rule of thumb, not a canonical cutoff) — diagnostic, not gate-bearing. Report with a bootstrap CI (PF's own bootstrap is fragile at low n). Skip Sortino at low n.
- **Max drawdown is a distribution, never a single number.** Resample the trade sequence — reshuffle (sequence risk) and bootstrap (magnitude) — and size to the ~95th-percentile Monte Carlo drawdown. **Caveat:** at ~100–160 lifetime trades the MC tail *understates* true tail risk (a bootstrap can't draw a loss worse than the worst observed), so treat it as a floor and layer broker-side risk limits.

## Position sizing

Kelly is a **ceiling, not the rule.** Never size from a small-sample edge estimate — an overstated edge causes catastrophic overbetting, and full Kelly likely produces >50% drawdowns. Use fixed-fractional caps (~0.25–2% risk per trade); they bind in practice. Keep "% risk per trade" (per-R loss) distinct from the Kelly fraction.

## Gotcha: a stop that booked a gain

A stop-out recorded as **positive R is mode-dependent**: legitimate in **trailing** mode (a chandelier trail moved into profit), but a known **phantom-stop bug in fixed mode** (next-open entry gaps past a trigger-anchored stop). **Check the exit mode and the entry-vs-stop geometry before calling it either — never assume.**

## Verdict discipline

Green-light only when post-cost expectancy has a 95% CI lower bound > 0, holding **out-of-sample** (walk-forward), **across regimes**, at **n ≥ ~150**, under **realistic fills**, sized within caps. Missing any → "keep it in the lab," not "promising."

For deeper detail without duplicating it here: engine/execution fidelity → the lab's *fidelity plan*; staged gates and metric thresholds → the *validation roadmap*; catalog of others' failure modes → the *algo-failure-modes checklist* (project docs, migrating to Notion).
