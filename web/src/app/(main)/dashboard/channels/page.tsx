"use client";

import { Suspense } from "react";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Embedded, PageHeader, useTabParam } from "@/modules/ops/components/shared";
import { AccountsView } from "@/modules/ops/views/accounts-view";
import { GroupsView } from "@/modules/ops/views/groups-view";
import { LatencyView } from "@/modules/ops/views/latency-view";
import { SchedView } from "@/modules/ops/views/sched-view";

const TABS = [
  ["accounts", "全部账号"],
  ["latency", "账号延迟"],
  ["sched", "智能调度"],
] as const;

// 渠道配置：需要调整时才来——上游账号、账号延迟、智能调度
function ChannelsInner() {
  const [tab, setTab] = useTabParam(
    TABS.map(([k]) => k),
    "accounts",
  );
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="渠道配置" description="上游账号 · 账号延迟 · 智能调度" />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          {TABS.map(([k, l]) => (
            <TabsTrigger key={k} value={k}>
              {l}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <Embedded>
        {tab === "accounts" ? (
          <AccountsView />
        ) : tab === "latency" ? (
          <LatencyView />
        ) : (
          <div className="flex flex-col gap-8">
            <GroupsView />
            <SchedView />
          </div>
        )}
      </Embedded>
    </div>
  );
}

export default function ChannelsPage() {
  return (
    <Suspense>
      <ChannelsInner />
    </Suspense>
  );
}
