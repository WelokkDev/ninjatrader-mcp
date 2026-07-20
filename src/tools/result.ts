// The result shape every tool handler returns: a single text content item,
// JSON-encoded when the payload is structured. Structurally assignable to the
// MCP SDK's CallToolResult, but kept narrow so callers and tests can read
// content[0].text without narrowing a content union.
export type ToolResult = { content: Array<{ type: "text"; text: string }> };

// A human-readable message (errors, guidance, notices).
export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

// A structured payload, JSON-encoded.
export function jsonResult(payload: unknown): ToolResult {
  return textResult(JSON.stringify(payload));
}
