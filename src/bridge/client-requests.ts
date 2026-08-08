import { onMessage as defaultOnMessage, send as defaultSend } from "./index.js";
import type { ClientRequestMessage, InboundMessage, OutboundMessage } from "./protocol.js";

// Dispatch for `client_request` — the inbound seam where a companion
// NinjaScript (typically a private indicator) asks the server to do work,
// rather than answering a request the server made.
//
// This module is the whole public surface of that seam, and it is
// deliberately empty of meaning: it routes an opaque `kind` to whichever
// handler claimed it and ships the result back correlated by the id NT8
// minted. Public code registers NO kinds — a private bin registers its own
// after startRuntime(). A stock public build therefore answers every
// client_request with ok:false, which is the correct answer when the
// handler genuinely isn't there.
//
// Handlers are fire-and-forget from the socket's point of view: dispatch
// never awaits before returning, so one slow scan cannot stall the reader
// thread or delay bar_close ingest behind it.

export type ClientRequestHandler = (
  payload: Record<string, unknown>,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

const handlers = new Map<string, ClientRequestHandler>();

/**
 * Claim a `kind`. Registering an already-claimed kind replaces it — a private
 * bin overriding its own handler on re-registration is the intended use, and
 * throwing here would make a benign double-boot fatal.
 */
export function registerClientRequestHandler(
  kind: string,
  handler: ClientRequestHandler,
): void {
  handlers.set(kind, handler);
}

/** Registered kinds, for diagnostics and tests. */
export function listClientRequestKinds(): string[] {
  return [...handlers.keys()];
}

/** Test seam — production never unregisters. */
export function resetClientRequestHandlers(): void {
  handlers.clear();
}

export interface ClientRequestDispatchDeps {
  onMessage: <T extends InboundMessage["type"]>(
    type: T,
    handler: (message: Extract<InboundMessage, { type: T }>) => void,
  ) => void;
  send: (message: OutboundMessage) => boolean;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Wire the seam onto the bridge connection. Call once, at runtime start. */
export function startClientRequestDispatch(
  deps: ClientRequestDispatchDeps = { onMessage: defaultOnMessage, send: defaultSend },
): void {
  deps.onMessage("client_request", (msg: ClientRequestMessage) => {
    const { id, kind, payload } = msg;

    const reply = (
      fields: { ok: true; payload: Record<string, unknown> } | { ok: false; error: string },
    ): void => {
      deps.send({ v: 1, id, type: "client_response", kind, ...fields });
    };

    const handler = handlers.get(kind);
    if (!handler) {
      const known = listClientRequestKinds();
      reply({
        ok: false,
        error:
          `no handler registered for client_request kind '${kind}'` +
          (known.length > 0 ? ` (registered: ${known.join(", ")})` : " (none registered)"),
      });
      return;
    }

    // Promise.resolve wraps both a sync throw and a rejected promise into one
    // rejection path, so a handler that throws before its first await still
    // answers instead of leaving NT8 waiting out its timeout.
    void Promise.resolve()
      .then(() => handler(payload))
      .then((result) => reply({ ok: true, payload: result ?? {} }))
      .catch((err: unknown) => reply({ ok: false, error: errorText(err) }));
  });
}
