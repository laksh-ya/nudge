import { agentGuide } from "@agent-wallet/backend/guide";
import { MCP_URL } from "@/lib/config";

/** llms.txt: the same agent guide, where models look for it. */
export function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const mcp = process.env.NEXT_PUBLIC_CONVEX_SITE_URL ? MCP_URL : undefined;
  return new Response(agentGuide(mcp, origin), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });
}
