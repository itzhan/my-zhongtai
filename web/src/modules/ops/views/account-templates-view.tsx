"use client";

import { useEffect, useMemo, useState } from "react";

import { Copy, Download, FileCode2, Plus, Save, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { del, get, post, put } from "../api";
import {
  EMPTY_TEMPLATE_CONFIG,
  GroupMultiPicker,
  ModelMappingEditor,
  accountFullToTemplateConfig,
  type AccountFull,
} from "../components/account-form";
import { PlatformBadge, Tag } from "../components/badges";
import { ResponsiveDialog, useConfirm } from "../components/shared";
import { readErr, time } from "../format";
import { useAccountTemplates, useAccounts, useInvalidate, useProxies, useVerifyChannels } from "../hooks";
import { useOps } from "../provider";
import type { AccountPlatform, AccountTemplate, AccountTemplateConfig } from "../types";

const NO_CHANNEL = "__none__";

type TemplateDraft = {
  name: string;
  description: string;
  channel_code: string;
  platform: AccountPlatform;
  notes: string;
  schedulable: boolean;
  use_as_detect_key: boolean;
  pool_mode: boolean;
  pool_mode_retry_count: string;
  pool_mode_retry_status_codes: string;
  passthrough: boolean;
  upstream_billing_probe_enabled: boolean;
  mapping: [string, string][];
  priority: string;
  concurrency: string;
  load_factor: string;
  rate_multiplier: string;
  proxy_id: string;
  auto_pause_on_expired: boolean;
  group_ids: Set<number>;
  credentials_other: string;
  extra_other: string;
};

function templateToDraft(t: AccountTemplate): TemplateDraft {
  const c = t.config;
  return {
    name: t.name,
    description: t.description,
    channel_code: t.channel_code || NO_CHANNEL,
    platform: c.platform,
    notes: c.notes,
    schedulable: c.schedulable,
    use_as_detect_key: c.use_as_detect_key,
    pool_mode: c.pool_mode,
    pool_mode_retry_count: String(c.pool_mode_retry_count ?? 3),
    pool_mode_retry_status_codes: c.pool_mode_retry_status_codes ?? "",
    passthrough: c.platform === "gemini" ? false : !!c.passthrough,
    upstream_billing_probe_enabled: !!c.upstream_billing_probe_enabled,
    mapping: Object.entries(c.model_mapping || {}),
    priority: String(c.priority ?? 1),
    concurrency: String(c.concurrency ?? 1000),
    load_factor: c.load_factor ?? "",
    rate_multiplier: String(c.rate_multiplier ?? 1),
    proxy_id: String(c.proxy_id ?? 0),
    auto_pause_on_expired: c.auto_pause_on_expired !== false,
    group_ids: new Set(c.group_ids || []),
    credentials_other: JSON.stringify(c.credentials_other || {}, null, 2),
    extra_other: JSON.stringify(c.extra_other || {}, null, 2),
  };
}

function configToDraftPatch(cfg: AccountTemplateConfig): Partial<TemplateDraft> {
  return {
    platform: cfg.platform,
    notes: cfg.notes,
    schedulable: cfg.schedulable,
    use_as_detect_key: cfg.use_as_detect_key,
    pool_mode: cfg.pool_mode,
    pool_mode_retry_count: String(cfg.pool_mode_retry_count ?? 3),
    pool_mode_retry_status_codes: cfg.pool_mode_retry_status_codes ?? "",
    passthrough: cfg.platform === "gemini" ? false : !!cfg.passthrough,
    upstream_billing_probe_enabled: !!cfg.upstream_billing_probe_enabled,
    mapping: Object.entries(cfg.model_mapping || {}),
    priority: String(cfg.priority ?? 1),
    concurrency: String(cfg.concurrency ?? 1000),
    load_factor: cfg.load_factor ?? "",
    rate_multiplier: String(cfg.rate_multiplier ?? 1),
    proxy_id: String(cfg.proxy_id ?? 0),
    auto_pause_on_expired: cfg.auto_pause_on_expired !== false,
    group_ids: new Set(cfg.group_ids || []),
    credentials_other: JSON.stringify(cfg.credentials_other || {}, null, 2),
    extra_other: JSON.stringify(cfg.extra_other || {}, null, 2),
  };
}

function NewTemplateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (id: number) => void;
}) {
  const invalidate = useInvalidate();
  const channelsQ = useVerifyChannels();
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState<AccountPlatform>("anthropic");
  const [channelCode, setChannelCode] = useState(NO_CHANNEL);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) return toast.error("模板名称必填");
    setBusy(true);
    try {
      const r = await post<AccountTemplate>("/account-templates", {
        name: name.trim(),
        description: description.trim(),
        channel_code: channelCode === NO_CHANNEL ? "" : channelCode,
        config: {
          ...EMPTY_TEMPLATE_CONFIG,
          platform,
          pool_mode: true,
          passthrough: platform !== "gemini",
        },
      });
      toast.success(`已创建模板「${r.name}」`);
      invalidate("account-templates");
      setName("");
      setPlatform("anthropic");
      setChannelCode(NO_CHANNEL);
      setDescription("");
      onOpenChange(false);
      onCreated(r.id);
    } catch (e) {
      toast.error(readErr(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="新增录入模板"
      description="创建后可在右侧配置默认分组、模型映射、并发、号池、透传等全部 sub2api 账号参数。"
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label>模板名称 *</Label>
          <Input placeholder="如 awsb-主力 / vertex-直连" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>平台</Label>
            <Select value={platform} onValueChange={(v) => setPlatform(v as AccountPlatform)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="anthropic">anthropic</SelectItem>
                <SelectItem value="openai">openai</SelectItem>
                <SelectItem value="gemini">gemini</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>关联鉴定渠道（可选）</Label>
            <Select value={channelCode} onValueChange={setChannelCode}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CHANNEL}>不自动关联</SelectItem>
                {(channelsQ.data ?? []).map((c) => (
                  <SelectItem key={c.code} value={c.code}>
                    {c.name} ({c.code})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>模板说明</Label>
          <Input
            placeholder="例如：AWS Bedrock 主力分组默认配置"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" disabled={busy || !name.trim()} onClick={submit}>
            {busy ? "创建中…" : "创建"}
          </Button>
        </div>
      </div>
    </ResponsiveDialog>
  );
}

function ImportFromAccountButton({ onImport }: { onImport: (cfg: AccountTemplateConfig, sourceName: string) => void }) {
  const accountsQ = useAccounts();
  const [open, setOpen] = useState(false);
  const [kw, setKw] = useState("");
  const [loadingId, setLoadingId] = useState<number | null>(null);

  const accounts = accountsQ.data ?? [];
  const filtered = useMemo(() => {
    const q = kw.trim().toLowerCase();
    if (!q) return accounts.slice(0, 40);
    return accounts
      .filter((a) => `${a.name} #${a.id} ${a.platform} ${a.notes || ""}`.toLowerCase().includes(q))
      .slice(0, 40);
  }, [accounts, kw]);

  const pick = async (id: number, name: string) => {
    setLoadingId(id);
    try {
      const r = await get<{ account: AccountFull }>(`/accounts/${id}/full`);
      onImport(accountFullToTemplateConfig(r.account), name);
      setOpen(false);
    } catch (e) {
      toast.error(`读取账号配置失败：${readErr(e)}`);
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="outline" disabled={loadingId !== null}>
          <Download className="size-3.5" />
          {loadingId !== null ? "导入中…" : "从已有账号导入配置"}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <Command shouldFilter={false}>
          <CommandInput placeholder="搜索要复制配置的 sub2 账号…" value={kw} onValueChange={setKw} />
          <CommandList className="max-h-72">
            {filtered.length === 0 ? (
              <CommandEmpty>{accountsQ.isLoading ? "加载账号中…" : "没有匹配的账号"}</CommandEmpty>
            ) : (
              <CommandGroup heading="点击即复制该账号的平台/号池/透传/模型映射/分组等配置">
                {filtered.map((a) => (
                  <CommandItem
                    key={a.id}
                    value={String(a.id)}
                    onSelect={() => void pick(a.id, a.name)}
                    className="flex items-center justify-between gap-2 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <Search className="text-muted-foreground size-3 shrink-0" />
                        <span className="truncate text-xs font-medium">{a.name}</span>
                        <span className="text-muted-foreground shrink-0 font-mono text-[11px]">#{a.id}</span>
                      </div>
                    </div>
                    <PlatformBadge platform={a.platform} />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function AccountTemplatesView() {
  const invalidate = useInvalidate();
  const { groups, groupName } = useOps();
  const [confirm, confirmEl] = useConfirm();
  const templatesQ = useAccountTemplates();
  const channelsQ = useVerifyChannels();
  const proxiesQ = useProxies();

  const templates = useMemo(() => templatesQ.data ?? [], [templatesQ.data]);
  const channels = useMemo(() => channelsQ.data ?? [], [channelsQ.data]);
  const channelNameByCode = useMemo(() => new Map(channels.map((c) => [c.code, c.name])), [channels]);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const activeTemplate = useMemo(
    () => templates.find((t) => t.id === selectedId) ?? templates[0] ?? null,
    [templates, selectedId],
  );

  useEffect(() => {
    if (!activeTemplate) {
      setDraft(null);
      setDirty(false);
      return;
    }
    setDraft(templateToDraft(activeTemplate));
    setDirty(false);
  }, [activeTemplate]);

  const updateDraft = (patch: Partial<TemplateDraft>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    setDirty(true);
  };

  const buildConfigFromDraft = (d: TemplateDraft): AccountTemplateConfig | null => {
    let credentialsOther: Record<string, unknown>;
    try {
      const parsed = JSON.parse(d.credentials_other || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        toast.error("其他凭证字段必须是 JSON 对象");
        return null;
      }
      credentialsOther = parsed as Record<string, unknown>;
    } catch {
      toast.error("其他凭证字段不是合法 JSON");
      return null;
    }
    let extraOther: Record<string, unknown>;
    try {
      const parsed = JSON.parse(d.extra_other || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        toast.error("扩展字段 extra 必须是 JSON 对象");
        return null;
      }
      extraOther = parsed as Record<string, unknown>;
    } catch {
      toast.error("扩展字段 extra 不是合法 JSON");
      return null;
    }
    return {
      platform: d.platform,
      notes: d.notes,
      schedulable: d.schedulable,
      use_as_detect_key: d.use_as_detect_key,
      pool_mode: d.pool_mode,
      pool_mode_retry_count: parseInt(d.pool_mode_retry_count, 10) || 0,
      pool_mode_retry_status_codes: d.pool_mode_retry_status_codes,
      passthrough: d.platform === "gemini" ? false : d.passthrough,
      upstream_billing_probe_enabled: d.upstream_billing_probe_enabled,
      model_mapping: Object.fromEntries(
        d.mapping.filter(([k]) => k.trim()).map(([k, x]) => [k.trim(), (x || k).trim()]),
      ),
      priority: Number(d.priority) || 1,
      concurrency: Number(d.concurrency) || 1000,
      load_factor: d.load_factor.trim(),
      rate_multiplier: Number(d.rate_multiplier) || 1,
      proxy_id: parseInt(d.proxy_id, 10) || 0,
      auto_pause_on_expired: d.auto_pause_on_expired,
      group_ids: [...d.group_ids],
      credentials_other: credentialsOther,
      extra_other: extraOther,
    };
  };

  const saveTemplate = async () => {
    if (!activeTemplate || !draft) return;
    if (!draft.name.trim()) return toast.error("模板名称必填");
    const cfg = buildConfigFromDraft(draft);
    if (!cfg) return;
    setSaving(true);
    try {
      await put(`/account-templates/${activeTemplate.id}`, {
        name: draft.name.trim(),
        description: draft.description.trim(),
        channel_code: draft.channel_code === NO_CHANNEL ? "" : draft.channel_code,
        config: cfg,
      });
      toast.success(`已保存模板「${draft.name.trim()}」`);
      setDirty(false);
      invalidate("account-templates");
    } catch (e) {
      toast.error(readErr(e));
    } finally {
      setSaving(false);
    }
  };

  const duplicateTemplate = async () => {
    if (!activeTemplate || !draft) return;
    const cfg = buildConfigFromDraft(draft);
    if (!cfg) return;
    try {
      const r = await post<AccountTemplate>("/account-templates", {
        name: `${draft.name.trim()} 副本`,
        description: draft.description.trim(),
        channel_code: "",
        config: cfg,
      });
      toast.success(`已复制为新模板「${r.name}」`);
      invalidate("account-templates");
      setSelectedId(r.id);
    } catch (e) {
      toast.error(readErr(e));
    }
  };

  const deleteTemplate = async () => {
    if (!activeTemplate) return;
    const ok = await confirm({
      title: `删除录入模板「${activeTemplate.name}」？`,
      description: "删除后不会影响已录入到 sub2api 的账号。",
      destructive: true,
      confirmText: "删除",
    });
    if (!ok) return;
    try {
      await del(`/account-templates/${activeTemplate.id}`);
      toast.success("已删除模板");
      setSelectedId(null);
      invalidate("account-templates");
    } catch (e) {
      toast.error(readErr(e));
    }
  };

  if (templatesQ.isLoading) return <Skeleton className="h-96" />;

  const showPassthrough = draft ? draft.platform === "anthropic" || draft.platform === "openai" : false;

  return (
    <div className="grid gap-6 lg:grid-cols-[270px_minmax(0,1fr)]">
      {/* 左侧模板列表 */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">录入模板 ({templates.length})</span>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setNewOpen(true)}>
            <Plus className="size-3.5" />
            新增模板
          </Button>
        </div>
        {templates.length ? (
          <div className="space-y-1.5">
            {templates.map((t) => {
              const active = activeTemplate?.id === t.id;
              const linkedName = t.channel_code ? channelNameByCode.get(t.channel_code) || t.channel_code : "";
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelectedId(t.id)}
                  className={cn(
                    "hover:bg-accent/50 flex w-full flex-col gap-1.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
                    active && "border-primary bg-primary/5 ring-primary/20 ring-1",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{t.name}</span>
                    <PlatformBadge platform={t.config.platform} />
                  </div>
                  <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
                    <span>并发 {t.config.concurrency}</span>
                    <span>·</span>
                    <span>优先级 {t.config.priority}</span>
                    <span>·</span>
                    <span>{t.config.group_ids.length} 分组</span>
                    {t.config.pool_mode ? (
                      <>
                        <span>·</span>
                        <span>号池</span>
                      </>
                    ) : null}
                    {t.config.passthrough ? (
                      <>
                        <span>·</span>
                        <span>透传</span>
                      </>
                    ) : null}
                  </div>
                  {linkedName ? (
                    <div className="flex items-center gap-1 text-[11px]">
                      <Tag tone="info" className="text-[10px]">
                        自动匹配：{linkedName}
                      </Tag>
                    </div>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-xs">
            暂无录入模板，点击右上角「新增模板」创建。
          </div>
        )}
      </div>

      {/* 右侧模板编辑区 */}
      {activeTemplate && draft ? (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                <FileCode2 className="text-primary size-4" />
                {activeTemplate.name}
                <PlatformBadge platform={draft.platform} />
                {dirty ? <Tag tone="warn">有未保存修改</Tag> : null}
              </CardTitle>
              <CardDescription>
                编码 <span className="font-mono">{activeTemplate.code}</span> · 最近更新{" "}
                {time(activeTemplate.updated_at)}
                {" · "}录入时只填名称 / URL / Key，其余默认套用此模板并支持临时微调
              </CardDescription>
              <CardAction className="flex flex-wrap items-center gap-2">
                <ImportFromAccountButton
                  onImport={(cfg, sourceName) => {
                    updateDraft(configToDraftPatch(cfg));
                    toast.success(`已从账号「${sourceName}」导入配置，核对后请点击「保存模板」`);
                  }}
                />
                <Button type="button" size="sm" variant="outline" onClick={duplicateTemplate}>
                  <Copy className="size-3.5" />
                  复制
                </Button>
                <Button type="button" size="sm" variant="outline" className="text-destructive" onClick={deleteTemplate}>
                  <Trash2 className="size-3.5" />
                  删除
                </Button>
                <Button type="button" size="sm" disabled={saving || !dirty} onClick={saveTemplate}>
                  <Save className="size-3.5" />
                  {saving ? "保存中…" : "保存模板"}
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label>模板名称 *</Label>
                  <Input value={draft.name} onChange={(e) => updateDraft({ name: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label>平台 *</Label>
                  <Select
                    value={draft.platform}
                    onValueChange={(v) =>
                      updateDraft({
                        platform: v as AccountPlatform,
                        passthrough: v === "gemini" ? false : draft.passthrough,
                      })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="anthropic">anthropic</SelectItem>
                      <SelectItem value="openai">openai</SelectItem>
                      <SelectItem value="gemini">gemini</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>关联鉴定渠道（URL 测完自动选中）</Label>
                  <Select value={draft.channel_code} onValueChange={(v) => updateDraft({ channel_code: v })}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_CHANNEL}>不自动关联</SelectItem>
                      {channels.map((c) => (
                        <SelectItem key={c.code} value={c.code}>
                          {c.name} ({c.code})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>模板说明</Label>
                  <Input
                    placeholder="备注此模板适用场景，如 awsb 主力账号默认配置"
                    value={draft.description}
                    onChange={(e) => updateDraft({ description: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>账号默认备注（notes）</Label>
                  <Input
                    placeholder="可选，录入时自动填到账号备注"
                    value={draft.notes}
                    onChange={(e) => updateDraft({ notes: e.target.value })}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>默认连接与特性开关</CardTitle>
              <CardDescription>上游地址（base_url）与 API Key 每次录入时单独填写，模板只保存共用配置</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-6">
                <label className="flex items-center gap-2 text-sm">
                  创建后立即参与调度{" "}
                  <Switch checked={draft.schedulable} onCheckedChange={(x) => updateDraft({ schedulable: x })} />
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={draft.use_as_detect_key}
                    onCheckedChange={(x) => updateDraft({ use_as_detect_key: !!x })}
                  />
                  同时作为该账号的深度检测 Key
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                <label className="flex items-center gap-2 text-sm">
                  号池模式 <Switch checked={draft.pool_mode} onCheckedChange={(x) => updateDraft({ pool_mode: x })} />
                </label>
                <label className={cn("flex items-center gap-2 text-sm", !draft.pool_mode && "opacity-50")}>
                  重试次数{" "}
                  <Input
                    type="number"
                    className="h-8 w-16"
                    disabled={!draft.pool_mode}
                    value={draft.pool_mode_retry_count}
                    onChange={(e) => updateDraft({ pool_mode_retry_count: e.target.value })}
                  />
                </label>
                <label className={cn("flex items-center gap-2 text-sm", !draft.pool_mode && "opacity-50")}>
                  重试状态码{" "}
                  <Input
                    className="h-8 w-44 font-mono text-xs"
                    disabled={!draft.pool_mode}
                    placeholder="如 401,403,429,503"
                    value={draft.pool_mode_retry_status_codes}
                    onChange={(e) => updateDraft({ pool_mode_retry_status_codes: e.target.value })}
                  />
                </label>
                {showPassthrough ? (
                  <label className="flex items-center gap-2 text-sm">
                    透传 <Switch checked={draft.passthrough} onCheckedChange={(x) => updateDraft({ passthrough: x })} />
                  </label>
                ) : null}
                <label className="flex items-center gap-2 text-sm">
                  上游计费探测{" "}
                  <Switch
                    checked={draft.upstream_billing_probe_enabled}
                    onCheckedChange={(x) => updateDraft({ upstream_billing_probe_enabled: x })}
                  />
                </label>
              </div>
            </CardContent>
          </Card>

          <ModelMappingEditor
            title="默认模型映射"
            mapping={draft.mapping}
            onChange={(next) => updateDraft({ mapping: next })}
          />

          <Card>
            <CardHeader>
              <CardTitle>默认调度与分组</CardTitle>
              <CardDescription>
                {draft.group_ids.size > 0
                  ? `当前默认分组：${[...draft.group_ids].map((id) => groupName(id)).join("、")}`
                  : "录入时可在此默认分组基础上按需增删"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div className="space-y-2">
                  <Label>优先级（1–10，越小越优先）</Label>
                  <Input
                    type="number"
                    value={draft.priority}
                    onChange={(e) => updateDraft({ priority: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>并发上限</Label>
                  <Input
                    type="number"
                    value={draft.concurrency}
                    onChange={(e) => updateDraft({ concurrency: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>负载系数（留空 = 按并发）</Label>
                  <Input
                    type="number"
                    step="any"
                    value={draft.load_factor}
                    onChange={(e) => updateDraft({ load_factor: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>账号倍率</Label>
                  <Input
                    type="number"
                    step="any"
                    value={draft.rate_multiplier}
                    onChange={(e) => updateDraft({ rate_multiplier: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>代理</Label>
                  <Select value={draft.proxy_id} onValueChange={(x) => updateDraft({ proxy_id: x })}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">不使用代理</SelectItem>
                      {(proxiesQ.data ?? []).map((p) => (
                        <SelectItem key={p.id} value={String(p.id)}>
                          {p.name} · {p.protocol}://{p.host}:{p.port}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-end pb-2">
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={draft.auto_pause_on_expired}
                      onCheckedChange={(x) => updateDraft({ auto_pause_on_expired: !!x })}
                    />
                    到期自动暂停
                  </label>
                </div>
              </div>
              <GroupMultiPicker
                groups={groups}
                value={draft.group_ids}
                onChange={(next) => updateDraft({ group_ids: next })}
                platform={draft.platform}
                label="默认所属分组"
              />
            </CardContent>
          </Card>

          <Collapsible className="rounded-xl border">
            <CollapsibleTrigger className="w-full px-6 py-4 text-left text-sm font-medium">
              高级：默认其他凭证与扩展字段（JSON；一般不用改）▾
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-4 px-6 pb-4">
              <div className="space-y-1.5">
                <Label className="text-xs">其他凭证字段（credentials）</Label>
                <Textarea
                  className="min-h-24 font-mono text-xs"
                  value={draft.credentials_other}
                  onChange={(e) => updateDraft({ credentials_other: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">扩展字段（extra，不含透传与计费探测开关）</Label>
                <Textarea
                  className="min-h-24 font-mono text-xs"
                  value={draft.extra_other}
                  onChange={(e) => updateDraft({ extra_other: e.target.value })}
                />
              </div>
            </CollapsibleContent>
          </Collapsible>

          <div className="flex items-center justify-end gap-2">
            {dirty ? (
              <Badge variant="outline" className="text-warning border-warning/40 font-normal">
                有未保存修改
              </Badge>
            ) : null}
            <Button type="button" disabled={saving || !dirty} onClick={saveTemplate}>
              <Save className="size-4" />
              {saving ? "保存中…" : "保存模板"}
            </Button>
          </div>
        </div>
      ) : (
        <Card>
          <CardContent className="text-muted-foreground flex flex-col items-center justify-center gap-3 py-16 text-sm">
            <FileCode2 className="size-8 opacity-40" />
            <p>选择一个模板查看或编辑，或点击左侧「新增模板」创建。</p>
            <Button size="sm" onClick={() => setNewOpen(true)}>
              <Plus className="size-4" />
              新增模板
            </Button>
          </CardContent>
        </Card>
      )}

      <NewTemplateDialog open={newOpen} onOpenChange={setNewOpen} onCreated={(id) => setSelectedId(id)} />
      {confirmEl}
    </div>
  );
}
