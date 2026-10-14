import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@agent-wallet/domain", "@agent-wallet/backend"],
  experimental: { optimizePackageImports: ["lucide-react"] },
};

export default config;
