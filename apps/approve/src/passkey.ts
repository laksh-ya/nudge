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

/** A short, human label for the device, shown back to the owner when they confirm it in the app. */
export function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Device";
  const browser = /EdgA?\//.test(ua) ? "Edge" : /Firefox|FxiOS/.test(ua) ? "Firefox" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${os} · ${browser}`;
}

const toHex = (b: ArrayBuffer) => `0x${Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("")}`;

export async function createPasskey(opts: { userHandle: string; name: string; challenge: string; backup?: boolean }) {
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { id: RP_ID, name: "Nudge payments" },
      user: { id: new TextEncoder().encode(opts.userHandle), name: `${opts.name || "you"} · payments${opts.backup ? " (backup)" : ""}`, displayName: opts.name || "Nudge" },
      // The server's challenge, so the registration it receives is provably from this ceremony.
      challenge: new Uint8Array(fromBase64url(opts.challenge)).buffer,
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      attestation: "none",
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was created");
  const response = cred.response as AuthenticatorAttestationResponse;
  const spki = response.getPublicKey?.();
  const authData = response.getAuthenticatorData?.();
  if (!spki || !authData) throw new Error("This browser can't share the passkey's public key. Try Safari or Chrome.");
  if (response.getPublicKeyAlgorithm?.() !== -7) throw new Error("This passkey doesn't use P-256");
  const { x, y } = spkiToXY(new Uint8Array(spki));
  return {
    credentialId: base64url(new Uint8Array(cred.rawId)),
    x,
    y,
    rpId: RP_ID,
    clientDataJSON: new TextDecoder().decode(response.clientDataJSON),
    authenticatorData: toHex(authData),
    device: deviceLabel(),
  };
}

/** Sign a 32-byte challenge the page computed itself from the action it shows. Any of the owner's passkeys may sign. */
export async function signWithPasskey(challenge: Hex, credentialIds: string[], rpId: string | null): Promise<{ auth: WebAuthnAuth; credentialId: string }> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: new Uint8Array(hexToBytes(challenge)).buffer,
      rpId: rpId ?? RP_ID,
      allowCredentials: credentialIds.length ? credentialIds.map((id) => ({ type: "public-key" as const, id: new Uint8Array(fromBase64url(id)).buffer })) : undefined,
      userVerification: "required",
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("Approval was cancelled");
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    credentialId: base64url(new Uint8Array(cred.rawId)),
    auth: toWebAuthnAuth({
      authenticatorData: new Uint8Array(r.authenticatorData),
      clientDataJSON: new Uint8Array(r.clientDataJSON),
      signature: new Uint8Array(r.signature),
    }),
  };
}
