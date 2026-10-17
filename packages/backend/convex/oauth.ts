import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireViewer, viewer } from "./lib/auth";
import { changeLimits } from "./lib/control";
import { sha256 } from "./lib/hash";
import { tryHit } from "./lib/limits";
import { CHALLENGE_RE, CODE_TTL_MS, VERIFIER_RE, cleanClientName, oauthEnabled, randomId, s256, validRedirectUri } from "./lib/oauth";
import { randomToken } from "./gateway";

/**
 * MCP OAuth 2.1 (issue #14) for connectors that can't send a custom header (claude.ai, Claude
 * Desktop, ChatGPT). Off unless MCP_OAUTH=on. The owner consents on the dashboard, choosing
 * permissions, limits and how long access lasts; the access token is an ordinary per-assistant key,
 * so the gateway, the limits and the vault treat it exactly like a key from the Agents screen.
 */

const DAY = 86_400_000;
const MAX_ASSISTANTS = 12;

function requireOn() {
  if (!oauthEnabled()) throw new Error("Connecting with OAuth isn't available yet. Use an access key from the Agents screen.");
}

async function client(ctx: QueryCtx, clientId: string) {
  return await ctx.db.query("oauthClients").withIndex("by_client_id", (q) => q.eq("clientId", clientId)).unique();
}

/** RFC 7591 dynamic registration: a public client with exact redirect URIs. */
export const register = internalMutation({
  args: { name: v.string(), redirectUris: v.array(v.string()) },
  handler: async (ctx, { name, redirectUris }): Promise<{ clientId: string; name: string; redirectUris: string[] } | { error: string; description: string }> => {
    requireOn();
    if (redirectUris.length === 0 || redirectUris.length > 5 || !redirectUris.every(validRedirectUri)) {
      return { error: "invalid_redirect_uri", description: "Register 1 to 5 redirect URIs: https, or http on localhost." };
    }
    // Registration is open by design (MCP clients self-register); a global cap stops it filling the table.
    if (!(await tryHit(ctx, "oauth:register", 200, 3600_000))) return { error: "temporarily_unavailable", description: "Too many registrations. Try again later." };
    const clientId = `awc_${randomId(18)}`;
    const clean = cleanClientName(name);
    await ctx.db.insert("oauthClients", { clientId, name: clean, redirectUris, createdAt: Date.now() });
    return { clientId, name: clean, redirectUris };
  },
});

/** The authorize endpoint checks the client and redirect URI before sending the owner anywhere. */
export const checkClient = internalQuery({
  args: { clientId: v.string(), redirectUri: v.string() },
  handler: async (ctx, { clientId, redirectUri }) => {
    const c = await client(ctx, clientId);
    return Boolean(c && c.redirectUris.includes(redirectUri));
  },
});

/** What the consent page shows: who is asking and where the owner returns to. */
export const consentInfo = query({
  args: { clientId: v.string(), redirectUri: v.string() },
  handler: async (ctx, { clientId, redirectUri }) => {
    if (!oauthEnabled()) return { enabled: false as const };
    if (!(await viewer(ctx))) return null;
    const c = await client(ctx, clientId);
    if (!c || !c.redirectUris.includes(redirectUri)) return { enabled: true as const, valid: false as const };
    return { enabled: true as const, valid: true as const, name: c.name, returnsTo: new URL(redirectUri).host };
  },
});

function providerFor(name: string) {
  if (/chatgpt|openai/i.test(name)) return "chatgpt" as const;
  if (/claude/i.test(name)) return "claude" as const;
  return "other" as const;
}

