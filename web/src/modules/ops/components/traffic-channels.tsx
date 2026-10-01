"use client";

import { type ComponentProps, useEffect, useMemo, useState } from "react";

import { Loader2, Plus, TestTube2, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { get, post, put } from "../api";
import { ms, num, readErr, yuan } from "../format";
import { useInvalidate } from "../hooks";
import { type TChannel, type TGroup, type TGroupUsage, type TRealtime, type TTodayStats, useUserRpm } from "../traffic";

import { Tag } from "./badges";
import { Pager, ResponsiveDialog, usePaged } from "./shared";

const DEFAULT_TEST_MODEL = "claude-sonnet-4-6";
const barColor = (pct: number) => (pct >= 90 ? "bg-danger" : pct >= 70 ? "bg-warning" : "bg-primary");
const isErrored = (a: TChannel) => a.status === "error" || !!a.error_message?.trim();

function LoadBar({ value, max, className }: { value: number; max: number; className?: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className={cn("bg-muted h-2 flex-1 overflow-hidden rounded-full", className)}>
      <div className={cn("h-full transition-all", barColor(pct))} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ---------- 用户实时并发：当前并发最高的前 N 个用户，及各自近 1 分钟在哪些分组发请求 ----------
function TopUsers({ siteId, rt }: { siteId: number; rt: TRealtime | undefined }) {
  const [topN, setTopN] = useState(6);
  const top = useMemo(
    () =>
      Object.values(rt?.user ?? {})
        .filter((u) => u.current_in_use > 0)
        .sort((a, b) => b.current_in_use - a.current_in_use)
        .slice(0, topN),
    [rt, topN],
  );
  const rpm = useUserRpm(
    siteId,
    top.map((u) => u.user_id),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>用户实时并发</CardTitle>
        <CardDescription>每 2 秒刷新；分组用量为近 1 分钟请求数 / 限额</CardDescription>
        <CardAction className="text-muted-foreground flex items-center gap-1.5 text-xs">
          显示前
          <Input
            type="number"
            min={1}
            max={20}
            value={topN}
            onChange={(e) => setTopN(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
            className="h-7 w-16"
          />
          个
        </CardAction>
      </CardHeader>
      <CardContent>
        {!rt ? (
          <Skeleton className="h-20" />
        ) : rt.user_monitoring === false ? (
          <p className="text-muted-foreground text-sm">
            这台 sub2api 没有开启实时监控（在 sub2api 设置里打开 realtime monitoring 后才有用户并发）
          </p>
        ) : !top.length ? (
          <p className="text-muted-foreground text-sm">当前没有用户有进行中的请求</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {top.map((u) => {
              const r = rpm.data?.[u.user_id];
              // 只看近 1 分钟真有请求的分组（sub2api 会返回该用户可用的全部分组）
              const groups = (r?.per_group ?? [])
                .filter((g) => g.used > 0)
                .sort((a, b) => b.used - a.used)
                .slice(0, 4);
              return (
                <div key={u.user_id} className="bg-muted/30 rounded-md border p-2.5">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate font-medium" title={u.name}>
                      {u.name}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {u.current_in_use}
                      {u.max_capacity ? <span className="text-muted-foreground"> / {u.max_capacity}</span> : null}
                    </span>
                  </div>
                  {u.max_capacity ? (
                    <LoadBar value={u.current_in_use} max={u.max_capacity} className="mt-1 h-1.5" />
                  ) : null}
                  <div className="mt-2 space-y-0.5 text-xs">
                    {groups.length ? (
                      groups.map((g) => (
                        <div key={g.group_id} className="flex justify-between gap-2">
                          <span className="truncate">{g.group_name || `#${g.group_id}`}</span>
                          <span className="text-muted-foreground shrink-0 tabular-nums">
                            {g.used}
                            {g.limit ? ` / ${g.limit}` : ""}
                          </span>
                        </div>
                      ))
                    ) : (
                      <span className="text-muted-foreground">{r ? "近 1 分钟没有分组用量" : "加载中…"}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type TestResult = { kind: "pending" } | { kind: "ok"; ms: number } | { kind: "fail"; ms: number; output: string };

function TestChip({ r }: { r?: TestResult }) {
  if (!r) return null;
  if (r.kind === "pending")
    return (
      <span className="text-primary inline-flex items-center gap-0.5 text-[11px]">
        <Loader2 className="size-3 animate-spin" /> 测试中
      </span>
    );
  if (r.kind === "ok")
    return (
      <span
        className={cn("text-[11px] font-medium", r.ms < 5000 ? "text-success" : r.ms < 15000 ? "" : "text-warning")}
      >
        ✓ {ms(r.ms)}
      </span>
    );
  return (
    <span className="text-danger text-[11px] font-medium" title={r.output}>
      ✗ {ms(r.ms)}
    </span>
  );
}

// ---------- 一个分组：并发占用、渠道列表（按今日消费排序）、批量操作、一键测试 ----------
function GroupCard({
  siteId,
  group,
  channels,
  rt,
  stats,
  todayCost,
  onEdit,
}: {
  siteId: number;
  group: TGroup;
  channels: TChannel[];
  rt: TRealtime | undefined;
  stats: TTodayStats | undefined;
  todayCost: number;
  onEdit: (a: TChannel) => void;
}) {
  const invalidate = useInvalidate();
  const [search, setSearch] = useState("");
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [tests, setTests] = useState<Record<number, TestResult>>({});
  const [testing, setTesting] = useState(false);
  const inUse = (id: number) => rt?.account[id]?.current_in_use ?? 0;
  const inFlight = channels.reduce((s, a) => s + inUse(a.id), 0);
  const capacity = channels.reduce((s, a) => s + (a.concurrency || 0), 0);

  const sorted = useMemo(() => {
    const kw = search.trim().toLowerCase();
    return channels
      .filter((a) => !kw || a.name.toLowerCase().includes(kw))
      .sort(
        (a, b) =>
          (stats?.[b.id]?.user_cost ?? 0) - (stats?.[a.id]?.user_cost ?? 0) ||
          (rt?.account[b.id]?.current_in_use ?? 0) - (rt?.account[a.id]?.current_in_use ?? 0),
      );
  }, [channels, stats, rt, search]);
  const { rows, pager } = usePaged(sorted, search);
  const changed = () => invalidate("traffic");

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      changed();
      return true;
    } catch (e) {
      toast.error(readErr(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const bulk = async (status: "active" | "inactive") => {
    if (
      await run(
        () => post(`/traffic/${siteId}/channels/bulk-update`, { account_ids: [...sel], status }),
        `已${status === "active" ? "启用" : "停用"} ${sel.size} 个渠道`,
      )
    )
      setSel(new Set());
  };
  const clearError = (ids: number[]) =>
    run(() => post(`/traffic/${siteId}/channels/clear-error`, { account_ids: ids }), "已清除错误状态");
  const toggleSched = (a: TChannel) =>
    run(
      () => post(`/traffic/${siteId}/channels/${a.id}/schedulable`, { schedulable: !a.schedulable }),
      a.schedulable ? "已暂停调度" : "已加入调度",
    );

  // 一键测试：5 个并发，逐个测组内渠道（会真实请求上游）
  const testAll = async () => {
    setTesting(true);
    setTests(Object.fromEntries(sorted.map((a) => [a.id, { kind: "pending" } as TestResult])));
    const queue = [...sorted];
    const worker = async () => {
      for (let a = queue.shift(); a; a = queue.shift()) {
        const id = a.id;
        try {
          const r = await post<{ ok: boolean; latency_ms: number; output: string }>(
            `/traffic/${siteId}/channels/${id}/test`,
            {
              model: DEFAULT_TEST_MODEL,
            },
          );
          setTests((t) => ({
            ...t,
            [id]: r.ok ? { kind: "ok", ms: r.latency_ms } : { kind: "fail", ms: r.latency_ms, output: r.output },
          }));
        } catch (e) {
          setTests((t) => ({ ...t, [id]: { kind: "fail", ms: 0, output: readErr(e) } }));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, queue.length) }, worker));
    setTesting(false);
  };
  const results = Object.values(tests);
  const okN = results.filter((r) => r.kind === "ok").length;
  const failN = results.filter((r) => r.kind === "fail").length;
  const pageAllSel = rows.length > 0 && rows.every((a) => sel.has(a.id));

  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {group.name}
          <Tag>×{group.rate_multiplier ?? 1}</Tag>
          {group.status !== "active" ? <Tag tone="warn">{group.status}</Tag> : null}
        </CardTitle>
        <CardDescription>
          {channels.length} 个启用渠道
          {todayCost > 0 ? (
            <>
              {" · 今日 "}
              <span className="text-success font-medium">{yuan(todayCost)}</span>
            </>
          ) : null}
        </CardDescription>
        <CardAction>
          <Button size="sm" variant="outline" disabled={testing || !sorted.length} onClick={testAll}>
            {testing ? <Loader2 className="animate-spin" /> : <TestTube2 />}
            一键测试（{sorted.length}）
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-3">
          <LoadBar value={inFlight} max={capacity} />
          <span className="font-mono text-xs">
            {inFlight} / {capacity || "∞"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="h-8 w-48"
            placeholder="搜索渠道名"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {okN || failN ? (
            <span className="text-muted-foreground text-xs">
              测试：{okN} 通过{failN ? <span className="text-danger"> · {failN} 失败</span> : null}
            </span>
          ) : null}
        </div>
        {sel.size ? (
          <div className="bg-muted/60 flex flex-wrap items-center gap-1.5 rounded-md px-2 py-1.5 text-xs">
            <b>已选 {sel.size}</b>
            <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => bulk("active")}>
              批量启用
            </Button>
            <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => bulk("inactive")}>
              批量停用
            </Button>
            <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => clearError([...sel])}>
              批量清错
            </Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setSel(new Set())}>
              取消选择
            </Button>
          </div>
        ) : null}
        <div className="space-y-1">
          {rows.length ? (
            <label className="text-muted-foreground flex items-center gap-2 px-2 text-xs">
              <Checkbox
                checked={pageAllSel}
                onCheckedChange={(v) => setSel(v ? new Set(rows.map((a) => a.id)) : new Set())}
              />
              全选本页
            </label>
          ) : (
            <p className="text-muted-foreground py-4 text-center text-sm">没有匹配的渠道</p>
          )}
          {rows.map((a) => {
            const used = inUse(a.id);
            const full = a.concurrency > 0 && used >= a.concurrency;
            const cost = stats?.[a.id]?.user_cost ?? 0;
            const err = isErrored(a);
            return (
              <div
                key={a.id}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs",
                  sel.has(a.id) ? "bg-primary/10 ring-primary/30 ring-1" : "bg-muted/40 hover:bg-accent/50",
                )}
              >
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
                <span className="w-3 shrink-0 text-center">
                  {err ? (
                    <span className="text-danger">⚠</span>
                  ) : a.status === "active" ? (
                    <span className="text-success">✓</span>
                  ) : (
                    "·"
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 font-medium">
                    <span className="truncate">{a.name}</span>
                    <span className="text-muted-foreground shrink-0 text-[10px] font-normal">P{a.priority}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 leading-tight">
                    {!a.schedulable ? <span className="text-warning text-[10px]">未调度</span> : null}
                    <TestChip r={tests[a.id]} />
                    {a.notes ? (
                      <span className="text-muted-foreground truncate text-[10px]" title={a.notes}>
                        {a.notes}
                      </span>
                    ) : null}
                    {err && a.error_message ? (
                      <span className="text-danger truncate text-[10px]" title={a.error_message}>
                        {a.error_message}
                      </span>
                    ) : null}
                  </div>
                </div>
                {cost > 0 ? <span className="text-success shrink-0 font-mono">{yuan(cost)}</span> : null}
                <span
                  className={cn(
                    "shrink-0 font-mono",
                    a.status !== "active" ? "text-muted-foreground" : full ? "text-danger font-semibold" : "",
                  )}
                >
                  {used}/{a.concurrency || "∞"}
                </span>
                <Switch
                  title="参与调度"
                  checked={a.schedulable}
                  disabled={busy}
                  onCheckedChange={() => toggleSched(a)}
                />
                {err ? (
                  <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => clearError([a.id])}>
                    清错
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onEdit(a)}>
                  编辑
                </Button>
              </div>
            );
          })}
        </div>
        <Pager {...pager} />
      </CardContent>
    </Card>
  );
}

// ---------- 模型白名单输入 ----------
function ModelsInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [input, setInput] = useState("");
  const add = () => {
    const v = input.trim();
    if (v && !value.includes(v)) onChange([...value, v]);
    setInput("");
  };
  return (
    <div className="space-y-2">
      <div className="flex min-h-7 flex-wrap gap-1">
        {value.length ? (
          value.map((m) => (
            <Badge key={m} variant="secondary" className="gap-1">
              {m}
              <button
                type="button"
                className="hover:text-destructive"
                onClick={() => onChange(value.filter((x) => x !== m))}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))
        ) : (
          <span className="text-muted-foreground text-xs">未限制（允许全部模型）</span>
        )}
      </div>
      <div className="flex gap-2">
        <Input
          placeholder="如 claude-sonnet-4-6，回车添加"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button variant="outline" onClick={add} disabled={!input.trim()}>
          添加
        </Button>
      </div>
    </div>
  );
}

function GroupPicker({
  groups,
  value,
  onChange,
}: {
  groups: TGroup[];
  value: Set<number>;
  onChange: (v: Set<number>) => void;
}) {
  return (
    <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border p-2">
      {groups.map((g) => (
        <label key={g.id} className="hover:bg-muted flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm">
          <Checkbox
            checked={value.has(g.id)}
            onCheckedChange={(v) => {
              const n = new Set(value);
              if (v) n.add(g.id);
              else n.delete(g.id);
              onChange(n);
            }}
          />
          {g.name} <span className="text-muted-foreground text-xs">×{g.rate_multiplier ?? 1}</span>
        </label>
      ))}
    </div>
  );
}

// ---------- 编辑渠道 ----------
function EditChannelDialog({
  siteId,
  channel,
  groups,
  rt,
  onClose,
}: {
  siteId: number;
  channel: TChannel | null;
  groups: TGroup[];
  rt: TRealtime | undefined;
  onClose: () => void;
}) {
  const invalidate = useInvalidate();
  const [f, setF] = useState({ status: true, schedulable: true, concurrency: "0", priority: "0", notes: "" });
  const [groupIds, setGroupIds] = useState<Set<number>>(new Set());
  const [models, setModels] = useState<string[]>([]);
  const [models0, setModels0] = useState<string[] | null>(null);
  const [testModel, setTestModel] = useState(DEFAULT_TEST_MODEL);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!channel) return;
    setF({
      status: channel.status === "active",
      schedulable: channel.schedulable,
      concurrency: String(channel.concurrency),
      priority: String(channel.priority),
      notes: channel.notes ?? "",
    });
    setGroupIds(new Set(channel.group_ids));
    setModels([]);
    setModels0(null);
    get<string[]>(`/traffic/${siteId}/channels/${channel.id}/models`)
      .then((m) => {
        setModels(m);
        setModels0(m);
      })
      .catch(() => setModels0([]));
  }, [channel, siteId]);

  const save = async () => {
    if (!channel) return;
    setSaving(true);
    try {
      if (f.schedulable !== channel.schedulable)
        await post(`/traffic/${siteId}/channels/${channel.id}/schedulable`, { schedulable: f.schedulable });
      await put(`/traffic/${siteId}/channels/${channel.id}`, {
        status: f.status ? "active" : "inactive",
        concurrency: f.concurrency,
        priority: f.priority,
        group_ids: [...groupIds],
        notes: f.notes,
      });
      if (models0 && models.join("\n") !== models0.join("\n"))
        await put(`/traffic/${siteId}/channels/${channel.id}/models`, { models });
      toast.success("已更新");
      invalidate("traffic");
      onClose();
    } catch (e) {
      toast.error(readErr(e));
    } finally {
      setSaving(false);
    }
  };
  const test = async () => {
    if (!channel) return;
    setTesting(true);
    try {
      const r = await post<{ ok: boolean; latency_ms: number; output: string }>(
        `/traffic/${siteId}/channels/${channel.id}/test`,
        {
          model: testModel,
        },
      );
      if (r.ok) toast.success(`测试成功 · ${ms(r.latency_ms)}`);
      else toast.error("测试失败", { description: r.output.slice(0, 200) });
    } catch (e) {
      toast.error(readErr(e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <ResponsiveDialog
      open={!!channel}
      onOpenChange={(o) => !o && onClose()}
      title={`编辑渠道 · ${channel?.name ?? ""}`}
    >
      {channel ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <Label>启用</Label>
            <Switch checked={f.status} onCheckedChange={(v) => setF({ ...f, status: v })} />
          </div>
          <div className="flex items-center justify-between">
            <Label>参与调度</Label>
            <Switch checked={f.schedulable} onCheckedChange={(v) => setF({ ...f, schedulable: v })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>并发上限</Label>
              <Input
                type="number"
                min={0}
                value={f.concurrency}
                onChange={(e) => setF({ ...f, concurrency: e.target.value })}
              />
              <p className="text-muted-foreground text-xs">实时使用 {num(rt?.account[channel.id]?.current_in_use)}</p>
            </div>
            <div className="space-y-1.5">
              <Label>优先级</Label>
              <Input
                type="number"
                min={0}
                value={f.priority}
                onChange={(e) => setF({ ...f, priority: e.target.value })}
              />
              <p className="text-muted-foreground text-xs">数字越小越优先</p>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>分组</Label>
            <GroupPicker groups={groups} value={groupIds} onChange={setGroupIds} />
          </div>
          <div className="space-y-1.5">
            <Label>备注</Label>
            <Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>可用模型 {models0 == null ? <Loader2 className="inline size-3 animate-spin" /> : null}</Label>
            <ModelsInput value={models} onChange={setModels} />
          </div>
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <Label>测试用模型</Label>
              <Input value={testModel} onChange={(e) => setTestModel(e.target.value)} />
            </div>
            <Button variant="outline" disabled={testing} onClick={test}>
              {testing ? <Loader2 className="animate-spin" /> : <TestTube2 />}
              测试
            </Button>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button disabled={saving} onClick={save}>
              保存
            </Button>
          </div>
        </div>
      ) : null}
    </ResponsiveDialog>
  );
}

// ---------- 新增渠道（apikey 类型） ----------
const NEW = { name: "", base_url: "", api_key: "", concurrency: "20", priority: "1", rate_multiplier: "1" };
function NewChannelDialog({
  siteId,
  open,
  onOpenChange,
  groups,
}: {
  siteId: number;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  groups: TGroup[];
}) {
  const invalidate = useInvalidate();
  const [f, setF] = useState(NEW);
  const [groupIds, setGroupIds] = useState<Set<number>>(new Set());
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await post(`/traffic/${siteId}/channels`, { ...f, group_ids: [...groupIds], models });
      toast.success("已创建");
      setF(NEW);
      setGroupIds(new Set());
      setModels([]);
      onOpenChange(false);
      invalidate("traffic");
    } catch (e) {
      toast.error(readErr(e));
    } finally {
      setBusy(false);
    }
  };
  const field = (k: keyof typeof NEW, label: string, props: ComponentProps<typeof Input> = {}) => (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...props} />
    </div>
  );
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title="新增渠道" className="sm:max-w-2xl">
      <div className="space-y-4">
        {field("name", "名称 *")}
        {field("base_url", "Base URL *", { placeholder: "https://api.example.com" })}
        {field("api_key", "API Key *", { type: "password", autoComplete: "off" })}
        <div className="grid grid-cols-3 gap-3">
          {field("concurrency", "并发", { type: "number" })}
          {field("priority", "优先级", { type: "number" })}
          {field("rate_multiplier", "倍率", { type: "number" })}
        </div>
        <div className="space-y-1.5">
          <Label>分组</Label>
          <GroupPicker groups={groups} value={groupIds} onChange={setGroupIds} />
        </div>
        <div className="space-y-1.5">
          <Label>模型白名单</Label>
          <ModelsInput value={models} onChange={setModels} />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={busy} onClick={submit}>
            创建
          </Button>
        </div>
      </div>
    </ResponsiveDialog>
  );
}

// ---------- 渠道调度 tab ----------
export function TrafficChannels({
  siteId,
  structure,
  rt,
  stats,
  usage,
}: {
  siteId: number;
  structure: { groups: TGroup[]; accounts: TChannel[] } | undefined;
  rt: TRealtime | undefined;
  stats: TTodayStats | undefined;
  usage: TGroupUsage | undefined;
}) {
  const [editing, setEditing] = useState<TChannel | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  // 分组按今日消费、再按进行中请求数排序；没有渠道的分组不显示
  const cards = useMemo(() => {
    if (!structure) return [];
    return structure.groups
      .map((g) => {
        // 只显示启用的渠道（已停用的不显示；出错的仍算启用，需要在这里清错）
        const channels = structure.accounts.filter((a) => a.status !== "inactive" && a.group_ids.includes(g.id));
        const inFlight = channels.reduce((s, a) => s + (rt?.account[a.id]?.current_in_use ?? 0), 0);
        return { g, channels, inFlight, cost: usage?.by_group[g.id]?.actual_cost ?? 0 };
      })
      .filter((x) => x.channels.length)
      .sort((a, b) => b.cost - a.cost || b.inFlight - a.inFlight);
  }, [structure, rt, usage]);
  const { rows, pager } = usePaged(cards, String(cards.length));

  return (
    <div className="space-y-4">
      <TopUsers siteId={siteId} rt={rt} />
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-sm">
          {structure
            ? `${cards.length} 个分组 · ${structure.accounts.filter((a) => a.status !== "inactive").length} 个启用渠道，按今日消费排序`
            : " "}
        </span>
        <Button size="sm" onClick={() => setNewOpen(true)}>
          <Plus />
          新增渠道
        </Button>
      </div>
      {!structure ? (
        <Skeleton className="h-96" />
      ) : rows.length ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {rows.map(({ g, channels, cost }) => (
            <GroupCard
              key={g.id}
              siteId={siteId}
              group={g}
              channels={channels}
              rt={rt}
              stats={stats}
              todayCost={cost}
              onEdit={setEditing}
            />
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground py-10 text-center text-sm">这台服务器没有带渠道的分组</p>
      )}
      <Pager {...pager} />
      <EditChannelDialog
        siteId={siteId}
        channel={editing}
        groups={structure?.groups ?? []}
        rt={rt}
        onClose={() => setEditing(null)}
      />
      <NewChannelDialog siteId={siteId} open={newOpen} onOpenChange={setNewOpen} groups={structure?.groups ?? []} />
    </div>
  );
}
