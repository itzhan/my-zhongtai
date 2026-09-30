"use client";

import { useEffect, useState } from "react";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { get, put, qs } from "../api";
import { ago, bigNum, money, ms, num, readErr, time } from "../format";
import { useCustomerChannels, useInvalidate } from "../hooks";
import { useOps } from "../provider";
import type { CustomerOverview, Paged } from "../types";

import { AccountTable } from "./account-table";
import { PlatformBadge, Tag } from "./badges";
import { ErrorDetailDialog, RangeSelect } from "./dialogs";
import { Pager, StatCards, useConfirm } from "./shared";

const ALL = "all";
const trendConfig = { cost: { label: "消费", color: "var(--primary)" } } satisfies ChartConfig;

// ---------- 概览 ----------
export function OverviewTab({ ov }: { ov: CustomerOverview }) {
  const { groups } = useOps();
  const invalidate = useInvalidate();
  const [confirm, confirmEl] = useConfirm();
  const s = ov.summary;

  const setUserStatus = async (uid: number, on: boolean) => {
    if (
      !on &&
      !(await confirm({
        title: "禁用该用户？",
        description: "禁用后他的所有 Key 都会无法调用。",
        destructive: true,
        confirmText: "禁用",
      }))
    )
      return;
    try {
      await put(`/s2/users/${uid}`, { status: on ? "active" : "disabled" });
      toast.success(on ? "已启用用户" : "已禁用用户");
      invalidate("overview");
    } catch (e) {
      toast.error(readErr(e));
    }
  };
  const setKeyGroup = async (kid: number, gid: string) => {
    try {
      await put(`/api-keys/${kid}/group`, { group_id: gid === ALL ? null : gid });
      toast.success("Key 分组已修改");
      invalidate("overview");
    } catch (e) {
      toast.error(readErr(e));
    }
  };

  return (
    <div className="space-y-4">
      <StatCards
        cols={5}
        items={[
          {
            label: "今日请求 / 消费",
            value: num(s.today.requests),
            sub: `${money(s.today.cost)} · ${bigNum(s.today.tokens)} tokens`,
          },
          {
            label: "近 7 天",
            value: money(s.d7.cost),
            sub: `${num(s.d7.requests)} 次 · ${bigNum(s.d7.tokens)} tokens`,
          },
          {
            label: "近 30 天",
            value: money(s.d30.cost),
            sub: `${num(s.d30.requests)} 次 · ${bigNum(s.d30.tokens)} tokens`,
          },
          {
            label: "报错 24h / 7 天",
            value: num(ov.errors.h24),
            className: ov.errors.h24 ? "text-danger" : "",
            sub: `7 天共 ${num(ov.errors.d7)} 条`,
          },
          {
            label: "账户余额合计",
            value: money(ov.users.reduce((a, u) => a + (u.balance || 0), 0)),
            sub: `${ov.users.length} 个 sub2api 用户`,
          },
        ]}
      />
      <Card>
        <CardHeader>
          <CardTitle>近 14 天消费</CardTitle>
        </CardHeader>
        <CardContent className="px-2 sm:px-6">
          {ov.trend.length ? (
            <ChartContainer config={trendConfig} className="aspect-auto h-[200px] w-full">
              <BarChart data={ov.trend}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} />
                <YAxis tickLine={false} axisLine={false} width={56} tickFormatter={(v) => money(Number(v))} />
                <ChartTooltip
                  cursor={{ fill: "var(--muted)", opacity: 0.5 }}
                  content={
                    <ChartTooltipContent
                      formatter={(v, _n, item) =>
                        `${money(Number(v))} · ${num((item.payload as { requests: number }).requests)} 次`
                      }
                    />
                  }
                />
                <Bar dataKey="cost" fill="var(--color-cost)" radius={[4, 4, 0, 0]} maxBarSize={36} />
              </BarChart>
            </ChartContainer>
          ) : (
            <p className="text-muted-foreground py-8 text-center text-sm">近 14 天无用量</p>
          )}
        </CardContent>
      </Card>
      {ov.users.map((u) => (
        <Card key={u.id}>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              {u.email}{" "}
              <span className="text-muted-foreground text-xs font-normal">
                #{u.id}
                {u.username ? ` · ${u.username}` : ""}
              </span>
            </CardTitle>
            <CardDescription>
              {u.missing ? (
                <Tag tone="bad">读取失败：{u.error}</Tag>
              ) : (
                <>
                  <Tag tone={u.status === "active" ? "ok" : "muted"}>{u.status === "active" ? "正常" : "已禁用"}</Tag>{" "}
                  余额 <b>{money(u.balance)}</b> · 并发 {num(u.concurrency)} · RPM{" "}
                  {u.rpm_limit ? num(u.rpm_limit) : "不限"} · 最近活跃 {ago(u.last_active_at)}
                </>
              )}
            </CardDescription>
            {u.missing ? null : (
              <CardAction className="flex items-center gap-2 text-sm">
                启用 <Switch checked={u.status === "active"} onCheckedChange={(v) => setUserStatus(u.id, v)} />
              </CardAction>
            )}
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Key 名称</TableHead>
                    <TableHead>Key</TableHead>
                    <TableHead>使用分组</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>最近使用</TableHead>
                    <TableHead>创建时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {u.keys.length ? (
                    u.keys.map((k) => (
                      <TableRow key={k.id}>
                        <TableCell>
                          {k.name} <span className="text-muted-foreground text-xs">#{k.id}</span>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{k.key_masked}</TableCell>
                        <TableCell>
                          <Select
                            value={k.group_id ? String(k.group_id) : ALL}
                            onValueChange={(v) => setKeyGroup(k.id, v)}
                          >
                            <SelectTrigger size="sm" className="w-44">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={ALL}>（无分组）</SelectItem>
                              {groups.map((g) => (
                                <SelectItem key={g.id} value={String(g.id)}>
                                  {g.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          <Tag tone={k.status === "active" ? "ok" : "muted"}>{k.status}</Tag>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{ago(k.last_used_at)}</TableCell>
                        <TableCell className="text-muted-foreground">{time(k.created_at)}</TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={6} className="text-muted-foreground">
                        没有 Key
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ))}
      {confirmEl}
    </div>
  );
}

// ---------- 接入渠道 ----------
export function ChannelsTab({ id }: { id: string }) {
  const { data, refetch } = useCustomerChannels(id);
  if (!data) return <Skeleton className="h-64" />;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>客户 Key 使用的分组</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {data.groups.length ? (
            data.groups.map((g) => (
              <Tag key={g.id} tone="info">
                {g.name} · {g.platform} · {g.key_count} 个 Key · 账号 {g.active_account_count ?? "?"}/
                {g.account_count ?? "?"}
              </Tag>
            ))
          ) : (
            <span className="text-muted-foreground text-sm">客户的 Key 都没有绑定分组</span>
          )}
        </CardContent>
      </Card>
      <p className="text-muted-foreground text-sm">
        下表是这些分组里的上游账号，以及近 7 天实际承接过该客户流量的账号。优先级数字越小越优先；改动会直接作用到
        sub2api，影响所有使用该账号的客户。
      </p>
      <AccountTable accounts={data.accounts} customer reload={() => refetch()} />
    </div>
  );
}

// ---------- 分组 ----------
export function GroupsTab({ ov, id }: { ov: CustomerOverview; id: string }) {
  const { groups } = useOps();
  const invalidate = useInvalidate();
  const { data } = useCustomerChannels(id);
  const [allowed, setAllowed] = useState<Record<number, Set<number>>>({});
  useEffect(
    () => setAllowed(Object.fromEntries(ov.users.map((u) => [u.id, new Set(u.allowed_groups ?? [])]))),
    [ov.users],
  );
  if (!data) return <Skeleton className="h-64" />;
  const accBy = (gid: number) =>
    data.accounts.filter((a) => a.group_ids.includes(gid)).sort((a, b) => a.priority - b.priority);
  const save = async (uid: number) => {
    try {
      await put(`/s2/users/${uid}`, { allowed_groups: [...(allowed[uid] ?? [])] });
      toast.success("分组权限已保存");
      invalidate("overview");
    } catch (e) {
      toast.error(readErr(e));
    }
  };
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>正在使用的分组（按客户 Key 归集）</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>分组</TableHead>
                  <TableHead>平台</TableHead>
                  <TableHead className="text-right">倍率</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead className="text-right">客户 Key 数</TableHead>
                  <TableHead>组内账号（按优先级）</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.groups.length ? (
                  data.groups.map((g) => (
                    <TableRow key={g.id}>
                      <TableCell>
                        <b>{g.name}</b> <span className="text-muted-foreground text-xs">#{g.id}</span>
                      </TableCell>
                      <TableCell>
                        <PlatformBadge platform={g.platform} />
                      </TableCell>
                      <TableCell className="text-right">{g.rate_multiplier}</TableCell>
                      <TableCell>{g.is_exclusive ? <Tag tone="warn">专属</Tag> : <Tag>公开</Tag>}</TableCell>
                      <TableCell className="text-right">{g.key_count}</TableCell>
                      <TableCell className="max-w-md">
                        <span className="inline-flex flex-wrap gap-1">
                          {accBy(g.id).map((a) => (
                            <Tag
                              key={a.id}
                              tone={
                                a.status === "active" && a.schedulable ? "ok" : a.status === "error" ? "bad" : "muted"
                              }
                            >
                              {a.name} · P{a.priority}
                            </Tag>
                          ))}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={6} className="text-muted-foreground">
                      无
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
      {ov.users
        .filter((u) => !u.missing)
        .map((u) => (
          <Card key={u.id}>
            <CardHeader>
              <CardTitle>{u.email} 可用的专属分组</CardTitle>
              <CardDescription>
                公开分组所有用户默认可用；专属分组需要勾选授权。Key 具体用哪个分组在「概览」里改。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-3">
                {groups.map((g) => (
                  <label key={g.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={allowed[u.id]?.has(g.id) ?? false}
                      onCheckedChange={(v) =>
                        setAllowed((all) => {
                          const n = new Set(all[u.id]);
                          if (v) n.add(g.id);
                          else n.delete(g.id);
                          return { ...all, [u.id]: n };
                        })
                      }
                    />
                    {g.name} {g.is_exclusive ? null : <span className="text-muted-foreground text-xs">(公开)</span>}
                  </label>
                ))}
              </div>
              <Button size="sm" onClick={() => save(u.id)}>
                保存分组权限
              </Button>
            </CardContent>
          </Card>
        ))}
    </div>
  );
}

// ---------- 日志公共：筛选条件 ----------
type LogFilters = {
  range: string;
  user_id: string;
  api_key_id: string;
  account_id: string;
  model: string;
  owner?: string;
  status_code?: string;
};
function LogFilterBar({
  ov,
  f,
  set,
  errors,
}: {
  ov: CustomerOverview;
  f: LogFilters;
  set: (p: Partial<LogFilters>) => void;
  errors?: boolean;
}) {
  const keys = ov.users.flatMap((u) => u.keys.map((k) => ({ ...k, email: u.email })));
  return (
    <div className="flex flex-wrap items-center gap-2">
      <RangeSelect value={f.range} onChange={(range) => set({ range })} />
      {ov.users.length > 1 ? (
        <Select value={f.user_id || ALL} onValueChange={(v) => set({ user_id: v === ALL ? "" : v })}>
          <SelectTrigger size="sm" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部用户</SelectItem>
            {ov.users.map((u) => (
              <SelectItem key={u.id} value={String(u.id)}>
                {u.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <Select value={f.api_key_id || ALL} onValueChange={(v) => set({ api_key_id: v === ALL ? "" : v })}>
        <SelectTrigger size="sm" className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>全部 Key</SelectItem>
          {keys.map((k) => (
            <SelectItem key={k.id} value={String(k.id)}>
              {k.name} (#{k.id}
              {ov.users.length > 1 ? ` · ${k.email}` : ""})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {errors ? (
        <Select value={f.owner || ALL} onValueChange={(v) => set({ owner: v === ALL ? "" : v })}>
          <SelectTrigger size="sm" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部归属</SelectItem>
            <SelectItem value="provider">上游(provider)</SelectItem>
            <SelectItem value="client">客户端(client)</SelectItem>
            <SelectItem value="platform">平台(platform)</SelectItem>
          </SelectContent>
        </Select>
      ) : null}
      {errors ? (
        <Input
          className="h-8 w-24"
          placeholder="状态码"
          defaultValue={f.status_code}
          key={`sc${f.status_code}`}
          onBlur={(e) => set({ status_code: e.target.value.trim() })}
        />
      ) : null}
      <Input
        className="h-8 w-24"
        placeholder="账号 ID"
        defaultValue={f.account_id}
        key={`ac${f.account_id}`}
        onBlur={(e) => set({ account_id: e.target.value.trim() })}
      />
      <Input
        className="h-8 w-40"
        placeholder="模型"
        defaultValue={f.model}
        onBlur={(e) => set({ model: e.target.value.trim() })}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
    </div>
  );
}

// ---------- 使用日志 ----------
type UsageRow = {
  id: number;
  created_at: string;
  email: string;
  api_key_id: number;
  key_name: string;
  account_id: number | null;
  account_name: string | null;
  group_name: string | null;
  model: string;
  upstream_model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  actual_cost: number;
  duration_ms: number | null;
  first_token_ms: number | null;
  stream: boolean;
  inbound_endpoint: string;
  ip: string | null;
};
export function UsageTab({ ov, id }: { ov: CustomerOverview; id: string }) {
  const [f, setF] = useState<LogFilters>({ range: "24h", user_id: "", api_key_id: "", account_id: "", model: "" });
  const [page, setPage] = useState(1);
  const set = (p: Partial<LogFilters>) => {
    setF((x) => ({ ...x, ...p }));
    setPage(1);
  };
  const q = useQuery({
    queryKey: ["ops", "usage", id, f, page],
    queryFn: () =>
      get<Paged<UsageRow> & { sum: { cost: number; tokens: number; avg_ms: number } }>(
        `/customers/${id}/usage?${qs({ ...f, page })}`,
      ),
    placeholderData: keepPreviousData,
  });
  const d = q.data;
  return (
    <div className="space-y-4">
      <LogFilterBar ov={ov} f={f} set={set} />
      {d ? (
        <StatCards
          items={[
            { label: "请求数", value: num(d.total) },
            { label: "消费", value: money(d.sum.cost) },
            { label: "Tokens", value: bigNum(d.sum.tokens) },
            { label: "平均耗时", value: ms(d.sum.avg_ms) },
          ]}
        />
      ) : null}
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {["时间", "Key", "模型", "分组", "上游账号"].map((h) => (
                <TableHead key={h}>{h}</TableHead>
              ))}
              {["输入", "输出", "缓存写", "缓存读", "费用", "耗时", "首字"].map((h) => (
                <TableHead key={h} className="text-right">
                  {h}
                </TableHead>
              ))}
              <TableHead>接口</TableHead>
              <TableHead>IP</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!d ? (
              <TableRow>
                <TableCell colSpan={14}>
                  <Skeleton className="h-24" />
                </TableCell>
              </TableRow>
            ) : d.items.length ? (
              d.items.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap">{time(r.created_at)}</TableCell>
                  <TableCell>
                    {r.key_name} <span className="text-muted-foreground text-xs">#{r.api_key_id}</span>
                    {ov.users.length > 1 ? <div className="text-muted-foreground text-xs">{r.email}</div> : null}
                  </TableCell>
                  <TableCell>
                    {r.model}
                    {r.upstream_model && r.upstream_model !== r.model ? (
                      <div className="text-muted-foreground text-xs">→ {r.upstream_model}</div>
                    ) : null}
                  </TableCell>
                  <TableCell>{r.group_name || "-"}</TableCell>
                  <TableCell>
                    {r.account_name || "-"} <span className="text-muted-foreground text-xs">#{r.account_id ?? ""}</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{num(r.input_tokens)}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(r.output_tokens)}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(r.cache_creation_tokens)}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(r.cache_read_tokens)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(r.actual_cost)}</TableCell>
                  <TableCell className="text-right tabular-nums">{ms(r.duration_ms)}</TableCell>
                  <TableCell className="text-right tabular-nums">{ms(r.first_token_ms)}</TableCell>
                  <TableCell className="text-xs">
                    {r.inbound_endpoint}
                    {r.stream ? <Tag className="ml-1">流</Tag> : null}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.ip || "-"}</TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={14} className="text-muted-foreground py-10 text-center">
                  该时间段无记录
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {d ? <Pager page={d.page} pageSize={d.page_size} total={d.total} onPage={setPage} /> : null}
    </div>
  );
}

// ---------- 报错日志 ----------
type ErrRow = {
  id: number;
  created_at: string;
  email: string;
  key_name: string | null;
  account_name: string | null;
  group_name: string | null;
  model: string | null;
  requested_model: string | null;
  status_code: number | null;
  upstream_status_code: number | null;
  error_phase: string;
  error_owner: string | null;
  error_message: string | null;
  upstream_error_message: string | null;
  duration_ms: number | null;
};
export function ErrorsTab({ ov, id }: { ov: CustomerOverview; id: string }) {
  const [f, setF] = useState<LogFilters>({
    range: "24h",
    user_id: "",
    api_key_id: "",
    account_id: "",
    model: "",
    owner: "",
    status_code: "",
  });
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<number | null>(null);
  const set = (p: Partial<LogFilters>) => {
    setF((x) => ({ ...x, ...p }));
    setPage(1);
  };
  const q = useQuery({
    queryKey: ["ops", "errors", id, f, page],
    queryFn: () =>
      get<
        Paged<ErrRow> & {
          by_status: { status_code: number | null; n: number }[];
          by_account: { account_id: number | null; account_name: string | null; n: number }[];
        }
      >(`/customers/${id}/errors?${qs({ ...f, page })}`),
    placeholderData: keepPreviousData,
  });
  const d = q.data;
  return (
    <div className="space-y-4">
      <LogFilterBar ov={ov} f={f} set={set} errors />
      {d ? (
        <Card className="gap-3 py-4">
          <CardContent className="space-y-2 px-4 text-sm">
            <div className="text-muted-foreground text-xs">共 {num(d.total)} 条报错 · 状态码分布（点击筛选）</div>
            <div className="flex flex-wrap gap-1">
              {d.by_status.length ? (
                d.by_status.map((s) => (
                  <button
                    key={String(s.status_code)}
                    type="button"
                    onClick={() => set({ status_code: String(s.status_code ?? "") })}
                  >
                    <Tag tone="bad">
                      {s.status_code ?? "无"} × {num(s.n)}
                    </Tag>
                  </button>
                ))
              ) : (
                <span className="text-muted-foreground">无</span>
              )}
            </div>
            <div className="text-muted-foreground text-xs">按上游账号</div>
            <div className="flex flex-wrap gap-1">
              {d.by_account.length ? (
                d.by_account.map((a) => (
                  <button
                    key={String(a.account_id)}
                    type="button"
                    onClick={() => set({ account_id: String(a.account_id ?? "") })}
                  >
                    <Tag tone="warn">
                      {a.account_name || "未分配账号"} × {num(a.n)}
                    </Tag>
                  </button>
                ))
              ) : (
                <span className="text-muted-foreground">无</span>
              )}
            </div>
          </CardContent>
        </Card>
      ) : null}
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {["时间", "状态码", "归属", "Key", "模型", "分组", "上游账号", "错误信息"].map((h) => (
                <TableHead key={h}>{h}</TableHead>
              ))}
              <TableHead className="text-right">耗时</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {!d ? (
              <TableRow>
                <TableCell colSpan={10}>
                  <Skeleton className="h-24" />
                </TableCell>
              </TableRow>
            ) : d.items.length ? (
              d.items.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap">{time(r.created_at)}</TableCell>
                  <TableCell>
                    <Tag tone={(r.status_code ?? 0) >= 500 ? "bad" : "warn"}>{r.status_code ?? "-"}</Tag>
                    {r.upstream_status_code && r.upstream_status_code !== r.status_code ? (
                      <div className="text-muted-foreground text-xs">上游 {r.upstream_status_code}</div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-xs">
                    {r.error_owner || "-"}
                    <div className="text-muted-foreground">{r.error_phase}</div>
                  </TableCell>
                  <TableCell>
                    {r.key_name || "-"}
                    {ov.users.length > 1 ? <div className="text-muted-foreground text-xs">{r.email}</div> : null}
                  </TableCell>
                  <TableCell>{r.requested_model || r.model || "-"}</TableCell>
                  <TableCell>{r.group_name || "-"}</TableCell>
                  <TableCell>{r.account_name || "-"}</TableCell>
                  <TableCell className="max-w-96 text-xs break-all whitespace-normal">
                    {r.error_message || r.upstream_error_message || "-"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{ms(r.duration_ms)}</TableCell>
                  <TableCell>
                    <button
                      type="button"
                      className="text-primary text-sm hover:underline"
                      onClick={() => setDetail(r.id)}
                    >
                      详情
                    </button>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={10} className="text-muted-foreground py-10 text-center">
                  该时间段没有报错 🎉
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {d ? <Pager page={d.page} pageSize={d.page_size} total={d.total} onPage={setPage} /> : null}
      <ErrorDetailDialog id={detail} onClose={() => setDetail(null)} />
    </div>
  );
}
