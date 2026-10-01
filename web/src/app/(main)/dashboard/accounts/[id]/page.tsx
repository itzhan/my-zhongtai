"use client";

import { use, useState } from "react";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Pencil, PlugZap, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { del, get, post, qs } from "@/modules/ops/api";
import { MONITOR_RANGES } from "@/modules/ops/components/account-table";
import { AccountStatus, BreakerBadge, PlatformBadge, Tag } from "@/modules/ops/components/badges";
import { DetectCell, type DetectInfo } from "@/modules/ops/components/detect";
import { ErrorDetailDialog, RangeSelect } from "@/modules/ops/components/dialogs";
import { GradeBadge, LatencyBar, Legend, accountCells } from "@/modules/ops/components/latency-bar";
import { DEFAULT_PAGE_SIZE, PageHeader, Pager, StatCards, useConfirm } from "@/modules/ops/components/shared";
import { ago, bigNum, money, ms, num, pct, readErr, time } from "@/modules/ops/format";
import { qk, useMonitor, useNow } from "@/modules/ops/hooks";
import { useOps } from "@/modules/ops/provider";
import type { Account, Paged } from "@/modules/ops/types";
import { useTabTitle, useTabsStore } from "@/stores/tabs/tab-store-provider";

type Full = {
  account: Account & {
    credentials?: {
      base_url?: string;
      model_mapping?: Record<string, string>;
      pool_mode?: boolean;
      pool_mode_retry_count?: number;
      pool_mode_retry_status_codes?: number[];
    };
    credentials_status?: { has_api_key?: boolean };
    extra?: Record<string, unknown>;
    rate_multiplier?: number;
    proxy_id?: number | null;
    expires_at?: string | null;
    auto_pause_on_expired?: boolean;
  };
  stats: {
    today_n: number;
    today_cost: number;
    today_tokens: number;
    d7_n: number;
    d7_cost: number;
    d7_tokens: number;
  };
  errors_24h: Record<string, number>;
  perf_1h: { n: number; p50: number | null; p90: number | null; cache: number | null; cache_today: number | null };
  sched: { groups: number[]; breaker: string | null; reason?: string };
  detect: DetectInfo;
};

