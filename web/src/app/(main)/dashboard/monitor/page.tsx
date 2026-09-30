"use client";

import { useMemo, useState } from "react";

import Link from "next/link";

import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { get } from "@/modules/ops/api";
import { MONITOR_RANGES } from "@/modules/ops/components/account-table";
import { AccountStatus, GroupTags, PlatformBadge, Tag } from "@/modules/ops/components/badges";
import { GradeBadge, LatencyBar, Legend, accountCells } from "@/modules/ops/components/latency-bar";
import { PageHeader, StatCards } from "@/modules/ops/components/shared";
import { ago, ms, num } from "@/modules/ops/format";
import { qk, useAccounts, useAlerts, useMonitor } from "@/modules/ops/hooks";
import { useOps } from "@/modules/ops/provider";
import type { Grade } from "@/modules/ops/types";

type SchedOverview = {
  enabled: boolean;
  lastFast: string | null;
  lastScore: string | null;
  groups: {
    id: number;
    name: string;
    platform: string;
    member_count: number;
    member_available: number;
    enrolled_count: number;
    alive: number | null;
    min_alive: number;
    auto: boolean;
  }[];
};

const GRADE_ORDER: Record<Grade["grade"], number> = { unavailable: 0, unstable: 1, excellent: 2, unknown: 3 };

