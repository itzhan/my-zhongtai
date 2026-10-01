"use client";

import { use, useMemo, useState } from "react";

import Link from "next/link";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { get, post, put } from "@/modules/ops/api";
import { MONITOR_RANGES, PrioInput, useBulk } from "@/modules/ops/components/account-table";
import { AccountStatus, BreakerBadge, PlatformBadge, ScoreBadge, Tag } from "@/modules/ops/components/badges";
import { DetectCell, type DetectInfo } from "@/modules/ops/components/detect";
import { AccountErrorsDialog } from "@/modules/ops/components/dialogs";
import { GroupSwitches } from "@/modules/ops/components/group-switches";
import { GradeBadge, LatencyBar, accountCells } from "@/modules/ops/components/latency-bar";
import { PageHeader, Pager, useConfirm, usePaged } from "@/modules/ops/components/shared";
import { ms, num, pct, readErr } from "@/modules/ops/format";
import { qk, useMonitor } from "@/modules/ops/hooks";
import type { Account } from "@/modules/ops/types";
import { useTabTitle } from "@/stores/tabs/tab-store-provider";

type Cell = {
  account_id: number;
  name: string;
  n: number;
  errors: number;
  p50: number | null;
  p90: number | null;
  cache: number | null;
  err: number;
  score: number | null;
};
type GAccount = Account & {
  in_group: boolean;
  enrolled: boolean;
  other_sched_groups: number[];
  breaker: string;
  breaker_reason?: string;
  probe_fails: number;
  last_probe?: { ok: boolean; model?: string } | null;
  probation_until?: number | null;
  live: { ok: number; fail: number; dead: number; r429: number } | null;
  detect?: DetectInfo;
  stats: {
    n: number;
    errors: number;
    p50: number | null;
    p90: number | null;
    cache: number | null;
    err: number;
    score: number | null;
  } | null;
  overall: { score: number; suggested: number } | null;
};
type GroupDetail = {
  group: {
    id: number;
    name: string;
    platform: string;
    model_routing_enabled: boolean;
    model_routing: Record<string, { id: number; name: string }[]>;
  };
  cfg: {
    auto: boolean;
    routing: boolean;
    min_alive: number;
    probe_model: string;
    default_probe_model: string;
    min_samples: number;
    detect: boolean;
    detect_expect: string;
  };
  enabled: boolean;
  alive: number | null;
  accounts: GAccount[];
  cells: { model: string; accounts: Cell[] }[];
};

