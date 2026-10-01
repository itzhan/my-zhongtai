"use client";

import { useState } from "react";

import Link from "next/link";

import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

import { bigNum, num } from "../format";
import { type TRealtime, trafficKey, type TUserRpm, type useSite } from "../traffic";

import { Pager, usePaged } from "./shared";

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

// 用户实时 RPM：每个用户近 60 秒的请求数（滚动窗口，不会在整分钟跳回 0）、TPM、按分组拆分
const rpmBar = (pct: number) => (pct >= 90 ? "bg-danger" : pct >= 70 ? "bg-warning" : "bg-success");
export function UserRpmPanel({ data, error }: { data: TUserRpm | undefined; error?: Error | null }) {
  const users = data?.users ?? [];
  const { rows, pager } = usePaged(users, String(users.length > 0));
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>用户实时 RPM</CardTitle>
        <CardDescription>
          近 60 秒每个用户的请求数（滚动窗口）· 每 5 秒刷新
          {data ? ` · ${users.length} 个用户在请求` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? <p className="text-danger text-sm">读取失败：{error.message}</p> : null}
        {!data ? (
          <p className="text-muted-foreground text-sm">加载中…</p>
        ) : !users.length ? (
          <p className="text-muted-foreground text-sm">近 60 秒没有用户请求</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {rows.map((u) => {
              const pct = u.rpm_limit > 0 ? Math.min(100, Math.round((u.rpm / u.rpm_limit) * 100)) : 0;
              return (
                <div key={u.user_id} className="bg-muted/30 rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate font-medium" title={`${u.email} · #${u.user_id}`}>
                      {u.name}
                    </span>
                    {u.concurrency != null ? (
                      <span className="text-muted-foreground shrink-0 text-xs">并发 {u.concurrency}</span>
                    ) : null}
                  </div>
                  <div className="mt-1 flex items-baseline gap-1">
                    <span className="text-2xl font-semibold tabular-nums">{num(u.rpm)}</span>
                    <span className="text-muted-foreground text-xs">
                      RPM{u.rpm_limit > 0 ? ` / ${num(u.rpm_limit)}` : ""}
                    </span>
                    <span className="text-muted-foreground ml-auto text-xs tabular-nums">TPM {bigNum(u.tpm)}</span>
                  </div>
                  {u.rpm_limit > 0 ? (
                    <div className="bg-muted mt-1.5 h-1 overflow-hidden rounded">
                      <div className={cn("h-full", rpmBar(pct))} style={{ width: `${pct}%` }} />
                    </div>
                  ) : null}
                  <div className="mt-2 space-y-0.5 text-xs">
                    {u.groups.slice(0, 3).map((g) => (
                      <div key={g.group_id} className="flex justify-between gap-2">
                        <span className="text-muted-foreground truncate">{g.name}</span>
                        <span className="shrink-0 tabular-nums">{num(g.rpm)}</span>
                      </div>
                    ))}
                    {u.groups.length > 3 ? (
                      <div className="text-muted-foreground">还有 {u.groups.length - 3} 个分组</div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <Pager {...pager} />
      </CardContent>
    </Card>
  );
}
