"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  FileCode2,
  Loader2,
  Search,
  Settings2,
  Sparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { post, put } from "../api";
import { CLAUDE_MODELS, GEMINI_MODELS, OPENAI_MODELS, readErr } from "../format";
import { useAccountTemplates, useInvalidate, useProxies } from "../hooks";
import { useOps } from "../provider";
import type { AccountPlatform, AccountTemplate, AccountTemplateConfig, Group, VerifyFetchModelsResp } from "../types";

import { PlatformBadge, Tag } from "./badges";
import { ResponsiveDialog, useConfirm } from "./shared";

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

export type AccountFormInitialValues = {
  name?: string;
  base_url?: string;
  api_key?: string;
  source_verify_run_id?: string;
  saved_key_masked?: string;
  platform?: string;
  notes?: string;
  preset_models?: string[];
};

function buildPresetModelMapping(presetModels: string[], tplMapping?: Record<string, string>): [string, string][] {
  const passedSet = new Set(presetModels);
  const rows: [string, string][] = presetModels.map((m) => [m, m]);
  const seenKeys = new Set(presetModels);
  if (tplMapping && typeof tplMapping === "object") {
    for (const [reqModel, upModel] of Object.entries(tplMapping)) {
      const req = reqModel.trim();
      const up = (upModel || reqModel).trim();
      if (!req || !up || seenKeys.has(req)) continue;
      if (passedSet.has(up)) {
        rows.push([req, up]);
        seenKeys.add(req);
      }
    }
  }
  return rows;
}

const KNOWN_CRED_KEYS = [
  "base_url",
  "model_mapping",
  "pool_mode",
  "pool_mode_retry_count",
  "pool_mode_retry_status_codes",
  "api_key",
  "access_token",
  "refresh_token",
  "session_key",
  "cookie",
];

const KNOWN_EXTRA_KEYS = ["anthropic_passthrough", "openai_passthrough", "upstream_billing_probe_enabled"];

export const EMPTY_TEMPLATE_CONFIG: AccountTemplateConfig = {
  platform: "anthropic",
  notes: "",
  schedulable: true,
  use_as_detect_key: true,
  pool_mode: false,
  pool_mode_retry_count: 3,
  pool_mode_retry_status_codes: "",
  passthrough: false,
  upstream_billing_probe_enabled: false,
  model_mapping: {},
  priority: 1,
  concurrency: 1000,
  load_factor: "",
  rate_multiplier: 1,
  proxy_id: 0,
  auto_pause_on_expired: true,
  group_ids: [],
  credentials_other: {},
  extra_other: {},
};

const passKey = (p: string): "anthropic_passthrough" | "openai_passthrough" | null =>
  p === "openai" ? "openai_passthrough" : p === "anthropic" ? "anthropic_passthrough" : null;

const normalizePlatform = (p?: string): AccountPlatform =>
  p === "openai" || p === "gemini" || p === "anthropic" ? p : "anthropic";

