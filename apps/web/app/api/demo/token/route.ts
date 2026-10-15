import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { JUDGE_COOKIE, SANDBOX_COOKIE, demoToken, sameSecret } from "@/lib/demo-token";

export const dynamic = "force-dynamic";

/**
 * A token for this browser's own demo sandbox. The sandbox id lives in an http-only cookie, so
 * nobody else can open it; holding the judge key (set by /judge) opens the judge account instead.
 */
export async function GET() {
  const jar = await cookies();
  const judge = sameSecret(jar.get(JUDGE_COOKIE)?.value, process.env.JUDGE_KEY);
  let sub = jar.get(SANDBOX_COOKIE)?.value;
  const fresh = !sub || !/^[A-Za-z0-9_-]{32}$/.test(sub);
  if (fresh) sub = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
  const token = await demoToken(judge ? "judge" : sub!);
  const res = NextResponse.json({ token }, { headers: { "cache-control": "no-store" } });
  if (fresh) {
    res.cookies.set(SANDBOX_COOKIE, sub!, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 7 * 86_400 });
  }
  return res;
}
