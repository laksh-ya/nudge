import { NextResponse, type NextRequest } from "next/server";
import { JUDGE_COOKIE, sameSecret } from "@/lib/demo-token";

export const dynamic = "force-dynamic";

/** /judge?key=… opens the judge account (the one with the real phone-passkey vault) in this browser. */
export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key") ?? "";
  const home = new URL("/?demo=1", req.url);
  if (!sameSecret(key, process.env.JUDGE_KEY)) return NextResponse.redirect(new URL("/", req.url));
  const res = NextResponse.redirect(home);
  res.cookies.set(JUDGE_COOKIE, key, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 30 * 86_400 });
  return res;
}
