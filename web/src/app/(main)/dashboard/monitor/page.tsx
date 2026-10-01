"use client";

import { Suspense } from "react";

import Link from "next/link";

import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader, useTabParam } from "@/modules/ops/components/shared";
import { TrafficChannels } from "@/modules/ops/components/traffic-channels";
import { RealtimeCards, SitePicker } from "@/modules/ops/components/traffic-header";
import { TrafficErrors, TrafficGroupUsers } from "@/modules/ops/components/traffic-usage";
import {
  type TRealtime,
  useGroupUsage,
  useRealtime,
  useSite,
  useStructure,
  useTodayStats,
} from "@/modules/ops/traffic";

const TABS = [
  ["channels", "渠道"],
  ["errors", "错误排行"],
  ["usage", "分组使用"],
] as const;

// 监控大盘：日常看的实时流量和渠道（账号延迟、智能调度这些配置类的在「渠道配置」）
function MonitorInner() {
  const site = useSite();
  const rt = useRealtime(site.siteId);
  const [tab, setTab] = useTabParam(
    TABS.map(([k]) => k),
    "channels",
  );
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="监控大盘"
        description="实时流量 · 渠道 · 错误排行 · 分组使用"
        actions={<SitePicker site={site} />}
      />
      {!site.siteId ? (
        <NeedSite loaded={site.loaded} />
      ) : (
        <>
          <RealtimeCards rt={rt.data} error={rt.error} />
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              {TABS.map(([k, l]) => (
                <TabsTrigger key={k} value={k}>
                  {l}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {tab === "channels" ? (
            <Channels siteId={site.siteId} rt={rt.data} />
          ) : tab === "errors" ? (
            <TrafficErrors siteId={site.siteId} />
          ) : (
            <TrafficGroupUsers siteId={site.siteId} />
          )}
        </>
      )}
    </div>
  );
}

function Channels({ siteId, rt }: { siteId: number; rt: TRealtime | undefined }) {
  const structure = useStructure(siteId);
  const stats = useTodayStats(siteId);
  const usage = useGroupUsage(siteId);
  return (
    <>
      <TrafficChannels siteId={siteId} structure={structure.data} rt={rt} stats={stats.data} usage={usage.data} />
      {structure.error ? <p className="text-danger text-sm">读取渠道失败：{structure.error.message}</p> : null}
    </>
  );
}

function NeedSite({ loaded }: { loaded: boolean }) {
  if (!loaded) return null;
  return (
    <Card>
      <CardContent className="text-muted-foreground py-10 text-center text-sm">
        还没有监控服务器，先去{" "}
        <Link href="/dashboard/settings" className="text-primary hover:underline">
          设置
        </Link>{" "}
        里添加 sub2api 的 URL 和 Admin Key
      </CardContent>
    </Card>
  );
}

export default function MonitorPage() {
  return (
    <Suspense>
      <MonitorInner />
    </Suspense>
  );
}
