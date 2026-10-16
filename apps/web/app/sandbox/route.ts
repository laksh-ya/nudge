import { NextResponse, type NextRequest } from "next/server";
import { JUDGE_COOKIE, SANDBOX_COOKIE } from "@/lib/demo-token";

export const dynamic = "force-dynamic";

/** Leave the judge account (or an old sandbox) for a fresh sandbox of your own. */
export function GET(req: NextRequest) {
  const res = NextResponse.redirect(new URL("/?demo=1", req.url));
  res.cookies.delete(JUDGE_COOKIE);
  res.cookies.delete(SANDBOX_COOKIE);
  return res;
}