const dtLocal = (t?: string | null) => {
  if (!t) return "";
  const d = new Date(t);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

function stripKeys(obj: Record<string, unknown> | undefined, keys: string[]): Record<string, unknown> {
  if (!obj || typeof obj !== "object") return {};
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
}

export function accountFullToTemplateConfig(a: AccountFull): AccountTemplateConfig {
  const c = a.credentials || {};
  const plat = normalizePlatform(a.platform);
  const pk = passKey(plat);
  return {
    platform: plat,
    notes: a.notes ?? "",
    schedulable: a.schedulable !== false,
    use_as_detect_key: true,
    pool_mode: !!c.pool_mode,
    pool_mode_retry_count: c.pool_mode_retry_count ?? 3,
    pool_mode_retry_status_codes: (c.pool_mode_retry_status_codes || []).join(","),
    passthrough: pk ? !!a.extra?.[pk] : false,
    upstream_billing_probe_enabled: !!a.extra?.upstream_billing_probe_enabled,
    model_mapping: { ...(c.model_mapping || {}) },
    priority: a.priority ?? 1,
    concurrency: a.concurrency ?? 1000,
    load_factor: a.load_factor ? String(a.load_factor) : "",
    rate_multiplier: a.rate_multiplier ?? 1,
    proxy_id: a.proxy_id ?? 0,
    auto_pause_on_expired: a.auto_pause_on_expired !== false,
    group_ids: [...(a.group_ids || [])],
    credentials_other: stripKeys(c, KNOWN_CRED_KEYS),
    extra_other: stripKeys(a.extra, KNOWN_EXTRA_KEYS),
  };
}

// ---------- 共享子组件：模型映射编辑器 ----------
export function ModelMappingEditor({
  mapping,
  onChange,
  availableModels,
  availableModelsLabel,
  onFetchUpstream,
  fetchingUpstream = false,
  canFetchUpstream = false,
  title = "模型映射",
  description = "左边是客户请求的模型，右边是发给上游的模型；相同则只是允许该模型",
}: {
  mapping: [string, string][];
  onChange: (next: [string, string][]) => void;
  availableModels?: string[];
  availableModelsLabel?: string;
  onFetchUpstream?: () => void;
  fetchingUpstream?: boolean;
  canFetchUpstream?: boolean;
  title?: string;
  description?: string;
}) {
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");

  const addModels = (list: string[]) => {
    const have = new Set(mapping.map(([k]) => k));
    const added = list
      .filter((x) => x.trim() && !have.has(x.trim()))
      .map((x) => [x.trim(), x.trim()] as [string, string]);
    if (!added.length) return;
    onChange([...mapping, ...added]);
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
          <CardAction className="flex flex-wrap gap-1">
            {onFetchUpstream ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={fetchingUpstream || !canFetchUpstream}
                onClick={onFetchUpstream}
              >
                {fetchingUpstream ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                {fetchingUpstream ? "拉取中…" : "拉取上游模型"}
              </Button>
            ) : null}
            {availableModels && availableModels.length > 0 ? (
              <Button type="button" size="sm" variant="outline" onClick={() => addModels(availableModels)}>
                ＋ {availableModelsLabel || "本次拉取模型"} ({availableModels.length})
              </Button>
            ) : null}
            <Button type="button" size="sm" variant="outline" onClick={() => addModels(CLAUDE_MODELS)}>
              ＋ Claude 常用
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => addModels(OPENAI_MODELS)}>
              ＋ GPT 常用
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => addModels(GEMINI_MODELS)}>
              ＋ Gemini 常用
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => onChange([...mapping, ["", ""]])}>
              ＋ 一行
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setBulkOpen(true)}>
              批量粘贴
            </Button>
            <Button type="button" size="sm" variant="outline" className="text-destructive" onClick={() => onChange([])}>
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
                  className="font-mono text-xs"
                  onChange={(e) => onChange(mapping.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))}
                />
                <span className="text-muted-foreground">→</span>
                <Input
                  value={x}
                  placeholder="上游模型（留空 = 同左）"
                  className="font-mono text-xs"
                  onChange={(e) => onChange(mapping.map((r, j) => (j === i ? [r[0], e.target.value] : r)))}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => onChange(mapping.filter((_, j) => j !== i))}
                >
                  删除
                </Button>
              </div>
            ))
          ) : (
            <p className="text-muted-foreground text-sm">未设置模型映射（留空表示不限制，由 sub2api 默认匹配）</p>
          )}
        </CardContent>
      </Card>

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
              const have = new Set(mapping.map(([k]) => k));
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
              onChange([...mapping, ...add]);
              setBulkText("");
              setBulkOpen(false);
            }}
          >
            添加
          </Button>
        </div>
      </ResponsiveDialog>
    </>
  );
}

