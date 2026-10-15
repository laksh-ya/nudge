"use client";

import { useQuery } from "convex/react";
import { api } from "@/lib/api";
import { relativeDay, time } from "@/lib/format";
import { ActivityIcon } from "@/components/activity-icon";
import { Card, Divided, Empty, PageTitle, Row, Skeleton } from "@/components/ui";

export default function ActivityPage() {
  const items = useQuery(api.activity.list);
  const groups: { day: string; items: NonNullable<typeof items> }[] = [];
  for (const a of items ?? []) {
    const day = relativeDay(a._creationTime);
    const last = groups.at(-1);
    if (last?.day === day) last.items.push(a);
    else groups.push({ day, items: [a] });
  }
  return (
    <div className="mx-auto max-w-3xl">
      <PageTitle>Activity</PageTitle>
      {items === undefined ? (
        <Skeleton className="h-96 rounded-card" />
      ) : items.length === 0 ? (
        <Card>
          <Empty>Nothing yet.</Empty>
        </Card>
      ) : (
        <Card pad={false} className="py-1">
          {groups.map((g) => (
            <div key={g.day}>
              <div className="px-4 pt-3 pb-1 text-label font-semibold text-mute">{g.day}</div>
              <Divided className="px-4">
                {g.items.map((a) => (
                  <Row
                    key={a._id}
                    leading={<ActivityIcon kind={a.kind} tone={a.tone} />}
                    title={a.title}
                    sub={a.sample ? ["Sample", a.detail].filter(Boolean).join(" · ") : a.detail}
                    trailing={<span className="text-label text-mute">{time(a._creationTime)}</span>}
                  />
                ))}
              </Divided>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
