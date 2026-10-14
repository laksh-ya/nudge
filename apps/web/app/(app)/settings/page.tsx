"use client";

import { useClerk } from "@clerk/nextjs";
import { useConvexAuth, useQuery } from "convex/react";
import { Fingerprint, Globe, LogOut, Send, User } from "lucide-react";
import { api } from "@/lib/api";
import { useDemo } from "@/lib/demo";
import { Initial } from "@/components/brand";
import { Button, Card, Chip, Divided, IconTile, PageTitle, Row, Skeleton } from "@/components/ui";

export default function SettingsPage() {
  const me = useQuery(api.users.me);
  const { isAuthenticated } = useConvexAuth();
  const { signOut, openUserProfile } = useClerk();
  const { setDemo } = useDemo();

  if (!me) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <PageTitle>Settings</PageTitle>
        <Skeleton className="h-24 rounded-card" />
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageTitle>Settings</PageTitle>
      <Card>
        <div className="flex items-center gap-3">
          <Initial name={me.name} size={52} />
          <div className="min-w-0 flex-1">
            <div className="text-title font-semibold">{me.name}</div>
            <div className="truncate text-label text-mute">{isAuthenticated ? me.email : "Demo account"}</div>
          </div>
          {isAuthenticated && (
            <Button tone="outline" size="sm" onClick={() => openUserProfile()}>
              Edit
            </Button>
          )}
        </div>
      </Card>

      <Card title="Preferences" pad={false}>
        <Divided className="px-4 pb-1">
          <Row leading={<IconTile icon={Globe} tone="page" />} title="Country and currency" trailing={<span className="text-body text-ink-2">{me.country} · {me.currency}</span>} />
          <Row leading={<IconTile icon={User} tone="page" />} title="Sign-in" trailing={<span className="text-body text-ink-2">{isAuthenticated ? "Clerk" : "Demo"}</span>} />
        </Divided>
      </Card>

      <Card title="Security" pad={false}>
        <Divided className="px-4 pb-1">
          <Row leading={<IconTile icon={Fingerprint} tone="page" />} title="Payment passkey" sub="Approves payments outside your limits" trailing={<Chip tone="amber">Not set up</Chip>} />
          <Row leading={<IconTile icon={Send} tone="page" />} title="Telegram" sub="Chat with your assistant" trailing={<Chip>Not linked</Chip>} />
        </Divided>
      </Card>

      <Button
        tone="outline"
        size="lg"
        icon={LogOut}
        className="w-full"
        onClick={() => (isAuthenticated ? signOut({ redirectUrl: "/" }) : setDemo(false))}
      >
        {isAuthenticated ? "Sign out" : "Leave demo"}
      </Button>
    </div>
  );
}