function TestDialog({
  open,
  onOpenChange,
  id,
  name,
  defaultModel,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  id: number;
  name: string;
  defaultModel: string;
}) {
  const [model, setModel] = useState(defaultModel);
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState<{ ok: boolean; model: string; output: string; error: string; ms: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setErr(null);
    setR(null);
    try {
      setR(await post(`/accounts/${id}/test`, { model_id: model.trim() }));
    } catch (e) {
      setErr(readErr(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>测试连接 · {name}</DialogTitle>
        </DialogHeader>
        <div className="flex gap-2">
          <Input
            placeholder="测试模型（留空用 sub2api 默认）"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
          <Button onClick={go} disabled={busy}>
            {busy ? "测试中…" : "开始测试"}
          </Button>
        </div>
        <p className="text-muted-foreground text-sm">通过 sub2api 发一次真实请求，走线上一样的链路。</p>
        {err ? <p className="text-danger text-sm">{err}</p> : null}
        {r ? (
          <div className="space-y-2 text-sm">
            <div>
              <Tag tone={r.ok ? "ok" : "bad"}>{r.ok ? "通过" : "失败"}</Tag> 模型 {r.model || "-"} · {ms(r.ms)}
            </div>
            {r.output ? (
              <pre className="bg-muted max-h-48 overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">
                {r.output}
              </pre>
            ) : null}
            {r.error ? (
              <pre className="bg-muted text-danger max-h-48 overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">
                {r.error}
              </pre>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type UsageRow = {
  id: number;
  created_at: string;
  email: string | null;
  key_name: string | null;
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
};
type ErrRow = {
  id: number;
  created_at: string;
  email: string | null;
  model: string | null;
  status_code: number | null;
  error_owner: string | null;
  error_message: string;
};

function Logs({ id }: { id: number }) {
  const [tab, setTab] = useState("usage");
  const [range, setRange] = useState("24h");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [detail, setDetail] = useState<number | null>(null);
  const q = useQuery({
    queryKey: ["ops", "acc-logs", id, tab, range, page, pageSize],
    queryFn: () =>
      get<Paged<UsageRow | ErrRow>>(
        `/accounts/${id}/${tab === "usage" ? "usage" : "errors"}?${qs({ range, page, page_size: pageSize })}`,
      ),
    placeholderData: keepPreviousData,
  });
  const d = q.data;
  return (
    <Card>
      <CardHeader>
        <Tabs
          value={tab}
          onValueChange={(v) => {
            setTab(v);
            setPage(1);
          }}
        >
          <TabsList>
            <TabsTrigger value="usage">使用记录</TabsTrigger>
            <TabsTrigger value="errors">报错</TabsTrigger>
          </TabsList>
        </Tabs>
        <CardAction>
          <RangeSelect
            value={range}
            onChange={(v) => {
              setRange(v);
              setPage(1);
            }}
          />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="overflow-x-auto rounded-md border">
          {tab === "usage" ? (
            <Table>
              <TableHeader>
                <TableRow>
                  {["时间", "用户", "Key", "分组", "模型"].map((h) => (
                    <TableHead key={h}>{h}</TableHead>
                  ))}
                  {["输入", "输出", "缓存写", "缓存读", "费用", "耗时", "首字"].map((h) => (
                    <TableHead key={h} className="text-right">
                      {h}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {(d?.items as UsageRow[] | undefined)?.length ? (
                  (d!.items as UsageRow[]).map((x) => (
                    <TableRow key={x.id}>
                      <TableCell className="whitespace-nowrap">{time(x.created_at)}</TableCell>
                      <TableCell>{x.email || "-"}</TableCell>
                      <TableCell>{x.key_name || "-"}</TableCell>
                      <TableCell>{x.group_name || "-"}</TableCell>
                      <TableCell>
                        {x.model}
                        {x.upstream_model && x.upstream_model !== x.model ? (
                          <div className="text-muted-foreground text-xs">→ {x.upstream_model}</div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{num(x.input_tokens)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(x.output_tokens)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(x.cache_creation_tokens)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(x.cache_read_tokens)}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(x.actual_cost)}</TableCell>
                      <TableCell className="text-right tabular-nums">{ms(x.duration_ms)}</TableCell>
                      <TableCell className="text-right tabular-nums">{ms(x.first_token_ms)}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={12} className="text-muted-foreground py-8 text-center">
                      {d ? "无记录" : "加载中…"}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {["时间", "用户", "模型", "状态码", "归属", "错误信息", ""].map((h, i) => (
                    <TableHead key={i}>{h}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {(d?.items as ErrRow[] | undefined)?.length ? (
                  (d!.items as ErrRow[]).map((x) => (
                    <TableRow key={x.id}>
                      <TableCell className="whitespace-nowrap">{time(x.created_at)}</TableCell>
                      <TableCell>{x.email || "-"}</TableCell>
                      <TableCell>{x.model || "-"}</TableCell>
                      <TableCell>
                        <Tag tone="bad">{x.status_code ?? "-"}</Tag>
                      </TableCell>
                      <TableCell className="text-xs">{x.error_owner || "-"}</TableCell>
                      <TableCell className="max-w-96 text-xs break-all whitespace-normal">{x.error_message}</TableCell>
                      <TableCell>
                        <button
                          type="button"
                          className="text-primary text-sm hover:underline"
                          onClick={() => setDetail(x.id)}
                        >
                          详情
                        </button>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={7} className="text-muted-foreground py-8 text-center">
                      {d ? "没有报错" : "加载中…"}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </div>
        {d ? (
          <Pager page={d.page} pageSize={d.page_size} total={d.total} onPage={setPage} onPageSize={setPageSize} />
        ) : null}
      </CardContent>
      <ErrorDetailDialog id={detail} onClose={() => setDetail(null)} />
    </Card>
  );
}

function Kv({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <div className="divide-y text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-4 py-2">
          <span className="text-muted-foreground w-28 shrink-0">{k}</span>
          <div className="min-w-0 flex-1 break-all">{v}</div>
        </div>
      ))}
    </div>
  );
}

export default function AccountPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number(use(params).id);
  const router = useRouter();
  const { groupName } = useOps();
  const {
    data: d,
    error,
    refetch,
  } = useQuery({ queryKey: qk.accountFull(id), queryFn: () => get<Full>(`/accounts/${id}/full`) });
  const [range, setRange] = useState("6h");
  const mon = useMonitor(range, [id]);
  const [testOpen, setTestOpen] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [confirm, confirmEl] = useConfirm();
  const now = useNow();
  const removeTab = useTabsStore((st) => st.removeTab);
  useTabTitle(d?.account.name);

  if (error) return <p className="text-destructive">{error.message}</p>;
  if (!d) return <Skeleton className="h-96" />;
  const a = d.account;
  const c = a.credentials || {};
  const st = d.stats;
  const p = d.perf_1h;
  const e24 = d.errors_24h;
  const mm = Object.entries(c.model_mapping || {});
  const errTotal = (e24.dead || 0) + (e24.fail || 0) + (e24.r429 || 0);
  const m = mon.data?.accounts[id];

  const clearError = async () => {
    try {
      await post(`/accounts/${id}/clear-error`);
      toast.success("已清除错误");
      refetch();
    } catch (e) {
      toast.error(readErr(e));
    }
  };
  const remove = async () => {
    if (
      !(await confirm({
        title: "删除账号",
        description: `将从 sub2api 永久删除「${a.name}」，所有分组都不再使用它，不可恢复。`,
        typeToConfirm: a.name,
        destructive: true,
        confirmText: "删除",
      }))
    )
      return;
    try {
      await del(`/accounts/${id}`);
      toast.success("已删除");
      router.push("/dashboard/accounts");
      removeTab(`/dashboard/accounts/${id}`); // 已删除的详情页不再留在标签栏
    } catch (e) {
      toast.error(readErr(e));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        back={
          <Link
            prefetch={false}
            href="/dashboard/accounts"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
          >
            <ArrowLeft className="size-4" />
            账号
          </Link>
        }
        title={
          <>
            {a.name} <span className="text-muted-foreground text-sm font-normal">#{a.id}</span>{" "}
            <PlatformBadge platform={a.platform} /> <Tag>{a.type}</Tag> <AccountStatus a={a} />
          </>
        }
        actions={
          <>
            <Button variant="outline" onClick={() => setTestOpen(true)}>
              <PlugZap />
              测试连接
            </Button>
            {a.status === "error" ? (
              <Button variant="outline" onClick={clearError}>
                清除错误
              </Button>
            ) : null}
            <Button asChild>
              <Link prefetch={false} href={`/dashboard/accounts/${id}/edit`}>
                <Pencil />
                编辑
              </Link>
            </Button>
            <Button variant="outline" className="text-destructive" onClick={remove}>
              <Trash2 />
              删除
            </Button>
          </>
        }
      />
      {a.error_message ? <p className="text-danger text-sm">错误信息：{a.error_message}</p> : null}
      {a.temp_unschedulable_until && new Date(a.temp_unschedulable_until).getTime() > now ? (
        <p className="text-warning text-sm">
          临时不可调度至 {time(a.temp_unschedulable_until)}：{a.temp_unschedulable_reason}
        </p>
      ) : null}

      <StatCards
        cols={5}
        items={[
          {
            label: "今日请求 / 费用",
            value: num(st.today_n),
            sub: `${money(st.today_cost)} · ${bigNum(st.today_tokens)} tokens`,
          },
          { label: "近 7 天", value: money(st.d7_cost), sub: `${num(st.d7_n)} 次 · ${bigNum(st.d7_tokens)} tokens` },
          { label: "近 1 小时首字 P50 / P90", value: ms(p.p50), sub: `P90 ${ms(p.p90)} · ${num(p.n)} 次` },
          { label: "缓存命中率（按 token）", value: pct(p.cache_today), sub: `今日 · 近 1 小时 ${pct(p.cache)}` },
          {
            label: "24h 报错（账号原因）",
            value: num(errTotal),
            className: errTotal ? "text-danger" : "",
            sub: `死亡 ${e24.dead || 0} · 故障 ${e24.fail || 0} · 429 ${e24.r429 || 0} · 客户端 ${e24.client || 0}`,
          },
        ]}
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            延迟监控 {m ? <GradeBadge score={m.score} /> : null}
          </CardTitle>
          <CardDescription className="space-y-1">
            <div>按真实流量每 {mon.data?.bucket_min ?? "-"} 分钟一格；悬停查看每段的请求数、首字 P50/P90 和错误。</div>
            <Legend />
          </CardDescription>
          <CardAction>
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
          </CardAction>
        </CardHeader>
        <CardContent className="overflow-x-auto pt-2">
          {m && mon.data ? (
            <LatencyBar cells={accountCells(m.samples, mon.data.bucket_min)} size="lg" />
          ) : (
            <Skeleton className="h-8" />
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>连接与模型</CardTitle>
          </CardHeader>
          <CardContent>
            <Kv
              rows={[
                [
                  "上游地址",
                  <span key="u" className="font-mono">
                    {c.base_url || "-"}
                  </span>,
                ],
                [
                  "API Key",
                  a.credentials_status?.has_api_key ? (
                    <>
                      <Tag tone="ok">已配置</Tag>{" "}
                      <span className="text-muted-foreground text-xs">（sub2api 不回传明文）</span>
                    </>
                  ) : (
                    <Tag tone="bad">未配置</Tag>
                  ),
                ],
                [
                  "号池模式",
                  c.pool_mode
                    ? `开 · 重试 ${c.pool_mode_retry_count ?? 0} 次${c.pool_mode_retry_status_codes ? ` · 状态码 ${c.pool_mode_retry_status_codes.join("/")}` : ""}`
                    : "关",
                ],
                [
                  "透传",
                  a.extra?.anthropic_passthrough || a.extra?.openai_passthrough ? <Tag tone="info">开</Tag> : "关",
                ],
                [
                  "模型映射",
                  mm.length ? (
                    <div>
                      {mm.length} 条{" "}
                      <button
                        type="button"
                        className="text-primary text-xs hover:underline"
                        onClick={() => setShowMap((v) => !v)}
                      >
                        {showMap ? "收起" : "展开"}
                      </button>
                      {showMap ? (
                        <div className="mt-1 space-y-0.5 font-mono text-xs">
                          {mm.map(([k, v]) => (
                            <div key={k}>
                              {k}
                              {k !== v ? <b> → {v}</b> : null}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <span className="text-muted-foreground">未设置</span>
                  ),
                ],
                ["上游计费探测", a.extra?.upstream_billing_probe_enabled ? "开" : "关"],
              ]}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>调度</CardTitle>
          </CardHeader>
          <CardContent>
            <Kv
              rows={[
                [
                  "分组",
                  a.group_ids?.length ? (
                    <span className="inline-flex flex-wrap gap-1">
                      {a.group_ids.map((g) => (
                        <Link key={g} prefetch={false} href={`/dashboard/groups/${g}`}>
                          <Tag tone="info">{groupName(g)}</Tag>
                        </Link>
                      ))}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">未分组</span>
                  ),
                ],
                [
                  "优先级 / 并发",
                  `${a.priority} / ${a.current_concurrency ?? 0}/${a.concurrency}${a.load_factor ? ` · 负载系数 ${a.load_factor}` : ""}`,
                ],
                ["账号倍率", String(a.rate_multiplier ?? 1)],
                ["代理", a.proxy_id ? `#${a.proxy_id}` : <span className="text-muted-foreground">不使用</span>],
                [
                  "过期时间",
                  a.expires_at ? (
                    `${time(a.expires_at)}${a.auto_pause_on_expired ? "（到期自动暂停）" : ""}`
                  ) : (
                    <span className="text-muted-foreground">不过期</span>
                  ),
                ],
                [
                  "智能调度",
                  d.sched.groups.length ? (
                    <span className="inline-flex flex-wrap items-center gap-1">
                      已关联{" "}
                      {d.sched.groups.map((g) => (
                        <Link
                          key={g}
                          prefetch={false}
                          href={`/dashboard/groups/${g}`}
                          className="text-primary hover:underline"
                        >
                          {groupName(g)}
                        </Link>
                      ))}{" "}
                      · <BreakerBadge breaker={d.sched.breaker || "closed"} reason={d.sched.reason} />{" "}
                      {d.sched.breaker === "open" ? d.sched.reason : null}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">未关联</span>
                  ),
                ],
                [
                  "深度检测",
                  <DetectCell key="dt" a={{ id, name: a.name, detect: d.detect }} onChanged={() => refetch()} />,
                ],
                ["最近使用 / 创建", `${ago(a.last_used_at)} · ${time(a.created_at)}`],
                ...(a.notes ? ([["备注", a.notes]] as [string, React.ReactNode][]) : []),
              ]}
            />
          </CardContent>
        </Card>
      </div>
      <Logs id={id} />
      <TestDialog
        open={testOpen}
        onOpenChange={setTestOpen}
        id={id}
        name={a.name}
        defaultModel={mm.find(([k]) => /opus-5|gpt-5\.5/.test(k))?.[0] ?? ""}
      />
      {confirmEl}
    </div>
  );
}