export default function MonitorPage() {
  const { groupName } = useOps();
  const [range, setRange] = useState("2h");
  const [activeOnly, setActiveOnly] = useState(true);
  const [q, setQ] = useState("");
  const accounts = useAccounts();
  const mon = useMonitor(range);
  const alerts = useAlerts();
  const sched = useQuery({
    queryKey: qk.schedOverview,
    queryFn: () => get<SchedOverview>("/sched/overview"),
    refetchInterval: 60_000,
  });

  const rows = useMemo(() => {
    if (!accounts.data || !mon.data) return [];
    const kw = q.trim().toLowerCase();
    return accounts.data
      .map((a) => {
        const m = mon.data.accounts[a.id];
        const active = !!m?.samples.some((s) => s.status !== "unknown");
        const last = m ? [...m.samples].reverse().find((s) => s.p50 != null) : undefined;
        return { a, m, active, lastP50: last?.p50 ?? null };
      })
      .filter((r) => (!activeOnly || r.active) && (!kw || `${r.a.name} ${r.a.id}`.toLowerCase().includes(kw)))
      .sort(
        (x, y) =>
          GRADE_ORDER[x.m?.score.grade ?? "unknown"] - GRADE_ORDER[y.m?.score.grade ?? "unknown"] ||
          x.a.priority - y.a.priority,
      );
  }, [accounts.data, mon.data, activeOnly, q]);

  const all = accounts.data ?? [];
  const grades = mon.data ? Object.values(mon.data.accounts).map((m) => m.score.grade) : [];
  const count = (g: Grade["grade"]) => grades.filter((x) => x === g).length;
  const enrolledGroups = sched.data?.groups.filter((g) => g.enrolled_count) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="监控大盘"
        description={
          sched.data
            ? `智能调度 ${sched.data.enabled ? "已开启" : "已关闭"} · 快循环 ${ago(sched.data.lastFast)} · 评分 ${ago(sched.data.lastScore)}`
            : " "
        }
      />
      {accounts.data && mon.data ? (
        <StatCards
          items={[
            {
              label: "上游账号 · 正常可调度",
              value: `${all.filter((a) => a.status === "active" && a.schedulable).length} / ${all.length}`,
              sub: `错误 ${all.filter((a) => a.status === "error").length} · 停调度 ${all.filter((a) => !a.schedulable).length}`,
            },
            {
              label: `近 ${MONITOR_RANGES.find(([k]) => k === range)?.[1]}有流量`,
              value: grades.length - count("unknown"),
              sub: `共 ${all.length} 个账号`,
            },
            {
              label: "延迟评级 · 优秀",
              value: count("excellent"),
              className: "text-success",
              sub: `不稳定 ${count("unstable")}`,
            },
            {
              label: "不可用",
              value: count("unavailable"),
              className: count("unavailable") ? "text-danger" : "",
              sub: `报警 ${alerts.data?.alerts.length ?? 0} 条`,
            },
          ]}
        />
      ) : (
        <Skeleton className="h-28" />
      )}

      {enrolledGroups.length ? (
        <Card>
          <CardHeader>
            <CardTitle>智能调度分组</CardTitle>
            <CardDescription>已关联账号的存活情况</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {enrolledGroups.map((g) => (
              <Link
                key={g.id}
                prefetch={false}
                href={`/dashboard/groups/${g.id}`}
                className="hover:bg-accent/50 rounded-lg border p-3 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <b>{g.name}</b>
                  <Tag tone={(g.alive ?? 0) >= g.min_alive ? "ok" : g.alive === 0 ? "bad" : "warn"}>
                    存活 {g.alive} / {g.min_alive}
                  </Tag>
                </div>
                <div className="text-muted-foreground mt-1 text-xs">
                  关联 {g.enrolled_count} · 组内可用 {g.member_available}/{g.member_count} ·{" "}
                  {g.auto ? "自动调整中" : "未开自动"}
                </div>
              </Link>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>账号延迟</CardTitle>
          <CardDescription className="space-y-1">
            <div>
              按真实流量每 {mon.data?.bucket_min ?? 5} 分钟一格，色块为该段状态；首字 P50 ≥{" "}
              {ms(mon.data?.slow_ms ?? 5000)} 记为偏慢。不发任何探测请求。
            </div>
            <Legend />
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative w-full sm:w-64">
              <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
              <Input placeholder="搜索账号名 / ID" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
            </div>
            <div className="flex items-center gap-2">
              <Switch id="active-only" checked={activeOnly} onCheckedChange={setActiveOnly} />
              <Label htmlFor="active-only" className="text-muted-foreground font-normal">
                只看有流量的账号
              </Label>
            </div>
            <div className="ml-auto flex items-center gap-3">
              <span className="text-muted-foreground hidden text-xs lg:inline">异常的排在前面 · 每分钟自动刷新</span>
              <ToggleGroup
                type="single"
                size="sm"
                variant="outline"
                value={range}
                onValueChange={(v) => v && setRange(v)}
              >
                {MONITOR_RANGES.map(([k, l]) => (
                  <ToggleGroupItem key={k} value={k} className="px-3">
                    {l}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          </div>
          {!mon.data || !accounts.data ? (
            <Skeleton className="h-64" />
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>账号</TableHead>
                    <TableHead>延迟监控条</TableHead>
                    <TableHead>评级</TableHead>
                    <TableHead className="text-right">最近首字 P50</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>分组</TableHead>
                    <TableHead className="text-right">优先级</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length ? (
                    rows.map(({ a, m, lastP50 }) => (
                      <TableRow key={a.id}>
                        <TableCell className="min-w-40">
                          <Link
                            prefetch={false}
                            href={`/dashboard/accounts/${a.id}`}
                            className="font-medium hover:underline"
                          >
                            {a.name}
                          </Link>{" "}
                          <span className="text-muted-foreground text-xs">#{a.id}</span>
                          <div className="mt-0.5">
                            <PlatformBadge platform={a.platform} />
                          </div>
                        </TableCell>
                        <TableCell>
                          {m ? <LatencyBar cells={accountCells(m.samples, mon.data.bucket_min)} /> : null}
                        </TableCell>
                        <TableCell>{m ? <GradeBadge score={m.score} /> : null}</TableCell>
                        <TableCell className="text-right tabular-nums">{ms(lastP50)}</TableCell>
                        <TableCell>
                          <AccountStatus a={a} />
                        </TableCell>
                        <TableCell className="max-w-56">
                          <GroupTags ids={a.group_ids} name={groupName} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{a.priority}</TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={7} className="text-muted-foreground py-10 text-center">
                        {activeOnly ? "这段时间没有账号有流量，关掉「只看有流量」可查看全部" : "没有账号"}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
          <p className="text-muted-foreground text-xs">共 {num(rows.length)} 个账号</p>
        </CardContent>
      </Card>
    </div>
  );
}