async function uniqueName(ctx: MutationCtx, userId: Id<"users">, base: string) {
  const agents = await ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", userId)).take(50);
  const taken = new Set(agents.filter((a) => a.status !== "revoked").map((a) => a.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return { name: base, live: agents.filter((a) => a.status !== "revoked" && a.provider !== "own").length };
  for (let i = 2; i < 20; i++) {
    const name = `${base.slice(0, 26)} ${i}`;
    if (!taken.has(name.toLowerCase())) return { name, live: agents.filter((a) => a.status !== "revoked" && a.provider !== "own").length };
  }
  throw new Error("Too many assistants with this name. Disconnect one first.");
}

/**
 * The owner approves on the consent page. A new assistant is created with exactly the permissions,
 * limits and expiry chosen here (never an existing one's key replaced), and a one-use code goes back
 * to the client's registered redirect URI.
 */
export const approve = mutation({
  args: {
    clientId: v.string(),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    codeChallengeMethod: v.string(),
    state: v.optional(v.string()),
    scopes: v.array(v.union(v.literal("read"), v.literal("prepare"), v.literal("spend"), v.literal("request"))),
    perPaymentMinor: v.number(),
    dailyCapMinor: v.number(),
    hidesBalances: v.boolean(),
    days: v.number(),
  },
  handler: async (ctx, args) => {
    requireOn();
    const user = await requireViewer(ctx);
    const c = await client(ctx, args.clientId);
    if (!c || !c.redirectUris.includes(args.redirectUri)) throw new Error("This connection request isn't valid. Start again from the assistant.");
    if (args.codeChallengeMethod !== "S256" || !CHALLENGE_RE.test(args.codeChallenge)) throw new Error("This connection request isn't valid. Start again from the assistant.");
    if (args.state !== undefined && args.state.length > 500) throw new Error("This connection request isn't valid. Start again from the assistant.");
    for (const n of [args.dailyCapMinor, args.perPaymentMinor]) if (!Number.isSafeInteger(n) || n < 0 || n > 1e9) throw new Error("Limit is out of range");
    if (args.perPaymentMinor > args.dailyCapMinor) throw new Error("A single payment can't exceed the daily limit");
    if (!Number.isInteger(args.days) || args.days < 1 || args.days > 365) throw new Error("Pick 1 to 365 days");
    const scopes = [...new Set(args.scopes)];
    if (!scopes.includes("read")) scopes.unshift("read");

    const { name, live } = await uniqueName(ctx, user._id, c.name);
    if (live >= MAX_ASSISTANTS) throw new Error(`Up to ${MAX_ASSISTANTS} assistants. Disconnect one first.`);
    const expiresAt = Date.now() + args.days * DAY;
    const agentId = await ctx.db.insert("agents", {
      userId: user._id,
      name,
      provider: providerFor(c.name),
      status: "active",
      scopes: ["read"],
      dailyCapMinor: 0,
      perPaymentMinor: 0,
      spentTodayMinor: 0,
      hidesBalances: args.hidesBalances,
      connectedAt: Date.now(),
      expiresAt,
    });
    const agent = (await ctx.db.get(agentId))!;
    // The same path as the Limits sheet: on a live vault, spending waits for the owner's passkey.
    await changeLimits(ctx, user, agent, { scopes, perPaymentMinor: args.perPaymentMinor, dailyCapMinor: args.dailyCapMinor, expiresAt });

    const code = randomId(32);
    await ctx.db.insert("oauthCodes", {
      codeHash: await sha256(code),
      clientId: c.clientId,
      userId: user._id,
      agentId,
      redirectUri: args.redirectUri,
      codeChallenge: args.codeChallenge,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    await ctx.db.insert("activity", {
      userId: user._id,
      kind: "agent",
      title: `Connected ${name}`,
      detail: `Through ${new URL(args.redirectUri).host}. ${scopes.includes("spend") ? `Up to $${(args.dailyCapMinor / 100).toFixed(2)} a day` : "Can't spend"}`,
      tone: "neutral",
    });
    const back = new URL(args.redirectUri);
    back.searchParams.set("code", code);
    if (args.state !== undefined) back.searchParams.set("state", args.state);
    // RFC 9207: the client can check the code came from this server.
    if (process.env.CONVEX_SITE_URL) back.searchParams.set("iss", process.env.CONVEX_SITE_URL);
    return back.toString();
  },
});

type TokenResult = { token: string; expiresIn: number; scope: string } | { error: "invalid_grant" | "invalid_request"; description: string };

/** Code + PKCE verifier → an access key for the assistant created at consent. One use, five minutes. */
export const exchange = internalMutation({
  args: { code: v.string(), clientId: v.string(), redirectUri: v.string(), codeVerifier: v.string() },
  handler: async (ctx, args): Promise<TokenResult> => {
    requireOn();
    if (!VERIFIER_RE.test(args.codeVerifier)) return { error: "invalid_request", description: "code_verifier must be 43 to 128 characters" };
    const codeHash = await sha256(args.code);
    const grant = await ctx.db.query("oauthCodes").withIndex("by_code_hash", (q) => q.eq("codeHash", codeHash)).unique();
    if (!grant) return { error: "invalid_grant", description: "Unknown or already used code" };
    // One use, whatever happens next: a replayed or stolen code never works twice.
    await ctx.db.delete(grant._id);
    if (grant.expiresAt < Date.now()) return { error: "invalid_grant", description: "The code expired. Connect again." };
    if (grant.clientId !== args.clientId || grant.redirectUri !== args.redirectUri) return { error: "invalid_grant", description: "The code was issued to another client or redirect URI" };
    if ((await s256(args.codeVerifier)) !== grant.codeChallenge) return { error: "invalid_grant", description: "code_verifier doesn't match the code_challenge" };
    const agent = await ctx.db.get(grant.agentId);
    if (!agent || agent.userId !== grant.userId || agent.status === "revoked" || agent.expiresAt < Date.now()) {
      return { error: "invalid_grant", description: "The owner disconnected this assistant. Connect again." };
    }
    const token = randomToken();
    await ctx.db.patch(agent._id, { tokenHash: await sha256(token), connectedAt: Date.now() });
    return { token, expiresIn: Math.max(1, Math.floor((agent.expiresAt - Date.now()) / 1000)), scope: agent.scopes.join(" ") };
  },
});
