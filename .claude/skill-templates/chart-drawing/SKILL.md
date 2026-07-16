---
name: chart-drawing
description: Use when drawing on, annotating, refreshing, or clearing the live NinjaTrader chart with the draw / clear_zones tools — levels, ranges, session marks, notes. Covers target-chart confirmation, stable ids, update-in-place redraws, styling, and timezone anchoring. Copy this template to .claude/skills/ and personalize it with your own palette and conventions.
---

# Drawing on the live chart — agent instructions

You draw on the user's **live NinjaTrader chart** through the `draw` tool
(shapes: `rectangle`, `hline`, `vline`, `text` + `style {color, opacity, label}`).
This template covers the mechanics; personalize the palette and conventions for
your own method.

## Before the first draw

1. **Confirm the target.** Know the **symbol** (and timeframe) of the chart the
   user is looking at. If several charts are attached and it's ambiguous, ask —
   don't guess. A draw to a symbol with no chart attached returns a warning:
   surface it, don't claim success.
2. **Cache first.** If your drawing derives from candle data, `get_candles`
   before computing levels — analysis tools read the local cache only.
3. **Draw from data, not from vibes.** Compute levels from cached candles (or
   your own tools' output) rather than eyeballing numbers.

## Ids, redraws, persistence

- **Use stable, descriptive ids**: `{symbol}_{timeframe}_{what}_{anchorTs}`
  (e.g. `MNQ_60m_range-high_1712001600`). Re-drawing the same id **updates in
  place**; `clear_zones {ids: [...]}` removes exactly those.
- **Refresh = clear then redraw** with the same ids — commands apply in order,
  so the new set cleanly replaces the old.
- **Drawings persist**: the AddOn retains draw commands per symbol and replays
  them when a chart reloads or switches data series — no need to redraw on the
  user's timeframe changes.

## Styling conventions (edit these!)

| What | Shape | Suggested style |
|---|---|---|
| Support / buy-side level or area | rectangle or hline | green, opacity ~0.2 |
| Resistance / sell-side level or area | rectangle or hline | red, opacity ~0.2 |
| Target / objective | rectangle | blue, opacity ~0.15 |
| Caution / obstacle | hline | amber, opacity ~0.2 |
| Notes | text | short label, anchored at the relevant bar |

The renderer has sensible direction-based defaults when color is omitted, but
set colors explicitly so your charts stay consistent.

## Timezone and anchoring

- Interpret natural-language dates as **America/New_York** calendar dates.
- Anchor a shape's left edge (`fromTs`, unix seconds) at the bar it derives
  from; omit `toTs` to extend it to the current bar.

## Don'ts

- Don't guess the symbol — confirm which chart the user is on.
- Don't claim success when the tool result carries a "no chart attached"
  warning — report it.
- Don't over-annotate: draw what was asked for, keep the chart readable.
