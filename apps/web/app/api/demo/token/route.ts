import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { SANDBOX_COOKIE, demoToken, visitorId } from "@/lib/demo-token";

export const dynamic = "force-dynamic";

/**
 * A token for this browser's own demo sandbox. The sandbox id lives in an http-only cookie, so
 * nobody else can open it. (The shared read-only judge account was removed on 18 Oct: every visitor
 * gets their own sandbox and a guided tour instead.)
 */
export async function GET() {
  const jar = await cookies();
  let sub = jar.get(SANDBOX_COOKIE)?.value;
  const fresh = !sub || !/^[A-Za-z0-9_-]{32}$/.test(sub);
  if (fresh) sub = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const vis = await visitorId(ip);
  const token = await demoToken(sub!, { vis });
  const res = NextResponse.json({ token }, { headers: { "cache-control": "no-store" } });
  if (fresh) {
    res.cookies.set(SANDBOX_COOKIE, sub!, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 7 * 86_400 });
  }
  return res;
}
