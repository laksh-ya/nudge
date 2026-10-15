import { base64url, fromBase64url, spkiToXY, toWebAuthnAuth, type WebAuthnAuth } from "@agent-wallet/domain";
import { hexToBytes, type Hex } from "viem";

/** The passkey belongs to this site only. Other sites, including the dashboard, can't use it. */
export const RP_ID = window.location.hostname;

export function passkeysSupported() {
  return typeof window.PublicKeyCredential !== "undefined" && typeof navigator.credentials?.create === "function";
}

/** Telegram and some chat apps open links in a web view where passkeys don't work. */
export function inAppBrowser(): string | null {
  const ua = navigator.userAgent;
  if (/Telegram/i.test(ua) || (window as unknown as { TelegramWebviewProxy?: unknown }).TelegramWebviewProxy) return "Telegram";
  if (/FBAN|FBAV|Instagram/i.test(ua)) return "this app";
  if (/WhatsApp/i.test(ua)) return "WhatsApp";
  return null;
}

export async function createPasskey(opts: { userHandle: string; name: string }) {
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { id: RP_ID, name: "Agent Wallet payments" },
      user: { id: new TextEncoder().encode(opts.userHandle), name: `${opts.name || "you"} · payments`, displayName: opts.name || "Agent Wallet" },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      attestation: "none",
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was created");
  const response = cred.response as AuthenticatorAttestationResponse;
  const spki = response.getPublicKey?.();
  if (!spki) throw new Error("This browser can't share the passkey's public key. Try Safari or Chrome.");
  if (response.getPublicKeyAlgorithm?.() !== -7) throw new Error("This passkey doesn't use P-256");
  const { x, y } = spkiToXY(new Uint8Array(spki));
  return { credentialId: base64url(new Uint8Array(cred.rawId)), x, y, rpId: RP_ID };
}

/** Sign a 32-byte challenge the page computed itself from the action it shows. */
export async function signWithPasskey(challenge: Hex, credentialId: string | null, rpId: string | null): Promise<WebAuthnAuth> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: new Uint8Array(hexToBytes(challenge)).buffer,
      rpId: rpId ?? RP_ID,
      allowCredentials: credentialId ? [{ type: "public-key", id: new Uint8Array(fromBase64url(credentialId)).buffer }] : undefined,
      userVerification: "required",
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("Approval was cancelled");
  const r = cred.response as AuthenticatorAssertionResponse;
  return toWebAuthnAuth({
    authenticatorData: new Uint8Array(r.authenticatorData),
    clientDataJSON: new Uint8Array(r.clientDataJSON),
    signature: new Uint8Array(r.signature),
  });
}
