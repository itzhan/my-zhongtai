"use client";

import { useMemo, useState } from "react";

import Link from "next/link";

import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Search } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { get } from "@/modules/ops/api";
import { MONITOR_RANGES } from "@/modules/ops/components/account-table";
import { AccountStatus, PlatformBadge, Tag } from "@/modules/ops/components/badges";
import { GRADE, GradeBadge, LatencyBar, Legend, accountCells } from "@/modules/ops/components/latency-bar";
import { Pager, StatCards, usePaged } from "@/modules/ops/components/shared";
import { ago, ms, num } from "@/modules/ops/format";
import { qk, useAccounts, useAlerts, useMonitor } from "@/modules/ops/hooks";
import { useOps } from "@/modules/ops/provider";
import type { Account, AccountSample, Grade } from "@/modules/ops/types";

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

type Row = { a: Account; m?: { samples: AccountSample[]; score: Grade }; lastP50: number | null };
type Section = { id: number; name: string; rows: Row[]; bad: number; unstable: number; excellent: number };

export function LatencyView() {
  const { groups } = useOps();
  // 用户手动展开 / 收起过的分组（相对默认状态取反）；默认：有异常 / 不稳定账号的分组展开
  const [toggled, setToggled] = useState<Set<number>>(new Set());
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

  // 按 sub2api 分组归类（一个账号在多个分组里就各出现一次），有不可用 / 不稳定账号的分组排前面
  const sections = useMemo<Section[]>(() => {
    const make = (id: number, name: string, list: Row[]): Section => {
      const n = (g: Grade["grade"]) => list.filter((r) => r.m?.score.grade === g).length;
      return { id, name, rows: list, bad: n("unavailable"), unstable: n("unstable"), excellent: n("excellent") };
    };
    const out = groups.map((g) =>
      make(
        g.id,
        g.name,
        rows.filter((r) => r.a.group_ids.includes(g.id)),
      ),
    );
    out.push(
      make(
        0,
        "未分组",
        rows.filter((r) => !r.a.group_ids.length),
      ),
    );
    return out
      .filter((x) => x.rows.length)
      .sort((x, y) => y.bad - x.bad || y.unstable - x.unstable || y.rows.length - x.rows.length);
  }, [groups, rows]);
  const isOpen = (x: Section) => x.bad + x.unstable > 0 !== toggled.has(x.id);
  const flip = (id: number) =>
    setToggled((t) => {
      const n = new Set(t);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const all = accounts.data ?? [];
  const grades = mon.data ? Object.values(mon.data.accounts).map((m) => m.score.grade) : [];
  const count = (g: Grade["grade"]) => grades.filter((x) => x === g).length;
  const enrolledGroups = sched.data?.groups.filter((g) => g.enrolled_count) ?? [];

  return (
    <div className="flex flex-col gap-6">
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
            <CardDescription>
              已关联账号的存活情况
              {sched.data
                ? ` · 智能调度${sched.data.enabled ? "已开启" : "已关闭"} · 快循环 ${ago(sched.data.lastFast)} · 评分 ${ago(sched.data.lastScore)}`
                : ""}
            </CardDescription>
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
              <span className="text-muted-foreground hidden text-xs lg:inline">
                按分组显示，异常的排在前面 · 每分钟自动刷新
              </span>
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
          ) : sections.length ? (
            <div className="space-y-2">
              {sections.map((x) => (
                <GroupSection
                  key={x.id}
                  section={x}
                  open={isOpen(x)}
                  onToggle={() => flip(x.id)}
                  bucketMin={mon.data.bucket_min}
                />
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground py-10 text-center text-sm">
              {activeOnly ? "这段时间没有账号有流量，关掉「只看有流量」可查看全部" : "没有账号"}
            </p>
          )}
          {mon.data && accounts.data ? (
            <p className="text-muted-foreground text-xs">
              共 {num(rows.length)} 个账号 · {sections.length} 个分组
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

// 一个分组：标题行（账号数、各评级数量）+ 可折叠的账号表（分页）
function GroupSection({
  section,
  open,
  onToggle,
  bucketMin,
}: {
  section: Section;
  open: boolean;
  onToggle: () => void;
  bucketMin: number;
}) {
  const { rows, pager } = usePaged(section.rows, String(section.rows.length));
  const worst: Grade["grade"] = section.bad
    ? "unavailable"
    : section.unstable
      ? "unstable"
      : section.excellent
        ? "excellent"
        : "unknown";
  return (
    <Collapsible open={open} onOpenChange={onToggle} className="rounded-md border">
      <CollapsibleTrigger className="hover:bg-accent/50 flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm">
        <ChevronRight
          className={cn("text-muted-foreground size-4 shrink-0 transition-transform", open && "rotate-90")}
        />
        <b className="truncate">{section.name}</b>
        {section.id ? <span className="text-muted-foreground text-xs">#{section.id}</span> : null}
        <span className="text-muted-foreground text-xs">{section.rows.length} 个账号</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {section.bad ? <Tag tone="bad">不可用 {section.bad}</Tag> : null}
          {section.unstable ? <Tag tone="warn">不稳定 {section.unstable}</Tag> : null}
          {section.excellent ? <Tag tone="ok">优秀 {section.excellent}</Tag> : null}
          {worst === "unknown" ? <Tag tone="muted">{GRADE.unknown.label}</Tag> : null}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t">
        <div className="overflow-x-auto">
          {/* 固定列宽：每个分组各自是一张表，不固定的话各组列宽随内容变化、上下对不齐 */}
          <Table className="min-w-[52rem] table-fixed">
            <colgroup>
              <col className="w-72" />
              <col className="w-56" />
              <col className="w-24" />
              <col className="w-28" />
              <col className="w-24" />
              <col className="w-16" />
              {/* 余下的宽度留在最右边，账号和延迟条挨着 */}
              <col />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">账号</TableHead>
                <TableHead>延迟监控条</TableHead>
                <TableHead>评级</TableHead>
                <TableHead className="text-right">最近首字 P50</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">优先级</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ a, m, lastP50 }) => (
                <TableRow key={a.id}>
                  <TableCell className="truncate pl-4" title={a.name}>
                    <Link prefetch={false} href={`/dashboard/accounts/${a.id}`} className="font-medium hover:underline">
                      {a.name}
                    </Link>{" "}
                    <span className="text-muted-foreground text-xs">#{a.id}</span>
                    <div className="mt-0.5">
                      <PlatformBadge platform={a.platform} />
                    </div>
                  </TableCell>
                  <TableCell>{m ? <LatencyBar cells={accountCells(m.samples, bucketMin)} /> : null}</TableCell>
                  <TableCell>{m ? <GradeBadge score={m.score} /> : null}</TableCell>
                  <TableCell className="text-right tabular-nums">{ms(lastP50)}</TableCell>
                  <TableCell>
                    <AccountStatus a={a} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{a.priority}</TableCell>
                  <TableCell />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <Pager {...pager} className="border-t px-4 py-2" />
      </CollapsibleContent>
    </Collapsible>
  );
}
