"use client";

import { useEffect, useState } from "react";

import Link from "next/link";

import { useQuery } from "@tanstack/react-query";
import { Play, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { get, post, put } from "@/modules/ops/api";
import { Tag, type Tone } from "@/modules/ops/components/badges";
import { GroupSwitches, type SchedGroupRow } from "@/modules/ops/components/group-switches";
import { PageHeader, Pager, useConfirm, usePaged } from "@/modules/ops/components/shared";
import { ago, readErr, time } from "@/modules/ops/format";
import { qk } from "@/modules/ops/hooks";
import type { Alert } from "@/modules/ops/types";

type Config = Record<string, unknown> & { probeModel?: string };
type Overview = {
  enabled: boolean;
  config: Config;
  lastFast: string | null;
  lastScore: string | null;
  lastError: string | null;
  alerts: Alert[];
  groups: SchedGroupRow[];
};
type AuditRow = {
  t: string;
  level: string;
  account_id?: number;
  account_name?: string;
  group_id?: number;
  msg: string;
};

const PARAMS: [string, string][] = [
  ["minAlive", "每组最少存活账号"],
  ["breaker.deadCount", "死亡类错误（401/403/额度）N 次熔断"],
  ["breaker.consecFail", "连续上游失败 N 次熔断"],
  ["breaker.errRate", "错误率熔断阈值（0~1）"],
  ["breaker.minReq", "错误率判定最少请求数"],
  ["breaker.windowSec", "熔断统计窗口（秒）"],
  ["probeIntervalSec", "熔断后探测间隔（秒）"],
  ["probationMin", "恢复后观察期（分钟）"],
  ["scoreWindowMin", "评分统计窗口（分钟）"],
  ["minSamples", "评分最少样本数"],
  ["weights.ttft", "权重：首字延迟"],
  ["weights.cache", "权重：缓存命中"],
  ["weights.err", "权重：错误率"],
  ["maxStep", "单次优先级最多变化"],
  ["changeCooldownMin", "优先级调整冷却（分钟）"],
  ["headroom", "并发占用超过此比例挡新会话（0~1）"],
  ["routingTopK", "每个模型路由候选数"],
  ["routingExpandLoad", "候选平均负载超过此值再加一个（0~1）"],
];
const pathGet = (o: Config, p: string) =>
  p.split(".").reduce<unknown>((x, k) => (x as Record<string, unknown> | undefined)?.[k], o);
const LV: Record<string, [Tone, string]> = {
  action: ["info", "调整"],
  alert: ["bad", "报警"],
  suggest: ["warn", "建议"],
  info: ["muted", "信息"],
};
const ALL = "all";

export default function SchedPage() {
  const ov = useQuery({ queryKey: qk.schedOverview, queryFn: () => get<Overview>("/sched/overview") });
  const audit = useQuery({ queryKey: qk.audit, queryFn: () => get<AuditRow[]>("/sched/audit?limit=300") });
  const [confirm, confirmEl] = useConfirm();
  const [cfg, setCfg] = useState<Record<string, string>>({});
  const [lv, setLv] = useState(ALL);
  const [busy, setBusy] = useState(false);
  const d = ov.data;
  useEffect(() => {
    if (!d) return;
    setCfg(
      Object.fromEntries([
        ...PARAMS.map(([k]) => [k, String(pathGet(d.config, k) ?? "")]),
        ["probeModel", String(d.config.probeModel ?? "")],
      ]),
    );
  }, [d]);
  const reload = () => {
    ov.refetch();
    audit.refetch();
  };
  const { rows: on, pager: onPager } = usePaged((d?.groups ?? []).filter((g) => g.enrolled_count));
  const logs = (audit.data ?? []).filter((e) => lv === ALL || e.level === lv);
  const { rows, pager: logPager } = usePaged(logs, lv);
  if (!d) return <Skeleton className="h-96" />;

  const setMaster = async (v: boolean) => {
    try {
      await put("/sched/config", { enabled: v });
      toast.success(v ? "智能调度已开启" : "智能调度已关闭（仅监测）");
      reload();
    } catch (e) {
      toast.error(readErr(e));
    }
  };
  const saveCfg = async () => {
    const out: Record<string, unknown> = {};
    for (const [k] of PARAMS) {
      const path = k.split(".");
      let o = out;
      path.slice(0, -1).forEach((p) => (o = (o[p] as Record<string, unknown>) ||= {}));
      o[path.at(-1)!] = Number(cfg[k]);
    }
    out.probeModel = (cfg.probeModel ?? "").trim();
    try {
      await put("/sched/config", { config: out });
      toast.success("参数已保存");
      reload();
    } catch (e) {
      toast.error(readErr(e));
    }
  };
  const run = async () => {
    setBusy(true);
    try {
      const r = await post<{ lastError: string | null }>("/sched/run");
      if (r.lastError) toast.error(`运行完成，但有异常：${r.lastError}`);
      else toast.success("已运行一次");
      reload();
    } catch (e) {
      toast.error(readErr(e));
    } finally {
      setBusy(false);
    }
  };
  const restore = async () => {
    if (
      !(await confirm({
        title: "一键还原？",
        description:
          "所有分组关闭智能调度和自动路由，关联账号的优先级、负载系数、调度状态恢复为关联前的值，分组路由恢复为开启前的配置。关联关系会保留。",
        destructive: true,
        confirmText: "还原",
      }))
    )
      return;
    try {
      await post("/sched/restore");
      toast.success("已还原");
      reload();
    } catch (e) {
      toast.error(readErr(e));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="智能调度"
        description={`快循环 ${d.lastFast ? ago(d.lastFast) : "未运行"} · 评分 ${d.lastScore ? ago(d.lastScore) : "未运行"}`}
        actions={
          <>
            <Button variant="outline" onClick={run} disabled={busy}>
              <Play />
              立即运行一次
            </Button>
            <Button variant="outline" className="text-destructive" onClick={restore}>
              <RotateCcw />
              一键还原
            </Button>
          </>
        }
      />
      {d.lastError ? <p className="text-danger text-sm">引擎异常：{d.lastError}</p> : null}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 font-medium">
            总开关 <Switch checked={d.enabled} onCheckedChange={setMaster} />
          </label>
          <span className="text-muted-foreground text-sm">
            关掉后引擎只监测和报警，不做任何调整。每个分组还需要单独开「智能调度」，并且只作用于在分组里关联的账号。
          </span>
        </CardContent>
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>已关联的分组</CardTitle>
          </CardHeader>
          <CardContent>
            {on.length ? (
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>分组</TableHead>
                      <TableHead className="text-right">已关联</TableHead>
                      <TableHead>存活 / 最少</TableHead>
                      <TableHead>智能调度</TableHead>
                      <TableHead>自动路由</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {on.map((g) => (
                      <TableRow key={g.id}>
                        <TableCell>
                          <Link prefetch={false} href={`/dashboard/groups/${g.id}`} className="hover:underline">
                            {g.name}
                          </Link>
                        </TableCell>
                        <TableCell className="text-right">{g.enrolled_count}</TableCell>
                        <TableCell>
                          <Tag tone={(g.alive ?? 0) >= g.min_alive ? "ok" : "bad"}>
                            {g.alive} / {g.min_alive}
                          </Tag>
                        </TableCell>
                        <GroupSwitches g={g} onChanged={reload} />
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <Pager {...onPager} className="mt-3" />
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">
                还没有关联任何账号。去{" "}
                <Link prefetch={false} href="/dashboard/groups" className="text-primary hover:underline">
                  分组
                </Link>{" "}
                进入某个分组，打开账号的「关联」开关。
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>当前报警（{d.alerts.length}）</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {d.alerts.length ? (
              d.alerts.map((a, i) => (
                <div key={i} className="flex items-start gap-2 text-sm">
                  <Tag tone={a.level === "critical" ? "bad" : "warn"}>{a.level === "critical" ? "紧急" : "警告"}</Tag>
                  {a.msg}
                </div>
              ))
            ) : (
              <span className="text-muted-foreground text-sm">无</span>
            )}
          </CardContent>
        </Card>
      </div>
      <Collapsible className="bg-card rounded-xl border">
        <CollapsibleTrigger className="w-full px-6 py-4 text-left">
          <b>参数设置</b>{" "}
          <span className="text-muted-foreground text-sm">（默认值已经按「快、稳、保缓存」调好，一般不用改）▾</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 px-6 pb-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {PARAMS.map(([k, l]) => (
              <div key={k} className="space-y-1">
                <Label className="text-xs">{l}</Label>
                <Input
                  type="number"
                  step="any"
                  value={cfg[k] ?? ""}
                  onChange={(e) => setCfg({ ...cfg, [k]: e.target.value })}
                />
              </div>
            ))}
            <div className="space-y-1">
              <Label className="text-xs">默认探测模型（分组没自定义时用）</Label>
              <Input value={cfg.probeModel ?? ""} onChange={(e) => setCfg({ ...cfg, probeModel: e.target.value })} />
            </div>
          </div>
          <Button onClick={saveCfg}>保存参数</Button>
        </CollapsibleContent>
      </Collapsible>
      <Card>
        <CardHeader>
          <CardTitle>决策日志</CardTitle>
          <CardDescription>最近 300 条</CardDescription>
          <CardAction>
            <Select value={lv} onValueChange={setLv}>
              <SelectTrigger size="sm" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部</SelectItem>
                <SelectItem value="action">执行的调整</SelectItem>
                <SelectItem value="alert">报警</SelectItem>
                <SelectItem value="suggest">建议（未开启自动时）</SelectItem>
                <SelectItem value="info">其他</SelectItem>
              </SelectContent>
            </Select>
          </CardAction>
        </CardHeader>
        <CardContent>
          <div className="max-h-[600px] overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>对象</TableHead>
                  <TableHead>内容</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.length ? (
                  rows.map((e, i) => (
                    <TableRow key={i}>
                      <TableCell className="whitespace-nowrap">{time(e.t)}</TableCell>
                      <TableCell>
                        <Tag tone={LV[e.level]?.[0] ?? "muted"}>{LV[e.level]?.[1] ?? e.level}</Tag>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {e.account_name ? (
                          <>
                            {e.account_name} <span className="text-muted-foreground text-xs">#{e.account_id}</span>
                          </>
                        ) : e.group_id ? (
                          `分组 #${e.group_id}`
                        ) : (
                          "-"
                        )}
                      </TableCell>
                      <TableCell className="min-w-96 text-sm whitespace-normal">{e.msg}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={4} className="text-muted-foreground py-8 text-center">
                      暂无记录
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <Pager {...logPager} className="mt-3" />
        </CardContent>
      </Card>
      {confirmEl}
    </div>
  );
}
