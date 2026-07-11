/** Warning when no chart with McpBridgeRenderer is attached for `symbol`
 *  (undefined when one is). Advisory, not a failure: the draw is dispatched
 *  regardless — the AddOn retains it and replays when a matching chart opens,
 *  for as long as NinjaTrader keeps running. */
export function drawTargetWarning(
  symbol: string,
  knownInstruments: readonly string[],
): string | undefined {
  if (knownInstruments.includes(symbol)) return undefined;
  const list = knownInstruments.length ? knownInstruments.join(", ") : "none";
  return (
    `No chart with symbol "${symbol}" has McpBridgeRenderer attached, so nothing renders yet. ` +
    `It is stored and will draw automatically when you open a ${symbol} chart with the renderer ` +
    `(while NinjaTrader stays running). Charts currently attached: [${list}].`
  );
}
