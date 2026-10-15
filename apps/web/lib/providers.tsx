"use client";

import { useAuth } from "@clerk/nextjs";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { useCallback, useMemo } from "react";
import { DemoProvider, useDemo } from "./demo";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

/**
 * Signed in: Clerk's token. Trying the demo: a token for this browser's own sandbox from
 * /api/demo/token. Nobody shares an account any more.
 */
function useAppAuth() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const { demo, loaded } = useDemo();
  const useDemoToken = isLoaded && !isSignedIn && loaded && demo;
  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
      if (isSignedIn) return (await getToken({ template: "convex", skipCache: forceRefreshToken })) ?? null;
      if (!useDemoToken) return null;
      try {
        const res = await fetch("/api/demo/token", { cache: "no-store" });
        return res.ok ? ((await res.json()) as { token: string }).token : null;
      } catch {
        return null;
      }
    },
    [isSignedIn, getToken, useDemoToken],
  );
  return useMemo(
    () => ({ isLoading: !isLoaded || !loaded, isAuthenticated: Boolean(isSignedIn) || useDemoToken, fetchAccessToken }),
    [isLoaded, loaded, isSignedIn, useDemoToken, fetchAccessToken],
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <DemoProvider>
      <ConvexProviderWithAuth client={convex} useAuth={useAppAuth}>
        {children}
      </ConvexProviderWithAuth>
    </DemoProvider>
  );
}
