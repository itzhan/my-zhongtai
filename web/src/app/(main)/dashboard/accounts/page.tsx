"use client";

import { useState } from "react";

import Link from "next/link";

import { Plus, RefreshCw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { AccountTable } from "@/modules/ops/components/account-table";
import { PageHeader, StatCards } from "@/modules/ops/components/shared";
import { useAccounts, useNow } from "@/modules/ops/hooks";
import { useOps } from "@/modules/ops/provider";

const ALL = "all";
const STATUS_OPTS: [string, string][] = [
  ["ok", "正常可调度"],
  ["error", "错误"],
  ["inactive", "已禁用"],
  ["unsched", "停止调度"],
  ["limited", "限流/过载/临时不可调度"],
];

export default function AccountsPage() {
  const { groups } = useOps();
  const { data, refetch, isFetching } = useAccounts();
  const [f, setF] = useState({ q: "", platform: ALL, group: ALL, status: ALL });
  const list = data ?? [];
  const platforms = [...new Set(list.map((a) => a.platform))].sort();
  const cnt = (fn: (a: (typeof list)[number]) => boolean) => list.filter(fn).length;
  const now = useNow();
  const q = f.q.trim().toLowerCase();
  const rows = list.filter((a) => {
    if (q && !`${a.name} ${a.id} ${a.notes || ""}`.toLowerCase().includes(q)) return false;
    if (f.platform !== ALL && a.platform !== f.platform) return false;
    if (f.group === "none" && a.group_ids.length) return false;
    if (f.group !== ALL && f.group !== "none" && !a.group_ids.includes(+f.group)) return false;
    if (f.status === "ok" && !(a.status === "active" && a.schedulable)) return false;
    if (f.status === "error" && a.status !== "error") return false;
    if (f.status === "inactive" && a.status !== "inactive") return false;
    if (f.status === "unsched" && a.schedulable) return false;
    if (
      f.status === "limited" &&
      ![a.rate_limit_reset_at, a.overload_until, a.temp_unschedulable_until].some(
        (t) => t && new Date(t).getTime() > now,
      )
    )
      return false;
    return true;
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="账号"
        description={data ? `共 ${list.length} 个上游账号 · 优先级数字越小越优先` : " "}
        actions={
          <>
            <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={cn(isFetching && "animate-spin")} />
              刷新
            </Button>
            <Button asChild>
              <Link prefetch={false} href="/dashboard/accounts/new">
                <Plus />
                新建供应商账号
              </Link>
            </Button>
          </>
        }
      />
      {data ? (
        <StatCards
          items={[
            {
              label: "正常可调度",
              value: cnt((a) => a.status === "active" && a.schedulable),
              className: "text-success",
            },
            { label: "错误", value: cnt((a) => a.status === "error"), className: "text-danger" },
            { label: "已禁用", value: cnt((a) => a.status === "inactive") },
            { label: "停止调度", value: cnt((a) => !a.schedulable), className: "text-warning" },
          ]}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            placeholder="搜索名称 / ID / 备注"
            value={f.q}
            onChange={(e) => setF({ ...f, q: e.target.value })}
            className="pl-9"
          />
        </div>
        <Select value={f.platform} onValueChange={(v) => setF({ ...f, platform: v })}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部平台</SelectItem>
            {platforms.map((p) => (
              <SelectItem key={p} value={p}>
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={f.group} onValueChange={(v) => setF({ ...f, group: v })}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部分组</SelectItem>
            <SelectItem value="none">（未分组）</SelectItem>
            {groups.map((g) => (
              <SelectItem key={g.id} value={String(g.id)}>
                {g.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={f.status} onValueChange={(v) => setF({ ...f, status: v })}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部状态</SelectItem>
            {STATUS_OPTS.map(([k, l]) => (
              <SelectItem key={k} value={k}>
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {data ? <AccountTable accounts={rows} reload={() => refetch()} /> : <Skeleton className="h-96" />}
    </div>
  );
}
