/**
 * Copy-paste configs for MCP clients that accept a bearer key in a header. Used with a real key in
 * the Connect sheet and with a placeholder on the public docs page, so the two never drift.
 */
export type Snippet = { id: string; label: string; where: string; code: string };

export function mcpSnippets(url: string, key: string, name = "nudge"): Snippet[] {
  const bearer = `Bearer ${key}`;
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      where: "Run in a terminal",
      code: `claude mcp add --transport http ${name} ${url} --header "Authorization: ${bearer}"`,
    },
    {
      id: "cursor",
      label: "Cursor",
      where: "~/.cursor/mcp.json (or .cursor/mcp.json in a project)",
      code: JSON.stringify({ mcpServers: { [name]: { url, headers: { Authorization: bearer } } } }, null, 2),
    },
    {
      id: "hermes",
      label: "Hermes",
      where: "~/.hermes/config.yaml",
      code: `mcp_servers:\n  ${name}:\n    url: "${url}"\n    headers:\n      Authorization: "${bearer}"`,
    },
    {
      id: "openclaw",
      label: "OpenClaw",
      where: "~/.openclaw/openclaw.json",
      code: JSON.stringify({ mcp: { servers: { [name]: { url, transport: "streamable-http", headers: { Authorization: bearer } } } } }, null, 2),
    },
    {
      // Assistants that run tools in their own sandbox (Instinct, Poke and the like) don't need MCP
      // client support: they POST JSON-RPC with the key from their secret store (#131).
      id: "instinct",
      label: "Instinct, Poke and other sandboxed assistants",
      where: "Paste the setup text; put the key in the assistant's vault/secrets as NUDGE_KEY (never in the chat). It then calls Nudge over plain HTTPS:",
      code: `POST ${url}\nAuthorization: Bearer $NUDGE_KEY\nContent-Type: application/json\n\n{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_my_limits","arguments":{}}}`,
    },
    {
      id: "json",
      label: "Other MCP clients",
      where: "Any client that takes a remote (streamable HTTP) server with headers",
      code: JSON.stringify({ mcpServers: { [name]: { type: "http", url, headers: { Authorization: bearer } } } }, null, 2),
    },
    {
      id: "curl",
      label: "curl (JSON-RPC)",
      where: "No client needed: list the tools this key can use",
      code: `curl -s ${url} \\\n  -H "Authorization: ${bearer}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    },
  ];
}

/** Clients that only connect through OAuth: not one-click until MCP OAuth ships (issue #14). */
export const OAUTH_ONLY_CLIENTS = ["ChatGPT", "claude.ai", "Claude Desktop"] as const;
