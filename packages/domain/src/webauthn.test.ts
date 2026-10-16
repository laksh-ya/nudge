import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha2";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { assertionProblem, base64url, toWebAuthnAuth } from "./webauthn";

const RP = "agent-wallet-approve.vercel.app";
const priv = p256.utils.randomPrivateKey();
const pub = p256.getPublicKey(priv, false);
const key = { x: `0x${Buffer.from(pub.slice(1, 33)).toString("hex")}` as Hex, y: `0x${Buffer.from(pub.slice(33)).toString("hex")}` as Hex, rpId: RP };
const challenge = `0x${"5a".repeat(32)}` as Hex;

function sign(opts: { challenge?: Hex; rp?: string; flags?: number; type?: string; with?: Uint8Array } = {}) {
  const authenticatorData = new Uint8Array([...sha256(new TextEncoder().encode(opts.rp ?? RP)), opts.flags ?? 0x05, 0, 0, 0, 1]);
  const clientDataJSON = new TextEncoder().encode(
    JSON.stringify({ type: opts.type ?? "webauthn.get", challenge: base64url(Buffer.from((opts.challenge ?? challenge).slice(2), "hex")), origin: `https://${RP}` }),
  );
  const msg = sha256(new Uint8Array([...authenticatorData, ...sha256(clientDataJSON)]));
  const a = toWebAuthnAuth({ authenticatorData, clientDataJSON, signature: p256.sign(msg, opts.with ?? priv, { prehash: false }).toDERRawBytes() });
  return { r: a.r, s: a.s, authenticatorData: a.authenticatorData, clientDataJSON: a.clientDataJSON };
}

describe("assertion check before relaying", () => {
  it("accepts a real assertion over the request's digest", async () => {
    expect(await assertionProblem({ auth: sign(), key, challenge })).toBeNull();
  });
  it("rejects junk", async () => {
    expect(await assertionProblem({ auth: { r: "0x00", s: "0x00", authenticatorData: "0x", clientDataJSON: "garbage" }, key, challenge })).not.toBeNull();
  });
  it("rejects a signature over a different request", async () => {
    expect(await assertionProblem({ auth: sign({ challenge: `0x${"11".repeat(32)}` }), key, challenge })).toBe("signed a different request");
  });
  it("rejects another key, another site, a registration, or no user verification", async () => {
    expect(await assertionProblem({ auth: sign({ with: p256.utils.randomPrivateKey() }), key, challenge })).toBe("signature does not match this passkey");
    expect(await assertionProblem({ auth: sign({ rp: "evil.example" }), key, challenge })).toBe("passkey made for a different site");
    expect(await assertionProblem({ auth: sign({ type: "webauthn.create" }), key, challenge })).toBe("not an approval signature");
    expect(await assertionProblem({ auth: sign({ flags: 0x01 }), key, challenge })).toBe("user verification missing");
  });
});
