import { NextResponse, type NextRequest } from "next/server";
import { JUDGE_COOKIE, judgeCookieValue, judgeRole } from "@/lib/demo-token";

export const dynamic = "force-dynamic";

const page = (wrong: boolean) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Judge access</title><style>
body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100dvh;background:#fff;color:#0b1f3a}
form{width:min(360px,calc(100% - 32px));display:grid;gap:12px}input,button{font:inherit;padding:12px;border-radius:10px;border:1px solid #cfd8e3}
button{background:#0b1f3a;color:#fff;border:0;font-weight:600}p{margin:0;color:#5b6b80;font-size:14px}.bad{color:#b42318}
@media (prefers-color-scheme:dark){body{background:#0b1220;color:#e6edf7}input{background:#121a2b;color:#e6edf7;border-color:#2a3650}p{color:#98a6bb}button{background:#e6edf7;color:#0b1220}.bad{color:#f97066}}
</style></head><body><form method="post" action="/judge">
<strong>Judge access</strong><p>Opens the team's demo account, read-only. To try everything yourself, use "Try the demo" on the home page instead.</p>
${wrong ? '<p class="bad">That key didn\'t match.</p>' : ""}
<input name="key" type="password" autocomplete="current-password" placeholder="Judge key" required autofocus>
<button type="submit">Open</button></form></body></html>`;

/** The key is typed into a form, so it never sits in a URL, browser history or server logs. */
export function GET(req: NextRequest) {
  return new NextResponse(page(req.nextUrl.searchParams.has("wrong")), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const key = String((await req.formData()).get("key") ?? "");
  const cookie = await judgeCookieValue(key);
  if (!key || !(await judgeRole(cookie))) return NextResponse.redirect(new URL("/judge?wrong", req.url), 303);
  const res = NextResponse.redirect(new URL("/?demo=1", req.url), 303);
  res.cookies.set(JUDGE_COOKIE, cookie, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 30 * 86_400 });
  return res;
}
