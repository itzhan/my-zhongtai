"use client";

import { useState } from "react";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

import { get, post, put } from "../api";
import { CLAUDE_MODELS, OPENAI_MODELS, readErr } from "../format";
import { useOps } from "../provider";

import { ResponsiveDialog, useConfirm } from "./shared";

type Proxy = { id: number; name: string; protocol: string; host: string; port: number };
export type AccountFull = {
  id: number;
  name: string;
  notes: string | null;
  platform: string;
  status: string;
  schedulable: boolean;
  priority: number;
  concurrency: number;
  load_factor?: number | null;
  rate_multiplier?: number;
  proxy_id?: number | null;
  expires_at?: string | null;
  auto_pause_on_expired?: boolean;
  group_ids: number[];
  credentials?: Record<string, unknown> & {
    base_url?: string;
    model_mapping?: Record<string, string>;
    pool_mode?: boolean;
    pool_mode_retry_count?: number;
    pool_mode_retry_status_codes?: number[];
  };
  extra?: Record<string, unknown>;
};

const KNOWN = ["base_url", "model_mapping", "pool_mode", "pool_mode_retry_count", "pool_mode_retry_status_codes"];
const passKey = (p: string) => (p === "openai" ? "openai_passthrough" : "anthropic_passthrough");
const dtLocal = (t?: string | null) => {
  if (!t) return "";
  const d = new Date(t);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

// 新建 / 编辑上游账号（直接写 sub2api；只读模式下后端会拦截）
export function AccountForm({ account: a, presetGroup }: { account: AccountFull | null; presetGroup?: number | null }) {
  const router = useRouter();
  const { groups } = useOps();
  const creating = !a;
  const pg = presetGroup ? groups.find((g) => g.id === presetGroup) : undefined;
  const proxies = useQuery({ queryKey: ["ops", "proxies"], queryFn: () => get<Proxy[]>("/proxies"), retry: false });
  const [confirm, confirmEl] = useConfirm();
  const c = a?.credentials || {};

  const [v, setV] = useState({
    name: a?.name ?? "",
    notes: a?.notes ?? "",
    platform:
      a?.platform || (pg && ["anthropic", "openai", "gemini"].includes(pg.platform) ? pg.platform : "anthropic"),
    base_url: c.base_url ?? "",
    api_key: "",
    use_as_detect_key: true,
    pool_mode: !!c.pool_mode,
    pool_mode_retry_count: String(c.pool_mode_retry_count ?? 3),
    pool_mode_retry_status_codes: (c.pool_mode_retry_status_codes || []).join(","),
    passthrough: !!a?.extra?.[passKey(a?.platform ?? "anthropic")],
    upstream_billing_probe_enabled: !!a?.extra?.upstream_billing_probe_enabled,
    priority: String(a?.priority ?? 1),
    concurrency: String(a?.concurrency ?? 1000),
    load_factor: a?.load_factor ? String(a.load_factor) : "",
    rate_multiplier: String(a?.rate_multiplier ?? 1),
    proxy_id: String(a?.proxy_id ?? 0),
    expires_at: dtLocal(a?.expires_at),
    auto_pause_on_expired: a?.auto_pause_on_expired !== false,
    schedulable: a ? a.schedulable : true,
    status_on: a ? a.status !== "inactive" : true,
    enroll: true,
    other: JSON.stringify(Object.fromEntries(Object.entries(c).filter(([k]) => !KNOWN.includes(k))), null, 2),
  });
  const [groupIds, setGroupIds] = useState<Set<number>>(new Set(a?.group_ids ?? (presetGroup ? [presetGroup] : [])));
  const [mapping, setMapping] = useState<[string, string][]>(Object.entries(c.model_mapping || {}));
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof v>) => setV((x) => ({ ...x, ...p }));

  const addModels = (list: string[]) =>
    setMapping((m) => {
      const have = new Set(m.map(([k]) => k));
      return [...m, ...list.filter((x) => !have.has(x)).map((x) => [x, x] as [string, string])];
    });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    let other: Record<string, unknown>;
    try {
      other = JSON.parse(v.other || "{}");
    } catch {
      return toast.error("高级凭证字段不是合法 JSON");
    }
    const plat = creating ? v.platform : a.platform;
    const body: Record<string, unknown> = {
      name: v.name,
      notes: v.notes,
      platform: plat,
      base_url: v.base_url,
      api_key: v.api_key,
      use_as_detect_key: v.use_as_detect_key,
      credentials: other,
      model_mapping: Object.fromEntries(mapping.filter(([k]) => k.trim()).map(([k, x]) => [k.trim(), (x || k).trim()])),
      pool_mode: v.pool_mode,
      pool_mode_retry_count: v.pool_mode_retry_count,
      pool_mode_retry_status_codes: v.pool_mode_retry_status_codes,
      upstream_billing_probe_enabled: v.upstream_billing_probe_enabled,
      priority: v.priority,
      concurrency: v.concurrency,
      load_factor: v.load_factor,
      rate_multiplier: v.rate_multiplier,
      proxy_id: v.proxy_id,
      expires_at: v.expires_at,
      auto_pause_on_expired: v.auto_pause_on_expired,
      group_ids: [...groupIds],
      schedulable: v.schedulable,
    };
    if (!creating) body.status = v.status_on ? "active" : "inactive";
    // 透传开关变了才提交 extra（sub2api 的 extra 是整份覆盖）
    const pk = passKey(plat);
    if (creating ? v.passthrough : !!a.extra?.[pk] !== v.passthrough)
      body.extra = { ...(a?.extra || {}), [pk]: v.passthrough };
    setBusy(true);
    const send = async (mixed: boolean): Promise<void> => {
      try {
        const r = creating
          ? await post<{ id: number }>("/accounts", { ...body, confirm_mixed_channel_risk: mixed })
          : await put<{ ok: boolean }>(`/accounts/${a.id}`, { ...body, confirm_mixed_channel_risk: mixed });
        toast.success(creating ? "账号已创建" : "已保存");
        const newId = creating ? (r as { id: number }).id : a.id;
        if (creating && pg) {
          if (v.enroll && groupIds.has(pg.id))
            await post(`/sched/groups/${pg.id}/enroll`, { account_ids: [newId], enrolled: true }).catch((err) =>
              toast.error(`关联智能调度失败：${readErr(err)}`),
            );
          router.push(`/dashboard/groups/${pg.id}`);
          return;
        }
        router.push(`/dashboard/accounts/${newId}`);
      } catch (err) {
        const msg = readErr(err);
        if (
          /mixed_channel/.test(msg) &&
          !mixed &&
          (await confirm({ title: "混合渠道风险", description: `sub2api 提示：${msg}。仍要保存？` }))
        )
          return send(true);
        toast.error(msg);
        setBusy(false);
      }
    };
    send(false);
  };

  const sw = (label: string, key: keyof typeof v) => (
    <label className="flex items-center gap-2 text-sm">
      {label} <Switch checked={!!v[key]} onCheckedChange={(x) => set({ [key]: x } as Partial<typeof v>)} />
    </label>
  );

  return (
    <form onSubmit={submit} className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>基本信息</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>账号名称 *</Label>
              <Input
                required
                value={v.name}
                placeholder="例如：小欧--awsb--3.3"
                onChange={(e) => set({ name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>平台{creating ? " *" : "（创建后不可改）"}</Label>
              <Select value={v.platform} onValueChange={(x) => set({ platform: x })} disabled={!creating}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["anthropic", "openai", "gemini"].map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label>备注</Label>
            <Input value={v.notes} onChange={(e) => set({ notes: e.target.value })} />
          </div>
          <div className="flex flex-wrap gap-6">
            {!creating ? sw("启用", "status_on") : null}
            {sw(creating ? "创建后立即参与调度" : "参与调度", "schedulable")}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>上游连接</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>上游地址（base_url）*</Label>
            <Input
              required
              value={v.base_url}
              placeholder="https://api.example.com"
              onChange={(e) => set({ base_url: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>API Key {creating ? "*" : "（留空 = 保持原 Key 不变）"}</Label>
            <Input
              type="password"
              autoComplete="new-password"
              placeholder={creating ? "sk-…" : "不修改请留空"}
              value={v.api_key}
              onChange={(e) => set({ api_key: e.target.value })}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={v.use_as_detect_key} onCheckedChange={(x) => set({ use_as_detect_key: !!x })} />{" "}
            同时作为这个账号的深度检测 Key
          </label>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            {sw("号池模式", "pool_mode")}
            <label className="flex items-center gap-2 text-sm">
              重试次数{" "}
              <Input
                type="number"
                className="h-8 w-16"
                value={v.pool_mode_retry_count}
                onChange={(e) => set({ pool_mode_retry_count: e.target.value })}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              重试状态码{" "}
              <Input
                className="h-8 w-44"
                placeholder="如 401,403,429,503"
                value={v.pool_mode_retry_status_codes}
                onChange={(e) => set({ pool_mode_retry_status_codes: e.target.value })}
              />
            </label>
            {sw("透传", "passthrough")}
            {sw("上游计费探测", "upstream_billing_probe_enabled")}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>模型映射</CardTitle>
          <CardDescription>左边是客户请求的模型，右边是发给上游的模型；相同则只是允许该模型</CardDescription>
          <CardAction className="flex flex-wrap gap-1">
            <Button type="button" size="sm" variant="outline" onClick={() => addModels(CLAUDE_MODELS)}>
              ＋ Claude 常用
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => addModels(OPENAI_MODELS)}>
              ＋ GPT 常用
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setMapping((m) => [...m, ["", ""]])}>
              ＋ 一行
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setBulkOpen(true)}>
              批量粘贴
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="text-destructive"
              onClick={() => setMapping([])}
            >
              清空
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-2">
          {mapping.length ? (
            mapping.map(([k, x], i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={k}
                  placeholder="请求模型"
                  onChange={(e) => setMapping((m) => m.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))}
                />
                <span className="text-muted-foreground">→</span>
                <Input
                  value={x}
                  placeholder="上游模型（留空 = 同左）"
                  onChange={(e) => setMapping((m) => m.map((r, j) => (j === i ? [r[0], e.target.value] : r)))}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setMapping((m) => m.filter((_, j) => j !== i))}
                >
                  删除
                </Button>
              </div>
            ))
          ) : (
            <p className="text-muted-foreground text-sm">未设置模型映射</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>调度设置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {(
              [
                ["priority", "优先级（1–10，越小越优先）"],
                ["concurrency", "并发上限"],
                ["load_factor", "负载系数（留空 = 按并发）"],
                ["rate_multiplier", "账号倍率"],
              ] as const
            ).map(([k, l]) => (
              <div key={k} className="space-y-2">
                <Label>{l}</Label>
                <Input type="number" step="any" value={v[k]} onChange={(e) => set({ [k]: e.target.value })} />
              </div>
            ))}
            <div className="space-y-2">
              <Label>代理</Label>
              <Select value={v.proxy_id} onValueChange={(x) => set({ proxy_id: x })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">不使用代理</SelectItem>
                  {(proxies.data ?? []).map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name} · {p.protocol}://{p.host}:{p.port}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>过期时间（留空 = 不过期）</Label>
              <Input type="datetime-local" value={v.expires_at} onChange={(e) => set({ expires_at: e.target.value })} />
            </div>
          </div>
          {pg ? (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={v.enroll} onCheckedChange={(x) => set({ enroll: !!x })} /> 创建后关联到「{pg.name}
              」的智能调度
            </label>
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={v.auto_pause_on_expired} onCheckedChange={(x) => set({ auto_pause_on_expired: !!x })} />{" "}
            到期自动暂停
          </label>
          <div className="space-y-2">
            <Label>所属分组</Label>
            <div className="grid max-h-56 gap-2 overflow-y-auto sm:grid-cols-3">
              {groups.map((g) => (
                <label key={g.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={groupIds.has(g.id)}
                    onCheckedChange={(x) =>
                      setGroupIds((s) => {
                        const n = new Set(s);
                        if (x) n.add(g.id);
                        else n.delete(g.id);
                        return n;
                      })
                    }
                  />
                  {g.name} <span className="text-muted-foreground text-xs">{g.platform}</span>
                </label>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Collapsible className="rounded-xl border">
        <CollapsibleTrigger className="w-full px-6 py-4 text-left text-sm font-medium">
          高级：其他凭证字段（JSON，不含 Key；一般不用改）▾
        </CollapsibleTrigger>
        <CollapsibleContent className="px-6 pb-4">
          <Textarea
            className="min-h-32 font-mono text-xs"
            value={v.other}
            onChange={(e) => set({ other: e.target.value })}
          />
        </CollapsibleContent>
      </Collapsible>

      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {creating ? "创建账号" : "保存修改"}
        </Button>
        <Button variant="outline" asChild>
          <Link
            prefetch={false}
            href={
              creating ? (pg ? `/dashboard/groups/${pg.id}` : "/dashboard/accounts") : `/dashboard/accounts/${a.id}`
            }
          >
            取消
          </Link>
        </Button>
      </div>

      <ResponsiveDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        title="批量粘贴模型映射"
        description="每行一个：模型 或 请求模型=上游模型，会追加到现有列表。"
      >
        <div className="space-y-3">
          <Textarea
            className="min-h-48 font-mono text-xs"
            placeholder={"claude-opus-5\nclaude-sonnet-5=claude-sonnet-5"}
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
          />
          <Button
            type="button"
            className="w-full"
            onClick={() => {
              setMapping((m) => {
                const have = new Set(m.map(([k]) => k));
                const add: [string, string][] = [];
                for (const l of bulkText
                  .split("\n")
                  .map((x) => x.trim())
                  .filter(Boolean)) {
                  const [k, x] = l.split(/\s*(?:=>|=|→)\s*/);
                  if (k && !have.has(k)) {
                    add.push([k, x || k]);
                    have.add(k);
                  }
                }
                return [...m, ...add];
              });
              setBulkText("");
              setBulkOpen(false);
            }}
          >
            添加
          </Button>
        </div>
      </ResponsiveDialog>
      {confirmEl}
    </form>
  );
}
