/**
 * Short-lived ES256 tokens for demo sandboxes, checked by Convex (packages/backend/convex/auth.config.ts).
 * The private key is DEMO_JWT_PRIVATE_KEY (a JWK); the matching public key is the deployment's DEMO_JWKS.
 */
export const DEMO_ISSUER = "https://demo.agent-wallet.app";
export const SANDBOX_COOKIE = "aw_demo";
export const JUDGE_COOKIE = "aw_judge";

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

let key: Promise<CryptoKey> | null = null;
function signingKey() {
  key ??= (async () => {
    const raw = process.env.DEMO_JWT_PRIVATE_KEY;
    if (!raw) throw new Error("DEMO_JWT_PRIVATE_KEY is not set");
    const jwk = JSON.parse(raw) as JsonWebKey & { kid?: string };
    return await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  })();
  return key;
}

export async function demoToken(sub: string) {
  const kid = (JSON.parse(process.env.DEMO_JWT_PRIVATE_KEY ?? "{}") as { kid?: string }).kid ?? "demo-1";
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "ES256", typ: "JWT", kid })));
  const body = b64url(new TextEncoder().encode(JSON.stringify({ iss: DEMO_ISSUER, aud: "agent-wallet-demo", sub, iat: now, exp: now + 3600, name: "Aarav" })));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await signingKey(), new TextEncoder().encode(`${header}.${body}`)));
  return `${header}.${body}.${b64url(signature)}`;
}

export function sameSecret(a: string | undefined, b: string | undefined) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
