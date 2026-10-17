/**
 * MCP OAuth 2.1 helpers (issue #14). Everything here is off unless the deployment sets
 * MCP_OAUTH=on; with it off the gateway takes bearer keys from the Agents screen only.
 */

export function oauthEnabled() {
  return process.env.MCP_OAUTH === "on";
}

/** Where the owner signs in and consents: the dashboard, never the agent's own page. */
export function webUrl() {
  return (process.env.WEB_URL ?? "https://agent-wallet-nu.vercel.app").replace(/\/+$/, "");
}

export const CODE_TTL_MS = 5 * 60_000;

/**
 * A redirect URI a client may register: https anywhere, or http on the loopback interface (native
 * clients such as Claude Code). No fragments, no credentials in the URL.
 */
export function validRedirectUri(raw: string) {
  if (raw.length > 500) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]");
}

/** RFC 7636 S256: base64url(sha256(verifier)) without padding. */
export async function s256(verifier: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7636: 43 to 128 characters from the unreserved set. */
export const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
export const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

export function randomId(bytes = 24) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Scopes a client may ask for, as space-separated OAuth scope strings. */
export const OAUTH_SCOPES = ["read", "prepare", "spend", "request"] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

export function parseScope(raw: string | null | undefined): OAuthScope[] {
  const asked = (raw ?? "").split(/\s+/).filter((s): s is OAuthScope => (OAUTH_SCOPES as readonly string[]).includes(s));
  return [...new Set<OAuthScope>(["read", ...asked])];
}

/** A client-chosen name is shown to the owner; keep it short and plain. */
export function cleanClientName(raw: unknown) {
  const name = String(raw ?? "").replace(/[^\p{L}\p{N} ._-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 30);
  return name || "MCP client";
}
