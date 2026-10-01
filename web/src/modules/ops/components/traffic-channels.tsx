"use client";

import { type ComponentProps, useEffect, useMemo, useRef, useState } from "react";

import { Loader2, Plus, Settings2, TestTube2, X } from "lucide-react";
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
import { CLAUDE_MODELS, OPENAI_MODELS, ms, num, readErr, yuan } from "../format";
import { useInvalidate } from "../hooks";
import {
  type TChannel,
  type TGroup,
  type TGroupUsage,
  type TRealtime,
  type TTodayStats,
  type TGroupSetting,
  useGroupSettings,
} from "../traffic";

import { Tag } from "./badges";
import { Pager, ResponsiveDialog, usePaged } from "./shared";
import { ChannelSettingsDialog } from "./traffic-dispatch";

const DEFAULT_TEST_MODEL = "claude-sonnet-4-6";
const barColor = (pct: number) => (pct >= 90 ? "bg-danger" : pct >= 70 ? "bg-warning" : "bg-primary");
const isLive = (a: TChannel) => a.status !== "inactive" && a.schedulable;
const isErrored = (a: TChannel) => a.status === "error" || !!a.error_message?.trim();

function LoadBar({ value, max, className }: { value: number; max: number; className?: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className={cn("bg-muted h-2 flex-1 overflow-hidden rounded-full", className)}>
      <div className={cn("h-full transition-all", barColor(pct))} style={{ width: `${pct}%` }} />
    </div>
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

// ---------- 测试设置（同 bill-manage 的「分组可用性自动检测」）：测试模型 + 定时自动测试，按服务器 + 分组存在后端 ----------
type TestCfg = { model: string; auto: boolean; intervalMin: number };
const defaultTestModel = (platform: string) =>
  platform === "openai" ? "gpt-5.5" : platform === "anthropic" ? "claude-opus-4-6" : "";
const testCfgKey = (siteId: number, groupId: number) => `ops.traffic.test.${siteId}.${groupId}`;
// 后端没存过的分组：沿用以前存在这个浏览器里的设置，再没有就按平台给默认模型
function localTestCfg(siteId: number, g: TGroup): TestCfg {
  const d: TestCfg = { model: defaultTestModel(g.platform), auto: false, intervalMin: 5 };
  try {
    const v = JSON.parse(localStorage.getItem(testCfgKey(siteId, g.id)) ?? "null") as Partial<TestCfg> | null;
    return v ? { ...d, ...v, intervalMin: Math.max(1, Number(v.intervalMin) || 5) } : d;
  } catch {
    return d;
  }
}

function TestSettingsDialog({
  open,
  onOpenChange,
  group,
  cfg,
  onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  group: TGroup;
  cfg: TestCfg;
  onSave: (c: TestCfg) => void;
}) {
  const [draft, setDraft] = useState(cfg);
  useEffect(() => {
    if (open) setDraft(cfg);
  }, [open, cfg]);
  const presets = group.platform === "openai" ? OPENAI_MODELS : CLAUDE_MODELS;
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="分组可用性检测"
      description={`分组「${group.name}」`}
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label>测试模型</Label>
          <Input
            list={`test-models-${group.id}`}
            value={draft.model}
            placeholder="留空 = sub2api 默认模型"
            onChange={(e) => setDraft({ ...draft, model: e.target.value })}
          />
          <datalist id={`test-models-${group.id}`}>
            {presets.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <p className="text-muted-foreground text-xs">「一键测试」和自动测试都用这个模型，可以填自定义的 model id</p>
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor={`auto-test-${group.id}`}>定时自动测试</Label>
          <Switch
            id={`auto-test-${group.id}`}
            checked={draft.auto}
            onCheckedChange={(v) => setDraft({ ...draft, auto: v })}
          />
        </div>
        {draft.auto ? (
          <div className="space-y-1.5">
            <Label>间隔（分钟）</Label>
            <Input
              type="number"
              min={1}
              value={draft.intervalMin}
              onChange={(e) => setDraft({ ...draft, intervalMin: Math.max(1, Number(e.target.value) || 1) })}
            />
            <p className="text-muted-foreground text-xs">
              只在这个页面开着、且在前台时运行；每次会真实请求上游（产生少量费用）
            </p>
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={() => {
              onSave(draft);
              onOpenChange(false);
            }}
          >
            保存
          </Button>
        </div>
      </div>
    </ResponsiveDialog>
  );
}

// ---------- 一个分组：并发占用、渠道列表（按今日消费排序）、批量操作、一键测试 ----------
// 列表只显示调度中的渠道；「渠道设置」弹窗里看分组下全部账号，一键检测、启用停用 / 未调度的
function GroupCard({
  siteId,
  group,
  channels,
  idle,
  rt,
  stats,
  todayCost,
  setting,
  onEdit,
}: {
  siteId: number;
  group: TGroup;
  channels: TChannel[];
  idle: TChannel[];
  setting: TGroupSetting | undefined;
  rt: TRealtime | undefined;
  stats: TTodayStats | undefined;
  todayCost: number;
  onEdit: (a: TChannel) => void;
}) {
  const invalidate = useInvalidate();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [tests, setTests] = useState<Record<number, TestResult>>({});
  const [testing, setTesting] = useState(false);
  const cfg: TestCfg = setting
    ? { model: setting.model, auto: setting.auto, intervalMin: setting.interval_min }
    : localTestCfg(siteId, group);
  const saveCfg = async (c: Partial<TestCfg>) => {
    const next = { ...cfg, ...c };
    try {
      await put(`/traffic/${siteId}/group-settings/${group.id}`, {
        model: next.model,
        auto: next.auto,
        interval_min: next.intervalMin,
      });
      invalidate("traffic");
    } catch (e) {
      toast.error(readErr(e));
    }
  };
  const [cfgOpen, setCfgOpen] = useState(false);
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

  // 一键测试：5 个并发，逐个测当前列表里的渠道（会真实请求上游），用设置里的测试模型
  const testAll = async () => {
    const targets = [...sorted];
    if (!targets.length) return;
    setTesting(true);
    setTests(Object.fromEntries(targets.map((a) => [a.id, { kind: "pending" } as TestResult])));
    const model = cfg.model.trim();
    const worker = async () => {
      for (let a = targets.shift(); a; a = targets.shift()) {
        const id = a.id;
        try {
          const r = await post<{ ok: boolean; latency_ms: number; output: string }>(
            `/traffic/${siteId}/channels/${id}/test`,
            model ? { model } : {},
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
    await Promise.all(Array.from({ length: Math.min(5, targets.length) }, worker));
    setTesting(false);
  };

  // 定时自动测试（页面在后台或正在测试时跳过）
  const testRef = useRef(testAll);
  useEffect(() => {
    testRef.current = testAll;
  });
  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = testing;
  }, [testing]);
  useEffect(() => {
    if (!cfg.auto) return;
    const tick = () => {
      if (!document.hidden && !busyRef.current) void testRef.current();
    };
    tick();
    const t = setInterval(tick, Math.max(1, cfg.intervalMin) * 60_000);
    return () => clearInterval(t);
  }, [cfg.auto, cfg.intervalMin]);

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
        <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>
            {channels.length} 个调度中渠道
            {todayCost > 0 ? (
              <>
                {" · 今日 "}
                <span className="text-success font-medium">{yuan(todayCost)}</span>
              </>
            ) : null}
          </span>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className={cn(
              "rounded-md px-1.5 text-[11px] font-medium",
              idle.length ? "bg-warning/15 text-warning" : "bg-muted text-muted-foreground hover:text-foreground",
            )}
            title="看分组下全部账号，一键检测并启用未调度的"
          >
            渠道设置{idle.length ? `（${idle.length} 个未调度）` : ""}
          </button>
        </CardDescription>
        <CardAction className="flex items-center gap-1">
          <Button size="sm" variant="outline" disabled={testing || !sorted.length} onClick={testAll}>
            {testing ? <Loader2 className="animate-spin" /> : <TestTube2 />}
            一键测试（{sorted.length}）
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title={cfg.auto ? `自动测试已开启 · 每 ${cfg.intervalMin} 分钟` : "测试设置"}
            onClick={() => setCfgOpen(true)}
          >
            <Settings2 className={cn(cfg.auto && "text-success")} />
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
          <span className="text-muted-foreground font-mono text-[11px]" title="在右上角齿轮里修改">
            模型：{cfg.model || "默认"}
          </span>
          {cfg.auto ? <span className="text-success text-[11px]">自动测试 · 每 {cfg.intervalMin} 分钟</span> : null}
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
      <ChannelSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        siteId={siteId}
        group={group}
        accounts={[...channels, ...idle]}
        model={cfg.model}
        onSaveModel={(m) => void saveCfg({ model: m })}
      />
      <TestSettingsDialog
        open={cfgOpen}
        onOpenChange={setCfgOpen}
        group={group}
        cfg={cfg}
        onSave={(c) => void saveCfg(c)}
      />
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
  const [showIdleGroups, setShowIdleGroups] = useState(false);
  const groupSettings = useGroupSettings(siteId);
  // 默认只显示启用且开启调度的渠道（出错的仍算启用，需要在这里清错）；停用 / 未调度的收在分组卡片的「未调度」里
  const all = useMemo(() => {
    if (!structure) return [];
    return structure.groups
      .map((g) => {
        const inGroup = structure.accounts.filter((a) => a.group_ids.includes(g.id));
        const channels = inGroup.filter(isLive);
        const inFlight = channels.reduce((s, a) => s + (rt?.account[a.id]?.current_in_use ?? 0), 0);
        return {
          g,
          channels,
          idle: inGroup.filter((a) => !isLive(a)),
          inFlight,
          cost: usage?.by_group[g.id]?.actual_cost ?? 0,
        };
      })
      .filter((x) => x.channels.length || x.idle.length)
      .sort((a, b) => b.cost - a.cost || b.inFlight - a.inFlight);
  }, [structure, rt, usage]);
  const idleGroups = all.filter((x) => !x.channels.length).length;
  const cards = showIdleGroups ? all : all.filter((x) => x.channels.length);
  const { rows, pager } = usePaged(cards, `${cards.length}`);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-sm">
          {structure
            ? `${cards.length} 个分组 · ${structure.accounts.filter(isLive).length} 个调度中渠道，按今日消费排序`
            : " "}
        </span>
        <div className="flex items-center gap-3">
          {idleGroups ? (
            <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Switch checked={showIdleGroups} onCheckedChange={setShowIdleGroups} />
              显示没有调度中渠道的分组（{idleGroups}）
            </label>
          ) : null}
          <Button size="sm" onClick={() => setNewOpen(true)}>
            <Plus />
            新增渠道
          </Button>
        </div>
      </div>
      {!structure ? (
        <Skeleton className="h-96" />
      ) : rows.length ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {rows.map(({ g, channels, idle, cost }) => (
            <GroupCard
              key={`${siteId}-${g.id}`}
              siteId={siteId}
              group={g}
              channels={channels}
              idle={idle}
              rt={rt}
              stats={stats}
              todayCost={cost}
              setting={groupSettings.data?.[g.id]}
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
