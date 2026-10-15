import type { AuthConfig } from "convex/server";

export default {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN!,
      applicationID: "convex",
    },
    // Private demo sandboxes, signed by the web app (apps/web/app/api/demo). The public key is
    // inlined as a data URI so dev deployments don't need to reach a local server.
    {
      type: "customJwt",
      applicationID: "agent-wallet-demo",
      issuer: "https://demo.agent-wallet.app",
      jwks: process.env.DEMO_JWKS!,
      algorithm: "ES256",
    },
  ],
} satisfies AuthConfig;
