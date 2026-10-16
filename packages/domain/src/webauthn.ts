import { bytesToHex, hexToBytes, type Hex } from "viem";

/** P-256 group order and half order. The contract only accepts the low-s form. */
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

export type WebAuthnAuth = {
  r: Hex;
  s: Hex;
  challengeIndex: bigint;
  typeIndex: bigint;
  authenticatorData: Hex;
  clientDataJSON: string;
};

export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function pad32(b: Uint8Array): Uint8Array {
  const trimmed = b[0] === 0 && b.length > 32 ? b.slice(b.length - 32) : b;
  const out = new Uint8Array(32);
  out.set(trimmed, 32 - trimmed.length);
  return out;
}

/** ASN.1 DER `SEQUENCE { INTEGER r, INTEGER s }` from a WebAuthn assertion. */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  let i = 0;
  if (der[i++] !== 0x30) throw new Error("Bad signature");
  let len = der[i++]!;
  if (len & 0x80) i += len & 0x7f;
  const int = () => {
    if (der[i++] !== 0x02) throw new Error("Bad signature");
    len = der[i++]!;
    const v = der.slice(i, i + len);
    i += len;
    return BigInt(bytesToHex(pad32(v)));
  };
  const r = int();
  const s = int();
  return { r, s };
}

/** Raw uncompressed P-256 key (x, y) from the SPKI that `response.getPublicKey()` returns. */
export function spkiToXY(spki: Uint8Array): { x: Hex; y: Hex } {
  const point = spki.slice(spki.length - 65);
  if (point[0] !== 0x04) throw new Error("Expected an uncompressed P-256 key");
  return { x: bytesToHex(point.slice(1, 33)), y: bytesToHex(point.slice(33, 65)) };
}

/** Turn a browser assertion into the struct PolicyVault.execute expects. */
export function toWebAuthnAuth(input: { authenticatorData: Uint8Array; clientDataJSON: Uint8Array; signature: Uint8Array }): WebAuthnAuth {
  const json = new TextDecoder().decode(input.clientDataJSON);
  const challengeIndex = json.indexOf('"challenge":"');
  const typeIndex = json.indexOf('"type":"');
  if (challengeIndex < 0 || typeIndex < 0) throw new Error("Unexpected client data");
  let { r, s } = parseDerSignature(input.signature);
  if (s > N / 2n) s = N - s;
  return {
    r: `0x${r.toString(16).padStart(64, "0")}`,
    s: `0x${s.toString(16).padStart(64, "0")}`,
    challengeIndex: BigInt(challengeIndex),
    typeIndex: BigInt(typeIndex),
    authenticatorData: bytesToHex(input.authenticatorData),
    clientDataJSON: json,
  };
}

export { hexToBytes };

/**
 * Check a passkey assertion the way PolicyVault.execute will, before the server accepts it:
 * the right ceremony, our challenge, the key's site, user presence and verification, a low-s
 * P-256 signature by this key. Returns why it fails, or null when it is valid. Uses WebCrypto,
 * so it runs in browsers, Node and the Convex runtime alike.
 */
export async function assertionProblem(input: {
  auth: { r: string; s: string; authenticatorData: string; clientDataJSON: string };
  key: { x: Hex; y: Hex; rpId: string };
  challenge: Hex;
}): Promise<string | null> {
  const { auth, key, challenge } = input;
  let client: { type?: string; challenge?: string };
  try {
    client = JSON.parse(auth.clientDataJSON);
  } catch {
    return "client data is not JSON";
  }
  if (client.type !== "webauthn.get") return "not an approval signature";
  if (client.challenge !== base64url(hexToBytes(challenge))) return "signed a different request";
  let authData: Uint8Array;
  try {
    authData = hexToBytes(auth.authenticatorData as Hex);
  } catch {
    return "authenticator data is not hex";
  }
  if (authData.length < 37) return "authenticator data too short";
  const rpIdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key.rpId)));
  if (!rpIdHash.every((b, i) => b === authData[i])) return "passkey made for a different site";
  const flags = authData[32]!;
  if (!(flags & 0x01) || !(flags & 0x04)) return "user verification missing";
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(auth.r) || !/^0x[0-9a-fA-F]{1,64}$/.test(auth.s)) return "malformed signature";
  const r = BigInt(auth.r);
  const s = BigInt(auth.s);
  if (r === 0n || s === 0n || r >= N || s > N / 2n) return "malformed signature";
  const pad = (n: bigint) => hexToBytes(`0x${n.toString(16).padStart(64, "0")}`);
  const signature = new Uint8Array([...pad(r), ...pad(s)]);
  const clientHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(auth.clientDataJSON)));
  const message = new Uint8Array([...authData, ...clientHash]);
  try {
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: base64url(hexToBytes(key.x)), y: base64url(hexToBytes(key.y)), ext: true },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature, message);
    return ok ? null : "signature does not match this passkey";
  } catch {
    return "signature does not match this passkey";
  }
}
