"use client";

import { useMutation, useQuery } from "convex/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { HeartHandshake } from "lucide-react";
import { api } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { Initial } from "@/components/brand";
import { Button, Card, PageTitle } from "@/components/ui";
import { ErrorText, Input, errorMessage } from "@/components/form";

/** Where a family invite link lands: see who invited you and on what terms, then accept. */
export default function JoinPage() {
  return (
    <Suspense>
      <Join />
    </Suspense>
  );
}

function Join() {
  const params = useSearchParams();
  const router = useRouter();
  const [code, setCode] = useState((params.get("code") ?? "").toUpperCase());
  const invite = useQuery(api.circle.invitation, code.trim().length === 8 ? { code } : "skip");
  const accept = useMutation(api.circle.accept);
  const [error, setError] = useState<string>();
  return (
    <div className="mx-auto max-w-md space-y-4">
      <PageTitle>Join a family</PageTitle>
      <Card>
        <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="8-letter code" maxLength={8} className="num text-center tracking-[0.2em]" />
        {invite?.valid === false && <p className="mt-2 text-label text-red">That invite isn't valid any more. Ask them for a new link.</p>}
        {invite?.valid && (
          <div className="mt-4 space-y-3">
            <div className="flex items-center gap-3">
              <Initial name={invite.ownerName} size={48} />
              <div>
                <div className="text-title font-semibold">{invite.ownerName}</div>
                <div className="text-label text-mute">{invite.ownerEmail}</div>
              </div>
            </div>
            {invite.self ? (
              <p className="text-body text-ink-2">That's your own invite: send the link to the person you're inviting.</p>
            ) : (
              <>
                <p className="text-body text-ink-2">
                  Invited you as <b>{invite.invitedAs}</b> ({invite.relation.toLowerCase()}). You'd get up to <b>{formatMoney(invite.allowanceMinor, "USDC")}</b> a month;
                  asks up to <b>{formatMoney(invite.autoApproveMinor, "USDC")}</b> are paid without asking them. They never see your accounts or balances.
                  {invite.canProtect && " They're also asking you to be their guardian: you could stop their held payments and freeze their assistants, never pay."}
                </p>
                <ErrorText>{error}</ErrorText>
                <Button
                  size="lg"
                  className="w-full"
                  icon={HeartHandshake}
                  onClick={async () => {
                    setError(undefined);
                    try {
                      await accept({ code });
                      router.replace("/family");
                    } catch (e) {
                      setError(errorMessage(e));
                    }
                  }}
                >
                  Accept, I know {invite.ownerName}
                </Button>
              </>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