// ---------- 共享子组件：所属分组多选器（支持搜索与按平台过滤） ----------
export function GroupMultiPicker({
  groups,
  value,
  onChange,
  platform,
  label = "所属分组",
}: {
  groups: Group[];
  value: Set<number>;
  onChange: (next: Set<number>) => void;
  platform?: string;
  label?: string;
}) {
  const [kw, setKw] = useState("");
  const [onlySamePlatform, setOnlySamePlatform] = useState(false);

  const selectedGroups = useMemo(() => {
    const map = new Map(groups.map((g) => [g.id, g]));
    return [...value].map((id) => ({ id, group: map.get(id) }));
  }, [groups, value]);

  const filtered = useMemo(() => {
    const q = kw.trim().toLowerCase();
    return groups.filter((g) => {
      if (onlySamePlatform && platform && g.platform !== platform) return false;
      if (q && !`${g.name} ${g.platform} ${g.id}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [groups, kw, onlySamePlatform, platform]);

  const toggle = (id: number, checked: boolean) => {
    const n = new Set(value);
    if (checked) n.add(id);
    else n.delete(id);
    onChange(n);
  };

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label>
          {label}
          {value.size > 0 ? (
            <span className="text-muted-foreground ml-1.5 font-normal">（已选 {value.size} 个）</span>
          ) : null}
        </Label>
        <div className="flex flex-wrap items-center gap-2">
          {platform ? (
            <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Checkbox checked={onlySamePlatform} onCheckedChange={(x) => setOnlySamePlatform(!!x)} />
              仅看 {platform} 分组
            </label>
          ) : null}
          {value.size > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-muted-foreground h-6 px-2 text-xs"
              onClick={() => onChange(new Set())}
            >
              清空已选
            </Button>
          ) : null}
        </div>
      </div>

      {selectedGroups.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {selectedGroups.map(({ id, group }) => (
            <Badge key={id} variant="secondary" className="gap-1 pr-1 font-normal">
              <span>{group ? group.name : `分组 #${id}（已不存在）`}</span>
              {group ? <span className="text-muted-foreground text-[10px]">{group.platform}</span> : null}
              <button
                type="button"
                className="hover:bg-muted-foreground/20 rounded-full p-0.5"
                onClick={() => toggle(id, false)}
                title="移除"
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}

      <div className="relative">
        <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
        <Input
          placeholder="搜索分组名称或平台…"
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          className="h-8 pl-8 text-xs"
        />
      </div>

      <div className="grid max-h-56 gap-2 overflow-y-auto rounded-md border p-3 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.length ? (
          filtered.map((g) => (
            <label
              key={g.id}
              className="hover:bg-accent/40 flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm"
            >
              <Checkbox checked={value.has(g.id)} onCheckedChange={(x) => toggle(g.id, !!x)} />
              <span className="truncate">{g.name}</span>
              <span className="text-muted-foreground shrink-0 text-xs">{g.platform}</span>
            </label>
          ))
        ) : (
          <p className="text-muted-foreground col-span-full py-4 text-center text-xs">没有匹配的分组</p>
        )}
      </div>
    </div>
  );
}

// 新建 / 编辑上游账号（直接写 sub2api；只读模式下后端会拦截）
export function AccountForm({
  account: a,
  presetGroup,
  initialValues,
  presetModelsLabel,
  presetModelsSyncVersion = 0,
  defaultChannelCode,
  availableModels,
  submitDisabled = false,
  submitLabel,
  onSuccess,
  onCancel,
  onManageTemplates,
}: {
  account: AccountFull | null;
  presetGroup?: number | null;
  initialValues?: AccountFormInitialValues;
  presetModelsLabel?: string;
  presetModelsSyncVersion?: number;
  defaultChannelCode?: string;
  availableModels?: string[];
  submitDisabled?: boolean;
  submitLabel?: string;
  onSuccess?: (created: { id: number; name: string }) => void;
  onCancel?: () => void;
  onManageTemplates?: () => void;
}) {
  const router = useRouter();
  const invalidate = useInvalidate();
  const { groups, groupName } = useOps();
  const creating = !a;
  const pg = presetGroup ? groups.find((g) => g.id === presetGroup) : undefined;
  const proxies = useProxies();
  const templatesQ = useAccountTemplates();
  const templates = useMemo(() => templatesQ.data ?? [], [templatesQ.data]);
  const [confirm, confirmEl] = useConfirm();
  const c = a?.credentials || {};

  const initPlatform = normalizePlatform(
    a?.platform ||
      initialValues?.platform ||
      (pg && ["anthropic", "openai", "gemini"].includes(pg.platform) ? pg.platform : "anthropic"),
  );
  const initPassKey = passKey(initPlatform);

  const [v, setV] = useState({
    name: a?.name ?? initialValues?.name ?? "",
    notes: a?.notes ?? initialValues?.notes ?? "",
    platform: initPlatform as string,
    base_url: c.base_url ?? initialValues?.base_url ?? "",
    api_key: initialValues?.api_key ?? "",
    use_as_detect_key: true,
    pool_mode: !!c.pool_mode,
    pool_mode_retry_count: String(c.pool_mode_retry_count ?? 3),
    pool_mode_retry_status_codes: (c.pool_mode_retry_status_codes || []).join(","),
    passthrough: initPassKey ? !!a?.extra?.[initPassKey] : false,
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
    other: JSON.stringify(stripKeys(c, KNOWN_CRED_KEYS), null, 2),
    extraOther: JSON.stringify(stripKeys(a?.extra, KNOWN_EXTRA_KEYS), null, 2),
  });
  const rawPresetModels = initialValues?.preset_models;
  const presetModels = useMemo(
    () => (rawPresetModels ? [...new Set(rawPresetModels.map((m) => m.trim()).filter(Boolean))] : []),
    [rawPresetModels],
  );
  const [groupIds, setGroupIds] = useState<Set<number>>(new Set(a?.group_ids ?? (presetGroup ? [presetGroup] : [])));
  const [mapping, setMapping] = useState<[string, string][]>(() =>
    a ? Object.entries(c.model_mapping || {}) : presetModels.length > 0 ? buildPresetModelMapping(presetModels) : [],
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("none");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fetchingUpstreamModels, setFetchingUpstreamModels] = useState(false);
  const [fetchedUpstreamList, setFetchedUpstreamList] = useState<string[]>([]);
  const autoAppliedRef = useRef(false);
  const userEditedMappingRef = useRef(false);
  const lastPresetSigRef = useRef(presetModels.join("\n"));
  const lastSyncVersionRef = useRef(presetModelsSyncVersion);

  const handleMappingChange = (next: [string, string][]) => {
    userEditedMappingRef.current = true;
    setMapping(next);
  };

  const set = (p: Partial<typeof v>) => setV((x) => ({ ...x, ...p }));

  const validGroupIdSet = useMemo(() => new Set(groups.map((g) => g.id)), [groups]);

  const applyTemplate = (tpl: AccountTemplate | null) => {
    if (!tpl) {
      setSelectedTemplateId("none");
      setV((prev) => ({
        ...prev,
        notes: initialValues?.notes ?? "",
        platform: initPlatform,
        use_as_detect_key: true,
        pool_mode: false,
        pool_mode_retry_count: "3",
        pool_mode_retry_status_codes: "",
        passthrough: false,
        upstream_billing_probe_enabled: false,
        priority: "1",
        concurrency: "1000",
        load_factor: "",
        rate_multiplier: "1",
        proxy_id: "0",
        auto_pause_on_expired: true,
        schedulable: true,
        other: "{}",
        extraOther: "{}",
      }));
      setMapping(presetModels.length > 0 ? buildPresetModelMapping(presetModels) : []);
      setGroupIds(new Set(presetGroup ? [presetGroup] : []));
      return;
    }
    const cfg = tpl.config;
    setSelectedTemplateId(String(tpl.id));
    setDetailsOpen(false);
    setV((prev) => ({
      ...prev,
      // 保留账号名称、URL、API Key 不变，其余按模板套用
      platform: cfg.platform,
      notes: cfg.notes,
      schedulable: cfg.schedulable,
      use_as_detect_key: cfg.use_as_detect_key,
      pool_mode: cfg.pool_mode,
      pool_mode_retry_count: String(cfg.pool_mode_retry_count ?? 3),
      pool_mode_retry_status_codes: cfg.pool_mode_retry_status_codes ?? "",
      passthrough: cfg.platform === "gemini" ? false : !!cfg.passthrough,
      upstream_billing_probe_enabled: !!cfg.upstream_billing_probe_enabled,
      priority: String(cfg.priority ?? 1),
      concurrency: String(cfg.concurrency ?? 1000),
      load_factor: cfg.load_factor ?? "",
      rate_multiplier: String(cfg.rate_multiplier ?? 1),
      proxy_id: String(cfg.proxy_id ?? 0),
      auto_pause_on_expired: cfg.auto_pause_on_expired !== false,
      other: JSON.stringify(cfg.credentials_other || {}, null, 2),
      extraOther: JSON.stringify(cfg.extra_other || {}, null, 2),
    }));
    setMapping(
      presetModels.length > 0
        ? buildPresetModelMapping(presetModels, cfg.model_mapping)
        : Object.entries(cfg.model_mapping || {}),
    );
    const nextGroups = new Set<number>(
      (cfg.group_ids || []).filter((id) => validGroupIdSet.size === 0 || validGroupIdSet.has(id)),
    );
    if (presetGroup) nextGroups.add(presetGroup);
    setGroupIds(nextGroups);
  };

  // 若指定了 defaultChannelCode（如来自 URL 鉴定的 aws_bedrock），加载模板后自动套用对应模板一次
  useEffect(() => {
    if (!creating || !defaultChannelCode || autoAppliedRef.current || !templates.length) return;
    const hit = templates.find((t) => t.channel_code === defaultChannelCode);
    if (hit) {
      autoAppliedRef.current = true;
      applyTemplate(hit);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creating, defaultChannelCode, templates]);

  const activeTemplate = useMemo(
    () => (selectedTemplateId === "none" ? null : (templates.find((t) => String(t.id) === selectedTemplateId) ?? null)),
    [selectedTemplateId, templates],
  );

  // 异步自动拉取到上游模型（或弹窗内点击「重新拉取」）后，同步填入模型映射且不丢用户输入
  useEffect(() => {
    if (!creating) return;
    const sig = presetModels.join("\n");
    const force = presetModelsSyncVersion !== lastSyncVersionRef.current;
    if (!force && sig === lastPresetSigRef.current) return;
    lastPresetSigRef.current = sig;
    lastSyncVersionRef.current = presetModelsSyncVersion;
    if (!presetModels.length) return;
    if (force || !userEditedMappingRef.current) {
      userEditedMappingRef.current = false;
      setMapping(buildPresetModelMapping(presetModels, activeTemplate?.config.model_mapping));
    }
  }, [creating, presetModels, presetModelsSyncVersion, activeTemplate]);

  const canFetchUpstream = Boolean(
    creating
      ? /^https?:\/\/[^/\s]+/i.test(v.base_url.trim()) && (v.api_key.trim() || initialValues?.source_verify_run_id)
      : a?.id,
  );

  const fetchUpstreamIntoMapping = async () => {
    if (fetchingUpstreamModels) return;
    setFetchingUpstreamModels(true);
    try {
      const payload = creating
        ? {
            base_url: v.base_url.trim(),
            api_key: v.api_key.trim() || undefined,
            source_run_id: !v.api_key.trim() ? initialValues?.source_verify_run_id : undefined,
          }
        : {
            account_id: a.id,
            api_key_override: v.api_key.trim() || undefined,
          };
      const r = await post<VerifyFetchModelsResp>("/verify/fetch-models", payload);
      const upstreamModels = (r.models || []).filter((m) => m.source !== "模型映射");
      const ids = [
        ...new Set((upstreamModels.length ? upstreamModels : r.models || []).map((m) => m.id.trim()).filter(Boolean)),
      ];
      setFetchedUpstreamList(ids);
      if (!ids.length) {
        toast.warning("上游返回的模型列表为空");
        return;
      }
      userEditedMappingRef.current = true;
      setMapping((prev) => {
        const cleanPrev = prev.filter(([k]) => k.trim());
        if (!cleanPrev.length) {
          return buildPresetModelMapping(ids, activeTemplate?.config.model_mapping);
        }
        const have = new Set(cleanPrev.map(([k]) => k.trim()));
        const added = ids.filter((id) => !have.has(id)).map((id) => [id, id] as [string, string]);
        return [...cleanPrev, ...added];
      });
      toast.success(`已从上游 ${r.endpoint} 获取 ${ids.length} 个模型 ID 并写入模型映射`);
    } catch (err) {
      toast.error(readErr(err));
    } finally {
      setFetchingUpstreamModels(false);
    }
  };

  const mergedAvailableModels = useMemo(() => {
    const list = [...(availableModels ?? []), ...fetchedUpstreamList];
    return [...new Set(list.map((m) => m.trim()).filter(Boolean))];
  }, [availableModels, fetchedUpstreamList]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    let other: Record<string, unknown>;
    try {
      const parsed = JSON.parse(v.other || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return toast.error("高级凭证字段必须是 JSON 对象");
      }
      other = parsed as Record<string, unknown>;
    } catch {
      return toast.error("高级凭证字段不是合法 JSON");
    }
    let extraOther: Record<string, unknown>;
    try {
      const parsed = JSON.parse(v.extraOther || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return toast.error("扩展字段 extra 必须是 JSON 对象");
      }
      extraOther = parsed as Record<string, unknown>;
    } catch {
      return toast.error("扩展字段 extra 不是合法 JSON");
    }

    const plat = creating ? v.platform : a.platform;
    const body: Record<string, unknown> = {
      name: v.name,
      notes: v.notes,
      platform: plat,
      base_url: v.base_url,
      api_key: v.api_key,
      ...(creating && !v.api_key.trim() && initialValues?.source_verify_run_id
        ? { source_verify_run_id: initialValues.source_verify_run_id }
        : {}),
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
    // 透传开关或扩展字段有内容时提交 extra（sub2api 的 extra 是整份覆盖）
    const pk = passKey(plat);
    const mergedExtra: Record<string, unknown> = { ...extraOther };
    if (pk) {
      if (creating ? v.passthrough : !!a.extra?.[pk] !== v.passthrough || Object.keys(extraOther).length > 0) {
        mergedExtra[pk] = v.passthrough;
      }
    }
    if (creating) {
      if (Object.keys(mergedExtra).length > 0) body.extra = mergedExtra;
    } else {
      const origExtraOther = stripKeys(a.extra, KNOWN_EXTRA_KEYS);
      const extraChanged =
        (pk ? !!a.extra?.[pk] !== v.passthrough : false) ||
        JSON.stringify(origExtraOther) !== JSON.stringify(extraOther);
      if (extraChanged) {
        body.extra = {
          ...(a.extra?.upstream_billing_probe_enabled !== undefined
            ? { upstream_billing_probe_enabled: a.extra.upstream_billing_probe_enabled }
            : {}),
          ...mergedExtra,
        };
      }
    }

    setBusy(true);
    const send = async (mixed: boolean): Promise<void> => {
      try {
        const r = creating
          ? await post<{ id: number; name?: string; warnings?: string[] }>("/accounts", {
              ...body,
              confirm_mixed_channel_risk: mixed,
            })
          : await put<{ ok: boolean; warnings?: string[] }>(`/accounts/${a.id}`, {
              ...body,
              confirm_mixed_channel_risk: mixed,
            });
        invalidate("accounts", "meta");
        const newId = creating ? (r as { id: number }).id : a.id;
        const createdName = creating ? (r as { name?: string }).name || v.name.trim() : v.name.trim();
        toast.success(creating ? `账号「${createdName}」已录入 (#${newId})` : "已保存");
        if (Array.isArray(r.warnings) && r.warnings.length > 0) {
          toast.warning(r.warnings.join("；"), { duration: 9000 });
        }
        if (creating && pg) {
          if (v.enroll && groupIds.has(pg.id))
            await post(`/sched/groups/${pg.id}/enroll`, { account_ids: [newId], enrolled: true }).catch((err) =>
              toast.error(`关联智能调度失败：${readErr(err)}`),
            );
          if (onSuccess) {
            onSuccess({ id: newId, name: createdName });
            return;
          }
          router.push(`/dashboard/groups/${pg.id}`);
          return;
        }
        if (onSuccess) {
          onSuccess({ id: newId, name: createdName });
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
    void send(false);
  };

  const sw = (label: string, key: keyof typeof v) => (
    <label className="flex items-center gap-2 text-sm">
      {label} <Switch checked={!!v[key]} onCheckedChange={(x) => set({ [key]: x } as Partial<typeof v>)} />
    </label>
  );

  const showPassthrough = v.platform === "anthropic" || v.platform === "openai";
  const compactTemplateMode = creating && Boolean(activeTemplate);
  const selectedGroupNames = [...groupIds].map((id) => groupName(id));

  const nameField = (
    <div className="space-y-2">
      <Label>账号名称 *</Label>
      <Input
        required
        value={v.name}
        placeholder="例如：小欧--awsb--3.3"
        onChange={(e) => set({ name: e.target.value })}
      />
    </div>
  );

  const baseUrlField = (
    <div className="space-y-2">
      <Label>上游地址（base_url）*</Label>
      <Input
        required
        className="font-mono text-xs"
        value={v.base_url}
        placeholder="https://api.example.com"
        onChange={(e) => set({ base_url: e.target.value })}
      />
    </div>
  );

  const apiKeyField = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label>
          API Key{" "}
          {creating
            ? initialValues?.source_verify_run_id && !v.api_key.trim()
              ? "（留空 = 自动复用测试 Key）"
              : "*"
            : "（留空 = 保持原 Key 不变）"}
        </Label>
        {creating && initialValues?.source_verify_run_id && !v.api_key.trim() ? (
          <Tag tone="ok" className="font-mono text-[10px]">
            已复用测试 Key：{initialValues.saved_key_masked || "后端已保存"}
          </Tag>
        ) : null}
      </div>
      <div className="flex gap-2">
        <Input
          type={showKey ? "text" : "password"}
          required={creating && !initialValues?.source_verify_run_id}
          autoComplete="new-password"
          className="flex-1 font-mono text-xs"
          placeholder={
            creating
              ? initialValues?.source_verify_run_id
                ? `留空将自动复用测试时的 Key（${initialValues.saved_key_masked || "已保存"}），也可输入新 Key 覆盖`
                : "sk-…"
              : "不修改请留空"
          }
          value={v.api_key}
          onChange={(e) => set({ api_key: e.target.value })}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => setShowKey((s) => !s)}
          title={showKey ? "隐藏 Key" : "显示 Key"}
        >
          {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </Button>
      </div>
    </div>
  );

  const platformField = (
    <div className="space-y-2">
      <Label>平台{creating ? " *" : "（创建后不可改）"}</Label>
      <Select
        value={v.platform}
        onValueChange={(x) => set({ platform: x, passthrough: x === "gemini" ? false : v.passthrough })}
        disabled={!creating}
      >
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
  );

  const connectionSwitches = (
    <>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={v.use_as_detect_key} onCheckedChange={(x) => set({ use_as_detect_key: !!x })} />{" "}
        同时作为这个账号的深度检测 Key
      </label>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        {sw("号池模式", "pool_mode")}
        <label className={cn("flex items-center gap-2 text-sm", !v.pool_mode && "opacity-50")}>
          重试次数{" "}
          <Input
            type="number"
            className="h-8 w-16"
            disabled={!v.pool_mode}
            value={v.pool_mode_retry_count}
            onChange={(e) => set({ pool_mode_retry_count: e.target.value })}
          />
        </label>
        <label className={cn("flex items-center gap-2 text-sm", !v.pool_mode && "opacity-50")}>
          重试状态码{" "}
          <Input
            className="h-8 w-44 font-mono text-xs"
            disabled={!v.pool_mode}
            placeholder="如 401,403,429,503"
            value={v.pool_mode_retry_status_codes}
            onChange={(e) => set({ pool_mode_retry_status_codes: e.target.value })}
          />
        </label>
        {showPassthrough ? sw("透传", "passthrough") : null}
        {sw("上游计费探测", "upstream_billing_probe_enabled")}
      </div>
    </>
  );

  const scheduleCard = (
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
        <GroupMultiPicker groups={groups} value={groupIds} onChange={setGroupIds} platform={v.platform} />
      </CardContent>
    </Card>
  );

  const advancedCard = (
    <Collapsible className="rounded-xl border">
      <CollapsibleTrigger className="w-full px-6 py-4 text-left text-sm font-medium">
        高级：其他凭证与扩展字段（JSON，不含 Key；一般不用改）▾
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 px-6 pb-4">
        <div className="space-y-1.5">
          <Label className="text-xs">其他凭证字段（credentials）</Label>
          <Textarea
            className="min-h-24 font-mono text-xs"
            value={v.other}
            onChange={(e) => set({ other: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">扩展字段（extra，不含透传与计费探测开关）</Label>
          <Textarea
            className="min-h-24 font-mono text-xs"
            value={v.extraOther}
            onChange={(e) => set({ extraOther: e.target.value })}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );

  return (
    <form onSubmit={submit} className="space-y-4">
      {creating ? (
        <Card className="border-primary/25 bg-primary/[0.02]">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <FileCode2 className="text-primary size-4" />
              套用录入模板
            </CardTitle>
            <CardDescription>
              选择模板后仅需填写名称、URL 与 Key 即可直接录入；其他详细配置默认收起，随时可展开微调（不会修改原模板）。
            </CardDescription>
            {onManageTemplates ? (
              <CardAction>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={onManageTemplates}
                >
                  <Settings2 className="size-3.5" />
                  管理模板
                </Button>
              </CardAction>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Select
                value={selectedTemplateId}
                onValueChange={(val) => {
                  if (val === "none") applyTemplate(null);
                  else applyTemplate(templates.find((t) => String(t.id) === val) ?? null);
                }}
              >
                <SelectTrigger className="w-full sm:w-72">
                  <SelectValue placeholder="选择录入模板（可选）" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">不使用模板（展开全部手动填写）</SelectItem>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>
                      {t.name}（{t.config.platform} · {t.config.group_ids.length} 分组）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {templates.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  {templates.slice(0, 6).map((t) => {
                    const active = String(t.id) === selectedTemplateId;
                    return (
                      <Button
                        key={t.id}
                        type="button"
                        size="sm"
                        variant={active ? "default" : "outline"}
                        className="h-7 gap-1 px-2.5 text-xs"
                        onClick={() => applyTemplate(t)}
                      >
                        <Sparkles className="size-3" />
                        {t.name}
                      </Button>
                    );
                  })}
                </div>
              ) : null}
            </div>
            {activeTemplate ? (
              <div className="bg-background/80 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs">
                <Tag tone="ok">已套用模板：{activeTemplate.name}</Tag>
                <PlatformBadge platform={v.platform} />
                <span className="text-muted-foreground">
                  {activeTemplate.description ||
                    "下方详细配置已按模板自动填充并默认收起，如需修改分组或参数可点击展开。"}
                </span>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {compactTemplateMode ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>必填信息</CardTitle>
              <CardDescription>已按模板填充其余配置，核对账号名称、URL 与 Key 后即可直接录入</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {nameField}
              {baseUrlField}
              {apiKeyField}
            </CardContent>
          </Card>

          <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen} className="rounded-xl border">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="hover:bg-accent/40 flex w-full flex-col gap-2 rounded-xl px-5 py-3.5 text-left transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {detailsOpen ? (
                      <ChevronDown className="text-muted-foreground size-4" />
                    ) : (
                      <ChevronRight className="text-muted-foreground size-4" />
                    )}
                    模板详细配置（平台 / 分组 / 模型映射 / 调度 / 号池等）
                  </span>
                  <span className="text-primary text-xs font-medium">{detailsOpen ? "收起详情" : "展开微调"}</span>
                </div>
                <div className="text-muted-foreground flex flex-wrap items-center gap-1.5 pl-6 text-xs">
                  <PlatformBadge platform={v.platform} />
                  <Badge variant="secondary" className="font-normal">
                    {selectedGroupNames.length > 0
                      ? `分组：${selectedGroupNames.slice(0, 3).join("、")}${selectedGroupNames.length > 3 ? ` +${selectedGroupNames.length - 3}` : ""}`
                      : "未选分组"}
                  </Badge>
                  <Badge variant="outline" className="font-normal">
                    并发 {v.concurrency || "1000"} · 优先级 {v.priority || "1"} · 倍率 {v.rate_multiplier || "1"}
                  </Badge>
                  {v.pool_mode ? (
                    <Badge variant="outline" className="font-normal">
                      号池（重试 {v.pool_mode_retry_count || "0"} 次）
                    </Badge>
                  ) : null}
                  {showPassthrough && v.passthrough ? (
                    <Badge variant="outline" className="font-normal">
                      透传
                    </Badge>
                  ) : null}
                  {mapping.length > 0 ? (
                    <Badge
                      variant="outline"
                      className={cn("font-normal", presetModels.length > 0 && "border-success/40 text-success")}
                    >
                      {presetModels.length > 0
                        ? `${presetModelsLabel || "上游模型"} ${mapping.length} 条`
                        : `模型映射 ${mapping.length} 条`}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="border-warning/40 text-warning font-normal">
                      未限模型（全放行）
                    </Badge>
                  )}
                </div>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-4 border-t p-4">
              <Card>
                <CardHeader>
                  <CardTitle>平台、备注与连接特性</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    {platformField}
                    <div className="space-y-2">
                      <Label>备注</Label>
                      <Input value={v.notes} onChange={(e) => set({ notes: e.target.value })} />
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-6">{sw("创建后立即参与调度", "schedulable")}</div>
                  {connectionSwitches}
                </CardContent>
              </Card>

              <ModelMappingEditor
                mapping={mapping}
                onChange={handleMappingChange}
                availableModels={mergedAvailableModels}
                availableModelsLabel={presetModels.length > 0 ? presetModelsLabel || "上游模型" : undefined}
                onFetchUpstream={() => void fetchUpstreamIntoMapping()}
                fetchingUpstream={fetchingUpstreamModels}
                canFetchUpstream={canFetchUpstream}
              />
              {scheduleCard}
              {advancedCard}
            </CollapsibleContent>
          </Collapsible>
        </>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>基本信息</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                {nameField}
                {platformField}
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
              {baseUrlField}
              {apiKeyField}
              {connectionSwitches}
            </CardContent>
          </Card>

          <ModelMappingEditor
            mapping={mapping}
            onChange={handleMappingChange}
            availableModels={mergedAvailableModels}
            availableModelsLabel={presetModels.length > 0 ? presetModelsLabel || "上游模型" : undefined}
            onFetchUpstream={() => void fetchUpstreamIntoMapping()}
            fetchingUpstream={fetchingUpstreamModels}
            canFetchUpstream={canFetchUpstream}
          />
          {scheduleCard}
          {advancedCard}
        </>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={busy || submitDisabled}>
          {busy ? "提交中…" : (submitLabel ?? (creating ? "创建账号" : "保存修改"))}
        </Button>
        {onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel}>
            取消
          </Button>
        ) : (
          <Button variant="outline" asChild>
            <Link
              prefetch={false}
              href={
                creating
                  ? pg
                    ? `/dashboard/groups/${pg.id}`
                    : "/dashboard/channels?tab=accounts"
                  : `/dashboard/accounts/${a.id}`
              }
            >
              取消
            </Link>
          </Button>
        )}
      </div>

      {confirmEl}
    </form>
  );
}
