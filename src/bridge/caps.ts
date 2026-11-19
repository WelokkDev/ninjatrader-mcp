// Deploy skew: an old AddOn ignores ops it doesn't know, so fail fast instead of
// waiting out the timeout.

/** An AddOn that predates `caps` supported exactly one write op. */
export const PRE_CAPS_ADDON_CAPS: readonly string[] = ["place_order"];

/** Hello `caps`: undefined until the hello arrives, null when disconnected or pre-caps. */
export type AddonCaps = string[] | null | undefined;

export function capsError(op: string, caps: AddonCaps): string | null {
  if (caps === undefined) {
    return `the AddOn has connected but not sent its hello yet — call ${op} again in a moment`;
  }
  const supported = caps ?? PRE_CAPS_ADDON_CAPS;
  if (supported.includes(op)) return null;
  return (
    `the connected AddOn does not support ${op} — recompile: copy every ` +
    `ninja-addon/addons/mcp-bridge*.cs into NT8 and press F5 in the NinjaScript Editor`
  );
}
