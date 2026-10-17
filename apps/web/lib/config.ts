export const APP_NAME = "agent wallet";
export const APPROVE_URL = process.env.NEXT_PUBLIC_APPROVE_URL ?? "http://localhost:3001";

export function approvalLink(token: string) {
  return `${APPROVE_URL}/a/${token}`;
}

export const MCP_URL = `${process.env.NEXT_PUBLIC_CONVEX_SITE_URL ?? ""}/mcp`;

export const EXPLORER = "https://sepolia.basescan.org";

/**
 * The default on /proof for anyone without a vault of their own: the full v3 end-to-end run of
 * 16 Oct (paid at once, held then released, passkey approval, a stolen key refused and frozen,
 * unfrozen after the delay, key removed), all on the current contract.
 */
export const REFERENCE_VAULT = process.env.NEXT_PUBLIC_REFERENCE_VAULT ?? "0xD654B846daf578E20b64FC0c4d1880A532112d31";
/** The judge account's vault since it moved to v3 on 16 Oct. */
export const JUDGE_VAULT = "0x85EFA7346e408DB2c28D01bA0De82E77F01900a8";
/** The judge account's v2 vault before the move: its phone-passkey history stays on-chain there. */
export const JUDGE_VAULT_V2 = "0xC9746222bdf0959B8ce3cE0F21C26c7c217f1EB1";
/** The v3 end-to-end run, where a stolen agent key was refused and then frozen by the vault. */
export const STOLEN_KEY_VAULT = "0x0a130a0cCABA11faA1c653f5ea4D76Adb36194d3";

export const REFERENCE_VAULTS = [
  { address: REFERENCE_VAULT, label: "Full run (v3)", note: "Paid $3 at once, held $6 then released, $12 approved by passkey, a stolen key refused and frozen, unfrozen after the delay. Test passkey, 16 Oct." },
  { address: JUDGE_VAULT, label: "Judge account", note: "Phone passkey, on the current contract since 16 Oct. Its earlier payments are on the v2 vault." },
  { address: JUDGE_VAULT_V2, label: "Judge account before the move (v2)", note: "Phone passkey. Claude paid $3 at once, $8 was held, $12 waited for the phone." },
  { address: STOLEN_KEY_VAULT, label: "Stolen-key test", note: "A stolen agent key, used without our server, refused five times and then frozen by the vault." },
];

/** Real Base Sepolia transactions from the README, for the judge tour. */
export const PROOF_TX = {
  paidAtOnce: "0x615d6621f0e186cb9870e533b6df0a8a26395d5c2f62b256d09e72bb5aa8a539",
  approvedOnPhone: "0xcda7773e0408da8e958bddbff7ec595a91587221e02a08120ec6135de99a8be9",
  stolenKeyRefused: "0x0563fdacf54f69d18a35f7d5a0a4668bd881781b2635c565df17ecf8eb9c80bd",
  stolenKeyFrozen: "0x9e852068f278fa9810a1cc9367979aa106238609e8bb3fca863c8d8dea369781",
};
