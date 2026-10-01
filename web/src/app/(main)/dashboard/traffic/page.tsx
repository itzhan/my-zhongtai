"use client";

import { useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { PageHeader, StatCards } from "@/modules/ops/components/shared";
import { TrafficChannels } from "@/modules/ops/components/traffic-channels";
import { TrafficSettings } from "@/modules/ops/components/traffic-settings";
import { TrafficErrors, TrafficGroupUsers } from "@/modules/ops/components/traffic-usage";
import { bigNum, num } from "@/modules/ops/format";
import {
  trafficKey,
  useGroupUsage,
  useRealtime,
  useStructure,
  useTodayStats,
  useTrafficSites,
} from "@/modules/ops/traffic";

const TABS = [
  ["channels", "渠道调度"],
  ["groups", "分组使用"],
  ["errors", "错误排行"],
  ["settings", "设置"],
] as const;
type Tab = (typeof TABS)[number][0];

// 记住上次看的 tab 和服务器（刷新后不用重新选）
const remember = (k: string, v?: string) => {
  try {
    if (v === undefined) return localStorage.getItem(k) ?? undefined;
    localStorage.setItem(k, v);
  } catch {
    // 浏览器禁用存储时忽略
  }
  return undefined;
};

export default function TrafficPage() {
  const qc = useQueryClient();
  const sites = useTrafficSites();
  const [tab, setTab] = useState<Tab>(() => (remember("ops.traffic.tab") as Tab | undefined) ?? "channels");
  const [picked, setPicked] = useState<number | null>(() => Number(remember("ops.traffic.site")) || null);
  const list = sites.data ?? [];
  // 选中的服务器不存在了（被删）就回到默认服务器
  const siteId = list.find((s) => s.id === picked)?.id ?? list.find((s) => s.is_default)?.id ?? list[0]?.id ?? null;

  const structure = useStructure(siteId);
  const rt = useRealtime(siteId);
  const stats = useTodayStats(siteId);
  const usage = useGroupUsage(siteId);
  const [refreshing, setRefreshing] = useState(false);
  const refreshAll = async () => {
    setRefreshing(true);
    await qc.refetchQueries({ queryKey: trafficKey(siteId) });
    setRefreshing(false);
  };

  const userConc = Object.values(rt.data?.user ?? {}).reduce((s, u) => s + u.current_in_use, 0);
  const chanConc = Object.values(rt.data?.account ?? {}).reduce((s, a) => s + a.current_in_use, 0);
  const activeTab: Tab = !sites.data || list.length ? tab : "settings";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="流量监控"
        description="sub2api 实时流量 · 渠道调度 · 分组使用 · 错误排行"
        actions={
          list.length ? (
            <>
              <Select
                value={siteId ? String(siteId) : undefined}
                onValueChange={(v) => {
                  setPicked(Number(v));
                  remember("ops.traffic.site", v);
                }}
              >
                <SelectTrigger className="w-48">
                  <SelectValue placeholder="选择服务器" />
                </SelectTrigger>
                <SelectContent>
                  {list.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                      {s.is_default ? " · 默认" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" onClick={refreshAll} disabled={refreshing || !siteId}>
                <RefreshCw className={cn(refreshing && "animate-spin")} />
                刷新
              </Button>
            </>
          ) : null
        }
      />
      {siteId ? (
        <StatCards
          items={[
            { label: "当前 RPM", value: rt.data?.rpm != null ? num(rt.data.rpm) : "-", sub: "每 2 秒刷新" },
            {
              label: "当前 TPM",
              value: rt.data?.tpm != null ? bigNum(rt.data.tpm) : "-",
              sub: rt.data?.tpm != null ? num(rt.data.tpm) : " ",
            },
            {
              label: "用户实时并发",
              value: rt.data ? (rt.data.user_monitoring === false ? "未开启" : num(userConc)) : "-",
              sub: `${Object.values(rt.data?.user ?? {}).filter((u) => u.current_in_use > 0).length} 个用户有进行中的请求`,
            },
            {
              label: "渠道实时并发",
              value: rt.data ? num(chanConc) : "-",
              sub: rt.error ? `读取失败：${rt.error.message}` : " ",
            },
          ]}
        />
      ) : null}
      <Tabs
        value={activeTab}
        onValueChange={(v) => {
          setTab(v as Tab);
          remember("ops.traffic.tab", v);
        }}
      >
        <TabsList>
          {TABS.map(([k, l]) => (
            <TabsTrigger key={k} value={k}>
              {l}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {!sites.data ? (
        <Skeleton className="h-96" />
      ) : activeTab === "settings" || !siteId ? (
        <TrafficSettings sites={list} />
      ) : activeTab === "channels" ? (
        <TrafficChannels
          siteId={siteId}
          structure={structure.data}
          rt={rt.data}
          stats={stats.data}
          usage={usage.data}
        />
      ) : activeTab === "groups" ? (
        <TrafficGroupUsers siteId={siteId} />
      ) : (
        <TrafficErrors siteId={siteId} />
      )}
      {structure.error && activeTab === "channels" ? (
        <p className="text-danger text-sm">读取渠道失败：{structure.error.message}</p>
      ) : null}
    </div>
  );
}
