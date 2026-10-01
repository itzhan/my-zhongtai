"use client";

import { useEffect, useState } from "react";

import { Download, X } from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { OPS_API, get, qs } from "@/modules/ops/api";
import { PageHeader, Pager, ResponsiveDialog, usePaged } from "@/modules/ops/components/shared";
import { bigNum, discLabel, moneyFull, num, readErr, ymd } from "@/modules/ops/format";
import { useCustomers } from "@/modules/ops/hooks";
import type { S2User } from "@/modules/ops/types";

type Sums = {
  requests: number;
  cost: number;
  std_cost: number;
  input: number | string;
  output: number | string;
  cache_write: number | string;
  cache_read: number | string;
};
type Summary = {
  total: Sums;
  by_user: (Sums & { user_id: number; email: string })[];
  by_model: (Sums & { model: string })[];
  daily: { day: string; cost: number; requests: number }[];
  discount: number;
  final_cost: number;
};

const tokens = (s: Sums) => Number(s.input) + Number(s.output) + Number(s.cache_write) + Number(s.cache_read);
const chartConfig = { cost: { label: "结算金额", color: "var(--primary)" } } satisfies ChartConfig;
const PICK = "pick";

// 起止日期快捷选择（北京时间）
function preset(k: string): [string, string] {
  const now = new Date();
  const today = ymd(now);
  const [y, m] = today.split("-").map(Number) as [number, number];
  const pad = (n: number) => String(n).padStart(2, "0");
  if (k === "today") return [today, today];
  if (k === "yesterday") {
    const d = ymd(new Date(now.getTime() - 86400e3));
    return [d, d];
  }
  if (k === "7d") return [ymd(new Date(now.getTime() - 6 * 86400e3)), today];
  if (k === "lastmonth") {
    const ly = m === 1 ? y - 1 : y;
    const lm = m === 1 ? 12 : m - 1;
    return [`${ly}-${pad(lm)}-01`, `${ly}-${pad(lm)}-${new Date(Date.UTC(ly, lm, 0)).getUTCDate()}`];
  }
  return [`${y}-${pad(m)}-01`, today];
}

function DiscountDialog({
  open,
  onOpenChange,
  onOk,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onOk: (v: number) => void;
}) {
  const [v, setV] = useState("1");
  useEffect(() => {
    if (!open) return;
    try {
      setV(localStorage.getItem("zt_discount") || "1");
    } catch {
      setV("1");
    }
  }, [open]);
  const n = Number(v);
  const valid = n > 0 && n <= 10;
  const ok = () => {
    if (!valid) return toast.error("折扣系数无效");
    try {
      localStorage.setItem("zt_discount", String(n));
    } catch {
      // 本机存不了就算了
    }
    onOpenChange(false);
    onOk(n);
  };
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="客户折扣"
      description="最终应付 = 结算金额 × 折扣系数。例：0.85 = 85 折，1 = 无折扣。"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {(
            [
              [1, "无折扣"],
              [0.9, "9 折"],
              [0.85, "8.5 折"],
              [0.8, "8 折"],
              [0.7, "7 折"],
            ] as const
          ).map(([x, t]) => (
            <Button key={x} size="sm" variant="outline" onClick={() => setV(String(x))}>
              {t}
            </Button>
          ))}
        </div>
        <div className="space-y-2">
          <Label>折扣系数</Label>
          <Input
            type="number"
            step="0.01"
            min="0.01"
            max="10"
            value={v}
            autoFocus
            onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ok()}
          />
          <p className="text-sm">
            {valid ? (
              <>
                即 <b>{discLabel(n)}</b>
                {n > 1 ? "（大于 1 表示加价）" : ""}
              </>
            ) : (
              <span className="text-danger">请输入 0.01 ~ 10 之间的系数</span>
            )}
          </p>
        </div>
        <Button className="w-full" onClick={ok}>
          确定并拉取
        </Button>
      </div>
    </ResponsiveDialog>
  );
}

