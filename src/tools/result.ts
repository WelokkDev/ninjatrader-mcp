// The result shape every tool handler returns: a single text content item,
// JSON-encoded when the payload is structured. Structurally assignable to the
// MCP SDK's CallToolResult, but kept narrow so callers and tests can read
// content[0].text without narrowing a content union.
//
// Convention: jsonResult for success (a `warning` key marks partial success),
// errorResult for failure — so every result's text is valid JSON and isError
// is the failure signal.
export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
};

// A human-readable message (guidance, notices).
export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

// A structured payload, JSON-encoded.
export function jsonResult(payload: unknown): ToolResult {
  return textResult(JSON.stringify(payload));
}

// A failure: JSON `{ ...extra, error }` with the MCP isError flag set.
export function errorResult(
  error: string,
  extra?: Record<string, unknown>,
): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ ...extra, error }) }],
    isError: true,
  };
}
