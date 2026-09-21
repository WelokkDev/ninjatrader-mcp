/** The selector both indicator tools take: exactly one of `id` or `match`. */
export interface IndicatorSelectorArgs {
  symbol: string;
  timeframe?: string;
  id?: number;
  match?: { name: string; params?: Record<string, string | number | boolean> };
}

/** null when usable, else the error message. */
export function indicatorSelectorError(tool: string, args: IndicatorSelectorArgs): string | null {
  const hasId = args.id !== undefined;
  if (hasId !== (args.match !== undefined)) return null;
  return hasId
    ? `${tool} takes either id or match, not both — pass id when you have it (list_chart_indicators gives one).`
    : `${tool} needs an indicator selector: id (from list_chart_indicators) or match:{name, params}.`;
}

/** `indicatorId`, not `id`: a payload `id` would clobber the envelope's
 *  correlation uuid. */
export function indicatorSelectorPayload(args: IndicatorSelectorArgs): Record<string, unknown> {
  const payload: Record<string, unknown> = { symbol: args.symbol };
  if (args.timeframe !== undefined) payload.timeframe = args.timeframe;
  if (args.id !== undefined) payload.indicatorId = args.id;
  if (args.match !== undefined) payload.match = args.match;
  return payload;
}
