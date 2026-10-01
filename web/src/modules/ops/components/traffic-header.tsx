"use client";

import { useState } from "react";

import Link from "next/link";

import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

import { bigNum, num } from "../format";
import { type TRealtime, trafficKey, type useSite } from "../traffic";

// 监控服务器选择 + 刷新（监控大盘、渠道页右上角）
export function SitePicker({ site }: { site: ReturnType<typeof useSite> }) {
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  if (!site.loaded) return null;
  if (!site.sites.length)
    return (
      <Button variant="outline" asChild>
        <Link href="/dashboard/settings">添加监控服务器</Link>
      </Button>
    );
  return (
    <>
      <Select value={site.siteId ? String(site.siteId) : undefined} onValueChange={(v) => site.pick(Number(v))}>
        <SelectTrigger className="w-48">
          <SelectValue placeholder="选择服务器" />
        </SelectTrigger>
        <SelectContent>
          {site.sites.map((s) => (
            <SelectItem key={s.id} value={String(s.id)}>
              {s.name}
              {s.is_default ? " · 默认" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        variant="outline"
        disabled={refreshing || !site.siteId}
        onClick={async () => {
          setRefreshing(true);
          await qc.refetchQueries({ queryKey: trafficKey(site.siteId) });
          setRefreshing(false);
        }}
      >
        <RefreshCw className={cn(refreshing && "animate-spin")} />
        刷新
      </Button>
    </>
  );
}

// 实时流量：RPM / TPM（每 2 秒刷新）
export function RealtimeCards({ rt, error }: { rt: TRealtime | undefined; error?: Error | null }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {[
        {
          label: "当前 RPM",
          value: rt?.rpm != null ? num(rt.rpm) : "-",
          sub: error ? `读取失败：${error.message}` : "每 2 秒刷新",
        },
        { label: "当前 TPM", value: rt?.tpm != null ? bigNum(rt.tpm) : "-", sub: rt?.tpm != null ? num(rt.tpm) : " " },
      ].map((x) => (
        <Card key={x.label} className="@container/card gap-2 py-5">
          <CardHeader className="px-5">
            <CardDescription>{x.label}</CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums">{x.value}</CardTitle>
          </CardHeader>
          <CardFooter className="text-muted-foreground px-5 text-xs">{x.sub}</CardFooter>
        </Card>
      ))}
    </div>
  );
}
