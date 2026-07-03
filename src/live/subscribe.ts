import { getInstrumentConfig } from "../core/sessions/registry.js";
import { send as defaultSend } from "../bridge/index.js";
import type {
  OutboundMessage,
  SubscribeBarsMessage,
  UnsubscribeBarsMessage,
} from "../bridge/protocol.js";

export interface SubscribeDeps {
  send: (message: OutboundMessage) => boolean;
}

const defaultDeps: SubscribeDeps = { send: defaultSend };

export function subscribeBars(
  symbol: string,
  timeframe: string,
  deps: SubscribeDeps = defaultDeps,
): boolean {
  const config = getInstrumentConfig(symbol); // throws on unknown symbol
  const message: SubscribeBarsMessage = {
    v: 1,
    type: "subscribe_bars",
    symbol,
    timeframe,
    tradingHoursTemplate: config.session.name,
  };
  return deps.send(message);
}

export function unsubscribeBars(
  symbol: string,
  timeframe: string,
  deps: SubscribeDeps = defaultDeps,
): boolean {
  const message: UnsubscribeBarsMessage = {
    v: 1,
    type: "unsubscribe_bars",
    symbol,
    timeframe,
  };
  return deps.send(message);
}