export function BillingView({ presetUsers }: { presetUsers?: { id: number; email: string }[] }) {
  const customers = useCustomers();
  const [[start, end], setRange] = useState<[string, string]>(() => preset("month"));
  // 从客户详情进来时，预先选好该客户的用户
  const [users, setUsers] = useState<Map<number, string>>(
    () => new Map((presetUsers ?? []).map((u) => [u.id, u.email])),
  );
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<S2User[] | null>(null);
  const [discOpen, setDiscOpen] = useState(false);
  const [discount, setDiscount] = useState(1);
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const v = search.trim();
    if (!v) return setResults(null);
    const t = setTimeout(
      () =>
        get<S2User[]>(`/s2/users?search=${encodeURIComponent(v)}`)
          .then(setResults)
          .catch(() => setResults([])),
      300,
    );
    return () => clearTimeout(t);
  }, [search]);

  const params = (disc: number) => qs({ start, end, user_ids: [...users.keys()].join(","), discount: disc });
  const pull = async (disc: number) => {
    setDiscount(disc);
    setLoading(true);
    try {
      setData(await get<Summary>(`/billing/summary?${params(disc)}`));
    } catch (e) {
      toast.error(readErr(e));
    } finally {
      setLoading(false);
    }
  };

  const t = data?.total;
  const { rows: userRows, pager: userPager } = usePaged(data?.by_user ?? []);
  const { rows: modelRows, pager: modelPager } = usePaged(data?.by_model ?? []);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="账单" description="按北京时间整天统计；结算金额 = 按用户倍率计算后的实际扣费" />
      <Card>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label className="text-xs">开始</Label>
              <Input type="date" value={start} onChange={(e) => setRange([e.target.value, end])} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">结束</Label>
              <Input type="date" value={end} onChange={(e) => setRange([start, e.target.value])} />
            </div>
            {(
              [
                ["today", "今天"],
                ["yesterday", "昨天"],
                ["7d", "近 7 天"],
                ["month", "本月"],
                ["lastmonth", "上月"],
              ] as const
            ).map(([k, l]) => (
              <Button key={k} size="sm" variant="outline" onClick={() => setRange(preset(k))}>
                {l}
              </Button>
            ))}
          </div>
          <div className="space-y-2">
            <Label>结算用户</Label>
            <div className="flex flex-wrap gap-1.5">
              {users.size ? (
                [...users].map(([id, email]) => (
                  <span
                    key={id}
                    className="bg-muted inline-flex items-center gap-1 rounded-md py-0.5 pr-1 pl-2 text-sm"
                  >
                    {email} <span className="text-muted-foreground text-xs">#{id}</span>
                    <button
                      type="button"
                      onClick={() =>
                        setUsers((m) => {
                          const n = new Map(m);
                          n.delete(id);
                          return n;
                        })
                      }
                    >
                      <X className="size-3.5" />
                    </button>
                  </span>
                ))
              ) : (
                <span className="text-muted-foreground text-sm">还没选用户</span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Input
              className="min-w-56 flex-1"
              placeholder="输入邮箱搜索 sub2api 用户…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select
              value={PICK}
              onValueChange={(v) => {
                const c = customers.data?.find((x) => x.id === v);
                if (c) setUsers((m) => new Map([...m, ...c.users.map((u) => [u.id, u.email] as [number, string])]));
              }}
            >
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={PICK}>或按客户添加…</SelectItem>
                {customers.data?.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}（{c.users.length} 个用户）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={() => (users.size ? setDiscOpen(true) : toast.error("请先选择用户"))}>拉取账单</Button>
          </div>
          {results ? (
            <div className="max-h-48 divide-y overflow-y-auto rounded-md border">
              {results.length ? (
                results.map((u) => (
                  <div key={u.id} className="flex items-center justify-between px-3 py-2 text-sm">
                    <span>
                      {u.email} <span className="text-muted-foreground text-xs">#{u.id}</span>
                    </span>
                    {users.has(u.id) ? (
                      <span className="text-muted-foreground text-xs">已选</span>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setUsers((m) => new Map(m).set(u.id, u.email))}
                      >
                        选择
                      </Button>
                    )}
                  </div>
                ))
              ) : (
                <div className="text-muted-foreground px-3 py-2 text-sm">没有匹配的用户</div>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {loading && !data ? <Skeleton className="h-64" /> : null}
      {data && t ? (
        <>
          <Card>
            <CardHeader>
              <CardDescription>
                {start} 至 {end} · {users.size} 个用户 ·{" "}
                {data.discount === 1 ? "应付金额（无折扣）" : `折后应付金额（${discLabel(data.discount)}）`}
              </CardDescription>
              <CardTitle className="text-3xl font-semibold tabular-nums">{moneyFull(data.final_cost)}</CardTitle>
              <CardDescription>
                {data.discount !== 1 ? `原结算 ${moneyFull(t.cost)} × ${data.discount} · ` : ""}
                {num(t.requests)} 次请求 · {bigNum(tokens(t))} tokens · 标准费用 {moneyFull(t.std_cost)}
              </CardDescription>
              <CardAction className="flex gap-2">
                <Button variant="outline" onClick={() => setDiscOpen(true)}>
                  修改折扣
                </Button>
                <Button asChild>
                  <a href={`${OPS_API}/billing/export?${params(discount)}`} download>
                    <Download />
                    导出 xlsx
                  </a>
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="px-2 sm:px-6">
              <div className="text-muted-foreground mb-2 px-4 text-xs sm:px-0">每日结算金额</div>
              <ChartContainer config={chartConfig} className="aspect-auto h-[180px] w-full">
                <BarChart data={data.daily}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="day"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    minTickGap={24}
                    tickFormatter={(v: string) => v.slice(5)}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    width={64}
                    tickFormatter={(v) => moneyFull(Number(v)).replace(/\.00$/, "")}
                  />
                  <ChartTooltip
                    cursor={{ fill: "var(--muted)", opacity: 0.5 }}
                    content={
                      <ChartTooltipContent
                        formatter={(v, _n, item) =>
                          `${moneyFull(Number(v))} · ${num((item.payload as { requests: number }).requests)} 次`
                        }
                      />
                    }
                  />
                  <Bar dataKey="cost" fill="var(--color-cost)" radius={[4, 4, 0, 0]} maxBarSize={28} />
                </BarChart>
              </ChartContainer>
            </CardContent>
          </Card>
          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>按用户</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>用户</TableHead>
                        <TableHead className="text-right">请求</TableHead>
                        <TableHead className="text-right">tokens</TableHead>
                        <TableHead className="text-right">结算金额</TableHead>
                        <TableHead className="text-right">折后金额</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {userRows.map((u) => (
                        <TableRow key={u.user_id}>
                          <TableCell>
                            {u.email || `#${u.user_id}`}{" "}
                            <span className="text-muted-foreground text-xs">#{u.user_id}</span>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{num(u.requests)}</TableCell>
                          <TableCell className="text-right tabular-nums">{bigNum(tokens(u))}</TableCell>
                          <TableCell className="text-right tabular-nums">{moneyFull(u.cost)}</TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">
                            {moneyFull(u.cost * data.discount)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <Pager {...userPager} className="mt-3" />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>按模型</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>模型</TableHead>
                        <TableHead className="text-right">请求</TableHead>
                        <TableHead className="text-right">结算金额</TableHead>
                        <TableHead className="text-right">占比</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.by_model.length ? (
                        modelRows.map((m) => (
                          <TableRow key={m.model}>
                            <TableCell>{m.model}</TableCell>
                            <TableCell className="text-right tabular-nums">{num(m.requests)}</TableCell>
                            <TableCell className="text-right tabular-nums">{moneyFull(m.cost)}</TableCell>
                            <TableCell className="text-right tabular-nums">
                              {t.cost ? `${((m.cost / t.cost) * 100).toFixed(1)}%` : "-"}
                            </TableCell>
                          </TableRow>
                        ))
                      ) : (
                        <TableRow>
                          <TableCell colSpan={4} className="text-muted-foreground py-6 text-center">
                            无用量
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
                <Pager {...modelPager} className="mt-3" />
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}
      <DiscountDialog open={discOpen} onOpenChange={setDiscOpen} onOk={pull} />
    </div>
  );
}
