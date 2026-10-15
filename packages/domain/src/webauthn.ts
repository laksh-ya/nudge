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
