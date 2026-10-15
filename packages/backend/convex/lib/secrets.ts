/**
 * Agent signing keys are stored encrypted (AES-256-GCM) under AGENT_KEY_SECRET, which lives only in
 * the deployment's environment. A database export or a leaked backup alone yields no usable key.
 * The contract's limits still bound what any one key can move.
 */

const PREFIX = "enc:v1:";

function b64(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function key() {
  const secret = process.env.AGENT_KEY_SECRET;
  if (!secret) throw new Error("AGENT_KEY_SECRET is not set");
  const raw = unb64(secret);
  if (raw.length !== 32) throw new Error("AGENT_KEY_SECRET must be 32 bytes, base64");
  return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(plain: string, context: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) }, await key(), new TextEncoder().encode(plain)),
  );
  return `${PREFIX}${b64(iv)}:${b64(ct)}`;
}

/** `context` (the agent id) is bound in, so a sealed key copied onto another agent won't open. */
export async function open(sealed: string, context: string): Promise<string> {
  if (!sealed.startsWith(PREFIX)) return sealed; // written before encryption; migrations.sealAgentKeys fixes these
  const [iv, ct] = sealed.slice(PREFIX.length).split(":");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(iv!), additionalData: new TextEncoder().encode(context) },
    await key(),
    unb64(ct!),
  );
  return new TextDecoder().decode(plain);
}

export const isSealed = (s: string) => s.startsWith(PREFIX);