function AddMembersDialog({
  open,
  onOpenChange,
  gid,
  gname,
  platform,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  gid: number;
  gname: string;
  platform: string;
  onDone: () => void;
}) {
  const all = useQuery({ queryKey: qk.accounts, queryFn: () => get<Account[]>("/accounts"), enabled: open });
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [enroll, setEnroll] = useState(true);
  const [confirm, confirmEl] = useConfirm();
  const cands = (all.data ?? [])
    .filter((a) => !a.group_ids.includes(gid) && a.name.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (a.platform === platform ? 0 : 1) - (b.platform === platform ? 0 : 1) || a.id - b.id);
  const submit = async () => {
    const ids = [...sel];
    if (!ids.length) return toast.error("先勾选账号");
    const send = async (mixed: boolean): Promise<{ results: { id: number; ok: boolean; error?: string }[] }> => {
      const r = await post<{ results: { id: number; ok: boolean; error?: string }[] }>(`/sched/groups/${gid}/members`, {
        add: ids,
        confirm_mixed_channel_risk: mixed,
      });
      const m = r.results.filter((x) => !x.ok && /mixed_channel/.test(x.error ?? ""));
      if (
        m.length &&
        !mixed &&
        (await confirm({ title: "混合渠道风险", description: `sub2api 提示：${m[0]!.error}。仍要加入？` }))
      )
        return send(true);
      return r;
    };
    try {
      const r = await send(false);
      const okIds = r.results.filter((x) => x.ok).map((x) => x.id);
      if (okIds.length && enroll) await post(`/sched/groups/${gid}/enroll`, { account_ids: okIds, enrolled: true });
      const bad = r.results.filter((x) => !x.ok);
      if (bad.length) toast.error(`加入 ${okIds.length} 个，失败 ${bad.length} 个：${bad[0]!.error}`);
      else toast.success(`已加入 ${okIds.length} 个账号`);
      onOpenChange(false);
      onDone();
    } catch (e) {
      toast.error(readErr(e));
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>把已有账号加入「{gname}」</DialogTitle>
        </DialogHeader>
        <Input placeholder="搜索账号" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="max-h-96 space-y-1 overflow-y-auto">
          {cands.length ? (
            cands.map((a) => (
              <label key={a.id} className="hover:bg-accent/50 flex items-center gap-2 rounded px-2 py-1.5 text-sm">
                <Checkbox
                  checked={sel.has(a.id)}
                  onCheckedChange={(v) =>
                    setSel((s) => {
                      const n = new Set(s);
                      if (v) n.add(a.id);
                      else n.delete(a.id);
                      return n;
                    })
                  }
                />
                {a.name} <span className="text-muted-foreground text-xs">#{a.id}</span>{" "}
                <PlatformBadge platform={a.platform} /> <AccountStatus a={a} />
              </label>
            ))
          ) : (
            <p className="text-muted-foreground text-sm">{all.data ? "没有可加的账号" : "加载中…"}</p>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={enroll} onCheckedChange={(v) => setEnroll(!!v)} /> 加入后同时关联到智能调度
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={submit}>加入分组</Button>
        </div>
        {confirmEl}
      </DialogContent>
    </Dialog>
  );
}

export default function GroupPage({ params }: { params: Promise<{ id: string }> }) {
  const gid = Number(use(params).id);
  const {
    data: d,
    refetch,
    isFetching,
  } = useQuery({ queryKey: qk.schedGroup(gid), queryFn: () => get<GroupDetail>(`/sched/groups/${gid}`) });
  useTabTitle(d?.group.name);
  const [range, setRange] = useState("2h");
  const rows = useMemo(
    () => [...(d?.accounts ?? [])].sort((a, b) => Number(b.enrolled) - Number(a.enrolled) || a.priority - b.priority),
    [d],
  );
  const { rows: pageRows, pager } = usePaged(rows);
  const { rows: cells, pager: cellPager } = usePaged(d?.cells ?? []);
  // 延迟条只查当前页的账号
  const mon = useMonitor(
    range,
    pageRows.map((a) => a.id),
  );
  const { bulk, confirm, confirmEl } = useBulk();
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [errorsFor, setErrorsFor] = useState<Account | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const reload = () => refetch();

  if (!d) return <Skeleton className="h-96" />;
  const g = d.group;
  const enrolledN = d.accounts.filter((a) => a.enrolled).length;

  const setCfg = async (body: Record<string, unknown>, msg: string) => {
    try {
      await put(`/sched/groups/${gid}`, body);
      toast.success(msg);
      reload();
    } catch (e) {
      toast.error(readErr(e));
    }
  };
  const enroll = async (ids: number[], on: boolean) => {
    try {
      await post(`/sched/groups/${gid}/enroll`, { account_ids: ids, enrolled: on });
      toast.success(on ? `已关联 ${ids.length} 个账号` : `已取消关联 ${ids.length} 个账号（已恢复它们原来的设置）`);
      reload();
    } catch (e) {
      toast.error(readErr(e));
    }
  };
  const removeFromGroup = async (ids: number[]) => {
    if (
      !(await confirm({
        title: `把 ${ids.length} 个账号移出「${g.name}」？`,
        description: "这些账号将不再服务这个分组（直接修改 sub2api）。",
        destructive: true,
        confirmText: "移出",
      }))
    )
      return;
    try {
      const r = await post<{ results: { ok: boolean; error?: string }[] }>(`/sched/groups/${gid}/members`, {
        remove: ids,
      });
      const bad = r.results.filter((x) => !x.ok);
      if (bad.length) toast.error(`失败 ${bad.length} 个：${bad[0]!.error}`);
      else toast.success("已移出分组");
      reload();
    } catch (e) {
      toast.error(readErr(e));
    }
  };
  const probe = async (id: number) => {
    try {
      const r = await post<{ ok: boolean; ms: number; msg: string }>(`/sched/accounts/${id}/probe`);
      if (r.ok) toast.success(`探测通过（${r.ms}ms）`);
      else toast.error(`探测失败：${r.msg}`);
    } catch (e) {
      toast.error(readErr(e));
    }
  };
  const setStatus = async (a: GAccount, on: boolean) => {
    if (
      !on &&
      !(await confirm({
        title: "禁用这个账号？",
        description: "所有分组都不会再调度到它。",
        destructive: true,
        confirmText: "禁用",
      }))
    )
      return;
    await bulk([a.id], { status: on ? "active" : "inactive" }, on ? "已启用" : "已禁用");
    reload();
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        back={
          <Link
            prefetch={false}
            href="/dashboard/channels?tab=sched"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
          >
            <ArrowLeft className="size-4" />
            渠道配置 · 智能调度
          </Link>
        }
        title={
          <>
            {g.name} <PlatformBadge platform={g.platform} />
          </>
        }
        actions={
          <>
            <Button variant="outline" onClick={reload} disabled={isFetching}>
              <RefreshCw className={cn(isFetching && "animate-spin")} />
              刷新
            </Button>
            <Button variant="outline" onClick={() => setAddOpen(true)}>
              <Plus />
              加入已有账号
            </Button>
            <Button asChild>
              <Link prefetch={false} href={`/dashboard/accounts/new?group=${gid}`}>
                <Plus />
                新建账号
              </Link>
            </Button>
          </>
        }
      />
      {!d.enabled ? (
        <p className="text-warning text-sm">智能调度总开关是关的，下面的分组开关不会生效。去「智能调度」页打开。</p>
      ) : null}
      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <GroupSwitches
              g={{ id: gid, auto: d.cfg.auto, routing: d.cfg.routing }}
              onChanged={reload}
              asCells={false}
            />
            <label className="flex items-center gap-2 text-sm">
              最少存活
              <Input
                type="number"
                min={0}
                className="h-8 w-16"
                defaultValue={d.cfg.min_alive}
                onBlur={(e) =>
                  +e.target.value !== d.cfg.min_alive && setCfg({ minAlive: e.target.value }, "已保存最少存活数")
                }
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              深度检测（每 5 分钟）
              <Switch
                checked={d.cfg.detect}
                onCheckedChange={(v) => setCfg({ detect: v }, v ? "已开启深度检测" : "已关闭深度检测")}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              期望上游
              <Select
                value={d.cfg.detect_expect === "bedrock" ? "bedrock" : "any"}
                onValueChange={(v) =>
                  setCfg({ detectExpect: v }, `期望上游：${v === "bedrock" ? "AWS Bedrock" : "不限"}`)
                }
              >
                <SelectTrigger size="sm" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">不限</SelectItem>
                  <SelectItem value="bedrock">AWS Bedrock</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              探测/检测模型
              <Input
                className="h-8 w-48"
                defaultValue={d.cfg.probe_model}
                placeholder={`默认 ${d.cfg.default_probe_model}`}
                onBlur={(e) =>
                  e.target.value !== d.cfg.probe_model &&
                  setCfg(
                    { probeModel: e.target.value },
                    e.target.value.trim() ? `探测模型改为 ${e.target.value.trim()}` : "探测模型恢复默认",
                  )
                }
              />
            </label>
            <span className="text-sm">
              关联存活：
              {d.alive == null ? (
                <span className="text-muted-foreground">未关联账号</span>
              ) : (
                <Tag tone={d.alive >= d.cfg.min_alive ? "ok" : "bad"}>
                  {d.alive} / {d.cfg.min_alive}
                </Tag>
              )}
            </span>
            <span className="text-muted-foreground text-sm">
              已关联 {enrolledN} / {d.accounts.length} 个账号
            </span>
          </div>
          <p className="text-muted-foreground text-xs">
            勾选「关联」的账号才会被监测和自动调整：熔断（停调度）→ 每 30 秒探测 → 通过后以优先级 10 观察 5 分钟 →
            按评分回到 1~10。评分 = 首字延迟 40% + 缓存命中 30% + 错误率
            30%（组内同模型对比）。优先级是账号级别的，一个账号在多个分组时会互相影响。
          </p>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {sel.size ? (
            <div className="bg-muted/60 flex items-center gap-2 rounded-md px-3 py-2 text-sm">
              <b>已选 {sel.size} 个</b>
              <Button size="sm" variant="outline" onClick={() => enroll([...sel], true)}>
                关联
              </Button>
              <Button size="sm" variant="outline" onClick={() => enroll([...sel], false)}>
                取消关联
              </Button>
              <Button size="sm" variant="outline" onClick={() => removeFromGroup([...sel])}>
                移出分组
              </Button>
            </div>
          ) : null}
          <div className="text-muted-foreground ml-auto flex items-center gap-2 text-xs">
            延迟条
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              value={range}
              onValueChange={(v) => v && setRange(v)}
            >
              {MONITOR_RANGES.map(([k, l]) => (
                <ToggleGroupItem key={k} value={k} className="px-2 text-xs">
                  {l}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </div>
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <Checkbox
                    checked={pageRows.length > 0 && pageRows.every((a) => sel.has(a.id))}
                    onCheckedChange={(v) => setSel(v ? new Set(pageRows.map((a) => a.id)) : new Set())}
                  />
                </TableHead>
                <TableHead>关联</TableHead>
                <TableHead>账号</TableHead>
                <TableHead>延迟（首字）</TableHead>
                <TableHead>调度状态</TableHead>
                <TableHead>sub2api 状态</TableHead>
                <TableHead>优先级</TableHead>
                <TableHead>建议</TableHead>
                <TableHead>评分</TableHead>
                <TableHead className="text-right">首字 P50 / P90</TableHead>
                <TableHead className="text-right" title="近 30 分钟，按 token 加权：Σ缓存读 / Σ(输入+缓存读+缓存写)">
                  缓存命中
                </TableHead>
                <TableHead className="text-right">30 分钟 请求 / 错误率</TableHead>
                <TableHead className="text-right">1 分钟 成功/失败/死亡/429</TableHead>
                <TableHead className="text-right">并发</TableHead>
                <TableHead>深度检测</TableHead>
                <TableHead>启用</TableHead>
                <TableHead>调度</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length ? (
                pageRows.map((a) => {
                  const st = a.stats;
                  const l = a.live;
                  const m = mon.data?.accounts[a.id];
                  return (
                    <TableRow key={a.id} className={cn(!a.enrolled && "opacity-70")}>
                      <TableCell>
                        <Checkbox
                          checked={sel.has(a.id)}
                          onCheckedChange={(v) =>
                            setSel((s) => {
                              const n = new Set(s);
                              if (v) n.add(a.id);
                              else n.delete(a.id);
                              return n;
                            })
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <Switch checked={a.enrolled} onCheckedChange={(v) => enroll([a.id], v)} />
                      </TableCell>
                      <TableCell className="min-w-44">
                        <Link
                          prefetch={false}
                          href={`/dashboard/accounts/${a.id}`}
                          className="font-medium hover:underline"
                        >
                          {a.name}
                        </Link>{" "}
                        <span className="text-muted-foreground text-xs">#{a.id}</span>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1">
                          <PlatformBadge platform={a.platform} />
                          {!a.in_group ? <Tag tone="bad">已不在此分组</Tag> : null}
                          {a.other_sched_groups.length ? (
                            <Tag tone="info" title="也在其他分组被关联">
                              多分组
                            </Tag>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        {m && mon.data ? (
                          <div className="flex items-center gap-2">
                            <LatencyBar cells={accountCells(m.samples, mon.data.bucket_min)} />
                            <GradeBadge score={m.score} />
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="min-w-28">
                        {a.enrolled ? (
                          <>
                            <BreakerBadge breaker={a.breaker} reason={a.breaker_reason} until={a.probation_until} />
                            {a.breaker === "open" ? (
                              <div className="text-muted-foreground mt-1 text-xs">
                                <div className="text-danger max-w-48 truncate" title={a.breaker_reason}>
                                  {a.breaker_reason}
                                </div>
                                已探测 {a.probe_fails} 次
                                {a.last_probe
                                  ? ` · ${a.last_probe.ok ? "上次通过" : "上次失败"}（${a.last_probe.model ?? ""}）`
                                  : ""}
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-muted-foreground text-xs">未关联</span>
                        )}
                      </TableCell>
                      <TableCell className="min-w-28">
                        <AccountStatus a={a} />
                        {a.error_message ? (
                          <div className="text-danger mt-1 max-w-48 truncate text-xs" title={a.error_message}>
                            {a.error_message}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <PrioInput
                          a={a}
                          onSave={async (v) => {
                            const ok = await bulk([a.id], { priority: v }, `优先级已改为 ${v}`);
                            reload();
                            return ok;
                          }}
                        />
                      </TableCell>
                      <TableCell>
                        {a.overall ? (
                          <b>{a.overall.suggested}</b>
                        ) : (
                          <span className="text-muted-foreground text-xs">
                            {!a.enrolled
                              ? "未关联"
                              : st
                                ? `样本不足 ${st.n + st.errors}/${d.cfg.min_samples}`
                                : "近 30 分钟无请求"}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <ScoreBadge v={st?.score} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {st?.p50 ? (
                          `${ms(st.p50)} / ${ms(st.p90)}`
                        ) : (
                          <span className="text-muted-foreground text-xs">{st ? "无流式请求" : "-"}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{pct(st?.cache)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {st ? (
                          <>
                            {num(st.n + st.errors)} /{" "}
                            <span className={cn(st.err > 0.05 && "text-danger")}>{pct(st.err)}</span>
                          </>
                        ) : (
                          "-"
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {l ? `${l.ok} / ${l.fail} / ${l.dead} / ${l.r429}` : "-"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {a.current_concurrency ?? 0}/{a.concurrency}
                        {a.load_factor && a.load_factor !== a.concurrency ? (
                          <div className="text-muted-foreground text-xs">负载系数 {a.load_factor}</div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <DetectCell a={a} onChanged={reload} />
                      </TableCell>
                      <TableCell>
                        <Switch checked={a.status !== "inactive"} onCheckedChange={(v) => setStatus(a, v)} />
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={a.schedulable}
                          onCheckedChange={async (v) => {
                            await bulk([a.id], { schedulable: v }, v ? "已开启调度" : "已停止调度");
                            reload();
                          }}
                        />
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <div className="flex gap-2 text-sm">
                          <button type="button" className="text-primary hover:underline" onClick={() => probe(a.id)}>
                            探测
                          </button>
                          <button
                            type="button"
                            className="text-primary hover:underline"
                            onClick={() => setErrorsFor(a)}
                          >
                            报错
                          </button>
                          <button
                            type="button"
                            className="text-muted-foreground hover:underline"
                            onClick={() => removeFromGroup([a.id])}
                          >
                            移出
                          </button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={18} className="text-muted-foreground py-10 text-center">
                    分组里没有账号
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <Pager {...pager} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>模型路由 · 各模型账号排名</CardTitle>
          <CardDescription>近 30 分钟，仅已关联账号</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {d.cells.length ? (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>模型</TableHead>
                    <TableHead className="text-right">请求</TableHead>
                    <TableHead>账号排名（评分 · 首字 P50 · 缓存命中 · 错误率）</TableHead>
                    <TableHead>sub2api 当前路由</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cells.map((c) => (
                    <TableRow key={c.model}>
                      <TableCell className="font-medium">{c.model}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {num(c.accounts.reduce((s, x) => s + x.n, 0))}
                      </TableCell>
                      <TableCell className="space-y-1">
                        {c.accounts.map((x, i) => (
                          <div key={x.account_id} className="flex flex-wrap items-center gap-1.5 text-sm">
                            <span className="text-muted-foreground text-xs">{i + 1}.</span>
                            {x.name} <ScoreBadge v={x.score} />
                            <span className="text-muted-foreground text-xs">
                              {ms(x.p50)} · {pct(x.cache)} · {pct(x.err)}
                              {x.score == null ? " · 样本不足" : ""}
                            </span>
                          </div>
                        ))}
                      </TableCell>
                      <TableCell className="text-xs">
                        {(g.model_routing[c.model] || []).map((x) => x.name).join(" / ") || (
                          <span className="text-muted-foreground">未设置（整组调度）</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pager {...cellPager} className="border-t px-4 py-2" />
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              还没有评分数据。关联账号后，引擎每 5 分钟统计一次近 30 分钟的数据；每个账号在每个模型上至少要有 20
              个请求才会评分。
            </p>
          )}
          {g.model_routing_enabled ? (
            <p className="text-muted-foreground text-xs">
              sub2api 模型路由已开启：
              {Object.entries(g.model_routing)
                .map(([m, ids]) => `${m} → ${ids.map((x) => x.name).join(" / ")}`)
                .join("；")}
            </p>
          ) : null}
        </CardContent>
      </Card>
      <AddMembersDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        gid={gid}
        gname={g.name}
        platform={g.platform}
        onDone={reload}
      />
      <AccountErrorsDialog account={errorsFor} onClose={() => setErrorsFor(null)} />
      {confirmEl}
    </div>
  );
}
