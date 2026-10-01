"use client";

import { useMemo, useState } from "react";

import { RefreshCw, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

import { num, time, yuan } from "../format";
import { ERROR_RANGES, type TErrorAccount, useErrorRanking, useGroupUsers } from "../traffic";

import { Pager, ResponsiveDialog, StatCards, usePaged } from "./shared";

// ---------- 分组使用：每个分组今天各用户的消费 ----------
export function TrafficGroupUsers({ siteId }: { siteId: number }) {
  const { data, isFetching, refetch } = useGroupUsers(siteId);
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return (data?.groups ?? [])
      .filter((g) => g.users.length && (!kw || g.group_name.toLowerCase().includes(kw)))
      .map((g) => ({
        ...g,
        users: [...g.users].sort((a, b) => b.actual_cost - a.actual_cost),
        cost: g.users.reduce((s, u) => s + u.actual_cost, 0),
        requests: g.users.reduce((s, u) => s + u.requests, 0),
      }))
      .sort((a, b) => b.cost - a.cost);
  }, [data, q]);
  const { rows, pager } = usePaged(list, q);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input placeholder="搜索分组名" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
        </div>
        <span className="text-muted-foreground text-xs">
          {data ? `${data.today} 当天 · ${list.length} 个分组有消费` : ""}
        </span>
        <Button variant="outline" size="sm" className="ml-auto" disabled={isFetching} onClick={() => refetch()}>
          <RefreshCw className={cn(isFetching && "animate-spin")} />
          刷新
        </Button>
      </div>
      {!data ? (
        <Skeleton className="h-96" />
      ) : rows.length ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {rows.map((g) => (
            <GroupUsersCard key={g.group_id} g={g} />
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground py-10 text-center text-sm">今天还没有分组有消费</p>
      )}
      <Pager {...pager} />
    </div>
  );
}

function GroupUsersCard({
  g,
}: {
  g: {
    group_name: string;
    cost: number;
    requests: number;
    users: { user_id: number; email: string; requests: number; actual_cost: number }[];
  };
}) {
  const { rows, pager } = usePaged(g.users);
  const top = g.users[0]?.actual_cost ?? 0;
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span className="truncate">{g.group_name}</span>
          <span className="text-success tabular-nums">{yuan(g.cost)}</span>
        </CardTitle>
        <CardDescription>
          {g.users.length} 个用户 · {num(g.requests)} 次请求
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        {rows.map((u) => {
          const pct = top > 0 ? Math.min(100, Math.round((u.actual_cost / top) * 100)) : 0;
          return (
            <div key={u.user_id} className="bg-muted/40 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{u.email || `用户 #${u.user_id}`}</div>
                <div className="bg-muted mt-1 h-1 overflow-hidden rounded-full">
                  <div className="bg-primary h-full" style={{ width: `${pct}%` }} />
                </div>
              </div>
              <span className="text-muted-foreground shrink-0">{num(u.requests)} 次</span>
              <span className="text-success w-20 shrink-0 text-right font-mono">{yuan(u.actual_cost)}</span>
            </div>
          );
        })}
        <Pager {...pager} className="pt-2" />
      </CardContent>
    </Card>
  );
}

