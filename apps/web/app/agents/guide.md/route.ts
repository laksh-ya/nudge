import { agentGuide } from "@agent-wallet/backend/guide";
import { MCP_URL } from "@/lib/config";

/** The guide for agents (not people), as Markdown: what to read after connecting to Nudge over MCP. */
export function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const mcp = process.env.NEXT_PUBLIC_CONVEX_SITE_URL ? MCP_URL : undefined;
  return new Response(agentGuide(mcp, origin), { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=300" } });
}
