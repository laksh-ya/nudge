export const APP_NAME = "agent wallet";
export const APPROVE_URL = process.env.NEXT_PUBLIC_APPROVE_URL ?? "http://localhost:3001";

export function approvalLink(token: string) {
  return `${APPROVE_URL}/a/${token}`;
}

export const MCP_URL = `${process.env.NEXT_PUBLIC_CONVEX_SITE_URL ?? ""}/mcp`;