// ---------- 错误排行：按账号聚合请求错误 ----------
const statusLine = (by: Record<string, number>) =>
  Object.entries(by)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}×${v}`)
    .join(" / ");

export function TrafficErrors({ siteId }: { siteId: number }) {
  const [range, setRange] = useState("1h");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<TErrorAccount | null>(null);
  const { data, isFetching, error, refetch } = useErrorRanking(siteId, range);
  const list = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return (data?.accounts ?? []).filter(
      (a) =>
        !kw ||
        a.account_name.toLowerCase().includes(kw) ||
        a.groups.some((g) => g.group_name.toLowerCase().includes(kw)),
    );
  }, [data, q]);
  const { rows, pager } = usePaged(list, `${q}|${range}`);
  const max = Math.max(1, ...(data?.accounts ?? []).map((a) => a.count));
  const s = data?.summary;
  const rate = (v: number) => `${(v * 100).toFixed(2)}%`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup type="single" size="sm" variant="outline" value={range} onValueChange={(v) => v && setRange(v)}>
          {ERROR_RANGES.map(([k, l]) => (
            <ToggleGroupItem key={k} value={k} className="px-3">
              {l}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="relative w-full sm:w-64">
          <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input placeholder="搜索账号 / 分组" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
        </div>
        <Button variant="outline" size="sm" className="ml-auto" disabled={isFetching} onClick={() => refetch()}>
          <RefreshCw className={cn(isFetching && "animate-spin")} />
          刷新
        </Button>
      </div>
      {s ? (
        <StatCards
          items={[
            {
              label: "请求错误率",
              value: rate(s.error_rate),
              className: s.error_rate >= 0.05 ? "text-danger" : s.error_rate >= 0.02 ? "text-warning" : "",
              sub: `${num(s.error_count)} / ${num(s.request_count)}`,
            },
            {
              label: "上游错误率",
              value: rate(s.upstream_error_rate),
              className:
                s.upstream_error_rate >= 0.1 ? "text-danger" : s.upstream_error_rate >= 0.05 ? "text-warning" : "",
              sub: `其他 ${num(s.upstream_other)} · 429×${num(s.upstream_429)} · 529×${num(s.upstream_529)}`,
            },
            {
              label: "SLA",
              value: rate(s.sla),
              className: s.sla >= 0.99 ? "text-success" : s.sla >= 0.95 ? "text-warning" : "text-danger",
              sub: `成功 ${num(s.success_count)}`,
            },
            {
              label: "健康分",
              value: s.health_score ?? "-",
              className:
                s.health_score == null || s.health_score >= 80
                  ? ""
                  : s.health_score >= 50
                    ? "text-warning"
                    : "text-danger",
              sub: `统计于 ${time(s.generated_at)}`,
            },
          ]}
        />
      ) : null}
      {error ? <p className="text-danger text-sm">加载失败：{error.message}</p> : null}
      <Card>
        <CardHeader>
          <CardTitle>账号错误排行</CardTitle>
          <CardDescription>
            {data
              ? `共 ${num(data.total)} 条错误 · 涉及 ${data.accounts.length} 个账号${data.truncated ? "（超过上限，更早的未统计）" : ""} · 点一行看明细`
              : "加载中…（时间范围越长越慢）"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!data ? (
            <Skeleton className="h-64" />
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>排名</TableHead>
                    <TableHead>账号</TableHead>
                    <TableHead>分组</TableHead>
                    <TableHead className="text-right">错误数</TableHead>
                    <TableHead>占比</TableHead>
                    <TableHead>状态码</TableHead>
                    <TableHead>最近错误</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length ? (
                    rows.map((a, i) => (
                      <TableRow key={a.account_id} className="cursor-pointer" onClick={() => setPicked(a)}>
                        <TableCell className="text-muted-foreground font-mono text-xs">
                          #{(pager.page - 1) * pager.pageSize + i + 1}
                        </TableCell>
                        <TableCell className="max-w-64">
                          <div className="truncate font-medium">{a.account_name}</div>
                          <div className="text-muted-foreground text-xs">#{a.account_id}</div>
                        </TableCell>
                        <TableCell
                          className="text-muted-foreground text-xs"
                          title={a.groups.map((g) => `${g.group_name}(${g.count})`).join("、")}
                        >
                          {a.groups[0]?.group_name ?? "-"}
                          {a.groups.length > 1 ? ` +${a.groups.length - 1}` : ""}
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">{num(a.count)}</TableCell>
                        <TableCell>
                          <div className="flex min-w-32 items-center gap-2">
                            <div className="bg-muted h-2 flex-1 overflow-hidden rounded-full">
                              <div className="bg-danger/70 h-full" style={{ width: `${(a.count / max) * 100}%` }} />
                            </div>
                            <span className="text-muted-foreground w-12 text-right text-xs tabular-nums">
                              {(a.share * 100).toFixed(1)}%
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground font-mono text-xs">
                          {statusLine(a.by_status)}
                        </TableCell>
                        <TableCell className="max-w-72">
                          <div className="text-muted-foreground text-xs">{time(a.latest_at)}</div>
                          <div className="text-danger truncate text-xs" title={a.latest_message}>
                            {a.latest_status} · {a.latest_message || "-"}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={7} className="text-muted-foreground py-10 text-center">
                        {data.accounts.length ? "没有匹配的账号" : "这段时间没有错误"}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
          <Pager {...pager} />
        </CardContent>
      </Card>
      <ErrorDetail account={picked} onClose={() => setPicked(null)} />
    </div>
  );
}

function ErrorDetail({ account, onClose }: { account: TErrorAccount | null; onClose: () => void }) {
  const [status, setStatus] = useState("all");
  const [q, setQ] = useState("");
  const kw = q.trim().toLowerCase();
  const events = (account?.recent ?? []).filter(
    (e) =>
      (status === "all" || String(e.status_code) === status) &&
      (!kw || `${e.message} ${e.user_email} ${e.model} ${e.request_id}`.toLowerCase().includes(kw)),
  );
  const { rows, pager } = usePaged(events, `${account?.account_id}|${status}|${kw}`);
  return (
    <ResponsiveDialog
      open={!!account}
      onOpenChange={(o) => {
        if (!o) {
          onClose();
          setStatus("all");
          setQ("");
        }
      }}
      title={account ? `${account.account_name} · ${num(account.count)} 条错误` : ""}
      description={
        account ? `分组：${account.groups.map((g) => `${g.group_name}(${g.count})`).join("、") || "-"}` : undefined
      }
      className="sm:max-w-5xl"
    >
      {account ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {[["all", account.count] as const, ...Object.entries(account.by_status).sort((a, b) => b[1] - a[1])].map(
              ([k, n]) => (
                <Badge
                  key={k}
                  variant={status === k ? "default" : "secondary"}
                  className="cursor-pointer"
                  onClick={() => setStatus(k)}
                >
                  {k === "all" ? "全部" : k} · {n}
                </Badge>
              ),
            )}
            <Input
              placeholder="搜索消息 / 用户 / 模型 / request_id"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="ml-auto h-8 w-full sm:w-72"
            />
          </div>
          <p className="text-muted-foreground text-xs">每个账号最多保留最近 {account.recent.length} 条原始错误</p>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>模型</TableHead>
                  <TableHead>用户</TableHead>
                  <TableHead>消息</TableHead>
                  <TableHead>request_id</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                      {time(e.created_at)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={e.status_code >= 500 ? "destructive" : "secondary"}>{e.status_code || "?"}</Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      {e.model || "-"}
                      {e.requested_model && e.requested_model !== e.model ? (
                        <div className="text-muted-foreground text-[10px]">请求：{e.requested_model}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground max-w-40 truncate text-xs">
                      {e.user_email || "-"}
                    </TableCell>
                    <TableCell className="text-danger max-w-96 truncate text-xs" title={e.message}>
                      {e.message || "-"}
                    </TableCell>
                    <TableCell className="text-muted-foreground max-w-36 truncate font-mono text-[10px]">
                      {e.request_id || "-"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pager {...pager} />
        </div>
      ) : null}
    </ResponsiveDialog>
  );
}
