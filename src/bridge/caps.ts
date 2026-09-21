// Deploy skew: an old AddOn ignores ops it doesn't know, so fail fast instead of
// waiting out the timeout.

/** An AddOn that predates `caps` supported exactly one write op. */
export const PRE_CAPS_ADDON_CAPS: readonly string[] = ["place_order"];

/** null when supported, else the message; `caps` is null when disconnected or
 *  pre-caps. */
export function capsError(op: string, caps: string[] | null): string | null {
  const supported = caps ?? PRE_CAPS_ADDON_CAPS;
  if (supported.includes(op)) return null;
  return (
    `the connected AddOn does not support ${op} — recompile ` +
    `ninja-addon/addons/mcp-bridge.cs in the NinjaScript Editor (F5) and reconnect`
  );
}
