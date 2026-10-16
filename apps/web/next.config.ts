import type { NextConfig } from "next";

/**
 * Security headers on every page. The dashboard holds controls (freeze, disconnect, new keys), so it
 * must never load inside another site's frame. Script sources are left to Next.js and Clerk; the
 * approval site, where passkeys sign, has the strict policy (apps/approve/vercel.json).
 */
const security = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=()" },
];

const config: NextConfig = {
  transpilePackages: ["@agent-wallet/domain", "@agent-wallet/backend"],
  experimental: { optimizePackageImports: ["lucide-react"] },
  async headers() {
    return [{ source: "/(.*)", headers: security }];
  },
};

export default config;
